// Selection state, the details panel (including the lazy /api/interaction/
// fetch for raw records), and relation buttons.

import {
  gettext, ngettext, interpolate,
  kindLabels, lifecycleLabels, statusLabels, edgeLabels,
  translatedLabel, errorsLabel, interactionsLabel,
} from "./observatory-labels.js?v=9";
import { element, isError } from "./observatory-views.js?v=9";
import { buildInsight, previewBlock, segmentBlock, pathChip } from "./observatory-insights.js?v=9";

// Relation buttons rendered per selected node before cutting off.
const MAX_RELATIONS = 30;
// Edge kinds pointing at file artifacts: shown as a Resources segment inside
// the Content layer (next to what the step actually did), not as relations.
const ARTIFACT_EDGES = new Set(["reads", "references", "patches", "copies", "creates", "deletes", "writes", "moves"]);
// Structural edges repeat what the field list already says (turn, agent).
const STRUCTURAL_EDGES = new Set(["contains", "produced"]);
// JSON previews start truncated so a huge interaction cannot freeze the panel;
// a visible notice plus a "show everything" button keeps the full data reachable.
const NORMALIZED_PREVIEW_CHARS = 8000;
const RAW_PREVIEW_CHARS = 14000;
const COPY_FEEDBACK_MS = 1500;

// Fields already rendered by the title or fieldList(); the normalized-interaction
// section shows only what is new, with the full JSON one click away.
const FIELDS_SHOWN_ELSEWHERE = new Set([
  "index", "label", "detail", "family", "kind", "subkind", "role", "status",
  "lifecycle", "timestamp", "timestamp_ms", "duration_ms",
  "turn_id", "turn_number", "conversation_turn_id", "conversation_turn_number",
  "conversation_turn_kind", "started_at_ms", "completed_at_ms",
]);

