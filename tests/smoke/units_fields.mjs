// Unit tests for the field layer of the Content view (no server needed).
//
// Usage: npm install jsdom && node tests/smoke/units_fields.mjs
//
// These cover the rules that the catalog depends on: source priority, the four
// value states (ok / empty / missing / unreadable), the guards around the
// parser's truncated `detail`, and descriptor resolution.

import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "visualization", "static", "visualization");
const fields = await import(`${STATIC_DIR}/observatory-fields.js`);
const catalog = await import(`${STATIC_DIR}/observatory-catalog.js`);
const insights = await import(`${STATIC_DIR}/observatory-insights.js`);

let passed = 0;
function check(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

const { sourceViews, pick, item, pay, rec, res, field, detailText, detailJson, renderSlots } = fields;

function ctxOf(interaction, records) {
  return sourceViews(interaction, (records || []).map(record => ({ record })));
}

// --- source priority ---------------------------------------------------------
{
  const ctx = ctxOf({}, [{ payload: { item: { path: "from-item" }, path: "from-payload" } }]);
  check("item wins over payload", pick({ from: [item("path"), pay("path")] }, ctx).value === "from-item");
  check("source is reported", pick({ from: [item("path")] }, ctx).source === "items");
}
{
  // One interaction, several records: the value may sit in any of them.
  const ctx = ctxOf({}, [
    { payload: { type: "a" } },
    { payload: { type: "b", cwd: "/tmp/x" } },
  ]);
  check("all records are searched", pick({ from: [pay("cwd")] }, ctx).value === "/tmp/x");
}
{
  const ctx = ctxOf({}, [{ payload: { text: "short" } }, { payload: { text: "much longer text" } }]);
  check("longest option picks the fullest copy",
    pick({ from: [pay("text", { longest: true })] }, ctx).value === "much longer text");
}

// --- the four states ---------------------------------------------------------
{
  const ctx = ctxOf({}, [{ payload: { item: { summary: [] }, summary: ["real text"] } }]);
  check("an empty value does not end the search",
    pick({ from: [item("summary"), pay("summary")] }, ctx).value[0] === "real text");
}
{
  const ctx = ctxOf({}, [{ payload: { stderr: "" } }]);
  const picked = pick({ from: [pay("stderr")] }, ctx);
  check("present but empty is reported as empty", picked.status === "empty");
}
{
  const ctx = ctxOf({}, [{ payload: {} }]);
  check("absent is reported as missing", pick({ from: [pay("nope")] }, ctx).status === "missing");
}
{
  const ctx = ctxOf({}, [{ payload: { value: 1 } }]);
  const picked = pick({ from: [pay("value")], transform: () => { throw new Error("boom"); } }, ctx);
  check("a throwing transform becomes 'unreadable', not a crash", picked.status === "unreadable");
}

// --- guards around the parser's lossy `detail` -------------------------------
{
  const truncated = `{"changes": {"/a/b.py": {"type": "add", "content": "xxx${"y".repeat(50)}...`;
  const ctx = ctxOf({ detail: truncated }, []);
  check("truncated JSON in detail is not parsed", pick({ from: [detailJson("changes")] }, ctx).status === "missing");
  check("JSON-shaped detail is not used as text", pick({ from: [detailText()] }, ctx).status === "missing");
}
{
  const ctx = ctxOf({ detail: '{"text": "hello"}' }, []);
  check("complete JSON in detail is parsed", pick({ from: [detailJson("text")] }, ctx).value === "hello");
}
{
  const ctx = ctxOf({ detail: "plain sentence" }, []);
  check("plain detail is still a text source", pick({ from: [detailText()] }, ctx).value === "plain sentence");
}

// --- formatting helpers ------------------------------------------------------
check("file:// paths are normalized", fields.normalizePath("file:///tmp/a%20b") === "/tmp/a b");
check("shell wrappers are unwrapped", fields.commandLine(["/bin/zsh", "-lc", "ls -la"]) === "ls -la");
check("plain argv is joined", fields.commandLine(["git", "status"]) === "git status");
check("nested JSON output is unwrapped", fields.unwrapOutput(
  JSON.stringify({ output: JSON.stringify({ output: "done", metadata: { exit_code: 0 } }) })).text === "done");
check("output metadata survives unwrapping", fields.unwrapOutput(
  JSON.stringify({ output: JSON.stringify({ output: "done", metadata: { exit_code: 3 } }) })).meta.exit_code === 3);
check("duration objects become seconds", fields.formatDuration({ secs: 2, nanos: 500000000 }) === "2.50 s");
{
  const files = fields.parsePatch("*** Begin Patch\n*** Add File: a.py\n+x\n*** Update File: b.py\n*** Move to: c.py\n-y\n*** End Patch");
  check("patch splits into files", files.length === 2 && files[0].op === "add" && files[1].moveTo === "c.py");
  check("non-patch text is rejected", fields.parsePatch("hello") === null);
}

// --- descriptor resolution ---------------------------------------------------
{
  const interaction = { kind: "file_change", subkind: "file_change" };
  const ctx = ctxOf(interaction, [{ payload: { item: { type: "FileChange" } } }]);
  const descriptor = catalog.descriptorFor(interaction, ctx);
  check("file change resolves to its own descriptor",
    descriptor.slots.some(slot => slot.id === "changes"));
}
{
  const interaction = { kind: "tool_call", subkind: "custom_tool_call", metadata: { tool_name: "apply_patch" } };
  const ctx = ctxOf(interaction, [{ payload: { input: "*** Begin Patch\n*** Add File: a\n+1" } }]);
  check("apply_patch is detected by content", catalog.descriptorFor(interaction, ctx).slots.some(slot => slot.id === "patch"));
}
{
  const interaction = { kind: "tool_call", subkind: "custom_tool_call", metadata: { tool_name: "exec" } };
  const ctx = ctxOf(interaction, [{ payload: { input: "console.log(1)" } }]);
  check("a non-patch custom tool keeps the tool view",
    catalog.descriptorFor(interaction, ctx).slots.some(slot => slot.id === "tool_name"));
}
{
  // 2025 logs have no envelope: the shape decides.
  const interaction = { kind: "event_unknown", subkind: "message" };
  const ctx = ctxOf(interaction, [{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  check("legacy records are recognised by shape",
    catalog.descriptorFor(interaction, ctx).slots.some(slot => slot.id === "sender"));
}
{
  const interaction = { kind: "totally_new_kind", subkind: "" };
  const ctx = ctxOf(interaction, [{ payload: { whatever: 1 } }]);
  check("an unknown kind falls back to the generic view", catalog.isGeneric(catalog.descriptorFor(interaction, ctx)));
}

// --- rendering ---------------------------------------------------------------
{
  const ctx = ctxOf({}, [{ payload: {} }]);
  const slots = [{ id: "x", label: "Where", role: "where", render: "path", from: [pay("nope")], missing: "explain" }];
  const { nodes, filled, defined } = renderSlots(slots, ctx);
  const chip = nodes[0].querySelector(".slot-missing");
  check("a missing value renders an explained chip", chip !== null && chip.title.length > 0);
  check("coverage counts the missing slot", filled === 0 && defined === 1);
}
{
  const ctx = ctxOf({}, [{ payload: { cwd: "/tmp" } }]);
  const slots = [
    { id: "a", label: "Where", role: "where", render: "path", from: [pay("cwd")] },
    { id: "b", label: "Extra", role: "output", render: "text", from: [pay("nothing")], missing: "hide" },
  ];
  const { filled, defined } = renderSlots(slots, ctx);
  check("hidden optional slots do not spoil the coverage", filled === 1 && defined === 1);
}

// --- regression: the FileChange record that started this work ----------------
{
  const record = {
    timestamp: "2026-08-09T15:05:34.104Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: "019fe70b",
      turn_id: "019fe70c",
      item: {
        type: "FileChange",
        id: "exec-575d5b06",
        changes: { "/home/demo/workspace/psy-i-koty.html": { type: "add", content: "<!doctype html>\n<html>\n</html>\n" } },
        status: "completed",
        stdout: "Success. Updated the following files:\nA /home/demo/workspace/psy-i-koty.html\n",
        stderr: "",
      },
      started_at_ms: 1786287934029,
      completed_at_ms: 1786287934104,
    },
  };
  // The parser hands over a truncated, whitespace-collapsed `detail` — the view
  // must not depend on it.
  const interaction = {
    kind: "file_change",
    subkind: "file_change",
    status: "success",
    detail: `{"/home/demo/workspace/psy-i-koty.html": {"type": "add", "content": "<!doctype html>${"x".repeat(4000)}...`,
    result: { status: "completed", stdout: record.payload.item.stdout, stderr: "" },
    metadata: {},
  };
  const nodes = insights.buildInsight(interaction, [{ record }]);
  check("file change renders", Array.isArray(nodes) && nodes.length > 0);
  const html = nodes.map(node => node.outerHTML).join("");
  check("file change shows WHERE the change went", html.includes("psy-i-koty.html"));
  check("file change shows the operation", /added|dodany/i.test(html));
  check("file change shows the status", /completed|zako/i.test(html.toLowerCase()));
  check("file change shows stdout", html.includes("Success. Updated the following files"));
  check("file change shows the timing", html.includes("75 ms"));
  check("empty stderr is shown as empty, not missing", html.includes("slot-missing is-empty"));
}

console.log(`ALL FIELD UNIT CHECKS PASSED (${passed})`);
process.exit(0);
