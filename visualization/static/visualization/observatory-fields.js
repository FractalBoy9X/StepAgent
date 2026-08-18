// Field extraction and rendering primitives for the Content layer.
//
// The idea (see fix_data_cleaning_types_base_aproach/01_PLAN_data_cleaning_per_typ.md):
// a presenter is a *list of slots*, not a pile of if-statements. A slot says
// what question it answers ("where?", "what came out?"), where to look for the
// value, and how to draw it. Everything here is strictly presentational — it
// reads the already-fetched interaction and its raw records and never calls the
// parser or the API.
//
// Two rules matter more than the rest:
//   1. `interaction.detail` is lossy on purpose (the parser truncates it), so it
//      is always the LAST source and never a source of structure.
//   2. A missing value is a visible, explained state — never a blank panel and
//      never an exception.

import { gettext, interpolate, ngettext, statusLabels, translatedLabel } from "./observatory-labels.js?v=9";
import { element } from "./observatory-views.js?v=9";

// Inline values longer than this move into their own labeled block.
export const ARG_INLINE_LIMIT = 200;
// Patches beyond this size skip line-by-line coloring to keep the panel fast.
const DIFF_MAX_CHARS = 60000;
export const OUTPUT_PREVIEW_CHARS = 12000;
export const BLOCK_PREVIEW_CHARS = 4000;
// The parser appends "..." when it truncates `detail`; that suffix is the only
// reliable signal that the JSON inside is incomplete.
const TRUNCATION_SUFFIX = "...";

// --- generic primitives ------------------------------------------------------

// Honest truncation: over the limit the preview is cut, but a visible notice
// states how much is shown and a button reveals the full text on demand.
export function previewBlock(text, limit) {
  const wrap = element("div", "preview-block");
  const pre = element("pre", "selection-detail");
  if (text.length <= limit) {
    pre.textContent = text;
    wrap.append(pre);
    return wrap;
  }
  pre.textContent = text.slice(0, limit);
  const note = element("div", "truncation-note");
  note.append(element("span", "", interpolate(
    gettext("Preview truncated — showing %s of %s characters."), [limit, text.length])));
  const expand = element("button", "btn", gettext("Show full content"));
  expand.type = "button";
  expand.addEventListener("click", () => {
    pre.textContent = text;
    note.remove();
  });
  note.append(expand);
  wrap.append(pre, note);
  return wrap;
}

// A labeled sub-block: the small caption names every part of the view
// (File, Operation, Content, …) so the panel reads as segments, not blobs.
export function segmentBlock(label, children) {
  const wrap = element("div", "insight-segment");
  wrap.append(element("div", "insight-output-label", label));
  children.forEach(child => { if (child) wrap.append(child); });
  return wrap;
}

// Splits a path into a muted directory part and an emphasized file name.
export function pathChip(path) {
  const wrap = element("span", "insight-pathsplit");
  const text = normalizePath(path);
  const slash = text.lastIndexOf("/");
  if (slash >= 0) wrap.append(element("span", "path-dir", text.slice(0, slash + 1)));
  wrap.append(element("strong", "path-name", slash >= 0 ? text.slice(slash + 1) : text));
  return wrap;
}

// Codex writes `cwd` both as a plain path and as a file:// URI.
export function normalizePath(value) {
  const text = String(value ?? "");
  return text.startsWith("file://") ? decodeURIComponent(text.slice(7)) : text;
}

export function codeBlock(text) {
  return element("pre", "selection-detail insight-code", text);
}

export function badge(text, tone) {
  return element("span", `insight-badge${tone ? ` ${tone}` : ""}`, text);
}

export function badgeRow(badges) {
  const row = element("div", "insight-badges");
  badges.forEach(item => { if (item) row.append(item); });
  return row.childElementCount ? row : null;
}

export function kvTable(rows) {
  const list = element("dl", "selection-fields insight-kv");
  rows.forEach(([name, value]) => {
    if (value == null || value === "") return;
    const dd = element("dd", "");
    if (typeof value === "string" || typeof value === "number") dd.textContent = String(value);
    else dd.append(value);
    list.append(element("dt", "", name), dd);
  });
  return list.childElementCount ? list : null;
}