function isEmptyValue(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function derivedFields(interaction) {
  return Object.fromEntries(Object.entries(interaction)
    .filter(([key, value]) => !FIELDS_SHOWN_ELSEWHERE.has(key) && !isEmptyValue(value)));
}

export function createSelection(ctx) {
  const { dom, state } = ctx;
  const groups = new Map();
  let groupCounter = 0;
  let rawRequest = 0;

  function resetGroups() {
    groups.clear();
    groupCounter = 0;
  }

  function registerGroup(ids) {
    const key = `group-${groupCounter}`;
    groupCounter += 1;
    groups.set(key, ids);
    return key;
  }

  // One element can address a single node (data-node-id) or a stored group of
  // nodes (data-selection-key); this resolves either to a list of node ids.
  function resolveSelectionIds(target) {
    return target.dataset.nodeId ? [target.dataset.nodeId] : (groups.get(target.dataset.selectionKey) || []);
  }

  function selectionButton(ids, label, className) {
    const button = element("button", className);
    button.type = "button";
    button.title = label;
    if (ids.length === 1) button.dataset.nodeId = ids[0];
    else button.dataset.selectionKey = registerGroup(ids);
    return button;
  }

  function updateHighlight() {
    const selected = new Set(state.selectionIds);
    document.querySelectorAll("[data-node-id], [data-selection-key]").forEach(node => {
      node.classList.toggle("active", resolveSelectionIds(node).some(id => selected.has(id)));
    });
  }

  // The band is only one line tall when nothing is selected, so the placeholder
  // has to say what fills it. Kept identical to the server-rendered one in
  // execution_observatory.html, which this replaces after Escape.
  function renderEmptySelection() {
    const hint = `${gettext("No interaction selected.")} ${gettext("Click a step, a table row, or a matrix cell — its details will appear here.")}`;
    setSelectionLayout("empty");
    dom.selection.replaceChildren(element("p", "selection-empty muted", hint));
    dom.relations.replaceChildren();
  }

  // The band renders as columns only when it has something to lay out; the
  // placeholder stays a plain block so it does not sit in a 280px cell.
  function setSelectionLayout(mode) {
    dom.selection.classList.toggle("is-detail", mode === "detail");
    dom.selection.classList.toggle("is-group", mode === "group");
  }

  function clearSelection() {
    if (!state.selectionIds.length) return;
    rawRequest += 1;
    state.selectionIds = [];
    updateHighlight();
    renderEmptySelection();
  }

  // Family rendered with its legend color, status with a success/error tint,
  // so the panel reads at a glance instead of as a wall of equal-weight text.
  function familyValue(node) {
    if (!node.family) return "-";
    const info = ctx.views.familyInfo(node.family);
    const value = element("span", "family-value");
    const swatch = element("span", "family-swatch");
    swatch.style.setProperty("--family-color", info.color);
    value.append(swatch, document.createTextNode(info.label));
    return value;
  }

  function statusValue(node) {
    const tone = isError(node) ? " is-error" : node.status === "success" ? " is-success" : "";
    return element("span", `status-value${tone}`, translatedLabel(statusLabels, node.status));
  }

  // The agent that produced this step, recovered from the structural edge the
  // relations list no longer shows.
  function agentName(nodeId) {
    const edge = ctx.edges.find(e => e.kind === "produced" && e.target === nodeId);
    const agent = edge && ctx.nodeMap.get(edge.source);
    return agent && agent.kind === "agent" ? agent.label.replace(/^Agent:\s*/, "") : "";
  }

  function fieldList(node) {
    const fields = [
      [gettext("Family"), familyValue(node)],
      [gettext("Type"), translatedLabel(kindLabels, node.kind)],
      [gettext("Subkind"), node.subkind || "-"],
      [gettext("Conversation turn"), node.conversation_turn_kind === "initialization" ? gettext("Session initialization") : String(node.conversation_turn_number ?? "-")],
      [gettext("Source turn"), `${node.turn_number ?? "-"}${node.turn_id ? ` (${node.turn_id})` : ""}`],
      [gettext("Timestamp"), node.timestamp || "-"],
      [gettext("Role"), node.role || "-"],
      [gettext("Agent"), agentName(node.node_id) || "-"],
      [gettext("Lifecycle"), translatedLabel(lifecycleLabels, node.lifecycle)],
      [gettext("Status"), statusValue(node)],
      [gettext("Duration"), node.duration_ms == null ? "-" : `${Math.round(node.duration_ms)} ms`],
    ];
    const list = element("dl", "selection-fields");
    fields.forEach(([name, value]) => {
      const dd = element("dd", "");
      if (typeof value === "string") dd.textContent = value;
      else dd.append(value);
      list.append(element("dt", "", name), dd);
    });
    return list;
  }

  // A named, collapsible layer of the details panel (native <details>, so it
  // works without extra JS and matches the "i" help popovers).
  function detailSection(title, hint, open) {
    const details = element("details", "selection-section");
    details.open = Boolean(open);
    details.append(element("summary", "", title));
    const body = element("div", "selection-section-body");
    if (hint) body.append(element("p", "section-hint", hint));
    details.append(body);
    return [details, body];
  }

  function copyButton(text) {
    const button = element("button", "btn copy-btn", gettext("Copy JSON"));
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = gettext("Copied");
      } catch {
        button.textContent = gettext("Copy failed");
      }
      setTimeout(() => { button.textContent = gettext("Copy JSON"); }, COPY_FEEDBACK_MS);
    });
    return button;
  }

  // One original JSONL log line: envelope metadata in the header, the exact
  // record payload underneath.
  function rawRecordCard(record) {
    const card = element("article", "raw-record");
    const head = element("header", "raw-record-head");
    head.append(element("span", "record-badge", record.rollout_type || "?"));
    const subtype = record.event_type || record.response_item_type;
    if (subtype) head.append(element("span", "record-badge subtype", subtype));
    head.append(element("span", "record-meta", `#${record.index}${record.timestamp ? ` · ${record.timestamp}` : ""}`));
    card.append(head, previewBlock(JSON.stringify(record.record ?? {}, null, 2), RAW_PREVIEW_CHARS));
    return card;
  }

  function buildDetailSections(detail) {
    const interaction = detail.interaction || {};
    const rawRecords = detail.raw_records || [];

    const [content, contentBody] = detailSection(gettext("Content"), "", true);
    // Type-aware view first (command lines, diffs, token grids, …); plain
    // text when no presenter applies; the lower layers always keep it all.
    const insight = buildInsight(interaction, rawRecords);
    if (insight) contentBody.append(...insight);
    else if (interaction.detail) contentBody.append(previewBlock(interaction.detail, NORMALIZED_PREVIEW_CHARS));
    else contentBody.append(element("p", "section-hint", gettext("This step has no text content.")));
    const resources = resourceRows(interaction.interaction_id);
    if (resources.length) contentBody.append(segmentBlock(gettext("Resources"), resources));

    const [normalized, normalizedBody] = detailSection(
      gettext("Normalized interaction"),
      gettext("What the parser derived from the source records below. Fields already listed above are omitted here."),
      false,
    );
    const fullJson = JSON.stringify(interaction, null, 2);
    normalizedBody.append(previewBlock(JSON.stringify(derivedFields(interaction), null, 2), NORMALIZED_PREVIEW_CHARS));
    const full = element("details", "selection-subsection");
    full.append(element("summary", "", gettext("Full JSON")));
    full.append(previewBlock(fullJson, NORMALIZED_PREVIEW_CHARS));
    normalizedBody.append(full, copyButton(fullJson));

    const [raw, rawBody] = detailSection(
      interpolate(ngettext("Source records (%s log line)", "Source records (%s log lines)", rawRecords.length), [rawRecords.length]),
      gettext("The exact lines from the JSONL log file this step was built from."),
      false,
    );
    rawRecords.forEach(record => rawBody.append(rawRecordCard(record)));
    rawBody.append(copyButton(JSON.stringify(rawRecords, null, 2)));

    // Named, because the three layers land in two different band columns.
    return { content, normalized, raw };
  }

  function stepChipText(node) {
    const number = node.step_number ? `#${String(node.step_number).padStart(2, "0")} ` : "";
    return `${number}${translatedLabel(kindLabels, node.kind)}`;
  }

  // Previous / next step from the chronology edges, as a compact nav bar
  // instead of two full-label relation buttons.
  function chronologyNav(nodeId) {
    const previousEdge = ctx.edges.find(edge => edge.kind === "next" && edge.target === nodeId);
    const nextEdge = ctx.edges.find(edge => edge.kind === "next" && edge.source === nodeId);
    const make = (id, formatText) => {
      const node = ctx.stepMap.get(id) || ctx.nodeMap.get(id);
      if (!node) return null;
      const button = selectionButton([id], node.label, "btn step-nav-btn");
      button.textContent = formatText(stepChipText(node));
      return button;
    };
    const previous = previousEdge && make(previousEdge.source, text => `‹ ${text}`);
    const next = nextEdge && make(nextEdge.target, text => `${text} ›`);
    if (!previous && !next) return null;
    const nav = element("nav", "step-nav");
    nav.append(previous || element("span", ""), next || element("span", ""));
    return nav;
  }

  // File artifacts this step touched, shown with the step's content:
  // verb + directory + file name, each row selectable.
  function resourceRows(nodeId) {
    const rows = [];
    ctx.edges.forEach(edge => {
      if (edge.source !== nodeId || !ARTIFACT_EDGES.has(edge.kind)) return;
      const target = ctx.nodeMap.get(edge.target);
      if (!target || target.kind !== "artifact") return;
      const button = selectionButton([edge.target], target.label, "resource-row");
      button.append(element("span", "resource-verb", translatedLabel(edgeLabels, edge.kind)), pathChip(target.label));
      rows.push(button);
    });
    return rows;
  }

  // Only causal edges remain here (invokes, triggered, retries, …); structure
  // is in the field list, chronology in the nav bar, artifacts under Content.
  function relationButtons(nodeId) {
    dom.relations.replaceChildren();
    const causal = ctx.edges.filter(edge =>
      (edge.source === nodeId || edge.target === nodeId)
      && edge.kind !== "next"
      && !STRUCTURAL_EDGES.has(edge.kind)
      && !ARTIFACT_EDGES.has(edge.kind));
    if (!causal.length) return;
    const groups = new Map();
    causal.slice(0, MAX_RELATIONS).forEach(edge => {
      const outgoing = edge.source === nodeId;
      const key = `${edge.kind}:${outgoing ? "out" : "in"}`;
      if (!groups.has(key)) groups.set(key, { kind: edge.kind, outgoing, ids: [] });
      groups.get(key).ids.push(outgoing ? edge.target : edge.source);
    });
    const list = element("div", "relation-groups");
    groups.forEach(group => {
      const row = element("div", "relation-group");
      const verb = translatedLabel(edgeLabels, group.kind);
      row.append(element("span", "relation-verb", group.outgoing ? `${verb} →` : `← ${verb}`));
      group.ids.forEach(id => {
        const other = ctx.nodeMap.get(id);
        const button = selectionButton([id], other?.label || id, "btn relation-btn");
        button.textContent = other ? stepChipText(other) : id;
        row.append(button);
      });
      list.append(row);
    });
    dom.relations.append(element("div", "insight-output-label", gettext("Relations")), list);
  }

  function showInTurnLanes(node) {
    state.mode = "turns";
    state.turn = node.conversation_turn_id;
    dom.turnFilter.value = state.turn;
    ctx.setActive("[data-view]", button => button.dataset.view === state.mode);
    ctx.views.renderChart();
    const marker = dom.stage.querySelector(`[data-node-id="${CSS.escape(node.node_id)}"]`);
    marker?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }

  async function renderExactSelection(node) {
    // Three columns instead of one long scroll: what the step is (left), what
    // it did (middle), and the parser/log layers behind it (right).
    const side = element("div", "selection-col-side");
    const main = element("div", "selection-col-main");
    const layers = element("div", "selection-col-layers");
    setSelectionLayout("detail");
    dom.selection.replaceChildren(side, main, layers);
    const title = element("div", "selection-title");
    title.append(
      element("strong", "", node.label),
      element("span", "", interpolate(gettext("Step %s · index %s"), [node.step_number || "-", node.interaction_index ?? "-"])),
    );
    side.append(title);
    const nav = chronologyNav(node.node_id);
    if (nav) side.append(nav);
    if (ctx.stepMap.has(node.node_id)) {
      const actions = element("div", "selection-actions");
      const showButton = element("button", "btn", gettext("Show in Turn Lanes"));
      showButton.type = "button";
      showButton.addEventListener("click", () => showInTurnLanes(node));
      actions.append(showButton);
      side.append(actions);
    }
    side.append(fieldList(node));
    // Instant preview from the 2D payload; replaced by the full, sectioned
    // detail once /api/interaction/ answers (interaction nodes only).
    const preview = node.detail ? element("pre", "selection-detail", node.detail) : null;
    if (preview) main.append(preview);
    relationButtons(node.node_id);

    if (!node.node_id.startsWith("interaction:")) return;
    const requestId = ++rawRequest;
    const loading = element("p", "selection-loading muted", gettext("Loading raw records…"));
    dom.selection.setAttribute("aria-busy", "true");
    main.append(loading);
    try {
      const response = await fetch(`/api/interaction/?file=${encodeURIComponent(ctx.selectedFile)}&id=${encodeURIComponent(node.node_id)}`);
      if (requestId !== rawRequest) return;
      if (!response.ok) {
        loading.remove();
        main.append(element("div", "flash error", interpolate(gettext("Raw records unavailable: %s"), [`HTTP ${response.status}`])));
        return;
      }
      const detail = await response.json();
      if (requestId !== rawRequest) return;
      loading.remove();
      preview?.remove();
      const { content, normalized, raw } = buildDetailSections(detail);
      main.append(content);
      layers.append(normalized, raw);
    } catch (error) {
      if (requestId === rawRequest) {
        loading.remove();
        main.append(element("div", "flash error", interpolate(gettext("Raw records unavailable: %s"), [error])));
      }
    } finally {
      if (requestId === rawRequest) dom.selection.removeAttribute("aria-busy");
    }
  }

  // A group has nothing to put in the third column, so it stays two columns:
  // the count on the left, the pickable list next to it.
  function renderGroupSelection(selectedSteps) {
    const side = element("div", "selection-col-side");
    const main = element("div", "selection-col-main");
    setSelectionLayout("group");
    dom.selection.replaceChildren(side, main);
    dom.relations.replaceChildren();
    const errors = selectedSteps.filter(isError).length;
    const title = element("div", "selection-title");
    title.append(element("strong", "", interactionsLabel(selectedSteps.length)), element("span", "", errorsLabel(errors)));
    const list = element("div", "selection-list");
    selectedSteps.forEach(step => {
      const button = selectionButton([step.node_id], step.label, "selection-item");
      button.append(element("span", "", `#${step.step_number || step.interaction_index}`), element("strong", "", step.label));
      list.append(button);
    });
    side.append(title);
    main.append(list);
  }

  // fromChart tells the two scroll follow-ups apart: a chart click has to bring
  // the matching table row into view, while a click anywhere else (table row,
  // relation button, step nav) may need the band itself scrolled to. Never both
  // — scrolling to the band after a chart click would push the lanes, and the
  // marker just clicked, out from under the pointer.
  function selectIds(ids, fromChart = false) {
    const selectedSteps = ids.map(id => ctx.stepMap.get(id) || ctx.nodeMap.get(id)).filter(Boolean);
    if (!selectedSteps.length) return;
    rawRequest += 1;
    state.selectionIds = selectedSteps.map(node => node.node_id);
    updateHighlight();
    if (selectedSteps.length === 1) renderExactSelection(selectedSteps[0]);
    else renderGroupSelection(selectedSteps);
    if (fromChart) {
      if (selectedSteps.length === 1) {
        dom.tableBody.querySelector(`[data-node-id="${CSS.escape(selectedSteps[0].node_id)}"]`)?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    // "nearest" is a no-op while the band is already fully visible.
    dom.selection.closest(".selection-band")?.scrollIntoView({ block: "nearest" });
  }

  function handleSelection(event) {
    const target = event.target.closest("[data-node-id], [data-selection-key]");
    if (!target || target.disabled) return;
    selectIds(resolveSelectionIds(target), target.closest("#chart-stage") !== null);
  }

  return {
    resetGroups,
    selectionButton,
    updateHighlight,
    clearSelection,
    selectIds,
    handleSelection,
  };
}
