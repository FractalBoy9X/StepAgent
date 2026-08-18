from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Any

from urllib.parse import urlencode

from django.contrib import messages
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils.translation import gettext as _
from django.utils.translation import gettext_lazy

from .listing import DEFAULT_SORT, SORT_KEYS, default_direction, filter_rows, sort_rows
from .repositories import RawCodexRepository, SessionRepository
from .services import (
    MODE_ALL,
    MODE_NEW,
    MODE_STALE,
    ImportOutcome,
    ObservatoryService,
    target_filename_for_raw,
)
from .two_d_views import build_2d_payload, family_catalog

logger = logging.getLogger(__name__)

# Display names match the JavaScript catalog (observatory-labels.js) so the
# glossary and the legend read identically.
FAMILY_NAMES = {
    "communication": gettext_lazy("Communication"),
    "cognition": gettext_lazy("Reasoning"),
    "planning": gettext_lazy("Planning"),
    "execution": gettext_lazy("Execution"),
    "tooling": gettext_lazy("Tools"),
    "filesystem": gettext_lazy("Files"),
    "web": gettext_lazy("Web"),
    "mcp": gettext_lazy("MCP"),
    "media": gettext_lazy("Media"),
    "multi_agent": gettext_lazy("Agents"),
    "human_control": gettext_lazy("Human control"),
    "safety_security": gettext_lazy("Safety"),
    "context_state": gettext_lazy("Context"),
    "lifecycle_observability": gettext_lazy("Lifecycle"),
}

FAMILY_DESCRIPTIONS = {
    "communication": gettext_lazy("Messages between you and the agent, including streamed replies."),
    "cognition": gettext_lazy("The model's recorded thinking: reasoning summaries and raw thought content."),
    "planning": gettext_lazy("The agent's working plan: step lists and their status updates."),
    "execution": gettext_lazy("Terminal commands the agent runs, with their output and exit status."),
    "tooling": gettext_lazy("Generic tool calls and their results, including dynamically registered tools."),
    "filesystem": gettext_lazy("File changes: patches applied to files and turn-level diffs."),
    "web": gettext_lazy("Web searches and pages the agent opened."),
    "mcp": gettext_lazy("External tools connected through the Model Context Protocol."),
    "media": gettext_lazy("Images and other media: generation, viewing, realtime streams."),
    "multi_agent": gettext_lazy("Sub-agents the main agent spawns, talks to, and waits for."),
    "human_control": gettext_lazy("Moments when the agent asks you for approval, permissions, or input."),
    "safety_security": gettext_lazy("Safety events: moderation, guardian assessments, model verification."),
    "context_state": gettext_lazy("Context changes: compaction, rollbacks, environment and thread settings."),
    "lifecycle_observability": gettext_lazy("Session plumbing: turn boundaries, token counters, errors, unknown events."),
}


def home(request: HttpRequest) -> HttpResponse:
    sessions = [row for row in ObservatoryService().inventory() if row["is_imported"]]
    return render(request, "home.html", {"sessions": _decorate(sessions)})


def execution_observatory_view(request: HttpRequest) -> HttpResponse:
    repository = SessionRepository()
    service = ObservatoryService(repository)
    selected_file = request.GET.get("file", "").strip()
    context: dict[str, Any] = {
        "available_sessions": [item.to_dict() for item in repository.list()],
        "selected_file": selected_file,
        "visualization": {},
        "error_message": "",
    }
    try:
        graph = service.load_graph(selected_file or None)
        context.update({
            "visualization": build_2d_payload(graph),
            "metrics": graph.metrics,
            "selected_file": selected_file or repository.resolve().name,
        })
    except Exception as exc:  # noqa: BLE001 - local diagnostic UI
        logger.exception("Failed to build execution observatory")
        context["error_message"] = _("Unable to load the observatory: %(error)s") % {"error": exc}
    return render(request, "execution_observatory.html", context)


def graph_api(request: HttpRequest) -> JsonResponse:
    filename = request.GET.get("file", "").strip()
    try:
        graph = ObservatoryService().load_graph(filename or None)
        return JsonResponse(graph.to_dict(), json_dumps_params={"ensure_ascii": False})
    except FileNotFoundError as exc:
        return JsonResponse({"error": str(exc)}, status=404)
    except (ValueError, json.JSONDecodeError) as exc:
        return JsonResponse({"error": str(exc)}, status=400)


def interaction_api(request: HttpRequest) -> JsonResponse:
    filename = request.GET.get("file", "").strip()
    interaction_id = request.GET.get("id", "").strip()
    if not filename or not interaction_id:
        # API payloads are deliberately language-independent (see
        # tests/test_i18n.py::test_language_does_not_change_graph_api_payload);
        # the frontend renders its own translated message on failure.
        return JsonResponse({"error": "Both file and id are required."}, status=400)
    try:
        return JsonResponse(
            SessionRepository().interaction_detail(filename, interaction_id),
            json_dumps_params={"ensure_ascii": False},
        )
    except (FileNotFoundError, KeyError) as exc:
        return JsonResponse({"error": str(exc)}, status=404)
    except (ValueError, json.JSONDecodeError) as exc:
        return JsonResponse({"error": str(exc)}, status=400)


