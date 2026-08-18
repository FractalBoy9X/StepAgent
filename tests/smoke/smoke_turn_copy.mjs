// Headless smoke test for the user message in a turn heading (.turn-copy).
// Loads the real page and the real ES modules into jsdom, but swaps the
// server-inlined payload for a fixture so every shape (long, short, empty,
// truncated, initialization) is present regardless of which sessions happen
// to be imported. Payload generation itself is covered by pytest.
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Usage: start the dev server, run `npm install jsdom` in the repo root, then
//   SMOKE_BASE=http://127.0.0.1:8000 node tests/smoke/smoke_turn_copy.mjs
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8000";
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

function step(turnId, index, role) {
  return {
    node_id: `interaction:${turnId}-${index}`,
    kind: role === "user" ? "message" : "command",
    label: `${role} step ${index}`,
    family: role === "user" ? "communication" : "execution",
    subkind: "", lifecycle: "completed", detail: "", timestamp: "",
    duration_ms: null, turn_number: 1, turn_id: turnId,
    conversation_turn_id: turnId, conversation_turn_number: index,
    conversation_turn_kind: "user_message", interaction_index: index,
    role, status: "success", step_number: index,
  };
}

function turn(id, kind, summary, { truncated = false, fullLength = null } = {}) {
  return {
    conversation_turn_id: id,
    conversation_turn_number: Number(id.replace(/\D/g, "")) || 0,
    conversation_turn_kind: kind,
    summary,
    summary_length: fullLength === null ? summary.length : fullLength,
    summary_truncated: truncated,
    interaction_count: 2,
    error_count: 0,
    steps: [step(id, 1, "user"), step(id, 2, "assistant")],
  };
}

// 6 hard line breaks: past the 4-line clamp at any width.
const LONG = Array.from({ length: 6 }, (_, i) => `Line ${i + 1}: ${"analyse this trace ".repeat(6)}`).join("\n");
const SHORT = "Fix the failing test";
// One long paragraph, no line breaks. Past the character heuristic but it
// still fits in four lines of a wide lane — the reported false positive.
const WIDE_FIT = `Na bazie obecnej wiedzy - zaplanuj stworzenie planu. ${"Dodatkowy kontekst dla tego zadania. ".repeat(14)}`;
// Short enough that the heuristic offers nothing, but it overflows a narrow lane.
const NARROW_ONLY = "Sprawdz gdzie teraz jest ten plik oraz czy nadal tam ma pozostac po zmianach. ".repeat(3);

const pageHtml = await (await realFetch(`${BASE}/visualization/`)).text();
const dom = new JSDOM(pageHtml, { url: `${BASE}/visualization/` });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CSS = dom.window.CSS ?? { escape: value => value.replace(/([^a-zA-Z0-9_-])/g, "\\$1") };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.fetch = async (input, init) =>
  realFetch(String(input).startsWith("http") ? String(input) : `${BASE}${input}`, init);

// jsdom performs no layout, so .turn-copy-text would report 0/0 and the
// measurement pass would refuse to act. Stand in for the browser: the clamp
// height comes from --turn-copy-lines, the natural height from wrapping the
// text at CHARS_PER_LINE. Changing CHARS_PER_LINE simulates a resize.
const LINE_HEIGHT = 19.5;
const layout = { charsPerLine: 160 };
function copyLines(node) {
  return node.textContent.split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / layout.charsPerLine)), 0);
}
for (const [property, compute] of [
  ["clientHeight", node => Number(node.closest(".turn-copy").style.getPropertyValue("--turn-copy-lines") || 4) * LINE_HEIGHT],
  ["scrollHeight", node => copyLines(node) * LINE_HEIGHT],
]) {
  Object.defineProperty(dom.window.HTMLElement.prototype, property, {
    configurable: true,
    get() {
      if (!this.classList?.contains("turn-copy-text")) return 0;
      return Math.round(compute(this));
    },
  });
}

