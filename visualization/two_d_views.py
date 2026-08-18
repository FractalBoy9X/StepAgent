from __future__ import annotations

from collections import defaultdict
from typing import Any

from .domain import ExecutionGraph, GraphNode, InteractionFamily

FAMILY_ORDER = tuple(family.value for family in InteractionFamily)

# Single source of truth for family colors. The frontend receives them through
# the payload ("families") and the instructions page renders the same swatches,
# so the legend, the matrix rows, and the glossary can never drift apart.
FAMILY_COLORS: dict[str, str] = {
    "communication": "#a78bfa",
    "cognition": "#60a5fa",
    "planning": "#e879f9",
    "execution": "#22d3ee",
    "tooling": "#4ade80",
    "filesystem": "#fbbf24",
    "web": "#38bdf8",
    "mcp": "#34d399",
    "media": "#f472b6",
    "multi_agent": "#2dd4bf",
    "human_control": "#fb923c",
    "safety_security": "#fb7185",
    "context_state": "#94a3b8",
    "lifecycle_observability": "#cbd5e1",
}

DETAIL_PREVIEW_CHARS = 1200

# A conversation turn opens with the user message, and those run long: across
# the imported corpus the median is ~500 characters and the longest is ~51 000.
# The page payload carries a prefix; the Selection panel loads the rest from
# /api/interaction/ with its own truncation notice.
TURN_SUMMARY_CHARS = 2000


def family_catalog() -> list[dict[str, str]]:
    """Ordered family descriptors shared by the 2D payload and the instructions page."""
    return [{"id": family, "color": FAMILY_COLORS[family]} for family in FAMILY_ORDER]


def _is_interaction(node: GraphNode) -> bool:
    return node.node_id.startswith("interaction:") and node.interaction_index is not None


def _step(node: GraphNode, step_number: int) -> dict[str, Any]:
    return {
        "node_id": node.node_id,
        "kind": node.kind.value,
        "label": node.label,
        "family": node.family.value if node.family else None,
        "subkind": node.subkind,
        "lifecycle": node.lifecycle.value,
        "detail": node.detail[:DETAIL_PREVIEW_CHARS],
        "timestamp": node.timestamp,
        "duration_ms": node.duration_ms,
        "turn_number": node.turn_number,
        "turn_id": node.turn_id,
        "conversation_turn_id": node.conversation_turn_id,
        "conversation_turn_number": node.conversation_turn_number,
        "conversation_turn_kind": node.conversation_turn_kind.value,
        "interaction_index": node.interaction_index,
        "role": node.role,
        "status": node.status,
        "step_number": step_number,
    }


def _node_reference(node: GraphNode) -> dict[str, Any]:
    return {
        "node_id": node.node_id,
        "kind": node.kind.value,
        "label": node.label,
        "family": node.family.value if node.family else None,
        "lifecycle": node.lifecycle.value,
        "turn_number": node.turn_number,
        "turn_id": node.turn_id,
        "conversation_turn_id": node.conversation_turn_id,
        "conversation_turn_number": node.conversation_turn_number,
        "conversation_turn_kind": node.conversation_turn_kind.value,
        "interaction_index": node.interaction_index,
        "status": node.status,
    }


def build_2d_payload(graph: ExecutionGraph) -> dict[str, Any]:
    """Build deterministic Turn Lanes and Activity Matrix input from parser interactions."""
    interactions = sorted(
        (node for node in graph.nodes if _is_interaction(node)),
        key=lambda node: (node.interaction_index or 0, node.node_id),
    )
    by_turn: dict[str, list[GraphNode]] = defaultdict(list)
    for node in interactions:
        by_turn[node.conversation_turn_id].append(node)

    structural_turns = {
        node.conversation_turn_id: node
        for node in graph.nodes
        if node.kind.value == "turn"
    }
    turns: list[dict[str, Any]] = []
    grouped_turns = sorted(by_turn.items(), key=lambda entry: entry[1][0].interaction_index or 0)
    for conversation_turn_id, nodes in grouped_turns:
        structural = structural_turns.get(conversation_turn_id)
        first = nodes[0]
        errors = sum(node.status in {"error", "failed"} for node in nodes)
        summary = structural.detail if structural else ""
        turns.append({
            "conversation_turn_id": conversation_turn_id,
            "conversation_turn_number": first.conversation_turn_number,
            "conversation_turn_kind": first.conversation_turn_kind.value,
            "summary": summary[:TURN_SUMMARY_CHARS],
            "summary_length": len(summary),
            "summary_truncated": len(summary) > TURN_SUMMARY_CHARS,
            "interaction_count": len(nodes),
            "error_count": errors,
            "steps": [_step(node, index) for index, node in enumerate(nodes, start=1)],
        })

    return {
        "schema_version": 4,
        "families": family_catalog(),
        "turns": turns,
        "nodes": [_node_reference(node) for node in graph.nodes],
        "edges": [edge.to_dict() for edge in graph.edges],
    }