// Colors patch lines: additions green, deletions red, headers muted.
export function diffBlock(patchText) {
  if (patchText.length > DIFF_MAX_CHARS) return previewBlock(patchText, OUTPUT_PREVIEW_CHARS);
  const pre = element("pre", "selection-detail insight-diff");
  patchText.split("\n").forEach(line => {
    let cls = "diff-ctx";
    if (line.startsWith("+")) cls = "diff-add";
    else if (line.startsWith("-")) cls = "diff-del";
    else if (line.startsWith("***") || line.startsWith("@@") || line.startsWith("diff ")) cls = "diff-meta";
    pre.append(element("span", cls, line), document.createTextNode("\n"));
  });
  return pre;
}

export function labeledOutput(label, text, limit = OUTPUT_PREVIEW_CHARS) {
  return segmentBlock(label, [previewBlock(text, limit)]);
}

// --- safe decoding of Codex payload shapes -----------------------------------

export function tryParseJson(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Codex tool outputs are frequently JSON strings nested inside JSON:
// {"output": "{\"output\": \"…\", \"metadata\": {\"exit_code\": 0}}"}.
// Unwrap the chain into readable text plus whatever metadata rode along.
export function unwrapOutput(value, depth = 0) {
  if (depth > 4 || value == null) return { text: "", meta: {} };
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed == null) return { text: value, meta: {} };
    return unwrapOutput(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    const text = value
      .map(part => (part && typeof part === "object" ? part.text ?? JSON.stringify(part) : String(part)))
      .join("\n");
    return { text, meta: {} };
  }
  if (typeof value === "object") {
    if ("output" in value) {
      const inner = unwrapOutput(value.output, depth + 1);
      return { text: inner.text, meta: { ...(value.metadata || {}), ...inner.meta } };
    }
    if (typeof value.text === "string") return { text: value.text, meta: {} };
    return { text: JSON.stringify(value, null, 2), meta: {} };
  }
  return { text: String(value), meta: {} };
}

const SHELL_WRAPPERS = new Set(["bash", "zsh", "sh", "/bin/bash", "/bin/zsh", "/bin/sh"]);

// ["/bin/zsh", "-lc", "actual script"] -> show the script itself.
export function commandLine(argv) {
  if (!Array.isArray(argv)) return typeof argv === "string" ? argv : "";
  if (argv.length === 3 && SHELL_WRAPPERS.has(argv[0])
      && typeof argv[1] === "string" && argv[1].startsWith("-") && argv[1].includes("c")) {
    return argv[2];
  }
  return argv.join(" ");
}

// Codex patch format: "*** Begin Patch", then per-file blocks opened by
// "*** Add File: p" / "*** Update File: p" / "*** Delete File: p", with an
// optional "*** Move to: p" after Update. Best effort: unparsable input
// returns null and the caller falls back to one flat colored diff.
export function parsePatch(text) {
  if (!text.startsWith("*** Begin Patch")) return null;
  const files = [];
  let current = null;
  for (const line of text.split("\n")) {
    const opener = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (opener) {
      current = { op: opener[1].toLowerCase(), path: opener[2], moveTo: "", lines: [] };
      files.push(current);
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move && current) {
      current.moveTo = move[1];
      continue;
    }
    if (line.startsWith("*** ")) continue;
    if (current) current.lines.push(line);
  }
  return files.length ? files : null;
}

// --- value formatting --------------------------------------------------------

export function formatDuration(value) {
  if (value && typeof value === "object" && typeof value.secs === "number") {
    return `${(value.secs + (value.nanos || 0) / 1e9).toFixed(2)} s`;
  }
  if (typeof value === "number") {
    return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
  }
  return String(value ?? "");
}

export function formatTimestamp(value) {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms)) return String(value ?? "");
  // Epoch seconds appear in a few older events; anything below this threshold
  // cannot be a millisecond timestamp of a 2025+ session.
  const epochMs = ms < 100_000_000_000 ? ms * 1000 : ms;
  return new Date(epochMs).toLocaleString();
}

export function humanizeToken(value) {
  return String(value ?? "").replaceAll("_", " ");
}

export function formatCount(value) {
  return Number(value).toLocaleString();
}

// --- sources -----------------------------------------------------------------

