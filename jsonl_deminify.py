#!/usr/bin/env python3
"""Normalize concatenated/pretty JSON objects into one-object-per-line JSONL."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from visualization.adapters import iter_json_objects


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", nargs="?", type=Path)
    args = parser.parse_args()
    output = args.output or args.input.with_suffix(".normalized.jsonl")
    with args.input.open("r", encoding="utf-8", errors="replace") as source, output.open("w", encoding="utf-8") as target:
        count = 0
        for item in iter_json_objects(source):
            target.write(json.dumps(item, ensure_ascii=False) + "\n")
            count += 1
    print(f"Wrote {count} JSON objects to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