STATUS_LABELS = {
    "new": gettext_lazy("New"),
    "current": gettext_lazy("Up to date"),
    "stale": gettext_lazy("Stale"),
    "untracked": gettext_lazy("Not tracked"),
    "orphaned": gettext_lazy("Orphaned"),
}

# Drives the badge colour only; see base.css .badge-*.
STATUS_TONES = {
    "new": "neutral",
    "current": "ok",
    "stale": "warn",
    "untracked": "neutral",
    "orphaned": "danger",
}

REASON_LABELS = {
    "size": gettext_lazy("size differs"),
    "mtime": gettext_lazy("source is newer"),
    "checksum": gettext_lazy("checksum differs"),
}

# Above this many outcomes a batch is reported as one summary line; see _flash.
MAX_DETAIL_MESSAGES = 5

SUMMARY_TEMPLATES = {
    "imported": gettext_lazy("%(count)s imported"),
    "refreshed": gettext_lazy("%(count)s refreshed"),
    "skipped": gettext_lazy("%(count)s unchanged"),
    "deleted": gettext_lazy("%(count)s deleted"),
    "mismatch": gettext_lazy("%(count)s with a checksum mismatch"),
    "failed": gettext_lazy("%(count)s failed"),
}


def _decorate(rows: list[dict]) -> list[dict]:
    """Attach the translated badge text each listing row renders."""
    for row in rows:
        status = row.get("status", "")
        row["status_label"] = STATUS_LABELS.get(status, status)
        row["status_tone"] = STATUS_TONES.get(status, "neutral")
        row["reason_label"] = REASON_LABELS.get(row.get("reason", ""), "")
        if "provenance" in row:  # inventory rows carry imported_at already
            row["imported_at"] = (row.get("provenance") or {}).get("imported_at", "")
    return rows


def _describe(outcome: ImportOutcome) -> str:
    if outcome.action == "imported":
        return _("Imported %(source)s → %(target)s") % {
            "source": outcome.source,
            "target": outcome.target,
        }
    if outcome.action == "refreshed":
        return _("Refreshed %(source)s → %(target)s (was %(before)s, now %(after)s interactions)") % {
            "source": outcome.source,
            "target": outcome.target,
            "before": outcome.interactions_before,
            "after": outcome.interactions_after,
        }
    if outcome.action == "skipped":
        return _("Skipped %(source)s — no changes") % {"source": outcome.source}
    if outcome.action == "deleted":
        return _("Deleted %(filename)s") % {"filename": outcome.target}
    if outcome.action == "mismatch":
        return _("Checksum mismatch: %(filename)s no longer matches its source") % {
            "filename": outcome.target,
        }
    if outcome.error == "empty_source":
        return _("Refused %(source)s: the source holds no records; the previous export was kept.") % {
            "source": outcome.source,
        }
    if outcome.error == "orphaned":
        return _("%(filename)s: source file is missing; only deletion is available.") % {
            "filename": outcome.target,
        }
    return _("Failed %(filename)s: %(error)s") % {
        "filename": outcome.source or outcome.target,
        "error": outcome.error,
    }


def _level_for(outcome: ImportOutcome) -> int:
    if outcome.action == "failed":
        return messages.ERROR
    if outcome.action in {"skipped", "mismatch"}:
        return messages.INFO
    return messages.SUCCESS


def _summarize(outcomes: list[ImportOutcome]) -> str:
    counts = Counter(outcome.action for outcome in outcomes)
    parts = [
        template % {"count": counts[action]}
        for action, template in SUMMARY_TEMPLATES.items()
        if counts[action]
    ]
    return ", ".join(str(part) for part in parts) + "."


def _flash(request: HttpRequest, outcomes: list[ImportOutcome], empty_note: str) -> None:
    """Report a batch without overflowing the message cookie.

    Messages are stored in a ~4 KB cookie (this app keeps no database), so a
    batch of dozens of sessions has to collapse into one summary plus the
    failures that actually need reading.
    """
    if not outcomes:
        messages.add_message(request, messages.INFO, empty_note)
        return
    if len(outcomes) <= MAX_DETAIL_MESSAGES:
        for outcome in outcomes:
            messages.add_message(request, _level_for(outcome), _describe(outcome))
        return

    failures = [outcome for outcome in outcomes if outcome.action == "failed"]
    messages.add_message(
        request,
        messages.INFO if failures else messages.SUCCESS,
        _summarize(outcomes),
    )
    for outcome in failures[:MAX_DETAIL_MESSAGES]:
        messages.add_message(request, messages.ERROR, _describe(outcome))
    if len(failures) > MAX_DETAIL_MESSAGES:
        messages.add_message(request, messages.ERROR, _("…and %(count)s more failures.") % {
            "count": len(failures) - MAX_DETAIL_MESSAGES,
        })


