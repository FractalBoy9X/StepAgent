"""Reimporting a rollout whose raw source changed after the first import.

Every test builds its own throwaway rollouts under ``tmp_path`` and points
``CODEX_SESSIONS_DIR`` at it. The real Codex log directory is never read from
or written to by this suite.
"""
from __future__ import annotations

import json
import os
import random
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agentic_app.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.test import Client, override_settings  # noqa: E402

from visualization import provenance  # noqa: E402
from visualization.adapters import parse_session_file  # noqa: E402
from visualization.repositories import SessionRepository  # noqa: E402
from visualization.services import (  # noqa: E402
    MODE_ALL,
    MODE_NEW,
    MODE_STALE,
    ObservatoryService,
    target_filename_for_raw,
)

HOST = {"HTTP_HOST": "localhost"}
RELATIVE = "2026/08/17/rollout-demo.jsonl"


def records(messages: list[str]) -> list[dict]:
    stream: list[dict] = [
        {"type": "session_meta", "timestamp": "2026-08-17T00:00:00Z", "payload": {"id": "refresh-demo"}},
        {"type": "event_msg", "timestamp": "2026-08-17T00:00:01Z", "payload": {"type": "task_started", "turn_id": "turn-a"}},
    ]
    for index, message in enumerate(messages):
        stream.append({
            "type": "event_msg",
            "timestamp": f"2026-08-17T00:00:{index + 2:02d}Z",
            "payload": {"type": "user_message", "message": message, "turn_id": "turn-a"},
        })
    return stream


def write_rollout(source_dir: Path, messages: list[str], relative: str = RELATIVE) -> Path:
    path = source_dir / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(record) for record in records(messages)) + "\n",
        encoding="utf-8",
    )
    return path


def touch_newer(path: Path, seconds: int = 120) -> None:
    """Advance mtime so the comparison is not fooled by coarse timestamps."""
    stat = path.stat()
    os.utime(path, (stat.st_atime + seconds, stat.st_mtime + seconds))


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """A private CODEX_SESSIONS_DIR plus a private processed-session dir."""
    source_dir = tmp_path / "codex-sessions"
    source_dir.mkdir()
    monkeypatch.setenv("CODEX_SESSIONS_DIR", str(source_dir))
    provenance._HEADER_CACHE.clear()
    provenance._CHECKSUM_MISMATCHES.clear()
    service = ObservatoryService(SessionRepository(tmp_path / "processed"))
    return source_dir, service


def status_of(service: ObservatoryService, relative: str = RELATIVE) -> str:
    rows = {row["filename"]: row for row in service.session_statuses()["raw"]}
    return rows[relative]["status"]


def test_first_import_records_provenance(sandbox) -> None:
    source_dir, service = sandbox
    source = write_rollout(source_dir, ["one"])

    outcome = service.import_raw(RELATIVE)

    assert outcome.action == "imported"
    block = provenance.read_provenance(service.repository.data_dir / outcome.target)
    assert block["relative_path"] == RELATIVE
    assert block["size"] == source.stat().st_size
    assert block["sha256"] == provenance.sha256_of(source)
    assert block["interaction_count"] == outcome.interactions_after > 0


def test_changed_source_becomes_stale_and_refreshes(sandbox) -> None:
    source_dir, service = sandbox
    source = write_rollout(source_dir, ["one"])
    first = service.import_raw(RELATIVE)
    assert status_of(service) == provenance.STATUS_CURRENT

    write_rollout(source_dir, ["one", "two", "three"])
    touch_newer(source)
    assert status_of(service) == provenance.STATUS_STALE

    second = service.import_raw(RELATIVE)
    assert second.action == "refreshed"
    assert second.interactions_before == first.interactions_after
    assert second.interactions_after > second.interactions_before
    assert status_of(service) == provenance.STATUS_CURRENT


def test_size_only_change_is_detected_without_mtime_bump(sandbox) -> None:
    source_dir, service = sandbox
    source = write_rollout(source_dir, ["one"])
    service.import_raw(RELATIVE)
    original_mtime = source.stat().st_mtime

    write_rollout(source_dir, ["one", "two"])
    os.utime(source, (original_mtime, original_mtime))

    assert status_of(service) == provenance.STATUS_STALE


