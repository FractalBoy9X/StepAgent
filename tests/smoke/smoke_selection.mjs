// Headless smoke test for the reworked Selection panel (001_cleaning).
// Loads the real page from the dev server, imports the real ES modules into a
// jsdom window, and verifies the three-layer detail sections end to end.
import { JSDOM } from "jsdom";

// Usage: start the dev server, run `npm install jsdom` in the repo root, then
//   SMOKE_BASE=http://127.0.0.1:8000 node tests/smoke/smoke_selection.mjs
// The insight section needs the 2026-06-01 session listed in INSIGHT_FILE
// to be imported; without it the script fails at "command step selected".
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8000";
// Canonical section order of the Content layer (observatory-fields.js).
const ORDER = ["role-what", "role-where", "role-input", "role-output", "role-status", "role-timing", "role-provenance"];
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "visualization", "static", "visualization");
const realFetch = globalThis.fetch.bind(globalThis);

let passed = 0;
function check(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

async function waitFor(predicate, label, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const pageHtml = await (await realFetch(`${BASE}/visualization/`)).text();
const dom = new JSDOM(pageHtml, { url: `${BASE}/visualization/` });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CSS = dom.window.CSS ?? { escape: value => value.replace(/([^a-zA-Z0-9_-])/g, "\\$1") };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

// Relative URLs from module code -> dev server; one hook lets a test inflate
// the interaction detail to exercise honest truncation.
let mutateDetail = null;
globalThis.fetch = async (input, init) => {
  const url = String(input).startsWith("http") ? String(input) : `${BASE}${input}`;
  const response = await realFetch(url, init);
  if (mutateDetail && url.includes("/api/interaction/")) {
    const data = await response.json();
    return { ok: true, status: 200, json: async () => mutateDetail(data) };
  }
  return response;
};

const clipboardWrites = [];
Object.defineProperty(dom.window.navigator, "clipboard", {
  value: { writeText: async text => { clipboardWrites.push(text); } },
  configurable: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

await import(`${STATIC_DIR}/observatory-2d.js?cacheBust=${Date.now()}`);

const doc = dom.window.document;
check("legend renders all 14 families", doc.querySelectorAll("#family-legend .legend-item").length === 14);

// --- the band sits above the chart, empty and self-explaining ---------------
const band = doc.querySelector("#selection-band");
check("selection band exists", Boolean(band));
check("selection band precedes the chart stage", Boolean(
  band.compareDocumentPosition(doc.querySelector("#chart-stage"))
  & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
));
check("selection box lives inside the band", doc.querySelector("#selection-band #selection-box") !== null);
check("relations live inside the band", doc.querySelector("#selection-band #node-relations") !== null);
check("side column is down to two panels", doc.querySelectorAll(".side-column .side-panel").length === 2);
const emptyText = doc.querySelector("#selection-box .selection-empty").textContent;
check("empty state names what fills the band", emptyText.includes("No interaction selected.") && emptyText.includes("matrix cell"));
check("empty state stays a plain block", !doc.querySelector("#selection-box").classList.contains("is-detail"));

// --- select a real interaction row -----------------------------------------
const row = [...doc.querySelectorAll("#node-table-body [data-node-id]")]
  .find(item => item.dataset.nodeId.startsWith("interaction:"));
check("table has interaction rows", Boolean(row));
row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await waitFor(() => doc.querySelectorAll("#selection-box .selection-section").length === 3, "three detail sections");

const summaries = [...doc.querySelectorAll("#selection-box .selection-section > summary")].map(node => node.textContent);
check("Content section visible", summaries[0] === "Content");
check("Normalized interaction section visible", summaries[1] === "Normalized interaction");
check("Source records section shows log-line count", /^Source records \(\d+ log lines?\)$/.test(summaries[2]));

const sections = doc.querySelectorAll("#selection-box .selection-section");
check("Content section open by default", sections[0].open === true);
check("Normalized and raw sections collapsed", !sections[1].open && !sections[2].open);
// Scoped to the column, not to #selection-box: the instant preview moved one
// level deeper, so `#selection-box > .selection-detail` would now pass whether
// or not it was replaced. A plain descendant selector is too wide the other
// way — .selection-detail also styles the previews inside the layers.
check("no stray inline detail preview left behind", !doc.querySelector("#selection-box .selection-col-main > .selection-detail"));

// --- three columns instead of one long scroll -------------------------------
check("band switched to the detail layout", doc.querySelector("#selection-box").classList.contains("is-detail"));
check("column 1 carries the field list", doc.querySelector("#selection-box .selection-col-side .selection-fields") !== null);
check("column 2 carries Content alone", doc.querySelectorAll("#selection-box .selection-col-main .selection-section").length === 1);
check("column 2 section is Content", doc.querySelector("#selection-box .selection-col-main .selection-section > summary").textContent === "Content");
check("column 3 carries the two deeper layers", doc.querySelectorAll("#selection-box .selection-col-layers .selection-section").length === 2);
check("normalized section has explanatory hint", sections[1].querySelector(".section-hint") !== null);
check("normalized section offers Full JSON", sections[1].querySelector(".selection-subsection > summary").textContent === "Full JSON");

const cards = sections[2].querySelectorAll(".raw-record");
check("one card per raw record", cards.length >= 1);
check("card header shows envelope badge", cards[0].querySelector(".record-badge") !== null);
check("card body is valid JSON of the record alone", (() => {
  // Expand first when the record is big enough to be (honestly) truncated.
  cards[0].querySelector(".truncation-note button")
    ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const parsed = JSON.parse(cards[0].querySelector("pre").textContent);
  return typeof parsed === "object" && !("raw_id" in parsed);
})());

const copyButtons = [...doc.querySelectorAll("#selection-box .copy-btn")];
check("copy buttons on JSON layers", copyButtons.length === 2);
copyButtons[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await waitFor(() => clipboardWrites.length === 1, "clipboard write");
check("copy button copies full valid JSON", (() => { JSON.parse(clipboardWrites[0]); return true; })());

// --- honest truncation ------------------------------------------------------
// Asserted on the Normalized layer, because that one renders the same JSON for
// every step type; the Content layer's limits depend on the presenter.
const HUGE = 20000;
mutateDetail = data => {
  data.interaction.detail = "x".repeat(HUGE);
  return data;
};
const otherRow = [...doc.querySelectorAll("#node-table-body [data-node-id]")]
  .find(item => item.dataset.nodeId.startsWith("interaction:") && item !== row);
(otherRow ?? row).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await waitFor(() => doc.querySelector("#selection-box .selection-col-layers .truncation-note"), "truncation notice");
const note = doc.querySelector("#selection-box .selection-col-layers .truncation-note");
check("truncation notice states shown vs total",
  note.textContent.includes("8000") && /\b2\d{4}\b/.test(note.textContent));
const contentPre = note.parentElement.querySelector("pre");
check("preview cut at the limit", contentPre.textContent.length === 8000);
note.querySelector("button").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
check("Show full content reveals everything", contentPre.textContent.length > HUGE);
check("notice removed after expanding", !note.isConnected);
mutateDetail = null;

// --- escape restores the placeholder ----------------------------------------
doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("Escape restores placeholder", doc.querySelector("#selection-box .selection-empty") !== null);
// The JS placeholder must carry the same hint as the server-rendered one, or
// the collapsed band goes back to an unexplained thin line.
check("restored placeholder keeps the hint", doc.querySelector("#selection-box .selection-empty").textContent === emptyText);
check("Escape drops the column layout", !doc.querySelector("#selection-box").classList.contains("is-detail"));

// --- type-aware insights (fresh page on a session with rich step kinds) ------
const INSIGHT_FILE = "2026__06__01__rollout-2026-06-01T19-30-51-019e843d-0497-7602-9f39-fde1be8519ef.v4.json";
const html2 = await (await realFetch(`${BASE}/visualization/?file=${INSIGHT_FILE}`)).text();
const dom2 = new JSDOM(html2, { url: `${BASE}/visualization/?file=${INSIGHT_FILE}` });
globalThis.window = dom2.window;
globalThis.document = dom2.window.document;
dom2.window.HTMLElement.prototype.scrollIntoView = () => {};
await import(`${STATIC_DIR}/observatory-2d.js?cacheBust=insights-${Date.now()}`);
const doc2 = dom2.window.document;
const payload = JSON.parse(doc2.getElementById("observatory-2d-data").textContent);
const steps = payload.turns.flatMap(turn => turn.steps || []);

async function selectStep(predicate, label) {
  const step = steps.find(predicate);
  if (!step) throw new Error(`no step for: ${label}`);
  const stepRow = doc2.querySelector(`#node-table-body [data-node-id="${step.node_id}"]`);
  if (!stepRow) throw new Error(`no table row for: ${label}`);
  stepRow.dispatchEvent(new dom2.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => doc2.querySelectorAll("#selection-box .selection-section").length === 3, label);
  return doc2.querySelectorAll("#selection-box .selection-section")[0];
}

let content = await selectStep(step => step.kind === "command", "command step selected");
check("command: command line block", content.querySelector(".insight-code") !== null);
check("command: exit code badge", [...content.querySelectorAll(".insight-badge")].some(b => b.textContent.startsWith("exit code")));
check("command: labeled output block", content.querySelector(".insight-output-label") !== null);
check("step nav bar rendered", doc2.querySelector("#selection-box .step-nav .step-nav-btn") !== null);
check("agent shown as a field row", [...doc2.querySelectorAll("#selection-box .selection-fields dt")].some(dt => dt.textContent === "Agent"));

// prev/next navigation actually moves the selection
const beforeLabel = doc2.querySelector("#selection-box .selection-title strong").textContent;
doc2.querySelector("#selection-box .step-nav .step-nav-btn").dispatchEvent(new dom2.window.MouseEvent("click", { bubbles: true }));
await waitFor(() => doc2.querySelector("#selection-box .selection-title strong").textContent !== beforeLabel, "nav changes selection");
check("chronology nav selects the neighbor step", true);

content = await selectStep(step => step.kind === "usage" && step.detail?.includes('"info": {'), "usage step selected");
check("usage: token grid rendered", content.querySelectorAll(".insight-tokens .token-stat").length >= 3);

content = await selectStep(step => step.kind === "tool_call", "tool_call step selected");
check("apply_patch: split into per-file cards", content.querySelectorAll(".insight-file").length >= 1);
check("apply_patch: card leads with File segment", content.querySelector(".insight-file .insight-output-label").textContent === "File");
check("apply_patch: path split with emphasized name", content.querySelector(".insight-file .path-name") !== null);
check("apply_patch: colored diff with additions", content.querySelector(".insight-diff .diff-add") !== null);

content = await selectStep(step => step.kind === "file_change", "file_change step selected");
check("file change: File -> Operation -> Content order", (() => {
  const labels = [...content.querySelectorAll(".insight-file .insight-output-label")].map(n => n.textContent);
  return labels[0] === "File" && labels[1] === "Operation";
})());

// resources segment: a step with an artifact edge lists the file under Content
const ARTIFACT = new Set(["reads", "references", "patches", "copies", "creates", "deletes", "writes", "moves"]);
const stepIds = new Set(steps.map(step => step.node_id));
const artifactEdge = payload.edges.find(edge => ARTIFACT.has(edge.kind) && stepIds.has(edge.source));
if (artifactEdge) {
  content = await selectStep(step => step.node_id === artifactEdge.source, "step with artifact edge selected");
  check("resources segment lists touched files", content.querySelector(".resource-row .path-name") !== null);
}

// relations: structural edges are gone, remaining groups carry step chips
const verbs = [...doc2.querySelectorAll("#node-relations .relation-verb")].map(n => n.textContent);
check("no structural contains/produced relations", verbs.every(v => !v.includes("contains") && !v.includes("produced")));

content = await selectStep(step => step.kind === "environment", "environment step selected");
check("environment: settings table with Model row", [...content.querySelectorAll(".insight-kv dt")].some(dt => dt.textContent === "Model"));

content = await selectStep(step => step.kind === "message", "message step selected");
check("message: sender badge in the What section", [...content.querySelectorAll(".role-what .insight-badge")]
  .some(node => ["You", "Agent", "System"].includes(node.textContent)));

// --- the canon: same skeleton for every type --------------------------------
function sectionRoles(node) {
  return [...node.querySelectorAll(".insight-section")].map(section =>
    [...section.classList].find(name => name.startsWith("role-")));
}

content = await selectStep(step => step.kind === "command", "command step for canon");
const roles = sectionRoles(content);
check("canon: sections keep the fixed order",
  JSON.stringify(roles) === JSON.stringify([...roles].sort(
    (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))));
check("canon: command has a Where section with the working directory",
  content.querySelector(".role-where .path-name") !== null);
check("canon: coverage counter rendered", /\d+ of \d+ fields/.test(
  doc2.querySelector("#selection-box .insight-coverage")?.textContent || ""));

content = await selectStep(step => step.kind === "file_change", "file_change for canon");
check("file change: Where section carries the file path",
  content.querySelector(".role-where .path-name") !== null);
check("file change: status is shown", [...content.querySelectorAll(".role-status .insight-badge")]
  .some(node => /completed|failed|success|error/i.test(node.textContent)));
check("file change: result (stdout) is shown",
  [...content.querySelectorAll(".insight-output-label")].some(node => node.textContent === "Result"));

// --- nothing falls back to a wall of collapsed JSON -------------------------
const KINDS = [...new Set(steps.map(step => step.kind))];
const uncovered = [];
for (const kind of KINDS) {
  content = await selectStep(step => step.kind === kind, `kind ${kind} selected`);
  const sections = content.querySelectorAll(".insight-section").length;
  const labels = content.querySelectorAll(".insight-output-label").length;
  // Every long block must sit inside a named section or segment — that is the
  // whole point of the canon: no orphaned wall of text.
  const orphanBlock = [...content.querySelectorAll("pre")].some(pre =>
    pre.textContent.length > 1000 && !pre.closest(".insight-section, .insight-segment"));
  check(`${kind}: rendered as labeled sections`, sections > 0 || labels > 0);
  check(`${kind}: long blocks live inside a named section`, !orphanBlock);
  if (content.querySelector(".insight-generic")) uncovered.push(kind);
}
console.log(uncovered.length
  ? `note: generic view used for: ${uncovered.join(", ")}`
  : "note: every kind in this session has a dedicated view");

// --- missing values are explained, never blank ------------------------------
const missingChips = [...doc2.querySelectorAll("#selection-box .slot-missing")];
check("missing values render as explained chips",
  missingChips.every(chip => chip.textContent.trim().length > 0 && chip.title.length > 0));

console.log(`ALL SELECTION SMOKE CHECKS PASSED (${passed})`);
process.exit(0);
