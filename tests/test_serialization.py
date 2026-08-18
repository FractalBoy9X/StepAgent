from __future__ import annotations

import json

import pytest

from visualization.adapters import parse_codex_records, parse_v4_json
from visualization.domain import NodeKind


def test_v4_round_trip_preserves_raw_and_interaction_fields() -> None:
    records = [
        {"type": "session_meta", "payload": {"id": "round-trip"}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
        {"type": "response_item", "payload": {"type": "function_call", "name": "shell", "call_id": "abc", "arguments": '{"command":"cat ./a.py"}'}},
        {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "abc", "output": "ok"}},
    ]
    original = parse_codex_records(records)
    restored = parse_v4_json(json.loads(json.dumps(original.to_dict())))
    assert [item.record for item in restored.raw_records] == records
    call = next(item for item in restored.interactions if item.call_id == "abc")
    assert call.kind == NodeKind.TOOL_CALL
    assert call.result["output"] == "ok"
    assert len(call.raw_record_ids) == 2


def test_existing_v4_without_conversation_fields_is_derived_in_memory() -> None:
    records = [
        {"type": "session_meta", "payload": {"id": "old-v4"}},
        {"type": "response_item", "payload": {"type": "message", "id": "m1", "role": "user", "content": [{"type": "input_text", "text": "First"}]}},
        {"type": "event_msg", "payload": {"type": "user_message", "message": "First"}},
        {"type": "response_item", "payload": {"type": "message", "id": "m2", "role": "user", "content": [{"type": "input_text", "text": "Second"}]}},
        {"type": "event_msg", "payload": {"type": "user_message", "message": "Second"}},
    ]
    old_v4 = parse_codex_records(records).to_dict()
    for interaction in old_v4["interactions"]:
        interaction.pop("conversation_turn_id")
        interaction.pop("conversation_turn_number")
        interaction.pop("conversation_turn_kind")

    restored = parse_v4_json(old_v4)
    user_messages = [item for item in restored.interactions if item.kind == NodeKind.MESSAGE and item.role == "user"]
    assert [item.conversation_turn_number for item in user_messages] == [1, 2]
    assert restored.to_dict()["schema_version"] == 4


def test_v3_is_explicitly_rejected() -> None:
    with pytest.raises(ValueError, match="schema v4 is required"):
        parse_v4_json({"schema_version": 3, "events": []})
