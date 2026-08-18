// The catalog: one declarative descriptor per interaction type/subtype.
//
// A descriptor is a list of slots (see observatory-fields.js). Adding support
// for a new Codex type means adding an entry here — no new rendering code.
// Field names and enum values come from codex-rs/protocol/src/items.rs,
// protocol.rs and approvals.rs, cross-checked against a scan of every imported
// session (fix_data_cleaning_types_base_aproach/dane/inventory_typow.json).

import {
  gettext, interpolate, statusLabels, lifecycleLabels, translatedLabel,
} from "./observatory-labels.js?v=9";
import {
  item, pay, rec, res, meta, field, detailJson, detailText, computed,
  commandLine, tryParseJson, unwrapOutput, humanizeToken, formatDuration,
  formatTimestamp, formatCount, normalizePath,
} from "./observatory-fields.js?v=9";

// --- shared slot builders ----------------------------------------------------

function statusTone(value) {
  const text = String(value).toLowerCase();
  if (["failed", "error", "declined", "denied", "aborted", "cancelled", "canceled"].includes(text)) return "bad";
  if (["completed", "success", "approved", "ok"].includes(text)) return "ok";
  return "";
}

function statusBadgeText(value) {
  return translatedLabel(statusLabels, String(value)) || humanizeToken(value);
}

/** status, taken from the item first and only then from the parser's summary. */
function statusSlot(...sources) {
  return {
    id: "status",
    label: gettext("Status"),
    role: "status",
    render: "badges",
    from: [...sources, res("status"), field("status")],
    badge: statusBadgeText,
    tone: statusTone,
    missing: "explain",
  };
}

function lifecycleSlot() {
  return {
    id: "lifecycle",
    label: gettext("Lifecycle"),
    role: "status",
    render: "badges",
    from: [field("lifecycle")],
    badge: value => translatedLabel(lifecycleLabels, String(value)) || humanizeToken(value),
    missing: "hide",
  };
}

function exitCodeSlot(...sources) {
  return {
    id: "exit_code",
    label: gettext("Exit code"),
    role: "status",
    render: "badges",
    from: sources,
    badge: value => interpolate(gettext("exit code %s"), [value]),
    tone: value => (Number(value) === 0 ? "ok" : "bad"),
    missing: "explain",
  };
}

function stderrSlot(...sources) {
  return {
    id: "stderr",
    label: gettext("Error output"),
    role: "status",
    render: "text",
    from: sources,
    missing: "dash",
  };
}

function durationSlot(policy, ...sources) {
  return {
    id: "duration",
    label: gettext("Duration"),
    role: "timing",
    render: "badges",
    from: [
      ...sources,
      field("duration_ms"),
      // Last resort, and flagged as calculated in the tooltip: the difference
      // between the timestamps the event itself carries.
      computed(ctx => {
        const at = key => ctx.payloads.map(payload => payload && payload[key]).find(value => typeof value === "number");
        const started = at("started_at_ms");
        const completed = at("completed_at_ms");
        return started != null && completed != null && completed >= started ? completed - started : null;
      }),
    ],
    badge: formatDuration,
    missing: policy,
  };
}

// `duration` is only worth reporting as missing where the type has a duration
// at all: a session header or a message simply does not have one.
function timingSlots(durationPolicy = "hide") {
  return [
    {
      id: "started_at",
      label: gettext("Started"),
      role: "timing",
      render: "kv",
      from: [pay("started_at_ms"), pay("started_at"), field("started_at_ms")],
      format: formatTimestamp,
      missing: "hide",
    },
    {
      id: "completed_at",
      label: gettext("Finished"),
      role: "timing",
      render: "kv",
      from: [pay("completed_at_ms"), pay("completed_at"), field("completed_at_ms")],
      format: formatTimestamp,
      missing: "hide",
    },
    durationSlot(durationPolicy, item("duration"), pay("duration"), pay("duration_ms"), res("duration")),
  ];
}

function callIdSlot() {
  return {
    id: "call_id",
    label: gettext("Call identifier"),
    role: "provenance",
    render: "kv",
    from: [item("id"), pay("call_id"), field("call_id"), field("item_id")],
    missing: "hide",
  };
}

// --- decoding helpers used by transforms -------------------------------------

// ParsedCommand: Read{cmd,name,path} | ListFiles{cmd,path} | Search{cmd,query,path} | Unknown{cmd}
function describeParsedCommand(entry) {
  if (!entry || typeof entry !== "object") return null;
  const type = String(entry.type || "");
  if (type === "read") return interpolate(gettext("reads %s"), [entry.name || normalizePath(entry.path || "")]);
  if (type === "list_files") return interpolate(gettext("lists %s"), [normalizePath(entry.path || ".")]);
  if (type === "search") {
    return entry.path
      ? interpolate(gettext("searches for %s in %s"), [entry.query || "?", normalizePath(entry.path)])
      : interpolate(gettext("searches for %s"), [entry.query || "?"]);
  }
  return null;
}

function parsedCommandList(entries) {
  const described = (Array.isArray(entries) ? entries : []).map(describeParsedCommand).filter(Boolean);
  return described.length ? described : null;
}

function shellArguments(ctx) {
  const parsed = tryParseJson(String(ctx.interaction.detail || ""));
  if (parsed && !Array.isArray(parsed)) return parsed;
  const args = ctx.metadata.arguments;
  if (args && typeof args === "object") {
    if (args.value !== undefined) return args.value;
    if (typeof args.raw === "string") return tryParseJson(args.raw);
    return args;
  }
  return null;
}

function outputText(value) {
  const unwrapped = unwrapOutput(value);
  return unwrapped.text || null;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map(part => (part && typeof part === "object" ? part.text || part.input_text || part.output_text : part))
    .filter(part => typeof part === "string" && part.trim());
  // An empty list is a real answer ("recorded, but no text"), so it stays an
  // empty string rather than becoming "not in the log".
  return parts.join("\n");
}

function imagesFromContent(content) {
  if (!Array.isArray(content)) return null;
  const images = content.filter(part => part && typeof part === "object" && (part.image_url || part.url));
  return images.length ? images : null;
}

const CONTEXT_ENVELOPES = ["<environment_context>", "<user_instructions>"];