def test_export_without_provenance_is_untracked_and_refreshable(sandbox) -> None:
    source_dir, service = sandbox
    write_rollout(source_dir, ["one"])
    service.import_raw(RELATIVE)

    target = service.repository.data_dir / target_filename_for_raw(RELATIVE)
    payload = json.loads(target.read_text(encoding="utf-8"))
    payload["meta"].pop(provenance.PROVENANCE_KEY)
    target.write_text(json.dumps(payload), encoding="utf-8")
    provenance._HEADER_CACHE.clear()

    assert status_of(service) == provenance.STATUS_UNTRACKED
    outcomes = service.import_batch(MODE_STALE)
    assert [outcome.action for outcome in outcomes] == ["refreshed"]
    assert status_of(service) == provenance.STATUS_CURRENT


def test_batch_modes_select_the_right_sessions(sandbox) -> None:
    source_dir, service = sandbox
    stable = write_rollout(source_dir, ["one"], "2026/08/17/stable.jsonl")
    changing = write_rollout(source_dir, ["one"], "2026/08/17/changing.jsonl")
    assert len(service.import_batch(MODE_NEW)) == 2

    write_rollout(source_dir, ["one", "two"], "2026/08/17/changing.jsonl")
    touch_newer(changing)
    write_rollout(source_dir, ["fresh"], "2026/08/17/fresh.jsonl")

    new_only = service.import_batch(MODE_NEW)
    assert [outcome.source for outcome in new_only] == ["2026/08/17/fresh.jsonl"]

    stale_only = service.import_batch(MODE_STALE)
    assert [outcome.source for outcome in stale_only] == ["2026/08/17/changing.jsonl"]

    assert len(service.import_batch(MODE_ALL)) == 3
    assert stable.exists() and changing.exists()  # sources are never rewritten


def test_unchanged_source_is_skipped_when_not_forced(sandbox) -> None:
    source_dir, service = sandbox
    write_rollout(source_dir, ["one"])
    service.import_raw(RELATIVE)

    assert service.import_raw(RELATIVE, force=False).action == "skipped"
    assert service.import_raw(RELATIVE).action == "refreshed"


def test_failed_refresh_keeps_the_previous_export(sandbox) -> None:
    source_dir, service = sandbox
    source = write_rollout(source_dir, ["one"])
    service.import_raw(RELATIVE)
    target = service.repository.data_dir / target_filename_for_raw(RELATIVE)
    before = target.read_bytes()

    source.write_text("{not json at all\n", encoding="utf-8")
    touch_newer(source)
    outcome = service.import_one_safely(RELATIVE)

    assert outcome.action == "failed" and outcome.error
    assert target.read_bytes() == before
    assert not target.with_suffix(target.suffix + ".tmp").exists()
    assert parse_session_file(target).interactions


def test_truncated_source_is_refused_instead_of_wiping_the_export(sandbox) -> None:
    """The parser tolerates garbage, so the guard has to live in the importer."""
    source_dir, service = sandbox
    source = write_rollout(source_dir, ["one", "two"])
    service.import_raw(RELATIVE)
    target = service.repository.data_dir / target_filename_for_raw(RELATIVE)
    before = target.read_bytes()

    source.write_text("", encoding="utf-8")
    touch_newer(source)
    outcome = service.import_one_safely(RELATIVE)

    assert outcome.action == "failed" and outcome.error == "empty_source"
    assert target.read_bytes() == before


def test_missing_source_marks_the_export_orphaned(sandbox) -> None:
    source_dir, service = sandbox
    source = write_rollout(source_dir, ["one"])
    service.import_raw(RELATIVE)

    source.unlink()
    processed = service.session_statuses()["processed"]
    assert [row["status"] for row in processed] == [provenance.STATUS_ORPHANED]

    outcome = service.delete_processed(processed[0]["filename"])
    assert outcome.action == "deleted"
    assert service.session_statuses()["processed"] == []


