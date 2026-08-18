// Translated label dictionaries and label helpers.
// Django's JavaScriptCatalog (loaded as a classic script in <head>) defines
// window.gettext before any deferred module runs; the fallbacks below only
// matter when the catalog is unavailable.

export const gettext = window.gettext || (message => message);
export const ngettext = window.ngettext || ((singular, plural, count) => count === 1 ? singular : plural);
export const interpolate = window.interpolate || ((format, values) => {
  let index = 0;
  return format.replace(/%s/g, () => String(values[index++] ?? ""));
});

export const familyLabels = {
  communication: gettext("Communication"),
  cognition: gettext("Reasoning"),
  planning: gettext("Planning"),
  execution: gettext("Execution"),
  tooling: gettext("Tools"),
  filesystem: gettext("Files"),
  web: gettext("Web"),
  mcp: gettext("MCP"),
  media: gettext("Media"),
  multi_agent: gettext("Agents"),
  human_control: gettext("Human control"),
  safety_security: gettext("Safety"),
  context_state: gettext("Context"),
  lifecycle_observability: gettext("Lifecycle"),
};

export const UNKNOWN_FAMILY_COLOR = "#94a3b8";

export const kindLabels = {
  session: gettext("Session"), agent: gettext("Agent"), turn: gettext("Turn"),
  message: gettext("Message"), reasoning: gettext("Reasoning"), plan: gettext("Plan"),
  plan_step: gettext("Plan step"), command: gettext("Command"), terminal_io: gettext("Terminal I/O"),
  tool_call: gettext("Tool call"), tool_result: gettext("Tool result"), tool_search: gettext("Tool search"),
  mcp_server: gettext("MCP server"), mcp_call: gettext("MCP call"), web_action: gettext("Web action"),
  file_change: gettext("File change"), artifact: gettext("Artifact"), image_generation: gettext("Image generation"),
  image_view: gettext("Image view"), media_stream: gettext("Media stream"), approval: gettext("Approval"),
  permission_request: gettext("Permission request"), user_input_request: gettext("User input request"),
  review: gettext("Review"), compaction: gettext("Compaction"), world_state: gettext("World state"),
  hook: gettext("Hook"), safety: gettext("Safety"), model_event: gettext("Model event"),
  environment: gettext("Environment"), usage: gettext("Usage"), error: gettext("Error"),
  warning: gettext("Warning"), lifecycle: gettext("Lifecycle"), event_unknown: gettext("Unknown event"),
};

export const lifecycleLabels = {
  pending: gettext("Pending"), started: gettext("Started"), streaming: gettext("Streaming"),
  waiting: gettext("Waiting"), blocked: gettext("Blocked"), completed: gettext("Completed"),
  failed: gettext("Failed"), cancelled: gettext("Cancelled"), aborted: gettext("Aborted"),
  unknown: gettext("Unknown"),
};

export const statusLabels = {
  success: gettext("Success"), error: gettext("Error"),
  ...lifecycleLabels,
};

export const edgeLabels = {
  contains: gettext("contains"), produced: gettext("produced"), next: gettext("next"),
  triggered: gettext("triggered"), invokes: gettext("invokes"), returns: gettext("returns"),
  failed_with: gettext("failed with"), retries: gettext("retries"), reads: gettext("reads"),
  creates: gettext("creates"), writes: gettext("writes"), patches: gettext("patches"),
  deletes: gettext("deletes"), copies: gettext("copies"), moves: gettext("moves"),
  references: gettext("references"), executes: gettext("executes"), observes: gettext("observes"),
  spawns: gettext("spawns"), sends_to: gettext("sends to"), waits_for: gettext("waits for"),
  resumes: gettext("resumes"), closes: gettext("closes"), requests_approval: gettext("requests approval"),
  approves: gettext("approves"), declines: gettext("declines"), requests_input: gettext("requests input"),
  responds_to: gettext("responds to"), blocks: gettext("blocks"), requests_permission: gettext("requests permission"),
  grants_permission: gettext("grants permission"), searches: gettext("searches"), opens: gettext("opens"),
  finds_in: gettext("finds in"), connects_to: gettext("connects to"), generates: gettext("generates"),
  compacts: gettext("compacts"), updates_state: gettext("updates state"), enters_mode: gettext("enters mode"),
  exits_mode: gettext("exits mode"), triggers_hook: gettext("triggers hook"), blocked_by: gettext("blocked by"),
  rerouted_to: gettext("rerouted to"), derived_from: gettext("derived from"), implements_step: gettext("implements step"),
};

export function translatedLabel(labels, value) {
  return labels[value] || String(value || gettext("Unknown")).replaceAll("_", " ");
}

export function stepsLabel(count) {
  return interpolate(ngettext("%s step", "%s steps", count), [count]);
}

export function errorsLabel(count) {
  return interpolate(ngettext("%s error", "%s errors", count), [count]);
}

export function interactionsLabel(count) {
  return interpolate(ngettext("%s interaction", "%s interactions", count), [count]);
}

export function turnLabel(number) {
  return interpolate(gettext("Turn %s"), [number]);
}

export function segmentLabel(turn) {
  return turn.conversation_turn_kind === "initialization"
    ? gettext("Session initialization")
    : turnLabel(turn.conversation_turn_number);
}

export function segmentShortLabel(turn) {
  return turn.conversation_turn_kind === "initialization"
    ? gettext("Init")
    : `T${turn.conversation_turn_number}`;
}