function envelopeKind(ctx) {
  const explicit = ctx.payloads.map(payload => payload && payload.kind).find(Boolean);
  if (explicit) return humanizeToken(explicit);
  // In 2025 logs a message lands in `event_unknown`, so `detail` holds the JSON
  // dump rather than the text; the envelope has to be recognised in the records.
  const texts = [String(ctx.interaction.detail || "")];
  ctx.items.concat(ctx.payloads, ctx.records).forEach(entry => {
    if (!entry || typeof entry !== "object") return;
    const text = textFromContent(entry.content) || (typeof entry.message === "string" ? entry.message : "");
    if (text) texts.push(text);
  });
  const isEnvelope = texts.some(text => CONTEXT_ENVELOPES.some(tag => text.trimStart().startsWith(tag)));
  return isEnvelope ? gettext("context envelope") : null;
}

// --- descriptors -------------------------------------------------------------

const messageSlots = [
  {
    id: "sender",
    label: gettext("From"),
    role: "what",
    render: "badges",
    from: [field("role"), item("role"), pay("role")],
    badge: value => ({
      user: gettext("You"),
      assistant: gettext("Agent"),
      agent: gettext("Agent"),
      system: gettext("System"),
      developer: gettext("System"),
    }[String(value)] || humanizeToken(value)),
    missing: "explain",
  },
  {
    // Codex marks assistant text as interim commentary or the turn's final
    // answer; absent means "phase unknown", which is a valid state.
    id: "phase",
    label: gettext("Phase"),
    role: "what",
    render: "badges",
    from: [item("phase"), pay("phase")],
    badge: value => (String(value) === "final_answer" ? gettext("final answer") : gettext("interim commentary")),
    missing: "hide",
  },
  {
    id: "envelope",
    label: gettext("Message kind"),
    role: "what",
    render: "badges",
    from: [computed(envelopeKind)],
    badge: value => interpolate(gettext("system message (%s)"), [value]),
    tone: () => "tool",
    missing: "hide",
  },
  {
    id: "text",
    label: gettext("Message"),
    role: "input",
    render: "text",
    bare: true,
    from: [
      item("content", { longest: true }),
      pay("content", { longest: true }),
      rec("content", { longest: true }),
      pay("message", { longest: true }),
      detailText(),
    ],
    transform: value => textFromContent(value) ?? (typeof value === "string" ? value : null),
    missing: "explain",
  },
  {
    id: "images",
    label: gettext("Images"),
    role: "input",
    render: "image",
    from: [item("content"), pay("content"), rec("content"), pay("images")],
    transform: imagesFromContent,
    missing: "hide",
  },
  ...timingSlots(),
];

const reasoningSlots = [
  {
    id: "reasoning_kind",
    label: gettext("Reasoning kind"),
    role: "what",
    render: "badges",
    from: [field("subkind")],
    badge: value => ({
      agent_reasoning: gettext("summary"),
      reasoning: gettext("summary"),
      agent_reasoning_raw_content: gettext("raw thinking"),
      agent_reasoning_section_break: gettext("section break"),
    }[String(value)] || humanizeToken(value)),
    missing: "hide",
  },
  {
    id: "summary",
    label: gettext("Summary"),
    role: "input",
    render: "text",
    bare: true,
    from: [
      item("summary_text", { first: "nonEmpty" }),
      pay("summary", { longest: true }),
      rec("summary", { longest: true }),
      pay("text", { longest: true }),
      detailText(),
    ],
    transform: value => textFromContent(value) ?? (typeof value === "string" ? value : null),
    missing: "explain",
  },
  {
    id: "raw_content",
    label: gettext("Raw thinking"),
    role: "input",
    render: "text",
    from: [item("raw_content", { first: "nonEmpty" }), pay("raw_content")],
    transform: value => textFromContent(value),
    missing: "hide",
  },
  {
    id: "encrypted",
    label: gettext("Encrypted content"),
    role: "provenance",
    render: "badges",
    from: [pay("encrypted_content"), rec("encrypted_content")],
    badge: () => gettext("model kept this thinking encrypted"),
    missing: "hide",
  },
  ...timingSlots(),
];

const commandSlots = [
  {
    id: "command_line",
    label: gettext("Command"),
    role: "input",
    render: "code",
    from: [
      item("command"),
      pay("command"),
      computed(ctx => {
        const args = shellArguments(ctx);
        return Array.isArray(args) ? args : args && args.command;
      }),
      detailText(),
    ],
    transform: value => commandLine(value) || null,
    missing: "explain",
  },
  {
    id: "cwd",
    label: gettext("Working directory"),
    role: "where",
    render: "path",
    from: [
      item("cwd"), pay("cwd"),
      computed(ctx => {
        const args = shellArguments(ctx);
        return args && !Array.isArray(args) ? args.workdir || args.cwd : null;
      }),
    ],
    missing: "explain",
  },
  {
    id: "parsed_cmd",
    label: gettext("What the command does"),
    role: "what",
    render: "list",
    from: [item("parsed_cmd"), pay("parsed_cmd")],
    transform: parsedCommandList,
    missing: "hide",
  },
  {
    id: "source",
    label: gettext("Started by"),
    role: "what",
    render: "badges",
    from: [item("source"), pay("source")],
    badge: value => ({
      agent: gettext("agent"),
      user_shell: gettext("your shell"),
      unified_exec_startup: gettext("agent (new process)"),
      unified_exec_interaction: gettext("agent (running process)"),
    }[String(value)] || humanizeToken(value)),
    missing: "hide",
  },
  {
    id: "process_id",
    label: gettext("Process"),
    role: "where",
    render: "kv",
    from: [item("process_id"), pay("process_id")],
    missing: "hide",
  },
  {
    id: "timeout",
    label: gettext("Timeout"),
    role: "input",
    render: "kv",
    from: [computed(ctx => {
      const args = shellArguments(ctx);
      return args && !Array.isArray(args) ? args.timeout_ms : null;
    })],
    format: value => `${formatCount(value)} ms`,
    missing: "hide",
  },
  {
    id: "interaction_input",
    label: gettext("Sent to the running process"),
    role: "input",
    render: "code",
    from: [item("interaction_input"), pay("interaction_input")],
    missing: "hide",
  },
  {
    id: "output",
    label: gettext("Output"),
    role: "output",
    render: "text",
    from: [
      item("aggregated_output"), item("stdout"), item("formatted_output"),
      pay("aggregated_output"), pay("stdout"),
      res("aggregated_output"), res("stdout"),
      computed(ctx => outputText(ctx.result.output)),
    ],
    consumes: ["aggregated_output", "stdout", "formatted_output", "output"],
    missing: "dash",
  },
  stderrSlot(item("stderr"), pay("stderr"), res("stderr")),
  exitCodeSlot(item("exit_code"), pay("exit_code"), res("exit_code")),
  statusSlot(item("status"), pay("status")),
  ...timingSlots("explain"),
  callIdSlot(),
];

