from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from . import listing
from . import provenance as provenance_module
from .adapters import parse_codex_jsonl
from .domain import ExecutionGraph
from .graph_builder import build_execution_graph
from .provenance import PROVENANCE_KEY, REFRESHABLE_STATUSES, STATUS_CURRENT, STATUS_NEW
from .repositories import RawCodexRepository, SessionRepository

# Batch modes for import_batch().
MODE_NEW = "new"
MODE_STALE = "stale"
MODE_ALL = "all"


def target_filename_for_raw(relative_path: str) -> str:
    """Create a stable, collision-resistant processed filename from a raw relative path."""
    source = Path(relative_path)
    without_suffix = source.with_suffix("")
    safe_parts = [part.replace(" ", "_") for part in without_suffix.parts if part not in {".", ".."}]
    base = "__".join(safe_parts) or source.stem or "session"
    return f"{base}.v4.json"


class EmptySourceError(RuntimeError):
    """Raised when a raw source yields no records but an export already exists."""

    code = "empty_source"


@dataclass(frozen=True, slots=True)
class ImportOutcome:
    source: str
    target: str
    action: str  # imported | refreshed | skipped | failed | deleted
    error: str = ""
    interactions_before: int = 0
    interactions_after: int = 0

    @property
    def ok(self) -> bool:
        return self.action != "failed"


