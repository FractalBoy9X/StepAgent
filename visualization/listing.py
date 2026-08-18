"""Presentation rules for the session listing: dates, sizes, sorting, filtering.

Kept separate from ``services`` (which decides what a session *is*) and from
``views`` (which speaks HTTP), so the sort keys can be tested without a request.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

DEFAULT_SORT = "started"
# Every measurement reads best newest/largest first; only text sorts ascending.
DEFAULT_DIRECTIONS = {"name": "asc", "project": "asc", "status": "asc"}

# Sessions needing attention keep floating to the top when sorting by status.
STATUS_ORDER = {"stale": 0, "untracked": 1, "new": 2, "current": 3, "orphaned": 4}

ROLLOUT_TIMESTAMP = re.compile(r"(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})")
ROLLOUT_ID = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F-]+)")


def parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def timestamp_value(value: Any) -> float | None:
    moment = parse_timestamp(value)
    return moment.timestamp() if moment else None


def format_timestamp(value: Any) -> str:
    """Local time: this tool only ever runs on the operator's own machine."""
    moment = parse_timestamp(value)
    return moment.astimezone().strftime("%Y-%m-%d %H:%M") if moment else ""


def format_size(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return ""
    size = float(value)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} B" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def started_at_from_filename(name: str) -> str:
    """Last-resort date from `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>`, no I/O.

    The name holds the recording machine's wall clock, so it is only used when
    the rollout's first record cannot be read.
    """
    match = ROLLOUT_TIMESTAMP.search(Path(name).name)
    if not match:
        return ""
    day, hour, minute, second = match.groups()
    return f"{day}T{hour}:{minute}:{second}Z"


def session_id_from_filename(name: str) -> str:
    match = ROLLOUT_ID.search(Path(name).name)
    return match.group(1) if match else ""


def label_for(row: dict[str, Any]) -> str:
    """`2026-08-09 10:02 · project · 019fe70b` — what a person recognises."""
    parts = [format_timestamp(row.get("started_at")), row.get("project", ""), str(row.get("session_id", ""))[:8]]
    return " · ".join(part for part in parts if part) or row.get("target", "")


SORT_KEYS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "started": lambda row: timestamp_value(row.get("started_at")),
    "updated": lambda row: row.get("source_modified"),
    "imported": lambda row: timestamp_value(row.get("imported_at")),
    "size": lambda row: row.get("size"),
    "interactions": lambda row: row.get("interaction_count"),
    "project": lambda row: (row.get("project") or "").lower() or None,
    "name": lambda row: (row.get("target") or "").lower(),
    "status": lambda row: STATUS_ORDER.get(row.get("status", ""), 9),
}


def default_direction(key: str) -> str:
    return DEFAULT_DIRECTIONS.get(key, "desc")


def sort_rows(rows: list[dict[str, Any]], key: str, descending: bool = True) -> list[dict[str, Any]]:
    """Sort by one whitelisted key; rows without a value always sink to the bottom."""
    getter = SORT_KEYS.get(key, SORT_KEYS[DEFAULT_SORT])
    present = [row for row in rows if getter(row) is not None]
    missing = [row for row in rows if getter(row) is None]
    present.sort(key=lambda row: (row.get("target") or "").lower())
    present.sort(key=getter, reverse=descending)
    missing.sort(key=lambda row: (row.get("target") or "").lower())
    return present + missing


def filter_rows(rows: list[dict[str, Any]], query: str = "", status: str = "") -> list[dict[str, Any]]:
    if status and status != "all":
        rows = [row for row in rows if row.get("status") == status]
    needle = query.strip().lower()
    if needle:
        fields = ("target", "raw_relative", "project", "session_id", "label")
        rows = [row for row in rows if any(needle in str(row.get(field, "")).lower() for field in fields)]
    return rows
