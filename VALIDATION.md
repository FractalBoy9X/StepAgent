# Validation

Run:

```bash
uv run python -m py_compile codex_prettify.py scripts/export_graph.py agentic_app/*.py visualization/*.py tests/test_*.py
uv run pytest -q
uv run python manage.py check
uv run python manage.py compilemessages -l pl
```

`compilemessages` needs GNU gettext (`msgfmt`) on PATH and is only required
after editing `locale/pl/LC_MESSAGES/*.po`. The compiled `.mo` catalogs are
committed, so running the application never needs gettext.

The JavaScript smoke tests need Node.js:

```bash
npm install
node tests/smoke/units_fields.mjs
node tests/smoke/smoke_selection.mjs
node tests/smoke/smoke_turn_copy.mjs
```

Coverage includes lossless raw preservation, v4 round trips, protocol registry completeness, lifecycle aggregation, control/file separation, artifacts, failures, retries, deterministic step ordering, Activity Matrix aggregation, path traversal, Polish/English locale selection, language-cookie persistence, JavaScript translations, API language invariance, and the absence of 3D renderer dependencies in the active UI.
