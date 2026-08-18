from __future__ import annotations

import io
import json
import re
from pathlib import Path

import pytest

from visualization.adapters import (
    KNOWN_EVENT_TYPES,
    KNOWN_RESPONSE_TYPES,
    KNOWN_ROLLOUT_TYPES,
    iter_json_objects,
    parse_codex_records,
)
from visualization.domain import EdgeKind, InteractionFamily, LifecycleState, NodeKind
from visualization.graph_builder import build_execution_graph
from visualization.repositories import SessionRepository
from visualization.two_d_views import TURN_SUMMARY_CHARS, build_2d_payload


def sample_records() -> list[dict]:
    return [
        {"type": "session_meta", "timestamp": "2026-08-08T00:00:00Z", "payload": {"id": "v4-demo", "model_provider": "openai", "cwd": "/tmp/demo"}},
        {"type": "turn_context", "timestamp": "2026-08-08T00:00:00.500Z", "payload": {"turn_id": "turn-a", "model": "codex"}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:01Z", "payload": {"type": "task_started", "turn_id": "turn-a"}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:02Z", "payload": {"type": "message", "id": "m1", "role": "user", "content": [{"type": "input_text", "text": "Inspect app.py"}]}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:02Z", "payload": {"type": "user_message", "message": "Inspect app.py", "turn_id": "turn-a"}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:03Z", "payload": {"type": "reasoning", "id": "r1", "summary": [{"text": "Read before editing."}]}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:03Z", "payload": {"type": "agent_reasoning", "text": "Read before editing.", "turn_id": "turn-a"}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:04Z", "payload": {"type": "function_call", "id": "tool-1", "call_id": "cmd-1", "name": "shell", "arguments": json.dumps({"command": "cat /tmp/demo/app.py"})}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:04Z", "payload": {"type": "exec_command_begin", "call_id": "cmd-1", "command": "cat /tmp/demo/app.py", "turn_id": "turn-a"}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:04.500Z", "payload": {"type": "exec_command_output_delta", "call_id": "cmd-1", "delta": "print('old')", "turn_id": "turn-a"}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:05Z", "payload": {"type": "exec_command_end", "call_id": "cmd-1", "stdout": "print('old')", "exit_code": 0, "status": "completed", "turn_id": "turn-a"}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:05.100Z", "payload": {"type": "exec_approval_request", "request_id": "approval-1", "call_id": "cmd-1", "reason": "sandbox", "turn_id": "turn-a"}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:06Z", "payload": {"type": "function_call", "call_id": "patch-1", "name": "apply_patch", "input": "*** Begin Patch\n*** Update File: /tmp/demo/app.py\n*** End Patch"}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:06.100Z", "payload": {"type": "patch_apply_begin", "call_id": "patch-1", "turn_id": "turn-a"}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:07Z", "payload": {"type": "patch_apply_end", "call_id": "patch-1", "changes": {"/tmp/demo/app.py": {"kind": "update"}}, "success": True, "turn_id": "turn-a"}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:07Z", "payload": {"type": "function_call_output", "call_id": "patch-1", "output": "Done!"}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:08Z", "payload": {"type": "function_call", "call_id": "test-1", "name": "shell", "arguments": "{\"command\":\"pytest -q /tmp/demo/test_app.py\"}"}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:09Z", "payload": {"type": "function_call_output", "call_id": "test-1", "output": "FAILED", "exit_code": 1}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:10Z", "payload": {"type": "function_call", "call_id": "test-2", "name": "shell", "arguments": "{\"command\":\"pytest -q /tmp/demo/test_app.py\"}"}},
        {"type": "response_item", "timestamp": "2026-08-08T00:00:11Z", "payload": {"type": "function_call_output", "call_id": "test-2", "output": "1 passed", "exit_code": 0}},
        {"type": "event_msg", "timestamp": "2026-08-08T00:00:12Z", "payload": {"type": "agent_message", "message": "Patched and tested.", "turn_id": "turn-a"}},
        {"type": "future_rollout", "timestamp": "2026-08-08T00:00:13Z", "payload": {"type": "future_event", "value": 1}},
    ]