const doc = dom.window.document;
const source = doc.getElementById("observatory-2d-data");
const payload = JSON.parse(source.textContent);
payload.turns = [
  turn("initialization", "initialization", ""),
  turn("conversation-turn-1", "user_message", LONG),
  turn("conversation-turn-2", "user_message", SHORT),
  turn("conversation-turn-3", "user_message", ""),
  turn("conversation-turn-4", "user_message", LONG, { truncated: true, fullLength: 50859 }),
  turn("conversation-turn-5", "user_message", WIDE_FIT),
  turn("conversation-turn-6", "user_message", NARROW_ONLY),
];
payload.nodes = payload.turns.flatMap(item => item.steps);
payload.edges = [];
source.textContent = JSON.stringify(payload);

await import(`${STATIC_DIR}/observatory-2d.js?cacheBust=${Date.now()}`);

// Lanes are rebuilt on every render, so look them up fresh by turn id.
const laneOf = turnId => doc.querySelector(`#chart-stage .turn-copy[data-turn-copy-id="${turnId}"]`).closest(".turn-lane");

const lanes = [...doc.querySelectorAll("#chart-stage .turn-lane")];
check("one lane per turn", lanes.length === 7);
const [initLane, longLane, shortLane, emptyLane, , wideFitLane, narrowOnlyLane] = lanes;

// --- the message is the heading's content ----------------------------------
const longText = longLane.querySelector(".turn-copy-text");
check("long turn renders the message", Boolean(longText));
check("full message is in the DOM, clamping is CSS-only", longText.textContent === LONG);
check("no legacy single-line span left", longLane.querySelector(".turn-copy > span") === null);
check("turn number is not repeated in the copy", longLane.querySelector(".turn-copy strong") === null);
check("turn id is still shown once", longLane.querySelector(".turn-id").textContent.trim().length > 0);

// --- the toggle appears only when it is needed -----------------------------
const toggle = longLane.querySelector(".turn-copy-toggle");
check("long turn offers a toggle", Boolean(toggle));
check("toggle names the message size", /50|characters|znak/i.test(toggle.textContent));
check("toggle starts collapsed", toggle.getAttribute("aria-expanded") === "false");
check("toggle points at the message", toggle.getAttribute("aria-controls") === longText.id);
check("short turn has no toggle", shortLane.querySelector(".turn-copy-toggle") === null);
check("short turn still shows its message", shortLane.querySelector(".turn-copy-text").textContent === SHORT);

// --- the layout, not a character count, decides (the reported false positive)
check("a long paragraph that fits the clamp offers no toggle",
  wideFitLane.querySelector(".turn-copy-toggle") === null);
check("...even though the character heuristic alone would have offered one",
  WIDE_FIT.length > 4 * 90 && WIDE_FIT.split("\n").length === 1);
check("its whole message is on screen", wideFitLane.querySelector(".turn-copy-text").textContent === WIDE_FIT);
check("the empty action row is hidden, leaving no dead space",
  wideFitLane.querySelector(".turn-copy-actions").hidden === true);
check("a message the heuristic missed gets no toggle while it fits",
  narrowOnlyLane.querySelector(".turn-copy-toggle") === null);

// Narrow the simulated lane and re-measure, as a window resize would.
layout.charsPerLine = 30;
dom.window.dispatchEvent(new dom.window.Event("resize"));
await new Promise(resolve => setTimeout(resolve, 350));
check("narrowing the window adds the toggle where it is now needed",
  laneOf("conversation-turn-6").querySelector(".turn-copy-toggle") !== null);
check("...and to the paragraph that no longer fits",
  laneOf("conversation-turn-5").querySelector(".turn-copy-toggle") !== null);
check("the revealed action row is no longer hidden",
  laneOf("conversation-turn-6").querySelector(".turn-copy-actions").hidden === false);
layout.charsPerLine = 160;
dom.window.dispatchEvent(new dom.window.Event("resize"));
await new Promise(resolve => setTimeout(resolve, 350));
check("widening it takes the toggle away again",
  laneOf("conversation-turn-5").querySelector(".turn-copy-toggle") === null);
check("a genuinely long message keeps its toggle throughout",
  laneOf("conversation-turn-1").querySelector(".turn-copy-toggle") !== null);

