// Orchestration of the Content layer: pick the descriptor for this step type,
// render its slots, and add the two diagnostics (coverage, unmapped keys).
//
// The rendering primitives live in observatory-fields.js and the per-type
// descriptors in observatory-catalog.js — adding a new Codex type is a catalog
// entry, not new code here. This module is strictly presentational: it reads the
// already-fetched interaction plus its raw records and never touches the parser
// or the API.

import { gettext } from "./observatory-labels.js?v=9";
import { element } from "./observatory-views.js?v=9";
import {
  sourceViews, renderSlots, coverageChip, unmappedBlock, unusedKeys,
  previewBlock, segmentBlock, pathChip, BLOCK_PREVIEW_CHARS,
} from "./observatory-fields.js?v=9";
import { descriptorFor, isGeneric } from "./observatory-catalog.js?v=9";

// Re-exported so the selection panel keeps one import site for the primitives.
export { previewBlock, segmentBlock, pathChip };

function richest(entries) {
  return entries.reduce(
    (best, next) => (Object.keys(next || {}).length > Object.keys(best || {}).length ? next : best),
    entries[0] || null,
  );
}

// For a step with no dedicated layout: the source record as readable JSON,
// never the parser's whitespace-collapsed, truncated `detail`.
function sourceRecordBlock(ctx) {
  const value = richest(ctx.items) || richest(ctx.payloads) || richest(ctx.records);
  if (!value) return null;
  return segmentBlock(gettext("Source record"), [
    previewBlock(JSON.stringify(value, null, 2), BLOCK_PREVIEW_CHARS),
  ]);
}

// "Has content" means a real value, not a section that only carries a
// "not in the log" chip — otherwise a step with nothing to say would silently
// render an empty panel instead of falling back to the source record.
const VALUE_SELECTOR = "pre, .insight-badges, .insight-kv, .insight-file, .insight-results, .insight-tokens, .insight-images, .insight-steps, .insight-pathsplit";

function hasContent(nodes) {
  return nodes.some(node =>
    (node.classList.contains("role-input") || node.classList.contains("role-output"))
    && node.querySelector(VALUE_SELECTOR) !== null);
}

/**
 * Returns an array of DOM nodes for the Content layer, or null when there is
 * genuinely nothing to show (the caller then falls back to plain text).
 */
export function buildInsight(interaction, rawRecords) {
  try {
    const ctx = sourceViews(interaction || {}, rawRecords);
    const descriptor = descriptorFor(interaction || {}, ctx);
    const { nodes, filled, defined, missing } = renderSlots(descriptor.slots || [], ctx);
    const generic = isGeneric(descriptor);
    const extra = [];
    if (generic || !hasContent(nodes)) {
      const block = sourceRecordBlock(ctx);
      if (block) extra.push(block);
    }
    if (!nodes.length && !extra.length) return null;

    const header = element("div", "insight-header");
    if (generic) {
      const note = element("span", "insight-generic",
        gettext("Generic view — this step type has no dedicated layout yet."));
      note.title = gettext("The complete data is in the Normalized interaction and Source records layers below.");
      header.append(note);
    }
    if (defined) header.append(coverageChip(filled, defined, missing));

    const unmapped = unmappedBlock(unusedKeys(ctx));
    return [
      ...(header.childElementCount ? [header] : []),
      ...nodes,
      ...extra,
      ...(unmapped ? [unmapped] : []),
    ];
  } catch {
    // A broken descriptor must never take the whole panel down.
    return null;
  }
}