def conversation_turn_records() -> list[dict]:
    return [
        {"type": "session_meta", "payload": {"id": "conversation-turns"}},
        {"type": "response_item", "payload": {"type": "message", "id": "context", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"}]}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "source-a"}},
        {"type": "response_item", "payload": {"type": "message", "id": "m1", "role": "user", "content": [{"type": "input_text", "text": "Build it"}]}},
        {"type": "event_msg", "payload": {"type": "user_message", "turn_id": "source-a", "message": "Build it"}},
        {"type": "event_msg", "payload": {"type": "agent_message", "turn_id": "source-a", "message": "Working"}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "source-b"}},
        {"type": "event_msg", "payload": {"type": "request_user_input", "turn_id": "source-b", "request_id": "question-1", "questions": [{"question": "Choose", "options": ["A", "B"]}]}},
        {"type": "response_item", "payload": {"type": "message", "id": "m2", "role": "user", "content": [{"type": "input_text", "text": "A"}]}},
        {"type": "event_msg", "payload": {"type": "user_message", "turn_id": "source-b", "message": "A"}},
        {"type": "event_msg", "payload": {"type": "agent_message", "turn_id": "source-b", "message": "Continuing"}},
        {"type": "response_item", "payload": {"type": "message", "id": "m3", "role": "user", "content": [{"type": "input_text", "text": "Next task"}]}},
        {"type": "event_msg", "payload": {"type": "user_message", "turn_id": "source-b", "message": "Next task"}},
        {"type": "event_msg", "payload": {"type": "agent_message", "turn_id": "source-b", "message": "Done"}},
        {"type": "response_item", "payload": {"type": "message", "id": "m4", "role": "user", "content": [{"type": "input_text", "text": "Next task"}]}},
        {"type": "event_msg", "payload": {"type": "user_message", "turn_id": "source-b", "message": "Next task"}},
    ]


def test_stream_parser_handles_concatenated_objects() -> None:
    assert list(iter_json_objects(io.StringIO('{"a":1}{"b":2}\n'))) == [{"a": 1}, {"b": 2}]


def test_registry_covers_required_protocol_layers() -> None:
    assert len(KNOWN_ROLLOUT_TYPES) == 8
    assert len(KNOWN_RESPONSE_TYPES) >= 17
    assert len(KNOWN_EVENT_TYPES) >= 81
    assert {"exec_command_begin", "request_user_input", "collab_agent_spawn_end", "hook_completed"} <= KNOWN_EVENT_TYPES


def test_parser_preserves_raw_and_aggregates_lifecycle() -> None:
    records = sample_records()
    session = parse_codex_records(records)
    assert len(session.raw_records) == len(records)
    assert [item.record for item in session.raw_records] == records
    assert len([item for item in session.interactions if item.kind == NodeKind.MESSAGE and item.role == "user"]) == 1
    assert len([item for item in session.interactions if item.kind == NodeKind.REASONING]) == 1
    command = next(item for item in session.interactions if item.call_id == "cmd-1" and item.kind == NodeKind.COMMAND)
    assert command.lifecycle == LifecycleState.COMPLETED
    assert command.status == "success"
    assert len(command.raw_record_ids) == 4
    assert command.result["exit_code"] == 0
    approval = next(item for item in session.interactions if item.kind == NodeKind.APPROVAL)
    assert approval.call_id == "cmd-1"
    assert approval.interaction_id != command.interaction_id
    assert any(item.kind == NodeKind.FILE_CHANGE and item.call_id == "patch-1" for item in session.interactions)
    assert any(item.kind == NodeKind.EVENT_UNKNOWN for item in session.interactions)


def test_unmatched_tool_output_remains_a_separate_result() -> None:
    session = parse_codex_records([
        {
            "type": "response_item",
            "timestamp": "2026-08-08T00:00:00Z",
            "payload": {"type": "function_call_output", "call_id": "missing", "output": "orphan"},
        }
    ])
    assert len(session.interactions) == 1
    assert session.interactions[0].kind == NodeKind.TOOL_RESULT


def test_graph_builds_artifacts_failures_retry_and_control_edges() -> None:
    graph = build_execution_graph(parse_codex_records(sample_records()))
    assert any(node.kind == NodeKind.ARTIFACT and node.label == "/tmp/demo/app.py" for node in graph.nodes)
    assert any(node.kind == NodeKind.ERROR for node in graph.nodes)
    assert any(edge.kind == EdgeKind.RETRIES and edge.confidence < 1 for edge in graph.edges)
    assert any(edge.kind == EdgeKind.REQUESTS_APPROVAL for edge in graph.edges)
    assert any(edge.kind == EdgeKind.PATCHES for edge in graph.edges)
    assert graph.metrics["raw_record_count"] == len(sample_records())
    assert graph.metrics["errors"] >= 1


def test_2d_payload_keeps_parser_order_and_family_catalog() -> None:
    graph = build_execution_graph(parse_codex_records(sample_records()))
    payload = build_2d_payload(graph)
    steps = [step for turn in payload["turns"] for step in turn["steps"]]
    assert [step["interaction_index"] for step in steps] == sorted(step["interaction_index"] for step in steps)
    assert [step["step_number"] for step in payload["turns"][0]["steps"]] == list(
        range(1, len(payload["turns"][0]["steps"]) + 1)
    )
    assert all(step["node_id"].startswith("interaction:") for step in steps)
    assert not any(step["kind"] == "artifact" for step in steps)
    assert [entry["id"] for entry in payload["families"]] == [family.value for family in InteractionFamily]
    assert all(re.fullmatch(r"#[0-9a-f]{6}", entry["color"]) for entry in payload["families"])


def test_turn_summary_is_capped_and_reports_its_full_length() -> None:
    long_message = "Analyse this trace.\n" + "x" * (TURN_SUMMARY_CHARS + 500)
    records = [
        {"type": "session_meta", "payload": {"id": "summary-cap"}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
        {"type": "event_msg", "payload": {"type": "user_message", "turn_id": "t1", "message": long_message}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t2"}},
        {"type": "event_msg", "payload": {"type": "user_message", "turn_id": "t2", "message": "Short one"}},
    ]
    turns = build_2d_payload(build_execution_graph(parse_codex_records(records)))["turns"]
    by_summary = {turn["summary"][:9]: turn for turn in turns}

    long_turn = by_summary["Analyse t"]
    assert len(long_turn["summary"]) == TURN_SUMMARY_CHARS
    assert long_turn["summary_truncated"] is True
    assert long_turn["summary_length"] == len(long_message)

    short_turn = by_summary["Short one"]
    assert short_turn["summary"] == "Short one"
    assert short_turn["summary_truncated"] is False
    assert short_turn["summary_length"] == len("Short one")


def test_turn_without_a_user_message_reports_an_empty_summary() -> None:
    records = [
        {"type": "session_meta", "payload": {"id": "no-user-message"}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
        {"type": "event_msg", "payload": {"type": "agent_message", "turn_id": "t1", "message": "Working"}},
    ]
    turn = build_2d_payload(build_execution_graph(parse_codex_records(records)))["turns"][0]

    assert turn["summary"] == ""
    assert turn["summary_length"] == 0
    assert turn["summary_truncated"] is False


def test_conversation_turns_start_at_direct_user_messages_and_keep_initialization_separate() -> None:
    session = parse_codex_records(conversation_turn_records())
    messages = [item for item in session.interactions if item.kind == NodeKind.MESSAGE and item.role == "user"]

    assert [item.detail for item in messages] == [
        "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>",
        "Build it",
        "A",
        "Next task",
        "Next task",
    ]
    assert [item.conversation_turn_number for item in messages] == [0, 1, 1, 2, 3]
    assert messages[2].metadata["conversation_message_classification"] == "control_response"
    assert messages[3].turn_id == messages[2].turn_id == "source-b"

    graph = build_execution_graph(session)
    payload = build_2d_payload(graph)
    assert [turn["conversation_turn_kind"] for turn in payload["turns"]] == [
        "initialization", "user_message", "user_message", "user_message",
    ]
    assert payload["turns"][0]["conversation_turn_number"] == 0
    assert graph.metrics["turn_count"] == 3
    assert graph.metrics["source_turn_count"] == 3


def test_every_static_asset_shares_one_cache_bust_version() -> None:
    """A stylesheet left unversioned ships new markup against cached CSS.

    The dev server sends no Cache-Control, so the ?v= query is the only thing
    forcing a refetch — and it has to cover .css links, not just ES modules.
    """
    sources = [*Path("templates").glob("*.html"), *Path("visualization/static/visualization").glob("*.js")]
    versions = {
        version
        for path in sources
        for version in re.findall(r"\.(?:js|css)['\"]?\s*(?:%\})?\?v=(\d+)", path.read_text(encoding="utf-8"))
    }
    assert len(versions) == 1, f"cache-bust versions drifted apart: {sorted(versions)}"

    stylesheets = re.findall(
        r"<link[^>]+stylesheet[^>]*>",
        "".join(path.read_text(encoding="utf-8") for path in Path("templates").glob("*.html")),
    )
    assert stylesheets, "no stylesheet links found"
    assert all("?v=" in link for link in stylesheets), f"unversioned stylesheet: {stylesheets}"


def test_observatory_exposes_only_native_2d_views() -> None:
    template = Path("templates/execution_observatory.html").read_text(encoding="utf-8")
    javascript = "".join(
        path.read_text(encoding="utf-8")
        for path in sorted(Path("visualization/static/visualization").glob("*.js"))
    )
    assert "Turn Lanes" in template
    assert "Activity Matrix" in template
    assert "data-node-id" in javascript
    assert "conversation_turn_id" in javascript
    assert 'gettext("Session initialization")' in javascript
    forbidden = ("Plotly", "scatter3d", "Surface", "WebGL", "requestAnimationFrame")
    assert all(token not in template + javascript for token in forbidden)


def test_repository_accepts_only_v4_and_rejects_traversal(tmp_path: Path) -> None:
    repository = SessionRepository(tmp_path)
    session = parse_codex_records(sample_records())
    output = repository.save_v4(session, "demo.v4.json")
    assert output.name == "demo.v4.json"
    assert repository.load(output.name).session_id == session.session_id
    detail = repository.interaction_detail(output.name, session.interactions[0].interaction_id)
    assert detail["schema_version"] == 4
    with pytest.raises(ValueError):
        repository.resolve("../demo.v4.json")
