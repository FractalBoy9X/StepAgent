// Rendering of the two 2D views (Turn Lanes, Activity Matrix), the family
// legend, and the interaction-explorer table. Pure HTML buttons only.

import {
  gettext, ngettext, interpolate,
  kindLabels, lifecycleLabels, statusLabels, familyLabels,
  translatedLabel, stepsLabel, errorsLabel, interactionsLabel,
  segmentLabel, segmentShortLabel,
} from "./observatory-labels.js?v=9";

// The explorer table stays responsive by capping rendered rows; the cap is
// surfaced to the user ("Showing first … of …") instead of failing silently.
export const MAX_TABLE_ROWS = 1500;
// A single selected turn is split into at most this many step-range columns.
const MATRIX_MAX_COLUMNS = 24;
// Target ~4 steps per matrix column before the column cap kicks in.
const MATRIX_CHUNK_DIVISOR = 4;
// Lines of the user message a collapsed turn heading shows, per density.
const COPY_LINES = { compact: 2, comfortable: 4, detailed: 8 };
// Conservative characters-per-line estimate. It decides whether the expand
// control is offered at all; measuring scrollHeight would be exact but forces
// a reflow per lane and is unobservable in jsdom, so the smoke suite could not
// cover it. Under-estimating only ever offers a toggle that turns out to be
// unnecessary — it never hides one that was needed.
const COPY_CHARS_PER_LINE = 90;

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function isError(node) {
  return node.status === "error" || node.status === "failed" || node.lifecycle === "failed";
}

// Cell background opacity: square root keeps small counts visible while the
// densest cell tops out at 90%.
function cellStrength(count, maximum) {
  return `${Math.round(20 + Math.sqrt(count / maximum) * 70)}%`;
}

