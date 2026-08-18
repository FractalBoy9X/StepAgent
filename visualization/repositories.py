from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import provenance as provenance_module
from .adapters import parse_session_file
from .domain import SessionDocument

DATA_DIR = Path(__file__).resolve().parent / "data" / "sessions_json"


@dataclass(frozen=True, slots=True)
class SessionFile:
    filename: str
    path: Path
    size: int
    modified: float
    format: str
    provenance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "filename": self.filename,
            "path": str(self.path),
            "size": self.size,
            "modified": self.modified,
            "format": self.format,
            "provenance": self.provenance,
        }


class SessionRepository:
    def __init__(self, data_dir: Path | None = None) -> None:
        self.data_dir = (data_dir or DATA_DIR).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[SessionFile]:
        files: list[SessionFile] = []
        for path in self.data_dir.iterdir():
            if not path.is_file() or path.name.startswith("._"):
                continue
            if not path.name.endswith(".v4.json"):
                continue
            stat = path.stat()
            files.append(SessionFile(
                filename=path.name,
                path=path,
                size=stat.st_size,
                modified=stat.st_mtime,
                format=path.suffix.lower().lstrip("."),
                provenance=provenance_module.read_provenance(path),
            ))
        return sorted(files, key=lambda item: item.modified, reverse=True)

    def resolve(self, filename: str | None = None) -> Path:
        candidates = self.list()
        if not candidates:
            raise FileNotFoundError(f"No session files found in {self.data_dir}")
        if not filename:
            return candidates[0].path
        # Name-only lookup prevents path traversal.
        safe_name = Path(filename).name
        if safe_name != filename:
            raise ValueError("Invalid session filename.")
        candidate = (self.data_dir / safe_name).resolve()
        if candidate.parent != self.data_dir or not candidate.is_file():
            raise FileNotFoundError(f"Session file not found: {safe_name}")
        return candidate

    def load(self, filename: str | None = None, max_events: int | None = None) -> SessionDocument:
        path = self.resolve(filename)
        session = parse_session_file(path)
        if max_events is not None and max_events > 0 and len(session.interactions) > max_events:
            session.interactions = session.interactions[:max_events]
            session.metadata["truncated"] = True
            session.metadata["max_interactions"] = max_events
        return session

    def save_v4(self, session: SessionDocument, filename: str | None = None) -> Path:
        base_name = filename or f"session_{session.session_id}.json"
        safe_name = Path(base_name).name
        path = self.data_dir / safe_name
        temporary = path.with_suffix(path.suffix + ".tmp")
        try:
            temporary.write_text(json.dumps(session.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
            # Validate the complete artifact before it replaces an existing export.
            parse_session_file(temporary)
            temporary.replace(path)
        except BaseException:
            # A failed refresh must leave the previous export untouched.
            temporary.unlink(missing_ok=True)
            raise
        provenance_module.forget(path)
        return path

    def delete(self, filename: str) -> Path:
        """Remove one processed export. Never touches the raw source directory."""
        safe_name = Path(filename).name
        if safe_name != filename or not safe_name.endswith(".v4.json"):
            raise ValueError("Invalid session filename.")
        path = (self.data_dir / safe_name).resolve()
        if path.parent != self.data_dir or not path.is_file():
            raise FileNotFoundError(f"Session file not found: {safe_name}")
        path.unlink()
        path.with_suffix(path.suffix + ".tmp").unlink(missing_ok=True)
        provenance_module.forget(path)
        return path

    def interaction_detail(self, filename: str, interaction_id: str) -> dict[str, Any]:
        session = self.load(filename)
        interaction = next((item for item in session.interactions if item.interaction_id == interaction_id), None)
        if interaction is None:
            raise KeyError(interaction_id)
        raw_ids = set(interaction.raw_record_ids)
        return {
            "schema_version": 4,
            "interaction": interaction.to_dict(),
            "raw_records": [record.to_dict() for record in session.raw_records if record.raw_id in raw_ids],
        }


class RawCodexRepository:
    def __init__(self, source_dir: Path | None = None) -> None:
        configured = source_dir or Path(os.path.expanduser(os.environ.get("CODEX_SESSIONS_DIR", "~/.codex/sessions")))
        self.source_dir = configured.resolve()

    def list(self) -> list[SessionFile]:
        if not self.source_dir.exists():
            return []
        files: list[SessionFile] = []
        for path in self.source_dir.rglob("*.jsonl"):
            if not path.is_file() or path.name.startswith("._"):
                continue
            stat = path.stat()
            files.append(SessionFile(
                filename=str(path.relative_to(self.source_dir)),
                path=path,
                size=stat.st_size,
                modified=stat.st_mtime,
                format="jsonl",
            ))
        return sorted(files, key=lambda item: item.modified, reverse=True)

    def resolve(self, relative_path: str) -> Path:
        candidate = (self.source_dir / relative_path).resolve()
        try:
            candidate.relative_to(self.source_dir)
        except ValueError as exc:
            raise ValueError("Invalid source session path.") from exc
        if not candidate.is_file() or candidate.suffix.lower() != ".jsonl":
            raise FileNotFoundError(relative_path)
        return candidate