class ObservatoryService:
    def __init__(self, repository: SessionRepository | None = None) -> None:
        self.repository = repository or SessionRepository()

    @property
    def max_interactions(self) -> int:
        try:
            return max(100, int(os.environ.get("AGENTIC_MAX_INTERACTIONS", "5000")))
        except ValueError:
            return 5000

    def load_graph(self, filename: str | None = None) -> ExecutionGraph:
        session = self.repository.load(filename, max_events=self.max_interactions)
        return build_execution_graph(session)

    # ------------------------------------------------------------------ import

    def import_raw(
        self,
        relative_path: str,
        replace_v3: bool = False,
        *,
        force: bool = True,
    ) -> ImportOutcome:
        """(Re)import one raw rollout.

        ``force=False`` skips sources whose export is already up to date, so a
        batch run does not re-parse dozens of unchanged multi-megabyte files.
        """
        raw_repo = RawCodexRepository()
        raw_path = raw_repo.resolve(relative_path)
        target_name = target_filename_for_raw(relative_path)
        target_path = self.repository.data_dir / target_name

        previous = provenance_module.read_provenance(target_path) if target_path.is_file() else {}
        status = provenance_module.status_for(target_path, raw_path)
        if not force and status not in REFRESHABLE_STATUSES and status != STATUS_NEW:
            return ImportOutcome(
                source=relative_path,
                target=target_name,
                action="skipped",
                interactions_before=int(previous.get("interaction_count", 0)),
                interactions_after=int(previous.get("interaction_count", 0)),
            )

        session = parse_codex_jsonl(raw_path)
        # A truncated or corrupted rollout parses to nothing instead of raising.
        # Refusing here is what keeps a good export from being wiped by one.
        if not session.raw_records and int(previous.get("raw_record_count", 0)) > 0:
            raise EmptySourceError(relative_path)
        session.metadata[PROVENANCE_KEY] = provenance_module.build_provenance(
            raw_path,
            raw_repo.source_dir,
            interaction_count=len(session.interactions),
            raw_record_count=len(session.raw_records),
        )
        output = self.repository.save_v4(session, filename=target_name)
        provenance_module.clear_checksum_mismatch(raw_path)
        if replace_v3:
            legacy = output.with_name(output.name.removesuffix(".v4.json") + ".v3.json")
            if legacy.is_file():
                legacy.unlink()
        return ImportOutcome(
            source=relative_path,
            target=output.name,
            action="imported" if status == STATUS_NEW else "refreshed",
            interactions_before=int(previous.get("interaction_count", 0)),
            interactions_after=len(session.interactions),
        )

    def import_batch(self, mode: str = MODE_NEW) -> list[ImportOutcome]:
        """Import raw sessions selected by ``mode``: new | stale | all."""
        outcomes: list[ImportOutcome] = []
        for entry in self.session_statuses()["raw"]:
            status = entry["status"]
            if mode == MODE_NEW and status != STATUS_NEW:
                continue
            if mode == MODE_STALE and status not in REFRESHABLE_STATUSES:
                continue
            outcomes.append(self.import_one_safely(entry["filename"], force=mode == MODE_ALL))
        return outcomes

    def import_many(self, relative_paths: list[str], *, force: bool = True) -> list[ImportOutcome]:
        return [self.import_one_safely(path, force=force) for path in relative_paths]

    def import_one_safely(self, relative_path: str, *, force: bool = True) -> ImportOutcome:
        try:
            return self.import_raw(relative_path, force=force)
        except EmptySourceError:
            return ImportOutcome(
                source=relative_path,
                target=target_filename_for_raw(relative_path),
                action="failed",
                error=EmptySourceError.code,
            )
        except Exception as exc:  # noqa: BLE001 - surfaced in the local UI
            return ImportOutcome(
                source=relative_path,
                target=target_filename_for_raw(relative_path),
                action="failed",
                error=str(exc),
            )

    def refresh_targets(self, target_names: list[str]) -> list[ImportOutcome]:
        """Re-import processed exports addressed by their own filename."""
        source_by_target = {
            target_filename_for_raw(item.filename): item.filename
            for item in RawCodexRepository().list()
        }
        outcomes: list[ImportOutcome] = []
        for name in target_names:
            source = source_by_target.get(name)
            if source is None:
                outcomes.append(ImportOutcome(source="", target=name, action="failed", error="orphaned"))
                continue
            outcomes.append(self.import_one_safely(source, force=True))
        return outcomes

    def delete_processed(self, filename: str) -> ImportOutcome:
        try:
            self.repository.delete(filename)
        except (FileNotFoundError, ValueError) as exc:
            return ImportOutcome(source="", target=filename, action="failed", error=str(exc))
        return ImportOutcome(source="", target=filename, action="deleted")

    # ------------------------------------------------------------------ status

    def session_statuses(self) -> dict[str, list[dict]]:
        """One pass over both directories: raw sessions and processed exports."""
        raw_repo = RawCodexRepository()
        raw_items = raw_repo.list()
        processed_items = self.repository.list()

        # Forward mapping is authoritative: it works even for exports written
        # before provenance tracking existed.
        raw_by_target = {target_filename_for_raw(item.filename): item for item in raw_items}
        processed_by_name = {item.filename: item for item in processed_items}

        raw_rows: list[dict] = []
        for item in raw_items:
            target_name = target_filename_for_raw(item.filename)
            processed = processed_by_name.get(target_name)
            status = (
                provenance_module.compare(processed.provenance, item.path)
                if processed is not None
                else STATUS_NEW
            )
            row = item.to_dict()
            row.update({
                "target": target_name,
                "status": status,
                "reason": provenance_module.difference_reason(
                    processed.provenance if processed else {}, item.path
                ),
                "provenance": processed.provenance if processed else {},
                "already_imported": processed is not None,
            })
            raw_rows.append(row)

        processed_rows: list[dict] = []
        for item in processed_items:
            raw_item = raw_by_target.get(item.filename)
            status = provenance_module.compare(item.provenance, raw_item.path if raw_item else None)
            row = item.to_dict()
            row.update({
                "status": status,
                "reason": provenance_module.difference_reason(
                    item.provenance, raw_item.path if raw_item else None
                ),
                "source_relative": raw_item.filename if raw_item else item.provenance.get("relative_path", ""),
            })
            processed_rows.append(row)

        # Sessions needing attention float to the top of the import table.
        order = {"stale": 0, "untracked": 1, "new": 2, "current": 3, "orphaned": 4}
        raw_rows.sort(key=lambda row: (order.get(row["status"], 9), -row["modified"]))
        return {"raw": raw_rows, "processed": processed_rows}

    def inventory(self) -> list[dict]:
        """One row per session, joining each raw rollout with its export.

        The listing pages sort and filter these rows; every field is derived
        from stats plus cached header reads, never from decoding a payload.
        """
        statuses = self.session_statuses()
        processed_by_target = {row["filename"]: row for row in statuses["processed"]}
        rows = [
            self._inventory_row(raw, processed_by_target.get(raw["target"]))
            for raw in statuses["raw"]
        ]
        covered = {raw["target"] for raw in statuses["raw"]}
        rows.extend(
            self._inventory_row(None, processed)
            for name, processed in processed_by_target.items()
            if name not in covered
        )
        return listing.sort_rows(rows, listing.DEFAULT_SORT, descending=True)

    def _inventory_row(self, raw: dict | None, processed: dict | None) -> dict:
        source = processed or raw or {}
        target = processed["filename"] if processed else raw["target"]
        provenance_block = (processed or {}).get("provenance") or {}

        started_at, session_id, project = "", "", ""
        if processed is not None:
            header = provenance_module.read_header(Path(processed["path"]))
            meta = header.get("meta", {})
            started_at = str(header.get("started_at") or meta.get("generated_at") or "")
            session_id = str(meta.get("session_id") or "")
            project = Path(str(meta.get("cwd") or "")).name
        if raw is not None:
            head = provenance_module.read_raw_head(Path(raw["path"]))
            started_at = started_at or str(head.get("started_at") or "")
            session_id = session_id or str(head.get("session_id") or "")
            project = project or Path(str(head.get("cwd") or "")).name
        if not started_at:
            started_at = listing.started_at_from_filename(target)
        if not session_id:
            session_id = listing.session_id_from_filename(target)

        count = provenance_block.get("interaction_count")
        row = {
            "target": target,
            "filename": processed["filename"] if processed else "",
            "raw_relative": raw["filename"] if raw else "",
            "path": source.get("path", ""),
            "session_id": session_id,
            "project": project,
            "started_at": started_at,
            "source_modified": raw["modified"] if raw else None,
            "imported_at": str(provenance_block.get("imported_at") or ""),
            "size": raw["size"] if raw else processed.get("size"),
            "interaction_count": int(count) if isinstance(count, (int, float)) and count else None,
            "status": source.get("status", ""),
            "reason": source.get("reason", ""),
            "is_imported": processed is not None,
        }
        row["label"] = listing.label_for(row)
        row["started_display"] = listing.format_timestamp(row["started_at"])
        row["updated_display"] = listing.format_timestamp(row["source_modified"])
        row["imported_display"] = listing.format_timestamp(row["imported_at"])
        row["size_display"] = listing.format_size(row["size"])
        return row

    def verify_checksums(self) -> list[ImportOutcome]:
        """Recompute digests for exports that look current.

        Catches a source replaced in place with an identical size and mtime,
        which the stat-only comparison cannot see. Read-only on the source.
        """
        outcomes: list[ImportOutcome] = []
        for entry in self.session_statuses()["processed"]:
            if entry["status"] != STATUS_CURRENT:
                continue
            provenance = entry.get("provenance") or {}
            recorded = str(provenance.get("sha256", ""))
            source_path = Path(str(provenance.get("absolute_path", "")))
            if not recorded or not source_path.is_file():
                continue
            if provenance_module.sha256_of(source_path) == recorded:
                provenance_module.clear_checksum_mismatch(source_path)
                continue
            provenance_module.record_checksum_mismatch(source_path)
            outcomes.append(ImportOutcome(
                source=entry.get("source_relative", ""),
                target=entry["filename"],
                action="mismatch",
            ))
        return outcomes

    # ------------------------------------------------------- backward compat

    def import_all_new(self) -> tuple[int, list[ImportOutcome]]:
        outcomes = self.import_batch(MODE_NEW)
        return sum(1 for outcome in outcomes if outcome.action == "imported"), outcomes