export function createViews(ctx) {
  const { dom, state } = ctx;

  function familyInfo(family) {
    return {
      label: familyLabels[family] || gettext("Unknown"),
      color: ctx.familyColors.get(family) || ctx.unknownFamilyColor,
    };
  }

  function scopedTurns() {
    if (state.turn === "all") return ctx.turns;
    return ctx.turns.filter(turn => turn.conversation_turn_id === state.turn);
  }

  function scopedSteps() {
    return scopedTurns().flatMap(turn => turn.steps || []);
  }

  function renderLegend() {
    dom.legend.replaceChildren();
    const present = new Set(scopedSteps().map(step => step.family));
    ctx.familyOrder.forEach(family => {
      const { label, color } = familyInfo(family);
      const item = element("span", `legend-item${present.has(family) ? "" : " absent"}`);
      if (!present.has(family)) item.title = gettext("Not present in this scope");
      const swatch = element("span", "legend-swatch");
      swatch.style.setProperty("--family-color", color);
      item.append(swatch, document.createTextNode(label));
      dom.legend.append(item);
    });
  }

  // First guess only, made before the lane exists: deliberately generous, so
  // syncCopyToggles() below never has to add a control the user already looked
  // past. The layout decides the final answer.
  function copyMightNeedToggle(summary, lines) {
    return summary.length > lines * COPY_CHARS_PER_LINE
      || summary.split("\n").length > lines;
  }

  function copyToggleButton(turnId, summaryLength, expanded, controls) {
    const toggle = element("button", "turn-copy-toggle");
    toggle.type = "button";
    // Deliberately not data-node-id: the #chart-stage click delegate must
    // ignore this button so expanding never disturbs the selection.
    toggle.dataset.turnCopy = turnId;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-controls", controls);
    toggle.textContent = expanded
      ? gettext("Collapse")
      : interpolate(gettext("Expand (%s characters)"), [summaryLength]);
    return toggle;
  }

  // The clamp is a CSS effect, so only layout knows whether the message is
  // actually cut off. A character estimate cannot: at a wide lane ~200
  // characters fit on a line, so a 600-character paragraph is fully visible in
  // four lines and an "Expand" control on it would promise text that is
  // already on screen. Runs once per render, reading every lane before writing
  // to any of them, so the whole stack costs a single layout pass.
  function syncCopyToggles(root) {
    const readings = [...root.querySelectorAll(".turn-copy[data-turn-copy-id]")].map(copy => {
      const body = copy.querySelector(".turn-copy-text");
      return {
        copy,
        body,
        // clientHeight is 0 where there is no layout engine (jsdom): leave the
        // heuristic's guess alone rather than stripping every control.
        measurable: Boolean(body) && body.clientHeight > 0,
        overflowing: Boolean(body) && body.scrollHeight > body.clientHeight + 1,
      };
    });
    readings.forEach(({ copy, body, measurable, overflowing }) => {
      if (!measurable || copy.classList.contains("is-expanded")) return;
      const actions = copy.querySelector(".turn-copy-actions");
      const toggle = actions.querySelector(".turn-copy-toggle");
      if (overflowing === Boolean(toggle)) return;
      if (overflowing) {
        actions.prepend(copyToggleButton(
          copy.dataset.turnCopyId,
          Number(copy.dataset.summaryLength),
          false,
          body.id,
        ));
      } else {
        toggle.remove();
      }
      actions.hidden = !actions.childElementCount;
    });
  }

  // The user message that opens a turn: the heading's real content.
  function renderTurnCopy(turn) {
    const copy = element("div", "turn-copy");
    const isInitialization = turn.conversation_turn_kind === "initialization";
    if (isInitialization) copy.append(element("strong", "", segmentLabel(turn)));
    if (!turn.summary) {
      if (!isInitialization) {
        copy.append(element("p", "turn-copy-empty", gettext("No user message in this turn.")));
      }
      return copy;
    }

    const expanded = state.expandedTurns.has(turn.conversation_turn_id);
    copy.classList.toggle("is-expanded", expanded);
    const lines = COPY_LINES[state.density] || COPY_LINES.comfortable;
    // The density control already exists; the clamp follows it instead of
    // adding a second knob for the same idea.
    copy.style.setProperty("--turn-copy-lines", String(lines));
    // Read back by syncCopyToggles(), which works from the DOM alone.
    copy.dataset.turnCopyId = turn.conversation_turn_id;
    copy.dataset.summaryLength = String(turn.summary_length);
    const body = element("p", "turn-copy-text", turn.summary);
    body.id = `turn-copy-${turn.conversation_turn_id}`;
    copy.append(body);

    const actions = element("div", "turn-copy-actions");
    if (expanded || copyMightNeedToggle(turn.summary, lines)) {
      actions.append(copyToggleButton(turn.conversation_turn_id, turn.summary_length, expanded, body.id));
    }
    if (expanded && turn.summary_truncated) {
      actions.append(element("span", "turn-copy-note", gettext("Message truncated in this view.")));
      const userStep = (turn.steps || []).find(step => step.role === "user");
      if (userStep) {
        // This one *is* a selection button: it hands the message to the
        // Selection panel, which fetches the untruncated interaction.
        const label = gettext("Open the full message");
        const open = ctx.selection.selectionButton([userStep.node_id], label, "turn-copy-open");
        open.textContent = label;
        actions.append(open);
      }
    }
    // Always attached, so syncCopyToggles() has somewhere to add a control.
    actions.hidden = !actions.childElementCount;
    copy.append(actions);
    return copy;
  }

  function renderTurnLanes() {
    const stack = element("div", "turn-stack");
    scopedTurns().forEach(turn => {
      const lane = element("section", `turn-lane${turn.error_count ? " has-errors" : ""}${turn.conversation_turn_kind === "initialization" ? " initialization" : ""}`);
      const heading = element("header", "turn-heading");
      heading.append(element("span", "turn-id", segmentShortLabel(turn)));
      const copy = renderTurnCopy(turn);
      const counts = element("span", "turn-counts");
      counts.append(document.createTextNode(stepsLabel(turn.interaction_count)));
      if (turn.error_count) counts.append(document.createTextNode(" · "), element("span", "error-count", errorsLabel(turn.error_count)));
      heading.append(copy, counts);

      const scroll = element("div", "turn-track-scroll");
      const track = element("div", "turn-track");
      track.dataset.density = state.density;
      (turn.steps || []).forEach(step => {
        const { label: familyLabel, color } = familyInfo(step.family);
        const button = ctx.selection.selectionButton([step.node_id], `${step.step_number}. ${step.label}`, `step-node${isError(step) ? " error" : ""}`);
        button.style.setProperty("--family-color", color);
        button.setAttribute("aria-label", interpolate(gettext("Step %s: %s. %s."), [step.step_number, step.label, familyLabel]));
        button.append(
          element("span", "step-number", String(step.step_number).padStart(2, "0")),
          element("span", "step-marker"),
          element("span", "step-kind", translatedLabel(kindLabels, step.kind)),
          element("span", "step-label", step.label),
        );
        track.append(button);
      });
      scroll.append(track);
      lane.append(heading, scroll);
      stack.append(lane);
    });
    dom.stage.append(stack);
    syncCopyToggles(stack);
  }

  function matrixColumns(visibleTurns) {
    if (visibleTurns.length !== 1) {
      return visibleTurns.map(turn => ({
        key: turn.conversation_turn_id,
        label: segmentShortLabel(turn),
        subtitle: `${turn.interaction_count}`,
        steps: turn.steps || [],
      }));
    }
    const stepsInTurn = visibleTurns[0].steps || [];
    const count = Math.min(MATRIX_MAX_COLUMNS, Math.max(1, Math.ceil(stepsInTurn.length / MATRIX_CHUNK_DIVISOR)));
    const chunkSize = Math.max(1, Math.ceil(stepsInTurn.length / count));
    const columns = [];
    for (let index = 0; index < stepsInTurn.length; index += chunkSize) {
      const chunk = stepsInTurn.slice(index, index + chunkSize);
      columns.push({
        key: `steps-${index + 1}-${index + chunk.length}`,
        label: `${index + 1}-${index + chunk.length}`,
        subtitle: gettext("steps"),
        steps: chunk,
      });
    }
    return columns.length ? columns : [{ key: "empty", label: "-", subtitle: "", steps: [] }];
  }

  function renderActivityMatrix() {
    const visibleTurns = scopedTurns();
    const columns = matrixColumns(visibleTurns);
    const presentFamilies = new Set(visibleTurns.flatMap(turn => turn.steps || []).map(step => step.family));
    const rows = ctx.familyOrder.filter(family => presentFamilies.has(family));
    const maximum = Math.max(1, ...rows.flatMap(family => columns.map(column => column.steps.filter(step => step.family === family).length)));
    const scroll = element("div", "matrix-scroll");
    const grid = element("div", "matrix-grid");
    grid.style.setProperty("--matrix-columns", columns.length);
    grid.append(element("div", "matrix-corner"));
    columns.forEach(column => {
      const heading = element("div", "matrix-column");
      heading.append(element("strong", "", column.label), document.createTextNode(column.subtitle));
      grid.append(heading);
    });

    rows.forEach(family => {
      const { label, color } = familyInfo(family);
      const rowLabel = element("div", "matrix-family", label);
      rowLabel.style.setProperty("--family-color", color);
      grid.append(rowLabel);
      columns.forEach(column => {
        const cellSteps = column.steps.filter(step => step.family === family);
        const button = ctx.selection.selectionButton(cellSteps.map(step => step.node_id), `${label}, ${column.label}: ${interactionsLabel(cellSteps.length)}`, `matrix-cell${cellSteps.length ? " has-events" : ""}`);
        button.disabled = !cellSteps.length;
        button.style.setProperty("--family-color", color);
        button.style.setProperty("--cell-strength", cellStrength(cellSteps.length, maximum));
        if (cellSteps.length) button.append(element("span", "matrix-count", String(cellSteps.length)));
        const errors = cellSteps.filter(isError).length;
        if (errors) button.append(element("span", "matrix-error", `!${errors}`));
        grid.append(button);
      });
    });
    scroll.append(grid);
    dom.stage.append(scroll);
  }

  function renderChart() {
    ctx.selection.resetGroups();
    dom.stage.querySelectorAll(":scope > :not(#chart-empty)").forEach(node => node.remove());
    const visible = scopedSteps();
    dom.empty.hidden = visible.length > 0;
    dom.visibleCount.textContent = String(visible.length);
    dom.visibleCountLabel.textContent = ngettext("step", "steps", visible.length);
    const visibleErrorCount = visible.filter(isError).length;
    dom.visibleErrors.textContent = String(visibleErrorCount);
    dom.visibleErrorsLabel.textContent = ngettext("error", "errors", visibleErrorCount);
    if (visible.length) {
      if (state.mode === "turns") renderTurnLanes();
      else renderActivityMatrix();
    }
    renderLegend();
    ctx.selection.updateHighlight();
  }

  function filterValues(key) {
    return [...new Set(ctx.steps.map(step => step[key]).filter(Boolean))].sort();
  }

  function fillSelect(select, items, labelForValue) {
    items.forEach(value => {
      const option = element("option", "", labelForValue(value));
      option.value = value;
      select.append(option);
    });
  }

  function fillFilters() {
    ctx.turns.forEach(turn => {
      const option = element("option", "", `${segmentLabel(turn)} · ${stepsLabel(turn.interaction_count)}`);
      option.value = turn.conversation_turn_id;
      dom.turnFilter.append(option);
    });
    fillSelect(dom.familyFilter, filterValues("family"), value => familyInfo(value).label);
    fillSelect(dom.kindFilter, filterValues("kind"), value => translatedLabel(kindLabels, value));
    fillSelect(dom.statusFilter, filterValues("status"), value => translatedLabel(statusLabels, value));
    fillSelect(dom.lifecycleFilter, filterValues("lifecycle"), value => translatedLabel(lifecycleLabels, value));
  }

  function filteredSteps() {
    const query = dom.search.value.trim().toLowerCase();
    return ctx.steps.filter(step =>
      (!dom.familyFilter.value || step.family === dom.familyFilter.value)
      && (!dom.kindFilter.value || step.kind === dom.kindFilter.value)
      && (!dom.statusFilter.value || step.status === dom.statusFilter.value)
      && (!dom.lifecycleFilter.value || step.lifecycle === dom.lifecycleFilter.value)
      && (!query || `${step.label} ${step.detail} ${step.kind} ${step.subkind}`.toLowerCase().includes(query))
    );
  }

  function renderRows() {
    dom.tableBody.replaceChildren();
    const matches = filteredSteps();
    if (!matches.length) {
      const row = element("tr", "node-row-empty");
      const cell = element("td", "muted", gettext("No interactions match the current filters."));
      cell.colSpan = 3;
      row.append(cell);
      dom.tableBody.append(row);
      return;
    }
    matches.slice(0, MAX_TABLE_ROWS).forEach(step => {
      const row = element("tr", "node-row");
      row.dataset.nodeId = step.node_id;
      const type = element("span", "badge", translatedLabel(kindLabels, step.kind));
      const typeCell = element("td");
      typeCell.append(type);
      row.append(element("td", "", String(step.interaction_index ?? "")), typeCell, element("td", "", step.label));
      dom.tableBody.append(row);
    });
    if (matches.length > MAX_TABLE_ROWS) {
      const row = element("tr", "node-row-empty");
      const cell = element("td", "muted", interpolate(gettext("Showing first %s of %s interactions."), [MAX_TABLE_ROWS, matches.length]));
      cell.colSpan = 3;
      row.append(cell);
      dom.tableBody.append(row);
    }
    ctx.selection.updateHighlight();
  }

  // Exposed so a resize can re-decide the toggles without a full re-render:
  // the clamp holds a different amount of text at a different width.
  function refreshCopyToggles() {
    syncCopyToggles(dom.stage);
  }

  return { familyInfo, scopedTurns, scopedSteps, renderChart, renderRows, fillFilters, refreshCopyToggles };
}