function getPath(source, path) {
  if (!path) return source;
  let value = source;
  for (const key of path.split(".")) {
    if (value == null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

export function isEmptyValue(value) {
  if (value === "" ) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

// One interaction is usually built from several raw records (a call and its
// output, a response item and its mirrored event). Every accessor therefore
// searches ALL records, never just the first one.
export function sourceViews(interaction, rawRecords) {
  const entries = rawRecords || [];
  const records = entries.map(entry => (entry && entry.record) || {});
  const payloads = records.map(record =>
    record && typeof record.payload === "object" && record.payload ? record.payload : record);
  const items = payloads
    .map(payload => (payload && typeof payload.item === "object" && payload.item ? payload.item : null))
    .filter(Boolean);
  const ctx = {
    interaction: interaction || {},
    result: (interaction && interaction.result) || {},
    metadata: (interaction && interaction.metadata) || {},
    rawRecords: entries,
    records,
    payloads,
    items,
    used: new Set(),
    detailCache: undefined,
  };
  return ctx;
}

// Keys are tracked by name only: the same field is often reachable through
// several sources (metadata.context.model and payload.model are one value), and
// the "not shown above" list must not report it as unused.
function markUsed(ctx, source, path) {
  const parts = path.split(".").filter(Boolean);
  // Both ends of the path count: `metadata.context.model` consumes the raw
  // `model` key just as much as `payload.model` does.
  if (parts.length) {
    ctx.used.add(parts[0]);
    ctx.used.add(parts[parts.length - 1]);
  }
}

function fromList(listName, path, options = {}) {
  return ctx => {
    const values = ctx[listName]
      .map(entry => getPath(entry, path))
      .filter(value => value !== undefined && value !== null);
    if (!values.length) return undefined;
    let value = values[0];
    if (options.longest) {
      value = values.reduce((best, next) =>
        (String(next ?? "").length > String(best ?? "").length ? next : best), values[0]);
    }
    if (options.richest) {
      value = values.reduce((best, next) =>
        (Object.keys(next || {}).length > Object.keys(best || {}).length ? next : best), values[0]);
    }
    if (options.first === "nonEmpty") {
      value = values.find(candidate => !isEmptyValue(candidate)) ?? values[0];
    }
    markUsed(ctx, listName, path);
    return { value, source: listName };
  };
}

/** `record.payload.item.<path>` — the richest shape in modern rollout logs. */
export const item = (path, options) => fromList("items", path, options);
/** `record.payload.<path>` — flat events (exec_command_end, token_count, …). */
export const pay = (path, options) => fromList("payloads", path, options);
/** `record.<path>` — 2025 logs without an envelope. */
export const rec = (path, options) => fromList("records", path, options);

function fromObject(key, sourceName) {
  return path => ctx => {
    const value = getPath(ctx[key], path);
    if (value === undefined || value === null) return undefined;
    markUsed(ctx, sourceName, path);
    return { value, source: sourceName };
  };
}

/** `interaction.result.<path>` — what the parser already extracted. */
export const res = fromObject("result", "result");
/** `interaction.metadata.<path>` — tool_name, arguments, context. */
export const meta = fromObject("metadata", "metadata");
/** `interaction.<path>` — identity, status, timings. */
export const field = fromObject("interaction", "interaction");

// `detail` is truncated by the parser, so it is only trusted when it clearly
// was not cut off. Everything else falls through to the next source.
function parsedDetail(ctx) {
  if (ctx.detailCache === undefined) {
    const text = String(ctx.interaction.detail || "");
    ctx.detailCache = text.endsWith(TRUNCATION_SUFFIX) ? null : tryParseJson(text);
  }
  return ctx.detailCache;
}

export const detailJson = path => ctx => {
  const parsed = parsedDetail(ctx);
  if (parsed == null) return undefined;
  const value = getPath(parsed, path);
  if (value === undefined || value === null) return undefined;
  return { value, source: "detail" };
};

// `detail` is a text fallback only. When it starts like JSON it is the parser's
// compacted structure dump, and printing that is exactly the wall of text this
// layer exists to remove — the structured sources or the generic view take over.
export const detailText = () => ctx => {
  const text = String(ctx.interaction.detail || "").trim();
  if (!text || text.startsWith("{") || text.startsWith("[")) return undefined;
  return { value: text, source: "detail" };
};

/** A value the view calculates instead of reading (marked as such in the UI). */
export const computed = producer => ctx => {
  const value = producer(ctx);
  return value === undefined || value === null ? undefined : { value, source: "computed" };
};

/**
 * Never throws: any failure becomes a visible "unreadable" state.
 * An empty value does not end the search — a later source may still hold the
 * real one (a reasoning item often carries `summary: []` next to the record
 * that actually has the text) — but it is remembered, so "present but empty"
 * stays distinguishable from "not in the log".
 */
export function pick(slot, ctx) {
  try {
    let empty = null;
    for (const accessor of slot.from || []) {
      const hit = accessor(ctx);
      if (!hit || hit.value === undefined || hit.value === null) continue;
      const value = slot.transform ? slot.transform(hit.value, ctx) : hit.value;
      if (value === undefined || value === null) continue;
      if (isEmptyValue(value)) {
        empty = empty || { value, status: "empty", source: hit.source };
        continue;
      }
      return { value, status: "ok", source: hit.source };
    }
    return empty || { value: null, status: "missing", source: "" };
  } catch {
    return { value: null, status: "unreadable", source: "" };
  }
}

// --- renderers ---------------------------------------------------------------

function fileCard(path, operation, contentNode, contentLabel) {
  const card = element("div", "insight-file");
  card.append(segmentBlock(gettext("File"), [pathChip(path)]));
  if (operation) card.append(segmentBlock(gettext("Operation"), [operation]));
  if (contentNode) card.append(segmentBlock(contentLabel, [contentNode]));
  return card;
}

const FILE_OP_TONES = { add: "ok", delete: "bad" };

export function fileOpLabel(op) {
  if (op === "add") return gettext("added");
  if (op === "update") return gettext("updated");
  if (op === "delete") return gettext("deleted");
  if (op === "move") return gettext("moved");
  return humanizeToken(op) || "?";
}

// `changes` is a map path -> Add{content} | Delete{content} | Update{unified_diff, move_path}
// (codex-rs/protocol/src/protocol.rs, enum FileChange).
function renderPathMap(changes) {
  const cards = [];
  Object.entries(changes).forEach(([path, change]) => {
    if (!change || typeof change !== "object") return;
    const moveTo = change.move_path || change.movePath || "";
    const op = moveTo ? "move" : String(change.type || change.kind || "");
    const label = element("span", "");
    label.append(badge(fileOpLabel(op), FILE_OP_TONES[op] || ""));
    const diff = change.unified_diff || change.diff || "";
    let body = null;
    let bodyLabel = gettext("Content");
    if (diff) {
      body = diffBlock(diff);
      bodyLabel = gettext("Diff");
      label.append(badge(diffStats(diff)));
    } else if (typeof change.content === "string" && change.content) {
      body = previewBlock(change.content, BLOCK_PREVIEW_CHARS);
      label.append(badge(sizeStat(change.content)));
    }
    const card = fileCard(moveTo ? `${path} → ${moveTo}` : path, label, body, bodyLabel);
    cards.push(card);
  });
  return cards.length ? cards : null;
}

// Calculated, not read from the log — the tooltip says so.
function diffStats(diff) {
  let added = 0;
  let removed = 0;
  diff.split("\n").forEach(line => {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  });
  return `+${added} / −${removed}`;
}

function sizeStat(text) {
  const lines = text.split("\n").length;
  return interpolate(gettext("%s characters, %s lines"), [formatCount(text.length), formatCount(lines)]);
}

function renderTokens(usage) {
  const grid = element("div", "insight-tokens");
  [
    [gettext("Input"), usage.input_tokens],
    [gettext("Cached"), usage.cached_input_tokens],
    [gettext("Cache write"), usage.cache_write_input_tokens],
    [gettext("Output"), usage.output_tokens],
    [gettext("Reasoning"), usage.reasoning_output_tokens],
    [gettext("Total"), usage.total_tokens],
  ].forEach(([label, value]) => {
    if (value == null) return;
    const cell = element("div", "token-stat");
    cell.append(element("span", "", label), element("strong", "", formatCount(value)));
    grid.append(cell);
  });
  return grid.childElementCount ? grid : null;
}

function renderResultList(results) {
  const list = element("div", "insight-results");
  results.slice(0, 30).forEach(entry => {
    if (entry == null) return;
    const row = element("div", "insight-result");
    if (typeof entry !== "object") {
      row.append(element("span", "", String(entry)));
      list.append(row);
      return;
    }
    const title = entry.title || entry.name || entry.url || "";
    if (title) row.append(element("strong", "", String(title)));
    const domain = entry.domain || "";
    if (domain) row.append(element("span", "result-domain", String(domain)));
    if (entry.url) row.append(element("span", "result-url", String(entry.url)));
    if (entry.snippet) row.append(element("span", "result-snippet", String(entry.snippet)));
    list.append(row);
  });
  if (results.length > 30) {
    list.append(element("div", "muted", interpolate(
      gettext("Showing first %s of %s results."), [30, results.length])));
  }
  return list.childElementCount ? list : null;
}

function renderSteps(steps) {
  const list = element("ol", "insight-steps");
  steps.forEach(entry => {
    const row = element("li", "insight-step");
    if (entry && typeof entry === "object") {
      const status = String(entry.status || "");
      row.append(badge(translatedLabel(statusLabels, status) || humanizeToken(status),
        status === "completed" ? "ok" : status === "in_progress" ? "tool" : ""));
      row.append(element("span", "", String(entry.step || entry.text || entry.title || "")));
    } else {
      row.append(element("span", "", String(entry)));
    }
    list.append(row);
  });
  return list.childElementCount ? list : null;
}

// data: URIs are common for pasted screenshots; never print them as text.
function renderImages(values) {
  const list = Array.isArray(values) ? values : [values];
  const wrap = element("div", "insight-images");
  list.forEach(value => {
    const url = typeof value === "string" ? value : (value && (value.image_url || value.url)) || "";
    if (!url) return;
    const figure = element("figure", "insight-image");
    const image = element("img", "");
    image.src = url;
    image.alt = gettext("Image attached to this step");
    image.loading = "lazy";
    figure.append(image, element("figcaption", "muted", url.startsWith("data:")
      ? interpolate(gettext("Embedded image, %s characters"), [formatCount(url.length)])
      : url));
    wrap.append(figure);
  });
  return wrap.childElementCount ? wrap : null;
}

function renderJson(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return previewBlock(text, BLOCK_PREVIEW_CHARS);
}

// A Codex patch is one text blob; split it into the same file cards the
// `changes` map produces, so both ways of changing a file look identical.
// Anything that is not a patch falls back to plain text instead of failing.
function renderPatch(text) {
  const source = String(text);
  const files = parsePatch(source);
  if (!files) return previewBlock(source, BLOCK_PREVIEW_CHARS);
  return files.map(file => {
    const body = file.lines.join("\n");
    const label = element("span", "");
    label.append(badge(fileOpLabel(file.moveTo ? "move" : file.op), FILE_OP_TONES[file.op] || ""));
    if (body.trim()) label.append(badge(file.op === "add" ? sizeStat(body) : diffStats(body)));
    return fileCard(
      file.moveTo ? `${file.path} → ${file.moveTo}` : file.path,
      label,
      body.trim() ? diffBlock(body) : null,
      file.op === "add" ? gettext("Content") : gettext("Diff"),
    );
  });
}

const RENDERERS = {
  text: value => previewBlock(String(value), OUTPUT_PREVIEW_CHARS),
  patch: value => renderPatch(value),
  short: value => element("span", "insight-value", String(value)),
  code: value => codeBlock(String(value)),
  path: value => pathChip(String(value)),
  pathmap: value => renderPathMap(value),
  diff: value => diffBlock(String(value)),
  tokens: value => renderTokens(value),
  list: value => renderResultList(Array.isArray(value) ? value : [value]),
  steps: value => renderSteps(Array.isArray(value) ? value : [value]),
  image: value => renderImages(value),
  json: value => renderJson(value),
};

// --- sections ----------------------------------------------------------------

// Every step, whatever its type, renders these sections in this order. Users
// learn the layout once instead of per type.
export const SECTION_ORDER = ["what", "where", "input", "output", "status", "timing", "provenance"];

function sectionLabel(role) {
  return {
    what: gettext("What"),
    where: gettext("Where"),
    input: gettext("Input"),
    output: gettext("Result"),
    status: gettext("Status"),
    timing: gettext("Timing"),
    provenance: gettext("Provenance"),
  }[role] || role;
}

function missingText(status) {
  if (status === "empty") return gettext("empty");
  if (status === "unreadable") return gettext("unreadable");
  return gettext("not in the log");
}

function missingHint(status) {
  if (status === "empty") return gettext("The field is present in the log but has no value.");
  if (status === "unreadable") return gettext("The value could not be decoded — see the Source records layer below.");
  return gettext("Codex did not record this field for this step.");
}

function missingChip(slot, status) {
  const chip = element("span", `slot-missing is-${status}`);
  chip.append(element("span", "slot-missing-label", slot.label), document.createTextNode(missingText(status)));
  chip.title = missingHint(status);
  return chip;
}

function valueNode(slot, picked) {
  const renderer = RENDERERS[slot.render] || RENDERERS.short;
  const node = renderer(picked.value, slot, picked);
  if (!node) return null;
  const nodes = Array.isArray(node) ? node : [node];
  nodes.forEach(entry => {
    if (!entry.title) {
      entry.title = picked.source === "computed"
        ? gettext("Calculated by the view from the data below.")
        : interpolate(gettext("Source: %s"), [picked.source]);
    }
  });
  return nodes;
}

function badgeFor(slot, picked) {
  const text = slot.badge ? slot.badge(picked.value) : `${slot.label}: ${picked.value}`;
  const tone = slot.tone ? slot.tone(picked.value) : "";
  const node = badge(text, tone);
  node.title = interpolate(gettext("Source: %s"), [picked.source]);
  return node;
}

/**
 * Renders one descriptor against one interaction.
 * Returns { nodes, filled, defined, missing } so the caller can show coverage.
 */
export function renderSlots(slots, ctx) {
  const nodes = [];
  let filled = 0;
  let defined = 0;
  const missing = [];
  SECTION_ORDER.forEach(role => {
    const inSection = slots.filter(slot => slot.role === role && (!slot.when || slot.when(ctx)));
    if (!inSection.length) return;
    const body = [];
    const badges = [];
    const rows = [];
    const chips = [];
    inSection.forEach(slot => {
      const picked = pick(slot, ctx);
      if (picked.status !== "ok") {
        // Slots that hide when absent are optional extras for this type; they
        // would make the coverage counter meaningless.
        if (slot.missing !== "hide") {
          defined += 1;
          chips.push(missingChip(slot, picked.status));
          missing.push(slot.label);
        }
        return;
      }
      defined += 1;
      filled += 1;
      // Alternate spellings of the same value, so the "not shown above" list
      // does not report them as forgotten.
      (slot.consumes || []).forEach(key => ctx.used.add(key));
      if (slot.render === "badges") {
        badges.push(badgeFor(slot, picked));
        return;
      }
      if (slot.render === "kv") {
        rows.push([slot.label, slot.format ? slot.format(picked.value) : String(picked.value)]);
        return;
      }
      const rendered = valueNode(slot, picked);
      if (!rendered) return;
      body.push(slot.bare ? rendered[0] : segmentBlock(slot.label, rendered));
      rendered.slice(1).forEach(extra => body.push(extra));
    });
    const badgesNode = badgeRow(badges);
    const table = kvTable(rows);
    if (!body.length && !badgesNode && !table && !chips.length) return;
    const section = element("section", `insight-section role-${role}`);
    section.append(element("div", "insight-section-title", sectionLabel(role)));
    if (badgesNode) section.append(badgesNode);
    if (table) section.append(table);
    body.forEach(node => section.append(node));
    if (chips.length) {
      const row = element("div", "slot-missing-row");
      chips.forEach(chip => row.append(chip));
      section.append(row);
    }
    nodes.push(section);
  });
  return { nodes, filled, defined, missing };
}

// Keys of the source records that no slot consumed. Shown collapsed at the
// bottom: for the reader it explains "nothing was hidden", for us it is a
// self-maintaining TODO list when Codex adds new fields.
const IGNORED_KEYS = new Set([
  "type", "id", "item", "payload", "thread_id", "turn_id", "record_type",
  // Envelope plumbing shown by the raw-record cards themselves.
  "ordinal", "timestamp", "internal_chat_message_metadata_passthrough",
]);

export function unusedKeys(ctx) {
  const seen = new Set();
  const collect = (source, entries) => {
    entries.forEach(entry => {
      if (!entry || typeof entry !== "object") return;
      Object.keys(entry).forEach(key => {
        if (IGNORED_KEYS.has(key)) return;
        if (ctx.used.has(key)) return;
        const value = entry[key];
        if (value === null || value === undefined || isEmptyValue(value)) return;
        seen.add(key);
      });
    });
  };
  collect("items", ctx.items);
  collect("payloads", ctx.payloads);
  collect("records", ctx.records);
  return [...seen].sort();
}

export function coverageChip(filled, defined, missing) {
  const chip = element("span", "insight-coverage", interpolate(
    gettext("%s of %s fields"), [filled, defined]));
  chip.title = missing.length
    ? `${gettext("Not filled:")} ${missing.join(", ")}`
    : gettext("Every field defined for this step type was found.");
  return chip;
}

export function unmappedBlock(keys) {
  if (!keys.length) return null;
  const details = element("details", "insight-unmapped");
  details.append(element("summary", "", interpolate(
    ngettext("%s field not shown above", "%s fields not shown above", keys.length), [keys.length])));
  details.append(element("p", "section-hint", gettext(
    "These keys exist in the source records but have no place in this view yet. The full data is in the layers below.")));
  details.append(codeBlock(keys.join(", ")));
  return details;
}