const fileChangeSlots = [
  {
    id: "changed_files",
    label: gettext("Changed files"),
    role: "what",
    render: "badges",
    from: [item("changes"), pay("changes")],
    badge: value => interpolate(gettext("%s file(s)"), [Object.keys(value).length]),
    missing: "hide",
  },
  {
    // The single most important slot of this type: without it the panel shows
    // file content with no idea which file it belongs to.
    id: "changes",
    label: gettext("Files"),
    role: "where",
    render: "pathmap",
    bare: true,
    from: [item("changes"), pay("changes"), detailJson("")],
    missing: "explain",
  },
  {
    id: "auto_approved",
    label: gettext("Approval"),
    role: "status",
    render: "badges",
    from: [item("auto_approved"), pay("auto_approved")],
    badge: value => (value ? gettext("auto-approved") : gettext("approved by you")),
    missing: "hide",
  },
  {
    id: "stdout",
    label: gettext("Result"),
    role: "output",
    render: "text",
    from: [item("stdout"), pay("stdout"), res("stdout")],
    missing: "dash",
  },
  stderrSlot(item("stderr"), pay("stderr"), res("stderr")),
  statusSlot(
    item("status"),
    pay("status"),
    // patch_apply_end reports success as a boolean instead of a status string.
    computed(ctx => {
      const success = ctx.payloads.map(payload => payload && payload.success).find(value => typeof value === "boolean");
      return success === undefined ? null : (success ? "completed" : "failed");
    }),
  ),
  ...timingSlots("explain"),
  callIdSlot(),
];

const toolCallSlots = [
  {
    id: "tool_name",
    label: gettext("Tool"),
    role: "what",
    render: "badges",
    from: [meta("tool_name"), pay("name"), item("tool"), rec("name")],
    consumes: ["name", "tool"],
    badge: value => String(value),
    tone: () => "tool",
    missing: "explain",
  },
  {
    id: "arguments",
    label: gettext("Arguments"),
    role: "input",
    render: "json",
    from: [
      computed(ctx => {
        const args = shellArguments(ctx);
        if (args == null) return null;
        return Array.isArray(args) ? { command: args } : args;
      }),
      pay("arguments"),
      item("arguments"),
      rec("arguments"),
      // Custom tools (exec, apply_patch, …) send their payload as `input`.
      pay("input"),
      item("input"),
      meta("arguments.raw"),
    ],
    consumes: ["arguments", "input"],
    transform: value => (typeof value === "string" ? tryParseJson(value) || value : value),
    missing: "explain",
  },
  {
    id: "command_line",
    label: gettext("Command"),
    role: "input",
    render: "code",
    from: [computed(ctx => {
      const args = shellArguments(ctx);
      const argv = Array.isArray(args) ? args : args && args.command;
      return Array.isArray(argv) ? commandLine(argv) : null;
    })],
    missing: "hide",
  },
  {
    id: "workdir",
    label: gettext("Working directory"),
    role: "where",
    render: "path",
    from: [computed(ctx => {
      const args = shellArguments(ctx);
      return args && !Array.isArray(args) ? args.workdir || args.cwd : null;
    })],
    missing: "hide",
  },
  {
    id: "output",
    label: gettext("Result"),
    role: "output",
    render: "text",
    from: [
      computed(ctx => outputText(ctx.result.output ?? ctx.result.value ?? ctx.result.results)),
      computed(ctx => outputText(ctx.payloads.map(payload => payload && payload.output).find(Boolean))),
    ],
    consumes: ["output", "results", "value", "response"],
    missing: "dash",
  },
  exitCodeSlot(
    computed(ctx => unwrapOutput(ctx.result.output ?? "").meta.exit_code),
    pay("exit_code"),
    res("exit_code"),
  ),
  statusSlot(item("status"), pay("status")),
  ...timingSlots("explain"),
  callIdSlot(),
];

const mcpSlots = [
  {
    id: "tool",
    label: gettext("Tool"),
    role: "what",
    render: "badges",
    from: [item("tool"), pay("invocation.tool"), meta("tool_name")],
    consumes: ["tool", "name"],
    badge: value => String(value),
    tone: () => "tool",
    missing: "explain",
  },
  {
    id: "server",
    label: gettext("MCP server"),
    role: "where",
    render: "kv",
    from: [item("server"), pay("invocation.server")],
    missing: "explain",
  },
  {
    id: "app",
    label: gettext("Application"),
    role: "where",
    render: "kv",
    from: [item("app_name"), item("connector_id"), item("mcp_app_resource_uri")],
    missing: "hide",
  },
  {
    id: "read_only",
    label: gettext("Access"),
    role: "what",
    render: "badges",
    from: [item("read_only_hint"), pay("read_only_hint")],
    badge: value => (value ? gettext("read-only tool") : gettext("tool can modify state")),
    tone: value => (value ? "ok" : ""),
    missing: "hide",
  },
  {
    id: "arguments",
    label: gettext("Arguments"),
    role: "input",
    render: "json",
    from: [item("arguments"), pay("invocation.arguments"), detailJson("")],
    missing: "explain",
  },
  {
    // The parser does not copy `item.result`, so without the raw records this
    // whole section would be invisible.
    id: "result",
    label: gettext("Result"),
    role: "output",
    render: "text",
    from: [item("result.content"), pay("result.content"), item("result")],
    transform: value => textFromContent(value) ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2)),
    missing: "dash",
  },
  {
    id: "error",
    label: gettext("Error"),
    role: "status",
    render: "text",
    from: [item("error.message"), pay("error.message"), item("error")],
    transform: value => (typeof value === "string" ? value : JSON.stringify(value, null, 2)),
    missing: "hide",
  },
  {
    id: "is_error",
    label: gettext("Outcome"),
    role: "status",
    render: "badges",
    from: [item("result.isError"), pay("result.isError")],
    badge: value => (value ? gettext("the tool reported an error") : gettext("the tool reported success")),
    tone: value => (value ? "bad" : "ok"),
    missing: "hide",
  },
  statusSlot(item("status"), pay("status")),
  ...timingSlots("explain"),
  callIdSlot(),
];

