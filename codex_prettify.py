#!/usr/bin/env python3
"""Convert raw Codex JSONL sessions into lossless schema-v4 JSON."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from visualization.adapters import parse_codex_jsonl, parse_session_file
from visualization.provenance import (
    PROVENANCE_KEY,
    REFRESHABLE_STATUSES,
    STATUS_NEW,
    build_provenance,
    forget,
    status_for,
)
from visualization.services import target_filename_for_raw


def discover(source_dir: Path) -> list[Path]:
    if not source_dir.exists():
        return []
    return sorted(
        (path for path in source_dir.rglob("*.jsonl") if path.is_file() and not path.name.startswith("._")),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def convert(
    source: Path,
    output: Path,
    compact: bool = False,
    replace_v3: bool = False,
    source_dir: Path | None = None,
) -> Path:
    session = parse_codex_jsonl(source)
    # Same provenance block the web importer writes; one source of truth.
    session.metadata[PROVENANCE_KEY] = build_provenance(
        source,
        source_dir,
        interaction_count=len(session.interactions),
        raw_record_count=len(session.raw_records),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        temporary.write_text(
            json.dumps(session.to_dict(), ensure_ascii=False, indent=None if compact else 2),
            encoding="utf-8",
        )
        parse_session_file(temporary)
        temporary.replace(output)
    except BaseException:
        # A failed refresh must leave the previous export untouched.
        temporary.unlink(missing_ok=True)
        raise
    forget(output)
    if replace_v3:
        legacy = output.with_name(output.name.removesuffix(".v4.json") + ".v3.json")
        if legacy.is_file():
            legacy.unlink()
    print(f"Wrote {source} → {output} ({len(session.raw_records)} raw, {len(session.interactions)} interactions)")
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, help="Direct raw .jsonl/.ndjson file")
    parser.add_argument("--all", action="store_true", help="Import every discovered raw session")
    parser.add_argument("--file", dest="relative_file", help="Import one path relative to CODEX_SESSIONS_DIR")
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=Path(os.path.expanduser(os.environ.get("CODEX_SESSIONS_DIR", "~/.codex/sessions"))),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "visualization" / "data" / "sessions_json",
    )
    parser.add_argument("-o", "--output", type=Path, help="Explicit output path for direct input")
    parser.add_argument("--compact", action="store_true", help="Write compact JSON")
    parser.add_argument("--force", action="store_true", help="Reimport every discovered session, changed or not")
    parser.add_argument(
        "--refresh-stale",
        action="store_true",
        help="Reimport sessions whose raw source changed since the last import",
    )
    parser.add_argument("--replace-v3", action="store_true", help="Delete the matching v3 export after v4 validation")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    source_dir = args.source_dir.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()

    if args.input:
        source = args.input.expanduser().resolve()
        output = args.output.expanduser().resolve() if args.output else output_dir / f"{source.stem}.v4.json"
        convert(source, output, args.compact, args.replace_v3, source_dir)
        return 0

    files = discover(source_dir)
    if args.relative_file:
        source = (source_dir / args.relative_file).resolve()
        try:
            relative = source.relative_to(source_dir)
        except ValueError as exc:
            raise SystemExit("--file must stay inside --source-dir") from exc
        if not source.is_file():
            raise SystemExit(f"Session not found: {source}")
        files = [source]
    elif not args.all:
        files = files[:1]

    if not files:
        raise SystemExit(f"No JSONL sessions found in {source_dir}")

    converted = 0
    refreshed = 0
    skipped = 0
    for source in files:
        relative = str(source.relative_to(source_dir))
        output = output_dir / target_filename_for_raw(relative)
        status = status_for(output, source)
        stale = status in REFRESHABLE_STATUSES
        if status != STATUS_NEW and not args.force and not (args.refresh_stale and stale):
            skipped += 1
            print(f"Skipped {output.name} ({status})")
            continue
        convert(source, output, args.compact, args.replace_v3, source_dir)
        if status == STATUS_NEW:
            converted += 1
        else:
            refreshed += 1
    print(f"Done: {converted} converted, {refreshed} refreshed, {skipped} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
