"""Import provenance: which raw rollout produced a processed session, and when.

The block lives under ``meta.import_source`` inside the v4 artifact. It rides
along without a schema bump because ``parse_v4_json`` funnels unknown ``meta``
keys into ``SessionDocument.metadata`` and ``meta_dict`` spreads them back.

The source directory is strictly read-only here: this module only ever opens
raw rollouts for reading and stats them.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROVENANCE_KEY = "import_source"

STATUS_NEW = "new"
STATUS_CURRENT = "current"
STATUS_STALE = "stale"
STATUS_UNTRACKED = "untracked"
STATUS_ORPHANED = "orphaned"

# Statuses whose processed artifact no longer matches its raw source.
REFRESHABLE_STATUSES = frozenset({STATUS_STALE, STATUS_UNTRACKED})

# Filesystems with one-second mtime resolution would otherwise report drift.
MTIME_TOLERANCE_SECONDS = 1.0

# `meta` is the second key written by `SessionDocument.to_dict`, so it always
# sits in the first few kilobytes even for multi-megabyte exports.
META_HEAD_BYTES = 256 * 1024
# The first rollout record carries the base instructions, so it is long but bounded.
FIRST_LINE_BYTES = 128 * 1024
_HASH_CHUNK = 1 << 20
_TIMESTAMP_FIELD = re.compile(r'"timestamp"\s*:\s*"([^"]*)"')
_CACHE_LIMIT = 512

# Keyed by (path, st_mtime_ns, st_size); the home page and the log manager
# render the same listing, and a page load must stay stat-only.
_HEADER_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}

# Same keying, for the first record of a raw rollout (see read_raw_head).
_RAW_HEAD_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}

# Checksum mismatches found by the explicit "verify checksums" action. Keyed
# like the meta cache so the finding survives page reloads but is dropped as
# soon as the raw file changes (the cheap comparison takes over then).
_CHECKSUM_MISMATCHES: set[tuple[str, int, int]] = set()


def _stat_key(path: Path, stat: os.stat_result | None = None) -> tuple[str, int, int]:
    stat = stat or path.stat()
    return (str(path), stat.st_mtime_ns, stat.st_size)


def sha256_of(path: Path) -> str:
    """Stream the digest; rollouts routinely exceed available memory budgets."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(timespec="seconds")


def build_provenance(
    source: Path,
    source_dir: Path | None = None,
    *,
    interaction_count: int | None = None,
    raw_record_count: int | None = None,
) -> dict[str, Any]:
    """Describe the raw file an export was built from."""
    stat = source.stat()
    relative = ""
    if source_dir is not None:
        try:
            relative = str(source.resolve().relative_to(source_dir.resolve()))
        except ValueError:
            relative = ""
    return {
        "relative_path": relative,
        "absolute_path": str(source.resolve()),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "mtime_iso": utc_iso(stat.st_mtime),
        "sha256": sha256_of(source),
        "imported_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        "interaction_count": interaction_count if interaction_count is not None else 0,
        "raw_record_count": raw_record_count if raw_record_count is not None else 0,
    }


def read_header(path: Path) -> dict[str, Any]:
    """Read the head of a v4 export: its ``meta`` block and the session start.

    Never raises: a missing or unreadable head simply means "not tracked",
    which must not take a listing page down.
    """
    try:
        key = _stat_key(path)
    except OSError:
        return {"meta": {}, "started_at": ""}
    cached = _HEADER_CACHE.get(key)
    if cached is not None:
        return cached
    header = _decode_head(path)
    if len(_HEADER_CACHE) >= _CACHE_LIMIT:
        _HEADER_CACHE.clear()
    _HEADER_CACHE[key] = header
    return header


def read_session_meta(path: Path) -> dict[str, Any]:
    """The ``meta`` block of a v4 export; ``{}`` when it cannot be read."""
    return read_header(path).get("meta", {})


def read_export_start(path: Path) -> str:
    """Timestamp of the first raw record, i.e. when the session actually began.

    ``meta.generated_at`` is not a substitute: it falls back to the *last*
    record for rollouts whose session_meta carries no timestamp of its own.
    """
    return str(read_header(path).get("started_at", ""))