def _handle_log_manager_post(request: HttpRequest, service: ObservatoryService) -> None:
    action = request.POST.get("action", "")
    if action == "import_selected":
        selected = request.POST.getlist("selected_files")
        _flash(request, service.import_many(selected), _("Nothing selected."))
    elif action == "import_all":
        _flash(request, service.import_batch(MODE_NEW), _("No new sessions to import."))
    elif action == "import_stale":
        _flash(request, service.import_batch(MODE_STALE), _("Every imported session is up to date."))
    elif action == "import_all_force":
        _flash(request, service.import_batch(MODE_ALL), _("No sessions found."))
    elif action == "verify_checksums":
        _flash(request, service.verify_checksums(), _("All checksums match their sources."))
    elif action == "refresh_selected":
        _flash(request, service.refresh_targets(request.POST.getlist("selected_sessions")), _("Nothing selected."))
    elif action == "delete_selected":
        # One checkbox per row: raw rows submit their source path, exports without
        # a source submit their own filename. Deletion always addresses the export.
        targets = [
            *request.POST.getlist("selected_sessions"),
            *(target_filename_for_raw(path) for path in request.POST.getlist("selected_files")),
        ]
        existing = {item.filename for item in service.repository.list()}
        outcomes = [service.delete_processed(name) for name in targets if name in existing]
        _flash(request, outcomes, _("Nothing selected that has been imported."))


STATUS_FILTERS = ("all", "new", "stale", "untracked", "current", "orphaned")

LISTING_COLUMNS = (
    ("project", gettext_lazy("Session")),
    ("started", gettext_lazy("Created")),
    ("updated", gettext_lazy("Source updated")),
    ("imported", gettext_lazy("Imported")),
    ("size", gettext_lazy("Size")),
    ("interactions", gettext_lazy("Interactions")),
    ("status", gettext_lazy("Status")),
)


def _listing_state(request: HttpRequest) -> dict[str, str]:
    """Sorting and filtering survive the POST redirect through the query string."""
    source = request.POST if request.method == "POST" else request.GET
    sort = source.get("sort", "").strip()
    if sort not in SORT_KEYS:
        sort = DEFAULT_SORT
    direction = source.get("dir", "").strip().lower()
    if direction not in {"asc", "desc"}:
        direction = default_direction(sort)
    status = source.get("status", "").strip() or "all"
    if status not in STATUS_FILTERS:
        status = "all"
    return {"sort": sort, "dir": direction, "q": source.get("q", "").strip(), "status": status}


def _query(state: dict[str, str], **overrides: str) -> str:
    """Query string carrying only what differs from the default listing."""
    merged = {**state, **overrides}
    trimmed = {
        key: value
        for key, value in merged.items()
        if value and not (key == "status" and value == "all")
        and not (key == "sort" and value == DEFAULT_SORT)
        and not (key == "dir" and value == default_direction(merged["sort"]))
    }
    return urlencode(trimmed)


def _columns(state: dict[str, str]) -> list[dict[str, Any]]:
    columns = []
    for key, label in LISTING_COLUMNS:
        active = state["sort"] == key
        # The active column flips on click; any other starts at its natural direction.
        direction = ("asc" if state["dir"] == "desc" else "desc") if active else default_direction(key)
        columns.append({
            "key": key,
            "label": label,
            "active": active,
            "indicator": ("▼" if state["dir"] == "desc" else "▲") if active else "",
            "aria": ("descending" if state["dir"] == "desc" else "ascending") if active else "none",
            "query": _query(state, sort=key, dir=direction),
        })
    return columns


def _status_options(state: dict[str, str], rows: list[dict]) -> list[dict[str, Any]]:
    counts = Counter(row["status"] for row in rows)
    options = []
    for value in STATUS_FILTERS:
        options.append({
            "value": value,
            "label": _("All") if value == "all" else STATUS_LABELS.get(value, value),
            "count": len(rows) if value == "all" else counts.get(value, 0),
            "active": state["status"] == value,
            "query": _query(state, status=value),
        })
    return options


def log_manager_view(request: HttpRequest) -> HttpResponse:
    service = ObservatoryService()
    state = _listing_state(request)
    if request.method == "POST":
        try:
            _handle_log_manager_post(request, service)
        except Exception as exc:  # noqa: BLE001 - local diagnostic UI
            logger.exception("Session import failed")
            messages.add_message(
                request,
                messages.ERROR,
                _("Session import failed: %(error)s") % {"error": exc},
            )
        query = _query(state)
        return redirect(f"{reverse('log_manager')}?{query}" if query else reverse("log_manager"))

    rows = service.inventory()
    visible = sort_rows(
        filter_rows(rows, state["q"], state["status"]),
        state["sort"],
        descending=state["dir"] == "desc",
    )
    return render(request, "log_manager.html", {
        "sessions": _decorate(visible),
        "columns": _columns(state),
        "status_options": _status_options(state, rows),
        "state": state,
        "total_count": len(rows),
        "source_dir": str(RawCodexRepository().source_dir),
    })


def instructions_view(request: HttpRequest) -> HttpResponse:
    families = [
        {**entry, "name": FAMILY_NAMES[entry["id"]], "description": FAMILY_DESCRIPTIONS[entry["id"]]}
        for entry in family_catalog()
    ]
    return render(request, "instructions.html", {"families": families})
