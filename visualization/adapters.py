from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, TextIO

from .domain import (
    ConversationTurnKind,
    JSONDict,
    SCHEMA_VERSION,
    Interaction,
    InteractionFamily,
    LifecycleState,
    NodeKind,
    RawRecord,
    SessionDocument,
)
from .conversation_turns import assign_conversation_turns

_MAX_BUFFER = 50_000_000


def _iso_to_epoch_ms(value: Any) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        numeric = float(value)
        return int(numeric * 1000.0 if abs(numeric) < 100_000_000_000 else numeric)
    if not isinstance(value, str) or not value:
        return None
    try:
        raw = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def _camel_to_snake(value: str) -> str:
    value = value.replace("-", "_").replace("/", "_")
    value = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", value)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value).lower()


def iter_json_objects(stream: TextIO) -> Iterator[JSONDict]:
    """Read JSONL, NDJSON, or concatenated objects without loading a huge buffer."""
    decoder = json.JSONDecoder()
    buffer = ""
    for line in stream:
        buffer += line
        cursor = 0
        while True:
            while cursor < len(buffer) and buffer[cursor].isspace():
                cursor += 1
            if cursor >= len(buffer):
                buffer = ""
                break
            try:
                value, end = decoder.raw_decode(buffer, cursor)
            except json.JSONDecodeError:
                buffer = buffer[cursor:]
                break
            if isinstance(value, dict):
                yield value
            cursor = end
        if len(buffer) > _MAX_BUFFER:
            raise ValueError("JSON input buffer exceeded 50 MB; the source is likely malformed.")


def _compact(value: Any, limit: int = 240) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, default=str)
    value = re.sub(r"\s+", " ", value).strip()
    return value if len(value) <= limit else value[: limit - 1] + "..."


