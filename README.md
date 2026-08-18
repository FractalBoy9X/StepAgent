# StepAgent

Local observability for Codex sessions. The importer preserves every rollout record, aggregates lifecycle events into semantic interactions, reconstructs explicit and inferred relationships, and presents the parser output in two native 2D views.

Everything runs on your machine. There is no database, no telemetry, and no network call: the Codex session directory is only ever read.

## Requirements

[uv](https://docs.astral.sh/uv/) — and nothing else. It installs the Python version pinned in `.python-version` and the dependencies declared in `pyproject.toml` on first run, so there is no virtualenv to create and no system Python to configure.

Windows, macOS, and Linux are supported. A plain-`pip` fallback for Python 3.10+ is documented in [`SETUP.md`](SETUP.md).

## Start

### Windows

Install uv in PowerShell, then start the app:

```powershell
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

```powershell
.\run.ps1 --serve
```

**If PowerShell refuses to run the script** — the usual first-run message is *"cannot be loaded because running scripts is disabled on this system"* — start it this way instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 --serve
```

This is Windows blocking an unsigned local script, not an error in the app. The `Bypass` flag applies to that single invocation only and changes nothing system-wide.

Codex sessions are expected under `%USERPROFILE%\.codex\sessions`. If yours live elsewhere, set the path in `.env` (created automatically on first run) or for one invocation:

```powershell
$env:CODEX_SESSIONS_DIR = "D:\codex\sessions"; .\run.ps1 --all --serve
```

### macOS and Linux

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh    # or: brew install uv
```

```bash
./run.sh --serve
```

For a source directory other than `~/.codex/sessions`:

```bash
CODEX_SESSIONS_DIR="/path/to/.codex/sessions" ./run.sh --all --serve
```

### First run

The launcher creates `.env` from `.env.example`, downloads the interpreter, and resolves dependencies — expect a few seconds. Later runs start immediately. Add `--all` to import every session found under `CODEX_SESSIONS_DIR` before the server starts.

Then open:

- `http://127.0.0.1:8000/visualization/` for Turn Lanes and Activity Matrix;
- `http://127.0.0.1:8000/logs/` to import sessions;
- `http://127.0.0.1:8000/api/graph/` for normalized graph JSON;
- `/api/interaction/?file=<name>&id=<id>` for one interaction and its raw records.

`DJANGO_HOST` and `DJANGO_PORT` in `.env` move the server if `127.0.0.1:8000` is taken.

## Model

Schema v4 separates two layers:

- `raw_records`: every source JSONL object, retained losslessly as JSON;
- `interactions`: normalized command, message, reasoning, plan, filesystem, web, MCP, media, multi-agent, human-control, safety, context, and lifecycle activity.

Begin/delta/end records and call outputs are aggregated into one interaction. Unknown future types remain available as `event_unknown` instead of being discarded. Relationships retain `confidence`, `inferred`, and `detected_by` metadata.

## 2D views

- **Turn Lanes** keeps one horizontal lane per conversation turn. A conversation turn starts at a standalone user message; events before the first such message form a separate Session initialization lane. Every normalized parser interaction remains a numbered step in source order.
- **Activity Matrix** compares interaction families across conversation turns, including initialization when present. After narrowing the scope to one turn, columns become consecutive step ranges.

Both views share selection state with the interaction table and detail panel. Matrix cells expand to their exact interactions. Raw records are fetched only for one selected interaction.

## Import and migration

```bash
uv run python codex_prettify.py ~/.codex/sessions/2026/08/08/rollout.jsonl \
  --output visualization/data/sessions_json/session.v4.json

uv run python codex_prettify.py --all --force --replace-v3

# reimport only sessions whose raw source changed since the last import
uv run python codex_prettify.py --all --refresh-stale
```

Schema v3 and flattened legacy JSON are deliberately not accepted by v4. Reimport the original JSONL to recover complete interaction data.

Imports are repeatable. Every export records the raw file it came from (`meta.import_source`), so `/logs/` marks a session **Stale** once its rollout changes and offers **Refresh changed**; **Verify checksums** additionally catches a source replaced with an identical size and mtime. Exports whose source is gone are marked **Orphaned** and can be deleted from the same page. The Codex session directory itself is only ever read — nothing in the app writes, moves, or deletes anything there.

Exports land in `visualization/data/sessions_json/` and are git-ignored apart from the bundled `demo-session.v4.json`. They can contain prompts, command arguments, and file paths from your sessions, so treat them as you would the raw logs.

## Languages

The interface supports Polish and English through Django i18n. On the first request, `LocaleMiddleware` uses the browser language and falls back to English. The PL/ENG switch stores the explicit choice in the standard `django_language` cookie. Session data, protocol identifiers, and API payloads are never translated.

After changing source strings, rebuild both catalogs:

```bash
uv run python manage.py makemessages -l pl -d django --no-wrap --no-location
uv run python manage.py makemessages -l pl -d djangojs --no-wrap --no-location
uv run python manage.py compilemessages -l pl
```

Rebuilding needs GNU gettext on PATH. The compiled `.mo` catalogs are committed, so running the application does not.

## Graph export

```bash
uv run python scripts/export_graph.py \
  visualization/data/sessions_json/demo-session.v4.json \
  --graph-output demo.graph.json
```

## Safety and scale

- JSONL decoding is incremental and supports concatenated objects; normalization currently materializes the record list.
- An unfinished input buffer is capped at 50 MB.
- Repository and raw source paths reject traversal.
- `AGENTIC_MAX_INTERACTIONS` defaults to `5000` for browser rendering; stored raw data is never truncated.
- The 2D UI has no chart runtime dependency, canvas, WebGL, animation loop, or continuous updates.
- Initial visualization data contains compact interaction summaries. Complete normalized and raw data loads on exact selection.
- `DJANGO_LANGUAGE_CODE` controls the fallback language and defaults to `en`.
- The bundled Django development server binds to `127.0.0.1` and is meant for local use only. `DJANGO_DEBUG` defaults to `true` and `DJANGO_SECRET_KEY` to a placeholder; change both before exposing the app beyond your own machine.

## Configuration

`.env` is created from `.env.example` on first run. Every value has a working default, so the file is optional.

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | raw JSONL source directory, read-only |
| `DJANGO_HOST` | `127.0.0.1` | server host |
| `DJANGO_PORT` | `8000` | server port |
| `DJANGO_DEBUG` | `true` | Django debug mode |
| `DJANGO_ALLOWED_HOSTS` | `127.0.0.1,localhost` | allowed hosts |
| `DJANGO_SECRET_KEY` | development placeholder | Django secret key |
| `DJANGO_LANGUAGE_CODE` | `en` | fallback language when neither cookie nor browser selects one |
| `AGENTIC_MAX_INTERACTIONS` | `5000` | interaction cap for browser rendering |

## Validation

```bash
uv run pytest -q
uv run python manage.py check
```

The JavaScript smoke tests additionally need Node.js: `npm install`, then `node tests/smoke/units_fields.mjs`. Full instructions are in [`VALIDATION.md`](VALIDATION.md).

Core modules are `visualization/adapters.py`, `domain.py`, `graph_builder.py`, `two_d_views.py`, and `static/visualization/observatory-2d.js`. Detailed design and migration rules are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/MIGRATION.md`](docs/MIGRATION.md); [`AGENTS.md`](AGENTS.md) is a fuller map of the codebase, its contracts, and its known limits.