def test_verify_checksums_catches_a_silent_replacement(sandbox) -> None:
    source_dir, service = sandbox
    source = write_rollout(source_dir, ["one"])
    service.import_raw(RELATIVE)
    stat = source.stat()

    # Same byte count, same mtime: only the digest can tell these apart.
    replaced = source.read_text(encoding="utf-8").replace('"one"', '"两"', 1)
    source.write_text(replaced, encoding="utf-8")
    os.utime(source, (stat.st_atime, stat.st_mtime))
    assert source.stat().st_size == stat.st_size
    assert status_of(service) == provenance.STATUS_CURRENT

    assert [outcome.action for outcome in service.verify_checksums()] == ["mismatch"]
    assert status_of(service) == provenance.STATUS_STALE


@pytest.mark.parametrize("name", ["../evil.v4.json", "sub/dir.v4.json", "demo-session.raw.jsonl", "notes.txt"])
def test_delete_rejects_unsafe_names(sandbox, name) -> None:
    _, service = sandbox
    assert service.delete_processed(name).action == "failed"


def test_read_session_meta_matches_a_full_parse_and_never_raises(sandbox, tmp_path) -> None:
    source_dir, service = sandbox
    write_rollout(source_dir, ["one"])
    service.import_raw(RELATIVE)
    target = service.repository.data_dir / target_filename_for_raw(RELATIVE)

    full = json.loads(target.read_text(encoding="utf-8"))["meta"]
    assert provenance.read_session_meta(target) == full

    broken = tmp_path / "broken.v4.json"
    broken.write_text("not json", encoding="utf-8")
    assert provenance.read_session_meta(broken) == {}
    assert provenance.read_session_meta(tmp_path / "missing.v4.json") == {}


def test_provenance_survives_a_save_load_round_trip(sandbox) -> None:
    source_dir, service = sandbox
    write_rollout(source_dir, ["one"])
    service.import_raw(RELATIVE)
    target = service.repository.data_dir / target_filename_for_raw(RELATIVE)

    reloaded = parse_session_file(target)
    assert reloaded.metadata[provenance.PROVENANCE_KEY] == provenance.read_provenance(target)
    assert reloaded.to_dict()["meta"][provenance.PROVENANCE_KEY]["relative_path"] == RELATIVE


@override_settings(DEBUG=True)
def test_large_batch_does_not_overflow_the_message_cookie(sandbox, monkeypatch) -> None:
    """Messages live in a cookie: 40 per-file notes would blow its size limit.

    ``DEBUG=True`` matches the dev server, where MessageMiddleware turns
    dropped messages into a 500 instead of discarding them silently.
    """
    source_dir, service = sandbox
    monkeypatch.setattr("visualization.views.ObservatoryService", lambda: service)
    # Real rollout names carry a random UUID. Repetitive names would compress
    # away inside the signed cookie and hide the overflow this test guards.
    rng = random.Random(0)
    for index in range(40):
        uid = "-".join(rng.randbytes(size).hex() for size in (4, 2, 2, 2, 6))
        write_rollout(
            source_dir,
            ["one"],
            f"2026/08/{index % 28 + 1:02d}/rollout-2026-08-17T{index:02d}-11-05-{uid}.jsonl",
        )
    client = Client()

    response = client.post("/logs/", {"action": "import_all"}, **HOST)

    assert response.status_code == 302
    assert len(response.cookies["messages"].value) < 4096
    page = client.get("/logs/", **HOST).content.decode("utf-8")
    assert "40 imported" in page


def test_log_manager_reimports_an_already_imported_session(sandbox, monkeypatch) -> None:
    """The regression this whole change exists for."""
    source_dir, service = sandbox
    monkeypatch.setattr("visualization.views.SessionRepository", lambda: service.repository)
    monkeypatch.setattr("visualization.views.ObservatoryService", lambda: service)
    source = write_rollout(source_dir, ["one"])
    client = Client()

    client.post("/logs/", {"action": "import_selected", "selected_files": [RELATIVE]}, **HOST)
    target = service.repository.data_dir / target_filename_for_raw(RELATIVE)
    before = len(parse_session_file(target).interactions)

    write_rollout(source_dir, ["one", "two", "three"])
    touch_newer(source)

    listing = client.get("/logs/", **HOST).content.decode("utf-8")
    assert "disabled" not in listing

    response = client.post("/logs/", {"action": "import_selected", "selected_files": [RELATIVE]}, **HOST)
    assert response.status_code == 302
    assert len(parse_session_file(target).interactions) > before