const webSlots = [
  {
    id: "action",
    label: gettext("Action"),
    role: "what",
    render: "badges",
    from: [item("action.type"), pay("action.type"), item("kind"), field("subkind")],
    consumes: ["action", "kind"],
    badge: value => ({
      search: gettext("web search"),
      open_page: gettext("opened a page"),
      openPage: gettext("opened a page"),
      find_in_page: gettext("searched inside a page"),
      findInPage: gettext("searched inside a page"),
    }[String(value)] || humanizeToken(value)),
    missing: "explain",
  },
  {
    id: "query",
    label: gettext("Query"),
    role: "input",
    render: "code",
    from: [
      item("query"), pay("query"),
      item("action.query"), pay("action.query"),
      item("action.pattern"), pay("action.pattern"),
      computed(ctx => {
        const queries = ctx.items.concat(ctx.payloads)
          .map(entry => entry && entry.action && entry.action.queries)
          .find(Array.isArray);
        return queries ? queries.join(" · ") : null;
      }),
    ],
    missing: "explain",
  },
  {
    id: "url",
    label: gettext("Address"),
    role: "where",
    render: "kv",
    from: [item("action.url"), pay("action.url")],
    // A plain search has no address; only page actions do.
    when: ctx => ctx.items.concat(ctx.payloads).some(entry => {
      const type = entry && entry.action && entry.action.type;
      return type && String(type) !== "search";
    }),
    missing: "explain",
  },
  {
    id: "results",
    label: gettext("Results"),
    role: "output",
    render: "list",
    from: [item("results"), pay("results"), res("results")],
    missing: "dash",
  },
  statusSlot(item("status"), pay("status")),
  ...timingSlots("explain"),
  callIdSlot(),
];

const planSlots = [
  {
    id: "plan_text",
    label: gettext("Plan"),
    role: "input",
    render: "text",
    bare: true,
    from: [item("text", { longest: true }), pay("text", { longest: true }), detailJson("text"), detailText()],
    missing: "explain",
  },
  {
    id: "steps",
    label: gettext("Steps"),
    role: "input",
    render: "steps",
    from: [meta("steps"), pay("plan"), item("plan"), detailJson("plan")],
    missing: "hide",
  },
  {
    id: "explanation",
    label: gettext("Why"),
    role: "what",
    render: "text",
    from: [pay("explanation"), item("explanation")],
    missing: "hide",
  },
  ...timingSlots(),
];

// turn_context and thread_settings_applied carry the same settings under
// different roots, so the slots are generated from one description.
function settingsSlots(at) {
  return [
    { id: "model", label: gettext("Model"), role: "what", render: "kv", from: [at("model"), at("collaboration_mode.settings.model")], missing: "explain" },
    { id: "effort", label: gettext("Effort"), role: "what", render: "kv", from: [at("effort"), at("reasoning_effort"), at("collaboration_mode.settings.reasoning_effort")], missing: "hide" },
    { id: "personality", label: gettext("Personality"), role: "what", render: "kv", from: [at("personality")], missing: "hide" },
    { id: "provider", label: gettext("Provider"), role: "what", render: "kv", from: [at("model_provider_id"), at("model_provider")], missing: "hide" },
    { id: "service_tier", label: gettext("Service tier"), role: "what", render: "kv", from: [at("service_tier")], missing: "hide" },
    { id: "collaboration", label: gettext("Collaboration mode"), role: "what", render: "kv", from: [at("collaboration_mode.mode"), at("collaboration_mode_kind")], missing: "hide" },
    { id: "multi_agent", label: gettext("Multi-agent version"), role: "what", render: "kv", from: [at("multi_agent_version")], missing: "hide" },
    { id: "cwd", label: gettext("Working directory"), role: "where", render: "path", from: [at("cwd")], missing: "explain" },
    { id: "workspace_roots", label: gettext("Workspace roots"), role: "where", render: "kv", from: [at("workspace_roots")], format: value => (Array.isArray(value) ? value.map(normalizePath).join(", ") : String(value)), missing: "hide" },
    { id: "approval_policy", label: gettext("Approval policy"), role: "status", render: "kv", from: [at("approval_policy")], format: humanizeToken, missing: "explain" },
    { id: "approvals_reviewer", label: gettext("Approvals reviewed by"), role: "status", render: "kv", from: [at("approvals_reviewer")], format: humanizeToken, missing: "hide" },
    { id: "sandbox", label: gettext("Sandbox"), role: "status", render: "kv", from: [at("sandbox_policy.mode"), at("sandbox_policy.type")], format: humanizeToken, missing: "explain" },
    { id: "writable_roots", label: gettext("Writable roots"), role: "status", render: "kv", from: [at("sandbox_policy.writable_roots")], format: value => (Array.isArray(value) ? value.map(normalizePath).join(", ") : String(value)), missing: "hide" },
    { id: "network", label: gettext("Network access"), role: "status", render: "kv", from: [at("sandbox_policy.network_access"), at("permission_profile.network")], format: value => (typeof value === "boolean" ? (value ? gettext("yes") : gettext("no")) : humanizeToken(value)), missing: "hide" },
    { id: "permission_profile", label: gettext("Permission profile"), role: "status", render: "kv", from: [at("permission_profile.type"), at("file_system_sandbox_policy.kind")], format: humanizeToken, missing: "hide" },
    { id: "file_permissions", label: gettext("File permissions"), role: "status", render: "list", from: [at("permission_profile.file_system.entries"), at("file_system_sandbox_policy.entries")], transform: entries => (Array.isArray(entries) ? entries.map(entry => `${normalizePath((entry.path && entry.path.value) || entry.path || "?")} — ${humanizeToken(entry.access)}`) : null), missing: "hide" },
    { id: "truncation", label: gettext("Output truncation"), role: "what", render: "kv", from: [at("truncation_policy.mode")], format: humanizeToken, missing: "hide" },
    { id: "date", label: gettext("Session date"), role: "timing", render: "kv", from: [at("current_date")], missing: "hide" },
    { id: "timezone", label: gettext("Time zone"), role: "timing", render: "kv", from: [at("timezone")], missing: "hide" },
    { id: "realtime", label: gettext("Realtime mode"), role: "what", render: "kv", from: [at("realtime_active")], format: value => (value ? gettext("yes") : gettext("no")), missing: "hide" },
    { id: "user_instructions", label: gettext("Project instructions"), role: "input", render: "text", from: [at("user_instructions")], missing: "hide" },
  ];
}