def _decode_head(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            head = stream.read(META_HEAD_BYTES)
    except OSError:
        return {"meta": {}, "started_at": ""}
    return {"meta": _decode_meta(head), "started_at": _decode_first_record_timestamp(head)}


def _decode_meta(head: str) -> dict[str, Any]:
    marker = head.find('"meta"')
    if marker < 0:
        return {}
    colon = head.find(":", marker + len('"meta"'))
    if colon < 0:
        return {}
    start = colon + 1
    while start < len(head) and head[start].isspace():
        start += 1  # raw_decode does not skip leading whitespace itself
    try:
        value, _ = json.JSONDecoder().raw_decode(head, start)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _decode_first_record_timestamp(head: str) -> str:
    """First ``timestamp`` after the raw_records marker, without decoding records."""
    marker = head.find('"raw_records"')
    if marker < 0:
        return ""
    match = _TIMESTAMP_FIELD.search(head, marker)
    return match.group(1) if match else ""


def read_provenance(path: Path) -> dict[str, Any]:
    block = read_session_meta(path).get(PROVENANCE_KEY)
    return block if isinstance(block, dict) else {}


def read_raw_head(path: Path) -> dict[str, Any]:
    """Read the first record of a raw rollout: its session start, id and cwd.

    A rollout that was never imported has no ``meta`` to read, and its filename
    carries the recording machine's wall clock rather than UTC. One line is
    enough to date it correctly, and the result is cached like the meta blocks.
    Never raises: an unreadable rollout is simply undated.
    """
    try:
        key = _stat_key(path)
    except OSError:
        return {}
    cached = _RAW_HEAD_CACHE.get(key)
    if cached is not None:
        return cached
    record = _decode_first_record(path)
    if len(_RAW_HEAD_CACHE) >= _CACHE_LIMIT:
        _RAW_HEAD_CACHE.clear()
    _RAW_HEAD_CACHE[key] = record
    return record


def _decode_first_record(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            line = stream.readline(FIRST_LINE_BYTES)
    except OSError:
        return {}
    try:
        record = json.loads(line)
    except ValueError:
        return {}
    if not isinstance(record, dict):
        return {}
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    started_at = record.get("timestamp") or payload.get("timestamp") or ""
    return {
        "started_at": str(started_at),
        "session_id": str(payload.get("id") or payload.get("session_id") or ""),
        "cwd": str(payload.get("cwd") or ""),
    }


def compare(provenance: dict[str, Any] | None, source: Path | None) -> str:
    """Status of an existing export against its raw source."""
    if source is None or not source.is_file():
        return STATUS_ORPHANED
    if not provenance:
        return STATUS_UNTRACKED
    try:
        stat = source.stat()
    except OSError:
        return STATUS_ORPHANED
    if int(provenance.get("size", -1)) != stat.st_size:
        return STATUS_STALE
    recorded_mtime = float(provenance.get("mtime", 0.0))
    if stat.st_mtime > recorded_mtime + MTIME_TOLERANCE_SECONDS:
        return STATUS_STALE
    if _stat_key(source, stat) in _CHECKSUM_MISMATCHES:
        return STATUS_STALE
    return STATUS_CURRENT


def status_for(target: Path, source: Path | None) -> str:
    """Status seen from the raw side: `new` when nothing was exported yet."""
    if not target.is_file():
        return STATUS_NEW
    return compare(read_provenance(target), source)


def difference_reason(provenance: dict[str, Any] | None, source: Path | None) -> str:
    """Machine-readable reason a status is `stale`: size | mtime | checksum."""
    if not provenance or source is None or not source.is_file():
        return ""
    try:
        stat = source.stat()
    except OSError:
        return ""
    if int(provenance.get("size", -1)) != stat.st_size:
        return "size"
    if stat.st_mtime > float(provenance.get("mtime", 0.0)) + MTIME_TOLERANCE_SECONDS:
        return "mtime"
    if _stat_key(source, stat) in _CHECKSUM_MISMATCHES:
        return "checksum"
    return ""


def record_checksum_mismatch(source: Path) -> None:
    try:
        _CHECKSUM_MISMATCHES.add(_stat_key(source))
    except OSError:
        pass


def clear_checksum_mismatch(source: Path) -> None:
    try:
        _CHECKSUM_MISMATCHES.discard(_stat_key(source))
    except OSError:
        pass


def forget(path: Path) -> None:
    """Drop cached meta for a path that was rewritten or deleted."""
    for cache in (_HEADER_CACHE, _RAW_HEAD_CACHE):
        for key in [key for key in cache if key[0] == str(path)]:
            cache.pop(key, None)
