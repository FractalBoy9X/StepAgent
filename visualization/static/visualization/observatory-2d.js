// Entry module: parses the server-inlined payload, builds the shared context
// object, wires all events, and bootstraps the 2D observatory.
// The Activity Matrix and Turn Lanes views live in observatory-views.js;
// selection and the details panel live in observatory-selection.js.

// The ?v= query busts the browser cache (the dev server sends no Cache-Control
// headers). Bump it EVERYWHERE at once whenever any front-end file changes:
// the imports below, the sibling modules, the template's <script> tag, and the
// <link rel="stylesheet"> tags — new markup against a cached stylesheet renders
// unstyled. test_every_static_asset_shares_one_cache_bust_version enforces it.
import { UNKNOWN_FAMILY_COLOR } from "./observatory-labels.js?v=9";
import { createViews } from "./observatory-views.js?v=9";
import { createSelection } from "./observatory-selection.js?v=9";

// Re-rendering up to MAX_TABLE_ROWS rows per keystroke is wasteful; wait for
// a short pause in typing instead.
const SEARCH_DEBOUNCE_MS = 150;
// Resizing is continuous; re-measuring the lanes on every frame is wasteful.
const RESIZE_DEBOUNCE_MS = 200;

function readDom() {
  return {
    stage: document.getElementById("chart-stage"),
    empty: document.getElementById("chart-empty"),
    turnFilter: document.getElementById("turn-filter"),
    tableBody: document.getElementById("node-table-body"),
    search: document.getElementById("node-search"),
    familyFilter: document.getElementById("family-filter"),
    kindFilter: document.getElementById("kind-filter"),
    statusFilter: document.getElementById("status-filter"),
    lifecycleFilter: document.getElementById("lifecycle-filter"),
    selection: document.getElementById("selection-box"),
    relations: document.getElementById("node-relations"),
    legend: document.getElementById("family-legend"),
    visibleCount: document.getElementById("visible-count"),
    visibleErrors: document.getElementById("visible-errors"),
    visibleCountLabel: document.getElementById("visible-count-label"),
    visibleErrorsLabel: document.getElementById("visible-errors-label"),
  };
}

function setActive(selector, predicate) {
  document.querySelectorAll(selector).forEach(item => {
    const active = predicate(item);
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
}

function debounce(callback, delayMs) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(callback, delayMs);
  };
}

function buildContext(payload) {
  const turns = payload.turns || [];
  const families = payload.families || [];
  const allNodes = payload.nodes || [];
  const steps = turns.flatMap(turn => turn.steps || []);
  return {
    payload,
    selectedFile: document.getElementById("selected-session-file")?.value || "",
    dom: readDom(),
    turns,
    edges: payload.edges || [],
    steps,
    nodeMap: new Map(allNodes.map(node => [node.node_id, node])),
    stepMap: new Map(steps.map(step => [step.node_id, step])),
    // Family order and colors come from the server payload (single source of
    // truth shared with the instructions page); labels stay in the JS catalog.
    familyOrder: families.map(family => family.id),
    familyColors: new Map(families.map(family => [family.id, family.color])),
    unknownFamilyColor: UNKNOWN_FAMILY_COLOR,
    // expandedTurns lives here, not in the DOM: renderChart() rebuilds the
    // lanes on every view, density and turn-filter change.
    state: { mode: "turns", turn: "all", density: "comfortable", selectionIds: [], expandedTurns: new Set() },
    setActive,
  };
}

function wireEvents(ctx) {
  const { dom, state, views, selection } = ctx;

  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    state.mode = button.dataset.view;
    setActive("[data-view]", item => item === button);
    views.renderChart();
  }));
  document.querySelectorAll("[data-density]").forEach(button => button.addEventListener("click", () => {
    state.density = button.dataset.density;
    setActive("[data-density]", item => item === button);
    views.renderChart();
  }));
  dom.turnFilter.addEventListener("change", () => {
    state.turn = dom.turnFilter.value;
    views.renderChart();
  });

  dom.search.addEventListener("input", debounce(views.renderRows, SEARCH_DEBOUNCE_MS));
  [dom.familyFilter, dom.kindFilter, dom.statusFilter, dom.lifecycleFilter].forEach(select => {
    select.addEventListener("change", views.renderRows);
  });

  dom.stage.addEventListener("click", event => {
    const toggle = event.target.closest("[data-turn-copy]");
    if (!toggle) return;
    const turnId = toggle.dataset.turnCopy;
    if (!state.expandedTurns.delete(turnId)) state.expandedTurns.add(turnId);
    views.renderChart();
  });
  dom.stage.addEventListener("click", selection.handleSelection);
  dom.tableBody.addEventListener("click", event => {
    const row = event.target.closest("[data-node-id]");
    if (row) selection.selectIds([row.dataset.nodeId]);
  });
  dom.selection.addEventListener("click", selection.handleSelection);
  dom.relations.addEventListener("click", selection.handleSelection);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") selection.clearSelection();
  });
  // A narrower window fits fewer characters per line, so a message that needed
  // no expand control may now need one, and the other way round.
  window.addEventListener("resize", debounce(views.refreshCopyToggles, RESIZE_DEBOUNCE_MS));
}

function main() {
  const source = document.getElementById("observatory-2d-data");
  if (!source) return;
  const ctx = buildContext(JSON.parse(source.textContent));
  ctx.selection = createSelection(ctx);
  ctx.views = createViews(ctx);
  wireEvents(ctx);
  ctx.views.fillFilters();
  ctx.views.renderRows();
  ctx.views.renderChart();
}

main();