const usageSlots = [
  {
    id: "tokens",
    label: gettext("Tokens in this request"),
    role: "output",
    render: "tokens",
    from: [
      pay("info.last_token_usage"), detailJson("info.last_token_usage"),
      pay("info.total_token_usage"), detailJson("info.total_token_usage"),
    ],
    missing: "explain",
  },
  {
    id: "session_total",
    label: gettext("Session total tokens"),
    role: "output",
    render: "kv",
    from: [pay("info.total_token_usage.total_tokens"), detailJson("info.total_token_usage.total_tokens")],
    format: formatCount,
    missing: "hide",
  },
  {
    id: "context_window",
    label: gettext("Context window"),
    role: "what",
    render: "kv",
    from: [computed(ctx => {
      const info = ctx.payloads.map(payload => payload && payload.info).find(Boolean)
        || tryParseJson(String(ctx.interaction.detail || ""))?.info;
      if (!info || !info.model_context_window) return null;
      const window = Number(info.model_context_window);
      const input = info.last_token_usage && info.last_token_usage.input_tokens;
      const used = input == null ? "" : ` · ${Math.round((input / window) * 100)}% ${gettext("used")}`;
      return `${formatCount(window)}${used}`;
    })],
    missing: "hide",
  },
  {
    id: "rate_primary",
    label: gettext("Rate limit (primary)"),
    role: "status",
    render: "kv",
    from: [pay("rate_limits.primary"), detailJson("rate_limits.primary")],
    format: limit => rateLimitText(limit),
    missing: "hide",
  },
  {
    id: "rate_secondary",
    label: gettext("Rate limit (secondary)"),
    role: "status",
    render: "kv",
    from: [pay("rate_limits.secondary"), detailJson("rate_limits.secondary")],
    format: limit => rateLimitText(limit),
    missing: "hide",
  },
  {
    id: "credits",
    label: gettext("Credits"),
    role: "status",
    render: "kv",
    from: [pay("rate_limits.credits"), detailJson("rate_limits.credits")],
    format: credits => (credits.unlimited
      ? gettext("unlimited")
      : credits.balance != null
        ? formatCount(credits.balance)
        : credits.has_credits ? gettext("available") : gettext("none")),
    missing: "hide",
  },
  {
    id: "limit_id",
    label: gettext("Limit"),
    role: "provenance",
    render: "kv",
    from: [pay("rate_limits.limit_id"), pay("rate_limits.plan_type")],
    missing: "hide",
  },
  ...timingSlots(),
];

function rateLimitText(limit) {
  if (!limit || typeof limit !== "object") return String(limit ?? "");
  const parts = [];
  if (limit.used_percent != null) parts.push(`${limit.used_percent}%`);
  if (limit.window_minutes) {
    const hours = Math.round(limit.window_minutes / 60);
    parts.push(hours >= 1
      ? interpolate(gettext("%s h window"), [hours])
      : interpolate(gettext("%s min window"), [limit.window_minutes]));
  }
  if (limit.resets_in_seconds != null) {
    parts.push(interpolate(gettext("resets in %s min"), [Math.round(limit.resets_in_seconds / 60)]));
  }
  return parts.join(" · ");
}

// apply_patch sends the patch as text, not as a `changes` map, so it gets its
// own input slot; everything else is the shared tool-call view.
const patchSlots = [
  {
    id: "tool_name",
    label: gettext("Tool"),
    role: "what",
    render: "badges",
    from: [meta("tool_name"), pay("name")],
    consumes: ["name"],
    badge: value => String(value),
    tone: () => "tool",
    missing: "hide",
  },
  {
    id: "patch",
    label: gettext("Files"),
    role: "where",
    render: "patch",
    bare: true,
    from: [pay("input", { longest: true }), item("input"), detailText()],
    missing: "explain",
  },
  {
    id: "output",
    label: gettext("Result"),
    role: "output",
    render: "text",
    from: [
      computed(ctx => outputText(ctx.result.output)),
      computed(ctx => outputText(ctx.payloads.map(payload => payload && payload.output).find(Boolean))),
    ],
    consumes: ["output"],
    missing: "dash",
  },
  statusSlot(pay("status"), item("status")),
  ...timingSlots("explain"),
  callIdSlot(),
];

