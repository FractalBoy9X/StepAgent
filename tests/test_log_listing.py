"""Dates, sorting and filtering on the session listing.

Like tests/test_import_refresh.py, every test builds throwaway rollouts under
``tmp_path`` and points ``CODEX_SESSIONS_DIR`` at them; the real Codex log
directory is never touched.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agentic_app.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.test import Client  # noqa: E402

from visualization import provenance, repositories  # noqa: E402
from visualization.listing import (  # noqa: E402
    filter_rows,
    format_size,
    label_for,
    sort_rows,
    started_at_from_filename,
)
from visualization.repositories import SessionRepository  # noqa: E402
from visualization.services import ObservatoryService  # noqa: E402

HOST = {"HTTP_HOST": "localhost"}


@pytest.fixture(scope="module", autouse=True)
def django_test_environment():
    """So the test client records the rendered template context."""
    from django.test.utils import setup_test_environment, teardown_test_environment

    try:
        setup_test_environment()
    except RuntimeError:  # another module already enabled it
        yield
        return
    yield
    teardown_test_environment()


def rollout(session_id: str, day: str, cwd: str, messages: int = 1) -> list[dict]:
    stream = [{
        "type": "session_meta",
        "timestamp": f"{day}T09:00:00Z",
        "payload": {"id": session_id, "cwd": cwd},
    }]
    for index in range(messages):
        stream.append({
            "type": "event_msg",
            "timestamp": f"{day}T09:0{index + 1}:00Z",
            "payload": {"type": "user_message", "message": f"msg {index}", "turn_id": "turn-a"},
        })
    return stream


def write_rollout(source_dir: Path, relative: str, records: list[dict]) -> Path:
    path = source_dir / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")
    provenance.forget(path)
    return path


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """Private source and processed directories, also used by the view under test."""
    source_dir = tmp_path / "codex-sessions"
    data_dir = tmp_path / "processed"
    source_dir.mkdir()
    data_dir.mkdir()
    monkeypatch.setenv("CODEX_SESSIONS_DIR", str(source_dir))
    monkeypatch.setattr(repositories, "DATA_DIR", data_dir)
    provenance._HEADER_CACHE.clear()
    provenance._RAW_HEAD_CACHE.clear()
    provenance._CHECKSUM_MISMATCHES.clear()
    return source_dir, ObservatoryService(SessionRepository(data_dir))


ALPHA = "2026/08/02/rollout-2026-08-02T11-00-00-11111111.jsonl"
BETA = "2026/08/09/rollout-2026-08-09T11-00-00-22222222.jsonl"


def test_created_date_comes_from_the_record_not_the_filename(sandbox) -> None:
    source_dir, service = sandbox
    # The filename carries the recording machine's wall clock (11-00-00 local),
    # while the first record holds the real UTC start.
    write_rollout(source_dir, ALPHA, rollout("11111111", "2026-08-02", "/tmp/projekt-alpha"))

    row = service.inventory()[0]
    assert row["started_at"] == "2026-08-02T09:00:00Z"
    assert row["project"] == "projekt-alpha"
    assert row["session_id"] == "11111111"
    assert row["status"] == "new"
    assert row["interaction_count"] is None
    assert row["imported_at"] == ""
    assert row["size"] > 0

    service.import_raw(ALPHA)
    row = service.inventory()[0]
    assert row["status"] == "current"
    assert row["started_at"] == "2026-08-02T09:00:00Z"
    assert row["imported_at"]
    assert row["interaction_count"] and row["interaction_count"] > 0
    assert row["label"].startswith("2026-08-02") and "projekt-alpha" in row["label"]


def test_inventory_covers_raw_and_orphaned_exports(sandbox) -> None:
    source_dir, service = sandbox
    write_rollout(source_dir, ALPHA, rollout("11111111", "2026-08-02", "/tmp/projekt-alpha"))
    write_rollout(source_dir, BETA, rollout("22222222", "2026-08-09", "/tmp/projekt-beta"))
    service.import_raw(BETA)
    (source_dir / BETA).unlink()

    rows = {row["target"]: row for row in service.inventory()}
    assert rows["2026__08__02__rollout-2026-08-02T11-00-00-11111111.v4.json"]["status"] == "new"
    orphan = rows["2026__08__09__rollout-2026-08-09T11-00-00-22222222.v4.json"]
    assert orphan["status"] == "orphaned"
    assert orphan["raw_relative"] == ""
    assert orphan["source_modified"] is None
    assert orphan["is_imported"] is True


def test_sorting_is_whitelisted_and_keeps_missing_values_last() -> None:
    rows = [
        {"target": "a.v4.json", "started_at": "2026-01-01T00:00:00Z", "source_modified": 30.0, "size": 10},
        {"target": "b.v4.json", "started_at": "2026-03-01T00:00:00Z", "source_modified": 10.0, "size": 30},
        {"target": "c.v4.json", "started_at": "", "source_modified": None, "size": None},
    ]
    names = lambda ordered: [row["target"] for row in ordered]  # noqa: E731

    assert names(sort_rows(rows, "started", True)) == ["b.v4.json", "a.v4.json", "c.v4.json"]
    assert names(sort_rows(rows, "started", False)) == ["a.v4.json", "b.v4.json", "c.v4.json"]
    assert names(sort_rows(rows, "updated", True)) == ["a.v4.json", "b.v4.json", "c.v4.json"]
    assert names(sort_rows(rows, "size", False)) == ["a.v4.json", "b.v4.json", "c.v4.json"]
    # An unknown key falls back to the default sort instead of raising.
    assert names(sort_rows(rows, "'; drop", True)) == ["b.v4.json", "a.v4.json", "c.v4.json"]


def test_filtering_by_text_and_status() -> None:
    rows = [
        {"target": "a.v4.json", "project": "alpha", "session_id": "1111", "status": "new", "raw_relative": "a.jsonl"},
        {"target": "b.v4.json", "project": "beta", "session_id": "2222", "status": "stale", "raw_relative": "b.jsonl"},
    ]
    assert [row["target"] for row in filter_rows(rows, "beta")] == ["b.v4.json"]
    assert [row["target"] for row in filter_rows(rows, "2222")] == ["b.v4.json"]
    assert [row["target"] for row in filter_rows(rows, "", "new")] == ["a.v4.json"]
    assert len(filter_rows(rows, "", "all")) == 2


def test_formatting_helpers() -> None:
    assert format_size(900) == "900 B"
    assert format_size(1536) == "1.5 KB"
    assert format_size(None) == ""
    assert started_at_from_filename(ALPHA) == "2026-08-02T11:00:00Z"
    assert started_at_from_filename("nonsense.jsonl") == ""
    assert label_for({"target": "x.v4.json"}) == "x.v4.json"


def test_log_manager_sorts_filters_and_keeps_state_through_post(sandbox) -> None:
    source_dir, service = sandbox
    write_rollout(source_dir, ALPHA, rollout("11111111", "2026-08-02", "/tmp/projekt-alpha"))
    write_rollout(source_dir, BETA, rollout("22222222", "2026-08-09", "/tmp/projekt-beta"))

    client = Client()
    descending = client.get("/logs/", {"sort": "started", "dir": "desc"}, **HOST)
    ascending = client.get("/logs/", {"sort": "started", "dir": "asc"}, **HOST)
    order_desc = [row["target"] for row in descending.context["sessions"]]
    order_asc = [row["target"] for row in ascending.context["sessions"]]
    assert order_desc == list(reversed(order_asc))
    assert order_desc[0].startswith("2026__08__09__")

    filtered = client.get("/logs/", {"q": "alpha"}, **HOST)
    assert [row["project"] for row in filtered.context["sessions"]] == ["projekt-alpha"]
    only_new = client.get("/logs/", {"status": "current"}, **HOST)
    assert only_new.context["sessions"] == []

    # A plain POST keeps the canonical URL; a sorted one carries its state back.
    plain = client.post("/logs/", {"action": "import_all"}, **HOST)
    assert plain.url == "/logs/"
    sorted_post = client.post(
        "/logs/",
        {"action": "import_selected", "selected_files": [ALPHA], "sort": "size", "dir": "asc", "q": "alpha"},
        **HOST,
    )
    assert sorted_post.status_code == 302
    assert "sort=size" in sorted_post.url and "dir=asc" in sorted_post.url and "q=alpha" in sorted_post.url


def test_delete_selected_removes_the_export_for_a_raw_row(sandbox) -> None:
    source_dir, service = sandbox
    write_rollout(source_dir, ALPHA, rollout("11111111", "2026-08-02", "/tmp/projekt-alpha"))
    service.import_raw(ALPHA)
    assert service.repository.list()

    Client().post("/logs/", {"action": "delete_selected", "selected_files": [ALPHA]}, **HOST)
    assert service.repository.list() == []
