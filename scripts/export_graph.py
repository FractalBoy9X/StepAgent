#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from visualization.adapters import parse_session_file  # noqa: E402
from visualization.graph_builder import build_execution_graph  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Export normalized execution graph JSON.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--graph-output", type=Path)
    args = parser.parse_args()

    graph = build_execution_graph(parse_session_file(args.input))
    graph_output = args.graph_output or args.input.with_suffix(".graph.json")
    graph_output.write_text(json.dumps(graph.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Graph: {graph_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