const CATALOG = {
  // Chosen by content (see descriptorFor), because a custom tool call is not
  // always apply_patch.
  "patch": { slots: patchSlots },
  // --- Filesystem ---
  "file_change": { slots: fileChangeSlots },
  "file_change|turn_diff": {
    slots: [
      { id: "diff", label: gettext("Diff of the whole turn"), role: "output", render: "diff", bare: true, from: [pay("unified_diff"), item("unified_diff"), detailText()], missing: "explain" },
      ...timingSlots(),
    ],
  },
  // --- Execution ---
  "command": { slots: commandSlots },
  // --- Communication / cognition / planning ---
  "message": { slots: messageSlots },
  "reasoning": { slots: reasoningSlots },
  "plan": { slots: planSlots },
  // --- Tooling ---
  "tool_call": { slots: toolCallSlots },
  // Standalone web search arrives as an "extension" item.
  "tool_call|extension": { slots: webSlots },
  "tool_result": {
    slots: [
      {
        id: "orphan",
        label: gettext("What this is"),
        role: "what",
        render: "badges",
        from: [field("kind")],
        badge: () => gettext("tool result with no matching call in the log"),
        missing: "hide",
      },
      ...toolCallSlots.filter(slot => slot.id !== "tool_name"),
    ],
  },
  "tool_search": {
    slots: [
      {
        id: "tools",
        label: gettext("Tools"),
        role: "output",
        render: "list",
        from: [pay("tools"), item("tools"), detailJson("tools")],
        missing: "explain",
      },
      statusSlot(),
      ...timingSlots(),
    ],
  },
  // --- MCP / web ---
  "mcp_call": { slots: mcpSlots },
  "mcp_server": {
    slots: [
      { id: "server", label: gettext("MCP server"), role: "where", render: "kv", from: [pay("server"), pay("name"), item("server")], missing: "explain" },
      { id: "tools", label: gettext("Tools"), role: "output", render: "list", from: [pay("tools"), item("tools")], missing: "hide" },
      { id: "message", label: gettext("Message"), role: "output", render: "text", from: [pay("message"), pay("error")], missing: "hide" },
      statusSlot(pay("status")),
      ...timingSlots(),
    ],
  },
  "web_action": { slots: webSlots },
  // --- Context / state ---
  // turn_context is the only record whose whole payload the parser keeps
  // (metadata.context); the other settings events must be read from raw.
  "environment": { slots: settingsSlots(path => meta(`context.${path}`)) },
  "environment|thread_settings_applied": { slots: settingsSlots(path => pay(`thread_settings.${path}`)) },
  "environment|session_configured": { slots: settingsSlots(path => pay(path)) },
  "environment|thread_name_updated": {
    slots: [
      { id: "thread_name", label: gettext("Conversation name"), role: "what", render: "kv", from: [pay("thread_name")], missing: "explain" },
      { id: "thread_id", label: gettext("Conversation"), role: "provenance", render: "kv", from: [pay("thread_id")], missing: "hide" },
      ...timingSlots(),
    ],
  },
  "environment|thread_goal_updated": {
    slots: [
      { id: "goal", label: gettext("Goal"), role: "what", render: "text", bare: true, from: [pay("goal"), pay("text"), detailText()], missing: "explain" },
      ...timingSlots(),
    ],
  },
  "world_state": {
    slots: [
      {
        id: "snapshot_kind",
        label: gettext("Snapshot"),
        role: "what",
        render: "badges",
        from: [meta("full"), pay("full")],
        badge: value => (value ? gettext("full snapshot") : gettext("difference from the previous state")),
        missing: "hide",
      },
      { id: "model", label: gettext("Model"), role: "what", render: "kv", from: [pay("state.model"), pay("state.collaboration_mode.model")], missing: "hide" },
      { id: "cwd", label: gettext("Working directory"), role: "where", render: "path", from: [pay("state.environments.environments.local.cwd")], missing: "hide" },
      { id: "date", label: gettext("Session date"), role: "timing", render: "kv", from: [pay("state.environments.current_date")], missing: "hide" },
      { id: "timezone", label: gettext("Time zone"), role: "timing", render: "kv", from: [pay("state.environments.timezone")], missing: "hide" },
      { id: "filesystem", label: gettext("Filesystem"), role: "where", render: "text", from: [pay("state.environments.filesystem")], missing: "hide" },
      { id: "approved_prefixes", label: gettext("Approved command prefixes"), role: "status", render: "list", from: [pay("state.permissions.approved_command_prefixes")], transform: entries => (Array.isArray(entries) ? entries.map(entry => (Array.isArray(entry) ? entry.join(" ") : String(entry))) : null), missing: "hide" },
      { id: "skills", label: gettext("Skills"), role: "input", render: "text", from: [pay("state.host_skills.body")], missing: "hide" },
      // ghost_snapshot
      { id: "commit", label: gettext("Snapshot commit"), role: "provenance", render: "kv", from: [pay("ghost_commit.id")], missing: "hide" },
      { id: "untracked", label: gettext("Untracked files"), role: "where", render: "list", from: [pay("ghost_commit.preexisting_untracked_files")], transform: value => (Array.isArray(value) && value.length ? value : null), missing: "hide" },
      ...timingSlots(),
    ],
  },
  "compaction": {
    slots: [
      {
        id: "summary",
        label: gettext("Summary that replaced the history"),
        role: "output",
        render: "text",
        bare: true,
        from: [pay("message", { longest: true }), item("text"), detailText()],
        missing: "explain",
      },
      { id: "replaced", label: gettext("Replaced messages"), role: "what", render: "badges", from: [pay("replacement_history")], badge: value => interpolate(gettext("%s message(s) replaced"), [value.length]), missing: "hide" },
      { id: "window", label: gettext("Context window"), role: "provenance", render: "kv", from: [pay("window_number")], format: value => interpolate(gettext("window %s"), [value]), missing: "hide" },
      { id: "window_id", label: gettext("Window identifier"), role: "provenance", render: "kv", from: [pay("window_id")], missing: "hide" },
      ...timingSlots(),
    ],
  },
  "review": {
    slots: [
      { id: "mode", label: gettext("Review mode"), role: "what", render: "badges", from: [field("subkind")], badge: value => (String(value).startsWith("entered") ? gettext("entered review mode") : gettext("left review mode")), missing: "hide" },
      { id: "target", label: gettext("Reviewing"), role: "where", render: "json", from: [item("target"), pay("target")], missing: "explain" },
      { id: "hint", label: gettext("Description"), role: "what", render: "text", from: [item("user_facing_hint"), pay("user_facing_hint")], missing: "hide" },
      { id: "output", label: gettext("Findings"), role: "output", render: "json", from: [item("review_output"), pay("review_output")], missing: "hide" },
      ...timingSlots(),
    ],
  },
  // --- Human control ---
  "approval": {
    slots: [
      { id: "what", label: gettext("Waiting for"), role: "what", render: "badges", from: [field("subkind")], badge: value => (String(value).startsWith("apply_patch") ? gettext("approval of file changes") : gettext("approval to run a command")), missing: "hide" },
      { id: "reason", label: gettext("Why the agent asks"), role: "what", render: "text", from: [pay("reason"), item("reason")], missing: "explain" },
      { id: "command", label: gettext("Command"), role: "input", render: "code", from: [pay("command"), item("command")], transform: value => commandLine(value) || null, missing: "hide" },
      { id: "cwd", label: gettext("Working directory"), role: "where", render: "path", from: [pay("cwd"), item("cwd")], missing: "hide" },
      { id: "changes", label: gettext("Files"), role: "where", render: "pathmap", bare: true, from: [pay("changes"), item("changes")], missing: "hide" },
      { id: "grant_root", label: gettext("Requested write access to"), role: "where", render: "path", from: [pay("grant_root"), item("grant_root")], missing: "hide" },
      { id: "decision", label: gettext("Decision"), role: "status", render: "badges", from: [pay("decision"), item("decision"), pay("response.decision")], badge: value => humanizeToken(typeof value === "object" ? Object.keys(value)[0] : value), tone: value => statusTone(typeof value === "object" ? Object.keys(value)[0] : value), missing: "explain" },
      statusSlot(pay("status")),
      lifecycleSlot(),
      ...timingSlots(),
      callIdSlot(),
    ],
  },
  "permission_request": {
    slots: [
      { id: "reason", label: gettext("Why the agent asks"), role: "what", render: "text", from: [pay("reason"), item("reason")], missing: "explain" },
      { id: "permissions", label: gettext("Requested permissions"), role: "input", render: "json", from: [pay("permissions"), item("permissions")], missing: "explain" },
      { id: "cwd", label: gettext("Working directory"), role: "where", render: "path", from: [pay("cwd"), item("cwd")], missing: "hide" },
      statusSlot(pay("status")),
      lifecycleSlot(),
      ...timingSlots(),
    ],
  },
  "user_input_request": {
    slots: [
      { id: "questions", label: gettext("Questions"), role: "input", render: "list", from: [pay("questions"), item("questions")], transform: value => (Array.isArray(value) ? value.map(entry => (typeof entry === "string" ? entry : entry && (entry.question || entry.prompt || JSON.stringify(entry)))) : null), missing: "explain" },
      { id: "blocking", label: gettext("Blocking"), role: "status", render: "badges", from: [pay("is_blocking"), item("is_blocking")], badge: value => (value ? gettext("the agent is waiting for you") : gettext("the agent continues meanwhile")), tone: value => (value ? "bad" : ""), missing: "hide" },
      { id: "auto", label: gettext("Auto-resolves after"), role: "timing", render: "kv", from: [pay("auto_resolution_ms")], format: formatDuration, missing: "hide" },
      { id: "server", label: gettext("MCP server"), role: "where", render: "kv", from: [pay("server_name")], missing: "hide" },
      lifecycleSlot(),
      ...timingSlots(),
    ],
  },
  // --- Lifecycle / observability ---
  "usage": { slots: usageSlots },
  "error": {
    slots: [
      { id: "message", label: gettext("Message"), role: "output", render: "text", bare: true, from: [pay("message", { longest: true }), item("message"), detailText()], missing: "explain" },
      { id: "code", label: gettext("Error code"), role: "status", render: "badges", from: [pay("codex_error_info"), item("codex_error_info")], badge: value => humanizeToken(typeof value === "object" ? Object.keys(value)[0] : value), tone: () => "bad", missing: "explain" },
      { id: "http", label: gettext("HTTP status"), role: "status", render: "kv", from: [pay("codex_error_info.httpConnectionFailed.httpStatusCode")], missing: "hide" },
      { id: "details", label: gettext("Details"), role: "output", render: "text", from: [pay("additional_details")], missing: "hide" },
      { id: "will_retry", label: gettext("Retry"), role: "status", render: "badges", from: [pay("will_retry")], badge: value => (value ? gettext("Codex will retry") : gettext("Codex will not retry")), tone: value => (value ? "" : "bad"), missing: "hide" },
      ...timingSlots(),
    ],
  },
  "warning": {
    slots: [
      { id: "message", label: gettext("Message"), role: "output", render: "text", bare: true, from: [pay("message", { longest: true }), pay("summary"), detailText()], missing: "explain" },
      { id: "details", label: gettext("Details"), role: "output", render: "text", from: [pay("details"), pay("additional_details")], missing: "hide" },
      ...timingSlots(),
    ],
  },
  "hook": {
    slots: [
      { id: "event", label: gettext("Hook event"), role: "what", render: "badges", from: [pay("run.event_name"), pay("event_name"), pay("run.hook_event_name")], badge: humanizeToken, missing: "explain" },
      { id: "name", label: gettext("Hook"), role: "what", render: "kv", from: [pay("run.name"), pay("run.handler"), pay("name")], missing: "hide" },
      { id: "output", label: gettext("Output"), role: "output", render: "json", from: [pay("run.output"), pay("run.outputs")], missing: "hide" },
      statusSlot(pay("run.status"), pay("status")),
      ...timingSlots(),
    ],
  },
  "safety": {
    slots: [
      { id: "risk", label: gettext("Risk level"), role: "status", render: "badges", from: [pay("risk_level"), item("risk_level")], badge: humanizeToken, tone: value => (["high", "critical"].includes(String(value)) ? "bad" : ""), missing: "hide" },
      { id: "action", label: gettext("Assessed action"), role: "what", render: "json", from: [pay("action"), item("action")], missing: "hide" },
      { id: "reasons", label: gettext("Reasons"), role: "output", render: "list", from: [pay("reasons"), pay("use_cases")], missing: "hide" },
      { id: "metadata", label: gettext("Details"), role: "output", render: "json", from: [pay("metadata"), detailJson("")], missing: "hide" },
      statusSlot(pay("status")),
      ...timingSlots(),
    ],
  },
  "model_event": {
    slots: [
      { id: "from", label: gettext("From model"), role: "what", render: "kv", from: [pay("from_model")], missing: "hide" },
      { id: "to", label: gettext("To model"), role: "what", render: "kv", from: [pay("to_model")], missing: "hide" },
      { id: "reason", label: gettext("Reason"), role: "what", render: "text", from: [pay("reason")], transform: value => (typeof value === "string" ? value : JSON.stringify(value, null, 2)), missing: "hide" },
      { id: "verifications", label: gettext("Verifications"), role: "output", render: "json", from: [pay("verifications")], missing: "hide" },
      ...timingSlots(),
    ],
  },
  "image_generation": {
    slots: [
      { id: "prompt", label: gettext("Prompt"), role: "input", render: "text", from: [item("revised_prompt"), pay("revised_prompt"), detailText()], missing: "hide" },
      { id: "image", label: gettext("Image"), role: "output", render: "image", from: [item("result"), pay("result")], missing: "dash" },
      { id: "saved_path", label: gettext("Saved to"), role: "where", render: "path", from: [item("saved_path"), pay("saved_path")], missing: "hide" },
      { id: "failure", label: gettext("Failure"), role: "status", render: "json", from: [item("failure"), pay("failure")], missing: "hide" },
      statusSlot(item("status"), pay("status")),
      ...timingSlots(),
    ],
  },
  "image_view": {
    slots: [
      { id: "path", label: gettext("Image"), role: "where", render: "path", from: [item("path"), pay("path")], missing: "explain" },
      ...timingSlots(),
    ],
  },
  "media_stream": {
    slots: [
      { id: "event", label: gettext("Event"), role: "what", render: "badges", from: [field("subkind")], badge: humanizeToken, missing: "hide" },
      { id: "payload", label: gettext("Details"), role: "output", render: "json", from: [pay(""), detailJson("")], missing: "hide" },
      ...timingSlots(),
    ],
  },
  "lifecycle": {
    slots: [
      { id: "event", label: gettext("Event"), role: "what", render: "badges", from: [field("subkind")], badge: value => ({
        task_started: gettext("turn started"),
        turn_started: gettext("turn started"),
        task_complete: gettext("turn finished"),
        turn_complete: gettext("turn finished"),
        turn_aborted: gettext("turn aborted"),
        shutdown_complete: gettext("session closed"),
        session_meta: gettext("session header"),
      }[String(value)] || humanizeToken(value)), missing: "hide" },
      // turn_aborted
      { id: "reason", label: gettext("Reason"), role: "what", render: "badges", from: [pay("reason")], badge: value => ({
        interrupted: gettext("interrupted by you"),
        replaced: gettext("replaced by a newer turn"),
        review_ended: gettext("review mode ended"),
        budget_limited: gettext("budget limit reached"),
      }[String(value)] || humanizeToken(value)), tone: () => "bad", missing: "hide" },
      // session_meta
      { id: "session_id", label: gettext("Session"), role: "provenance", render: "kv", from: [pay("id"), pay("session_id"), rec("id"), rec("session_id")], consumes: ["id", "session_id"], missing: "hide" },
      { id: "cwd", label: gettext("Working directory"), role: "where", render: "path", from: [pay("cwd"), rec("cwd")], missing: "hide" },
      { id: "originator", label: gettext("Started from"), role: "what", render: "kv", from: [pay("originator"), pay("source"), rec("originator"), rec("source")], consumes: ["originator", "source", "thread_source"], format: humanizeToken, missing: "hide" },
      { id: "cli_version", label: gettext("Codex version"), role: "provenance", render: "kv", from: [pay("cli_version"), rec("cli_version")], missing: "hide" },
      { id: "provider", label: gettext("Provider"), role: "provenance", render: "kv", from: [pay("model_provider"), rec("model_provider")], missing: "hide" },
      { id: "git", label: gettext("Git"), role: "where", render: "kv", from: [pay("git"), rec("git")], format: value => [value.branch, value.commit_hash && String(value.commit_hash).slice(0, 10), value.repository_url].filter(Boolean).join(" · "), missing: "hide" },
      { id: "base_instructions", label: gettext("Base model instructions"), role: "input", render: "text", from: [pay("base_instructions.text"), rec("base_instructions.text"), pay("instructions"), rec("instructions")], consumes: ["base_instructions", "instructions"], missing: "hide" },
      // task_started / task_complete
      { id: "context_window", label: gettext("Context window"), role: "what", render: "kv", from: [pay("model_context_window")], format: formatCount, missing: "hide" },
      { id: "last_message", label: gettext("Final message of the turn"), role: "output", render: "text", from: [pay("last_agent_message", { longest: true })], missing: "hide" },
      { id: "first_token", label: gettext("Time to first token"), role: "timing", render: "kv", from: [pay("time_to_first_token_ms")], format: formatDuration, missing: "hide" },
      { id: "turn", label: gettext("Source turn"), role: "provenance", render: "kv", from: [pay("turn_id"), field("turn_id")], missing: "hide" },
      ...timingSlots(),
    ],
  },
};