def _text_from_content(content: Any) -> tuple[str, list[str]]:
    if isinstance(content, str):
        return content.strip(), ["text"]
    if not isinstance(content, list):
        return "", []
    text: list[str] = []
    types: list[str] = []
    for item in content:
        if isinstance(item, str):
            text.append(item)
            types.append("text")
            continue
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type") or "content")
        types.append(item_type)
        for key in ("text", "input_text", "output_text", "message", "transcript"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                text.append(value.strip())
                break
    return "\n".join(text).strip(), types


def _reasoning_text(payload: JSONDict) -> str:
    for key in ("summary_text", "text", "raw_content"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    summary = payload.get("summary")
    if isinstance(summary, str):
        return summary.strip()
    if isinstance(summary, list):
        return "\n".join(
            str(item.get("text", "")).strip()
            for item in summary
            if isinstance(item, dict) and str(item.get("text", "")).strip()
        )
    return ""


def _parse_jsonish(value: Any) -> tuple[str, JSONDict]:
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False), value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return value, parsed if isinstance(parsed, dict) else {"value": parsed}
        except (json.JSONDecodeError, TypeError):
            return value, {"raw": value}
    return json.dumps(value, ensure_ascii=False, default=str), {"value": value}


@dataclass(frozen=True, slots=True)
class InteractionSpec:
    family: InteractionFamily
    kind: NodeKind
    lifecycle: LifecycleState = LifecycleState.COMPLETED
    subkind: str = ""


def _spec(family: InteractionFamily, kind: NodeKind, lifecycle: LifecycleState, subkind: str) -> InteractionSpec:
    return InteractionSpec(family, kind, lifecycle, subkind)


_EVENT_GROUPS: list[tuple[set[str], InteractionFamily, NodeKind]] = [
    ({"error", "stream_error"}, InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.ERROR),
    ({"warning", "guardian_warning", "deprecation_notice"}, InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.WARNING),
    ({"realtime_conversation_started", "realtime_conversation_realtime", "realtime_conversation_closed", "realtime_conversation_sdp", "realtime_conversation_list_voices_response"}, InteractionFamily.MEDIA, NodeKind.MEDIA_STREAM),
    ({"model_reroute", "model_verification"}, InteractionFamily.SAFETY_SECURITY, NodeKind.MODEL_EVENT),
    ({"turn_moderation_metadata", "safety_buffering", "guardian_assessment"}, InteractionFamily.SAFETY_SECURITY, NodeKind.SAFETY),
    ({"context_compacted", "thread_rolled_back"}, InteractionFamily.CONTEXT_STATE, NodeKind.COMPACTION),
    ({"turn_started", "task_started", "turn_complete", "task_complete", "turn_aborted", "shutdown_complete", "item_started", "item_completed", "raw_response_completed"}, InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.LIFECYCLE),
    ({"agent_message", "user_message", "agent_message_content_delta"}, InteractionFamily.COMMUNICATION, NodeKind.MESSAGE),
    ({"agent_reasoning", "agent_reasoning_raw_content", "agent_reasoning_section_break", "reasoning_content_delta", "reasoning_raw_content_delta"}, InteractionFamily.COGNITION, NodeKind.REASONING),
    ({"session_configured", "environment_connected", "environment_disconnected", "thread_settings_applied", "thread_goal_updated", "thread_queue_changed", "thread_name_updated"}, InteractionFamily.CONTEXT_STATE, NodeKind.ENVIRONMENT),
    ({"mcp_startup_update", "mcp_startup_complete"}, InteractionFamily.MCP, NodeKind.MCP_SERVER),
    ({"mcp_tool_call_begin", "mcp_tool_call_end"}, InteractionFamily.MCP, NodeKind.MCP_CALL),
    ({"web_search_begin", "web_search_end"}, InteractionFamily.WEB, NodeKind.WEB_ACTION),
    ({"image_generation_begin", "image_generation_end"}, InteractionFamily.MEDIA, NodeKind.IMAGE_GENERATION),
    ({"exec_command_begin", "exec_command_output_delta", "terminal_interaction", "exec_command_end"}, InteractionFamily.EXECUTION, NodeKind.COMMAND),
    ({"view_image_tool_call"}, InteractionFamily.MEDIA, NodeKind.IMAGE_VIEW),
    ({"exec_approval_request", "apply_patch_approval_request"}, InteractionFamily.HUMAN_CONTROL, NodeKind.APPROVAL),
    ({"request_permissions"}, InteractionFamily.HUMAN_CONTROL, NodeKind.PERMISSION_REQUEST),
    ({"request_user_input", "elicitation_request"}, InteractionFamily.HUMAN_CONTROL, NodeKind.USER_INPUT_REQUEST),
    ({"dynamic_tool_call_request", "dynamic_tool_call_response"}, InteractionFamily.TOOLING, NodeKind.TOOL_CALL),
    ({"patch_apply_begin", "patch_apply_updated", "patch_apply_end", "turn_diff"}, InteractionFamily.FILESYSTEM, NodeKind.FILE_CHANGE),
    ({"plan_update", "plan_delta"}, InteractionFamily.PLANNING, NodeKind.PLAN),
    ({"entered_review_mode", "exited_review_mode"}, InteractionFamily.CONTEXT_STATE, NodeKind.REVIEW),
    ({"raw_response_item"}, InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.LIFECYCLE),
    ({"hook_started", "hook_completed"}, InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.HOOK),
    ({"collab_agent_spawn_begin", "collab_agent_spawn_end", "collab_agent_interaction_begin", "collab_agent_interaction_end", "collab_waiting_begin", "collab_waiting_end", "collab_close_begin", "collab_close_end", "collab_resume_begin", "collab_resume_end", "sub_agent_activity"}, InteractionFamily.MULTI_AGENT, NodeKind.TOOL_CALL),
    ({"token_count"}, InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.USAGE),
]

KNOWN_EVENT_TYPES = frozenset(value for values, _, _ in _EVENT_GROUPS for value in values)

KNOWN_RESPONSE_TYPES = frozenset({
    "additional_tools", "message", "agent_message", "reasoning", "local_shell_call", "function_call",
    "tool_search_call", "function_call_output", "custom_tool_call", "custom_tool_call_output",
    "tool_search_output", "web_search_call", "image_generation_call", "compaction",
    "compaction_trigger", "context_compaction", "other", "ghost_snapshot",
})

KNOWN_ROLLOUT_TYPES = frozenset({
    "session_meta", "response_item", "inter_agent_communication",
    "inter_agent_communication_metadata", "compacted", "turn_context", "world_state", "event_msg",
})


def _lifecycle_from_name(name: str, payload: JSONDict) -> LifecycleState:
    status = str(payload.get("status") or "").lower()
    if status in {"failed", "error"}:
        return LifecycleState.FAILED
    if status in {"cancelled", "canceled"}:
        return LifecycleState.CANCELLED
    if status == "aborted" or name.endswith("aborted"):
        return LifecycleState.ABORTED
    if name.endswith(("_begin", "_started")) or name in {"turn_started", "task_started", "item_started", "hook_started"}:
        return LifecycleState.STARTED
    if name.endswith("_delta") or name.endswith("_updated") or name.endswith("_realtime"):
        return LifecycleState.STREAMING
    if name in {"request_user_input", "request_permissions", "exec_approval_request", "apply_patch_approval_request", "elicitation_request", "collab_waiting_begin"}:
        return LifecycleState.WAITING
    if name.endswith(("_end", "_complete", "_completed", "_closed")):
        return LifecycleState.COMPLETED
    return LifecycleState.COMPLETED


def _event_spec(name: str, payload: JSONDict) -> InteractionSpec:
    for values, family, kind in _EVENT_GROUPS:
        if name in values:
            return _spec(family, kind, _lifecycle_from_name(name, payload), name)
    return _spec(InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.EVENT_UNKNOWN, LifecycleState.UNKNOWN, name or "unknown")


def _response_spec(name: str, payload: JSONDict) -> InteractionSpec:
    lifecycle = _lifecycle_from_name(name, payload)
    mapping: dict[str, tuple[InteractionFamily, NodeKind, LifecycleState]] = {
        "additional_tools": (InteractionFamily.TOOLING, NodeKind.TOOL_SEARCH, LifecycleState.COMPLETED),
        "message": (InteractionFamily.COMMUNICATION, NodeKind.MESSAGE, LifecycleState.COMPLETED),
        "agent_message": (InteractionFamily.COMMUNICATION, NodeKind.MESSAGE, LifecycleState.COMPLETED),
        "reasoning": (InteractionFamily.COGNITION, NodeKind.REASONING, LifecycleState.COMPLETED),
        "local_shell_call": (InteractionFamily.EXECUTION, NodeKind.COMMAND, lifecycle),
        "function_call": (InteractionFamily.TOOLING, NodeKind.TOOL_CALL, LifecycleState.STARTED),
        "custom_tool_call": (InteractionFamily.TOOLING, NodeKind.TOOL_CALL, LifecycleState.STARTED),
        "function_call_output": (InteractionFamily.TOOLING, NodeKind.TOOL_CALL, LifecycleState.COMPLETED),
        "custom_tool_call_output": (InteractionFamily.TOOLING, NodeKind.TOOL_CALL, LifecycleState.COMPLETED),
        "tool_search_call": (InteractionFamily.TOOLING, NodeKind.TOOL_SEARCH, LifecycleState.STARTED),
        "tool_search_output": (InteractionFamily.TOOLING, NodeKind.TOOL_SEARCH, LifecycleState.COMPLETED),
        "web_search_call": (InteractionFamily.WEB, NodeKind.WEB_ACTION, lifecycle),
        "image_generation_call": (InteractionFamily.MEDIA, NodeKind.IMAGE_GENERATION, lifecycle),
        "compaction": (InteractionFamily.CONTEXT_STATE, NodeKind.COMPACTION, LifecycleState.COMPLETED),
        "compaction_trigger": (InteractionFamily.CONTEXT_STATE, NodeKind.COMPACTION, LifecycleState.STARTED),
        "context_compaction": (InteractionFamily.CONTEXT_STATE, NodeKind.COMPACTION, lifecycle),
        "ghost_snapshot": (InteractionFamily.CONTEXT_STATE, NodeKind.WORLD_STATE, LifecycleState.COMPLETED),
    }
    family, kind, state = mapping.get(name, (InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.EVENT_UNKNOWN, LifecycleState.UNKNOWN))
    return _spec(family, kind, state, name or "other")


def _nested_item_spec(payload: JSONDict) -> InteractionSpec | None:
    item = payload.get("item")
    if not isinstance(item, dict):
        return None
    name = _camel_to_snake(str(item.get("type") or ""))
    mapping = {
        "agent_message": (InteractionFamily.COMMUNICATION, NodeKind.MESSAGE),
        "user_message": (InteractionFamily.COMMUNICATION, NodeKind.MESSAGE),
        "reasoning": (InteractionFamily.COGNITION, NodeKind.REASONING),
        "command_execution": (InteractionFamily.EXECUTION, NodeKind.COMMAND),
        "file_change": (InteractionFamily.FILESYSTEM, NodeKind.FILE_CHANGE),
        "mcp_tool_call": (InteractionFamily.MCP, NodeKind.MCP_CALL),
        "web_search": (InteractionFamily.WEB, NodeKind.WEB_ACTION),
        "image_generation": (InteractionFamily.MEDIA, NodeKind.IMAGE_GENERATION),
        "collab_tool_call": (InteractionFamily.MULTI_AGENT, NodeKind.TOOL_CALL),
        "plan": (InteractionFamily.PLANNING, NodeKind.PLAN),
        "entered_review_mode": (InteractionFamily.CONTEXT_STATE, NodeKind.REVIEW),
        "exited_review_mode": (InteractionFamily.CONTEXT_STATE, NodeKind.REVIEW),
        "extension": (InteractionFamily.TOOLING, NodeKind.TOOL_CALL),
    }
    family, kind = mapping.get(name, (InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.EVENT_UNKNOWN))
    return _spec(family, kind, _lifecycle_from_name(str(payload.get("type") or ""), payload), name or "item")


def _raw_record(index: int, record: JSONDict) -> RawRecord:
    raw_type = _camel_to_snake(str(record.get("type") or ""))
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    subtype = _camel_to_snake(str(payload.get("type") or ""))
    digest = hashlib.sha1(json.dumps(record, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:12]
    ordinal = record.get("ordinal")
    return RawRecord(
        raw_id=f"raw:{index}:{digest}", index=index,
        ordinal=int(ordinal) if isinstance(ordinal, int) else None,
        timestamp=str(record.get("timestamp") or payload.get("timestamp") or ""),
        rollout_type=raw_type,
        response_item_type=subtype if raw_type == "response_item" else "",
        event_type=subtype if raw_type == "event_msg" else "",
        record=record,
    )


def _record_spec(raw: RawRecord, payload: JSONDict) -> InteractionSpec:
    raw_type = raw.rollout_type
    subtype = raw.response_item_type or raw.event_type
    if raw_type == "response_item":
        return _response_spec(subtype, payload)
    if raw_type == "event_msg":
        nested = _nested_item_spec(payload) if subtype in {"item_started", "item_completed"} else None
        return nested or _event_spec(subtype, payload)
    if raw_type == "inter_agent_communication":
        return _spec(InteractionFamily.MULTI_AGENT, NodeKind.MESSAGE, LifecycleState.COMPLETED, raw_type)
    if raw_type == "inter_agent_communication_metadata":
        return _spec(InteractionFamily.MULTI_AGENT, NodeKind.LIFECYCLE, LifecycleState.COMPLETED, raw_type)
    if raw_type == "compacted":
        return _spec(InteractionFamily.CONTEXT_STATE, NodeKind.COMPACTION, LifecycleState.COMPLETED, raw_type)
    if raw_type == "turn_context":
        return _spec(InteractionFamily.CONTEXT_STATE, NodeKind.ENVIRONMENT, LifecycleState.COMPLETED, raw_type)
    if raw_type == "world_state":
        return _spec(InteractionFamily.CONTEXT_STATE, NodeKind.WORLD_STATE, LifecycleState.COMPLETED, raw_type)
    if raw_type == "session_meta":
        return _spec(InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.LIFECYCLE, LifecycleState.COMPLETED, raw_type)
    return _spec(InteractionFamily.LIFECYCLE_OBSERVABILITY, NodeKind.EVENT_UNKNOWN, LifecycleState.UNKNOWN, raw_type or "unknown")


def _payload_text(payload: JSONDict, spec: InteractionSpec) -> tuple[str, JSONDict]:
    source = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    assert isinstance(source, dict)
    metadata: JSONDict = {}
    if spec.kind == NodeKind.MESSAGE:
        text, types = _text_from_content(source.get("content"))
        text = text or str(source.get("message") or "")
        metadata["content_types"] = types
        return text, metadata
    if spec.kind == NodeKind.REASONING:
        return _reasoning_text(source), metadata
    if spec.kind in {NodeKind.TOOL_CALL, NodeKind.TOOL_SEARCH, NodeKind.COMMAND, NodeKind.MCP_CALL, NodeKind.WEB_ACTION}:
        value = source.get("input", source.get("arguments", source.get("command", source.get("query", source.get("action", "")))))
        raw, parsed = _parse_jsonish(value)
        metadata["arguments"] = parsed
        return raw, metadata
    if spec.kind == NodeKind.PLAN:
        value = source.get("plan", source.get("steps", source.get("delta", source.get("message", source))))
        if isinstance(value, list):
            metadata["steps"] = value
        return _compact(value, 2000), metadata
    if spec.kind == NodeKind.FILE_CHANGE:
        value = source.get("changes", source.get("patch", source.get("diff", source.get("stdout", source))))
        return _compact(value, 4000), metadata
    for key in ("message", "text", "formatted_output", "aggregated_output", "stdout", "query", "reason", "summary"):
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip(), metadata
    return _compact(source, 2000), metadata


def _result_from_payload(payload: JSONDict, spec: InteractionSpec) -> JSONDict:
    source = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    if not isinstance(source, dict):
        return {}
    result: JSONDict = {}
    for key in ("output", "aggregated_output", "formatted_output", "stdout", "stderr", "exit_code", "duration", "status", "success", "error", "results", "response"):
        if key in source:
            result[key] = source[key]
    if spec.subkind.endswith(("_output", "_end", "_complete", "_completed")) and not result:
        result["value"] = source
    return result


def _status(payload: JSONDict, result: JSONDict, lifecycle: LifecycleState) -> str:
    source = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    source = source if isinstance(source, dict) else payload
    value = str(source.get("status") or result.get("status") or "").lower()
    if value in {"failed", "failure", "error"} or lifecycle == LifecycleState.FAILED:
        return "error"
    if value in {"cancelled", "canceled"} or lifecycle == LifecycleState.CANCELLED:
        return "cancelled"
    exit_code = source.get("exit_code", result.get("exit_code"))
    if isinstance(exit_code, int):
        return "success" if exit_code == 0 else "error"
    success = source.get("success")
    if isinstance(success, bool):
        return "success" if success else "error"
    output_text = " ".join(str(result.get(key) or "") for key in ("output", "aggregated_output", "stderr", "error")).lower()
    if any(token in output_text for token in ("traceback", "fatal:", "error:", "failed", "permission denied")):
        return "error"
    if lifecycle == LifecycleState.COMPLETED:
        return "success"
    if lifecycle in {LifecycleState.WAITING, LifecycleState.BLOCKED}:
        return "blocked"
    return "unknown"


def _correlation_key(payload: JSONDict, spec: InteractionSpec, turn_id: str, detail: str, raw: RawRecord) -> str:
    source = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    source = source if isinstance(source, dict) else payload
    item_id = str(source.get("id") or payload.get("item_id") or "")
    call_id = str(source.get("call_id") or payload.get("call_id") or "")
    process_id = str(source.get("process_id") or payload.get("process_id") or "")
    if spec.kind in {NodeKind.APPROVAL, NodeKind.PERMISSION_REQUEST, NodeKind.USER_INPUT_REQUEST}:
        request_id = str(source.get("request_id") or payload.get("request_id") or raw.raw_id)
        return f"control:{spec.kind.value}:{request_id}"
    if spec.kind == NodeKind.FILE_CHANGE and call_id:
        return f"file_change:{call_id}"
    if spec.kind in {NodeKind.USAGE, NodeKind.LIFECYCLE, NodeKind.ENVIRONMENT} and not item_id:
        return raw.raw_id
    if item_id:
        return f"item:{item_id}"
    if call_id:
        return f"call:{call_id}"
    if process_id and spec.kind == NodeKind.COMMAND:
        return f"process:{process_id}"
    if spec.kind in {NodeKind.MESSAGE, NodeKind.REASONING} and detail:
        digest = hashlib.sha1(_compact(detail, 800).encode()).hexdigest()[:14]
        return f"mirror:{turn_id}:{spec.kind.value}:{digest}"
    return raw.raw_id


def _promote(existing: Interaction, spec: InteractionSpec) -> None:
    generic = {NodeKind.TOOL_CALL, NodeKind.LIFECYCLE, NodeKind.EVENT_UNKNOWN}
    if existing.kind in generic and spec.kind not in generic:
        existing.kind = spec.kind
        existing.family = spec.family
    if spec.lifecycle in {LifecycleState.COMPLETED, LifecycleState.FAILED, LifecycleState.CANCELLED, LifecycleState.ABORTED}:
        existing.lifecycle = spec.lifecycle
    elif existing.lifecycle in {LifecycleState.UNKNOWN, LifecycleState.PENDING}:
        existing.lifecycle = spec.lifecycle


def parse_codex_records(records: Iterable[JSONDict], source_name: str = "session.jsonl") -> SessionDocument:
    source_records = list(records)
    raw_records = [_raw_record(index, record) for index, record in enumerate(source_records)]
    meta: JSONDict = {}
    interactions: list[Interaction] = []
    by_key: dict[str, Interaction] = {}
    mirror_candidates: dict[str, tuple[Interaction, int, str]] = {}
    turn_numbers: dict[str, int] = {}
    turn_number = 0
    turn_id = "turn-1"
    latest_context: JSONDict = {}

    for raw in raw_records:
        record = raw.record
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else record
        assert isinstance(payload, dict)
        subtype = raw.response_item_type or raw.event_type

        if raw.rollout_type == "session_meta":
            meta.update(payload)

        candidate_turn = str(payload.get("turn_id") or "")
        if raw.rollout_type == "event_msg" and subtype in {"task_started", "turn_started"}:
            candidate_turn = candidate_turn or f"turn-{turn_number + 1}"
            if candidate_turn not in turn_numbers:
                turn_number += 1
                turn_numbers[candidate_turn] = turn_number
            turn_id = candidate_turn
        elif candidate_turn:
            if candidate_turn not in turn_numbers:
                turn_number += 1
                turn_numbers[candidate_turn] = turn_number
            turn_id = candidate_turn
        elif turn_number == 0:
            turn_number = 1
            turn_numbers[turn_id] = turn_number

        if raw.rollout_type == "turn_context":
            latest_context = payload

        spec = _record_spec(raw, payload)
        detail, extracted_meta = _payload_text(payload, spec)
        key = _correlation_key(payload, spec, turn_id, detail, raw)
        source = payload.get("item") if isinstance(payload.get("item"), dict) else payload
        assert isinstance(source, dict)
        call_id = str(source.get("call_id") or payload.get("call_id") or "")
        item_id = str(source.get("id") or payload.get("item_id") or "")
        timestamp = raw.timestamp
        timestamp_ms = _iso_to_epoch_ms(timestamp)
        started_value = payload.get("started_at_ms", payload.get("started_at", source.get("started_at")))
        completed_value = payload.get("completed_at_ms", payload.get("completed_at", source.get("completed_at")))
        started_ms = _iso_to_epoch_ms(started_value) or timestamp_ms
        completed_ms = _iso_to_epoch_ms(completed_value)
        result = _result_from_payload(payload, spec)
        inferred_role = "user" if subtype == "user_message" else "assistant" if subtype in {"agent_message", "agent_message_content_delta"} else ""
        role = str(source.get("role") or payload.get("role") or inferred_role or ("assistant" if spec.kind == NodeKind.REASONING else ""))
        actor_id = str(payload.get("agent_id") or payload.get("source_agent_id") or ("user" if role == "user" else "primary"))
        target_id = str(payload.get("target_agent_id") or payload.get("receiver_agent_id") or "")
        label_root = spec.subkind.replace("_", " ").title() or spec.kind.value.replace("_", " ").title()
        label = f"{label_root}: {_compact(detail, 150)}" if detail else label_root

        mirror_key = ""
        if spec.kind in {NodeKind.MESSAGE, NodeKind.REASONING} and detail:
            mirror_digest = hashlib.sha1(_compact(detail, 800).encode()).hexdigest()[:14]
            mirror_key = f"mirror:{turn_id}:{spec.kind.value}:{mirror_digest}"
        raw_type = f"{raw.rollout_type}:{subtype}"
        existing = by_key.get(key) if key != mirror_key else None
        if existing is None and mirror_key:
            candidate = mirror_candidates.get(mirror_key)
            if candidate:
                candidate_item, candidate_index, _ = candidate
                if raw.index - candidate_index == 1:
                    existing = candidate_item
        if existing is None:
            digest = hashlib.sha1(f"{key}|{raw.index}".encode()).hexdigest()[:12]
            existing = Interaction(
                interaction_id=f"interaction:{raw.index}:{digest}", index=len(interactions),
                turn_id=turn_id, turn_number=turn_numbers.get(turn_id, turn_number),
                family=spec.family, kind=spec.kind, subkind=spec.subkind,
                lifecycle=spec.lifecycle, status=_status(payload, result, spec.lifecycle),
                role=role, actor_id=actor_id, target_id=target_id,
                label=label, detail=detail, call_id=call_id, item_id=item_id,
                timestamp=timestamp, timestamp_ms=timestamp_ms,
                started_at=str(started_value or timestamp), started_at_ms=started_ms,
                completed_at=str(completed_value or ""), completed_at_ms=completed_ms,
                result=result,
                metadata={
                    **extracted_meta,
                    "tool_name": str(source.get("name") or payload.get("name") or ""),
                    "raw_types": [raw_type], "source_indices": [raw.index],
                },
                raw_record_ids=[raw.raw_id],
            )
            interactions.append(existing)
            if key != mirror_key:
                by_key[key] = existing
            if call_id and spec.kind not in {NodeKind.APPROVAL, NodeKind.PERMISSION_REQUEST, NodeKind.USER_INPUT_REQUEST, NodeKind.FILE_CHANGE}:
                by_key[f"call:{call_id}"] = existing
        else:
            _promote(existing, spec)
            existing.raw_record_ids.append(raw.raw_id)
            existing.metadata.setdefault("raw_types", []).append(raw_type)
            existing.metadata.setdefault("source_indices", []).append(raw.index)
            if detail and (not existing.detail or len(detail) > len(existing.detail)):
                existing.detail = detail
                existing.label = label
            if call_id:
                existing.call_id = call_id
            if item_id:
                existing.item_id = item_id
            if role and not existing.role:
                existing.role = role
            if result:
                existing.result.update(result)
            if started_ms is not None:
                existing.started_at_ms = min(value for value in (existing.started_at_ms, started_ms) if value is not None)
            if completed_ms is not None:
                existing.completed_at_ms = max(value for value in (existing.completed_at_ms, completed_ms) if value is not None)
                existing.completed_at = str(completed_value or timestamp)
            merged_status = _status(payload, existing.result, existing.lifecycle)
            if merged_status != "unknown":
                existing.status = merged_status
            existing.metadata.update({key: value for key, value in extracted_meta.items() if value})

        if mirror_key:
            mirror_candidates[mirror_key] = (existing, raw.index, raw_type)

        duration = source.get("duration", payload.get("duration_ms"))
        if isinstance(duration, (int, float)) and not isinstance(duration, bool):
            existing.duration_ms = float(duration) * (1000.0 if source.get("duration") is not None and duration < 10000 else 1.0)
        elif existing.started_at_ms is not None and existing.completed_at_ms is not None:
            existing.duration_ms = max(0.0, float(existing.completed_at_ms - existing.started_at_ms))
        if raw.rollout_type == "turn_context":
            existing.metadata["context"] = payload
        if spec.kind == NodeKind.WORLD_STATE:
            existing.metadata["full"] = bool(payload.get("full"))

    # A result normally joins its call through call_id. Keep a genuinely orphaned
    # output visible as a separate result instead of pretending it was a call.
    for interaction in interactions:
        if (
            interaction.kind == NodeKind.TOOL_CALL
            and interaction.subkind.endswith("_output")
            and len(interaction.raw_record_ids) == 1
        ):
            interaction.kind = NodeKind.TOOL_RESULT

    assign_conversation_turns(interactions, raw_records)

    session_id = str(meta.get("id") or meta.get("session_id") or Path(source_name).stem)
    generated_at = str(meta.get("timestamp") or (raw_records[-1].timestamp if raw_records else ""))
    model = latest_context.get("model") or meta.get("model") or "unknown"
    description = next((item.detail for item in interactions if item.kind == NodeKind.MESSAGE and item.role == "user"), "")
    unknown_types = sorted({
        f"{raw.rollout_type}:{raw.response_item_type or raw.event_type}"
        for raw in raw_records
        if raw.rollout_type not in KNOWN_ROLLOUT_TYPES
        or (raw.rollout_type == "response_item" and raw.response_item_type not in KNOWN_RESPONSE_TYPES)
        or (raw.rollout_type == "event_msg" and raw.event_type not in KNOWN_EVENT_TYPES)
    })
    return SessionDocument(
        session_id=session_id,
        label=f"Codex session {generated_at or session_id}",
        source=str(meta.get("originator") or source_name),
        description=_compact(description, 300), generated_at=generated_at,
        agent={
            "type": "codex", "model": model, "version": meta.get("cli_version", ""),
            "provider": meta.get("model_provider", "openai"),
        },
        raw_records=raw_records, interactions=interactions,
        metadata={"cwd": meta.get("cwd", ""), "unknown_types": unknown_types},
    )


def parse_codex_jsonl(path: str | Path) -> SessionDocument:
    source = Path(path)
    with source.open("r", encoding="utf-8", errors="replace") as stream:
        return parse_codex_records(iter_json_objects(stream), source.name)


def parse_v4_json(data: Any, source_name: str = "session.v4.json") -> SessionDocument:
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION:
        found = data.get("schema_version") if isinstance(data, dict) else None
        raise ValueError(f"Unsupported session schema {found!r}; schema v4 is required.")
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    raw_records: list[RawRecord] = []
    for value in data.get("raw_records", []):
        if isinstance(value, dict):
            raw_records.append(RawRecord(**value))
    interactions: list[Interaction] = []
    needs_conversation_derivation = False
    for value in data.get("interactions", []):
        if not isinstance(value, dict):
            continue
        item = dict(value)
        if not {"conversation_turn_id", "conversation_turn_number", "conversation_turn_kind"} <= item.keys():
            needs_conversation_derivation = True
        item["family"] = InteractionFamily(item.get("family", InteractionFamily.LIFECYCLE_OBSERVABILITY.value))
        item["kind"] = NodeKind(item.get("kind", NodeKind.EVENT_UNKNOWN.value))
        item["lifecycle"] = LifecycleState(item.get("lifecycle", LifecycleState.UNKNOWN.value))
        item["conversation_turn_kind"] = ConversationTurnKind(
            item.get("conversation_turn_kind", ConversationTurnKind.INITIALIZATION.value)
        )
        interactions.append(Interaction(**item))
    if needs_conversation_derivation:
        assign_conversation_turns(interactions, raw_records)
    agent = meta.get("agent") if isinstance(meta.get("agent"), dict) else {"type": "codex"}
    return SessionDocument(
        session_id=str(meta.get("session_id") or Path(source_name).stem),
        label=str(meta.get("label") or Path(source_name).stem), source=str(meta.get("source") or source_name),
        description=str(meta.get("description") or ""), generated_at=str(meta.get("generated_at") or ""),
        agent=agent, raw_records=raw_records, interactions=interactions,
        metadata={key: value for key, value in meta.items() if key not in {"session_id", "label", "source", "description", "generated_at", "agent"}},
    )


def parse_session_file(path: str | Path) -> SessionDocument:
    source = Path(path)
    if source.suffix.lower() in {".jsonl", ".ndjson"}:
        return parse_codex_jsonl(source)
    data = json.loads(source.read_text(encoding="utf-8", errors="replace"))
    return parse_v4_json(data, source.name)
