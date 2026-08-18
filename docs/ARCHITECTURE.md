# Architecture

## Pipeline

```text
Codex rollout JSONL
  -> lossless RawRecord stream
  -> lifecycle correlation and Interaction normalization
  -> conversation-turn derivation
  -> causal ExecutionGraph
  -> compact 2D view payload
  -> Turn Lanes / Activity Matrix + graph/detail APIs
```

`adapters.py` owns source protocol knowledge. It recognizes rollout, response-item, event-message, and nested thread-item types. Correlation priority is item ID, call ID, explicit thread/turn/agent IDs, and finally a narrow content fingerprint for known mirrored messages and reasoning.

`domain.py` is the dependency boundary. A `SessionDocument` contains both raw records and normalized interactions. An interaction owns its lifecycle, result, status, source references, semantic family, source-protocol turn, and derived conversation turn. Graph edges distinguish explicit relationships from inference with confidence metadata.

`conversation_turns.py` derives presentation turns after protocol normalization. A conversation turn starts only at a standalone user message. A user message that answers an active input, approval, or permission request remains in the current turn. Context-only envelopes do not start turns. Interactions before the first qualifying message belong to `initialization` with number `0`. Source `turn_id` and `turn_number` remain unchanged.

`graph_builder.py` creates structural session/conversation-turn/agent nodes, semantic interaction nodes, artifacts, plan steps, errors, control relations, retries, and metrics. `NEXT` is chronology only. `turn_count` counts user-message conversation turns and excludes initialization; `source_turn_count` exposes the independent protocol count.

## 2D view model

`two_d_views.py` selects only graph nodes backed by normalized parser interactions. It preserves `interaction_index`, assigns a stable step number within each conversation turn, and exposes the ordered family catalog (`families`: id + color, single source of truth shared with the instructions page). The Activity Matrix grid is derived client-side from `turns[].steps`. Derived artifact and error nodes stay available for relations, but do not become extra timeline steps.

The initial payload contains compact step and node references rather than full result payloads. Exact normalized interaction and raw records are loaded from `/api/interaction/` after selection.

Static assets carry a `?v=N` cache-bust because the dev server sends no `Cache-Control`. It must cover every front-end file at once — ES module imports, the entry `<script>` tag, and the `<link rel="stylesheet">` tags — since new markup served against a cached stylesheet renders unstyled. `test_every_static_asset_shares_one_cache_bust_version` asserts the versions never drift apart.

A turn heading carries the user message that opened the turn (`turns[].summary`). The payload holds a prefix capped at `TURN_SUMMARY_CHARS` together with `summary_length` and `summary_truncated`, because those messages run long — median ~500 characters, longest measured ~51 000. Collapsed, the message is clamped to a line count that follows the density control. The expand control is offered only when the text really exceeds that clamp: a character estimate picks the candidates, then `syncCopyToggles` measures `scrollHeight` against `clientHeight` once the lanes are in the DOM and adds or removes the control accordingly — reading every lane before writing to any, so the whole stack costs one layout pass. A character count alone cannot decide this, since a wide lane fits roughly 200 characters per line; it is re-run, debounced, on window resize. Where there is no layout engine the measurement is skipped and the estimate stands. Expansion state lives in `ctx.state.expandedTurns` because `renderChart()` rebuilds every lane. When the payload prefix is truncated, the expanded heading links into the Selection panel, which loads the untruncated interaction from `/api/interaction/`.

The browser renderer uses native HTML buttons:

- Turn Lanes renders one scrollable chronological track per conversation turn and a visually distinct initialization track;
- Activity Matrix uses families as rows and conversation turns as columns, including initialization;
- with one selected turn, matrix columns become consecutive step ranges;
- chart, table, matrix groups, individual steps, and relation buttons share one selection mechanism.

There is no Plotly, canvas, WebGL, SVG hit testing, or 3D scene in the active visualization.

## APIs and storage

Processed files use schema v4 and the `.v4.json` suffix. Writes use a temporary file, full parse validation, and atomic replacement; a failed write removes the temporary file and leaves the previous export intact. `/api/graph/` excludes raw payloads; `/api/interaction/` returns raw records for one validated interaction ID.

## Import provenance and refresh

`provenance.py` records which raw rollout produced an export under `meta.import_source`: relative and absolute source path, size, mtime, sha256, import timestamp, and record counts. The block needs no schema bump because `parse_v4_json` funnels unknown `meta` keys into `SessionDocument.metadata` and `meta_dict` spreads them back, so it survives a load/save round trip. Exports written before provenance existed simply report status `untracked`.

A raw session is `new`, `current`, `stale`, or `untracked`; an export whose source disappeared is `orphaned`. Comparison is stat-only — size first, then mtime with a one-second tolerance — so listing pages stay cheap: `read_header` decodes just the leading `meta` object of a multi-megabyte export (`meta` is always the second key `to_dict` writes) plus the timestamp of its first raw record, and caches both per `(path, mtime, size)`. The stored digest is used only by the explicit "verify checksums" action, which catches a source replaced in place with an identical size and mtime.

## Session listing

`ObservatoryService.inventory()` joins each raw rollout with its export into one row per session, and `listing.py` holds the presentation rules: whitelisted sort keys (`started`, `updated`, `imported`, `size`, `interactions`, `project`, `name`, `status`), text and status filtering, and local-time formatting. `/logs/` drives them through `?sort=&dir=&q=&status=`, which the POST redirect carries back so an action does not reset the view.

The creation date is the session's own start, not a file timestamp: the first record of the rollout for raw sessions (`read_raw_head`, one line), the first raw record of the export for imported ones. `meta.generated_at` is not used for it — the parser falls back to the *last* record when a rollout's session_meta carries no timestamp — and a rollout's filename is only a last resort, because it holds the recording machine's wall clock rather than UTC.

`ObservatoryService.import_raw` re-imports and overwrites by design; `import_batch(mode)` selects `new`, `stale`, or `all`. `codex_prettify.py --refresh-stale` applies the same comparison from the CLI. An import that parses to zero records while a non-empty export exists is refused, so a truncated source cannot wipe good data.

The source directory is strictly read-only: import code only opens raw files for reading and stats them. Deletion acts exclusively on processed exports in `visualization/data/sessions_json/`.

The conversation fields are additive within schema v4. Existing v4 files without them are enriched deterministically in memory from their interactions and lossless raw records. Newly written v4 files persist the derived fields.

The application remains database-free and local-first. A database is only justified for cross-session queries, concurrent users, or incremental ingestion at substantially larger scale.

## Known inference boundaries

- Adjacent mirrored message/reasoning records without a shared item ID use exact normalized content within the same source turn. Identical messages separated by another record remain distinct interactions and can start distinct conversation turns.
- Control responses are classified conservatively from an active human-control request. Resumed execution or an explicit response event clears that pending request.
- Artifact extraction is structured when path arguments or patch headers exist and heuristic otherwise.
- A retry is inferred from matching executable signatures after a failed attempt.
- Unknown protocol variants become `event_unknown` and remain lossless in raw storage.