// A nested ContextCompaction item lands in `event_unknown` (the parser has no
// mapping for it) but reads exactly like a compaction.
CATALOG["event_unknown|context_compaction"] = CATALOG.compaction;

// Extra keys resolved before the generic fallback: the same kind can come from
// different records (a command as CommandExecution vs as function_call), and a
// 2025 log has no type at all — then the shape decides.
function legacyDescriptor(ctx) {
  const record = ctx.records.find(entry => entry && typeof entry === "object") || {};
  if (record.role && record.content) return CATALOG.message;
  if (record.summary || record.encrypted_content) return CATALOG.reasoning;
  if (record.name && (record.arguments !== undefined || record.call_id)) return CATALOG.tool_call;
  return null;
}

const GENERIC = {
  generic: true,
  slots: [
    { id: "kind", label: gettext("Type"), role: "what", render: "badges", from: [field("subkind"), field("kind")], badge: humanizeToken, missing: "hide" },
    { id: "record_type", label: gettext("Record"), role: "provenance", render: "kv", from: [rec("record_type"), rec("type"), pay("type")], format: humanizeToken, missing: "hide" },
    { id: "text", label: gettext("Content"), role: "output", render: "text", bare: true, from: [pay("message", { longest: true }), pay("text", { longest: true }), detailText()], missing: "hide" },
    statusSlot(pay("status"), item("status")),
    ...timingSlots(),
    callIdSlot(),
  ],
};