// --- expanding and collapsing ----------------------------------------------
const click = node => node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
click(toggle);
const expandedCopy = [...doc.querySelectorAll("#chart-stage .turn-lane")][1].querySelector(".turn-copy");
check("expanding sets the expanded class", expandedCopy.classList.contains("is-expanded"));
check("expanded toggle reports aria-expanded", expandedCopy.querySelector(".turn-copy-toggle").getAttribute("aria-expanded") === "true");
check("only the clicked turn expands", ![...doc.querySelectorAll("#chart-stage .turn-lane")]
  .filter((_, index) => index !== 1)
  .some(lane => lane.querySelector(".turn-copy")?.classList.contains("is-expanded")));

// --- expansion survives a re-render (state lives in ctx.state) --------------
click(doc.querySelector('[data-density="compact"]'));
const afterDensity = [...doc.querySelectorAll("#chart-stage .turn-lane")][1].querySelector(".turn-copy");
check("expansion survives a density change", afterDensity.classList.contains("is-expanded"));
check("density drives the collapsed line count", afterDensity.style.getPropertyValue("--turn-copy-lines") === "2");
click(doc.querySelector('[data-density="comfortable"]'));
check("standard density restores four lines",
  [...doc.querySelectorAll("#chart-stage .turn-lane")][1].querySelector(".turn-copy").style.getPropertyValue("--turn-copy-lines") === "4");

// --- collapsing again -------------------------------------------------------
const laneAt = index => doc.querySelectorAll("#chart-stage .turn-lane")[index];
click(laneAt(1).querySelector(".turn-copy-toggle"));
check("collapsing returns to the clamped state", !laneAt(1).querySelector(".turn-copy").classList.contains("is-expanded"));
check("collapsed toggle reports aria-expanded", laneAt(1).querySelector(".turn-copy-toggle").getAttribute("aria-expanded") === "false");

// --- the toggle must never touch the selection ------------------------------
click(doc.querySelector("#chart-stage .step-node"));
const selected = [...doc.querySelectorAll("#chart-stage .step-node.active")].map(node => node.dataset.nodeId);
check("a step can be selected", selected.length === 1);
click(laneAt(1).querySelector(".turn-copy-toggle"));
check("expanding leaves the selection untouched",
  [...doc.querySelectorAll("#chart-stage .step-node.active")].map(node => node.dataset.nodeId).join() === selected.join());
check("the expansion did happen", laneAt(1).querySelector(".turn-copy").classList.contains("is-expanded"));

// --- truncated messages route to the Selection panel ------------------------
const truncatedIndex = 4;
click(doc.querySelectorAll("#chart-stage .turn-lane")[truncatedIndex].querySelector(".turn-copy-toggle"));
const truncatedActions = doc.querySelectorAll("#chart-stage .turn-lane")[truncatedIndex].querySelector(".turn-copy-actions");
check("truncated message explains itself once expanded", Boolean(truncatedActions.querySelector(".turn-copy-note")));
const open = truncatedActions.querySelector(".turn-copy-open");
check("truncated message offers the full view", Boolean(open));
check("that button is a real selection button", open.dataset.nodeId === "interaction:conversation-turn-4-1");
check("collapsed truncated message hides the note", (() => {
  click(doc.querySelectorAll("#chart-stage .turn-lane")[truncatedIndex].querySelector(".turn-copy-toggle"));
  return doc.querySelectorAll("#chart-stage .turn-lane")[truncatedIndex].querySelector(".turn-copy-note") === null;
})());

// --- degenerate turns -------------------------------------------------------
check("initialization lane keeps its heading word", initLane.querySelector(".turn-copy strong") !== null);
check("initialization lane has no empty-state line", initLane.querySelector(".turn-copy-empty") === null);
check("initialization lane has no toggle", initLane.querySelector(".turn-copy-toggle") === null);
check("turn without a user message says so", Boolean(emptyLane.querySelector(".turn-copy-empty")));
check("that lane renders no message paragraph", emptyLane.querySelector(".turn-copy-text") === null);

console.log(`\nALL TURN COPY SMOKE CHECKS PASSED (${passed})`);
process.exit(0);