function looksLikePatch(interaction, ctx) {
  if (!["tool_call", "tool_result"].includes(String(interaction.kind || ""))) return false;
  if (String((interaction.metadata || {}).tool_name || "") === "apply_patch") return true;
  const inputs = ctx.payloads.map(payload => payload && payload.input).filter(value => typeof value === "string");
  return [...inputs, String(interaction.detail || "")].some(text => text.startsWith("*** Begin Patch"));
}

/**
 * Most specific match wins: kind+subkind+raw item type -> kind+subkind -> kind
 * -> shape sniffing (legacy logs) -> generic.
 */
export function descriptorFor(interaction, ctx) {
  const kind = String(interaction.kind || "");
  const subkind = String(interaction.subkind || "");
  const itemType = ctx.items.length ? String(ctx.items[0].type || "") : "";
  if (looksLikePatch(interaction, ctx)) return CATALOG.patch;
  const keys = [`${kind}|${subkind}|${itemType}`, `${kind}|${subkind}`, kind];
  for (const key of keys) {
    if (CATALOG[key]) return CATALOG[key];
  }
  return legacyDescriptor(ctx) || GENERIC;
}

export function isGeneric(descriptor) {
  return Boolean(descriptor && descriptor.generic);
}

export { CATALOG, GENERIC };
