# Setup

The only prerequisite is [uv](https://docs.astral.sh/uv/). It installs the
Python version pinned in `.python-version` and the dependencies declared in
`pyproject.toml`, so there is no virtualenv to create and no system Python to
configure.

## Install uv

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh    # macOS / Linux
brew install uv                                    # Homebrew
```

```powershell
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"    # Windows
winget install --id=astral-sh.uv -e                          # winget
```

## Run

```bash
./run.sh --serve            # macOS / Linux
```

```powershell
.\run.ps1 --serve           # Windows
```

The first run creates `.env` from `.env.example`, downloads the interpreter and
resolves dependencies; later runs start immediately. Then open
<http://127.0.0.1:8000/visualization/>.

`uv.lock` pins the exact resolved versions, so every machine installs the same
set. `uv run` respects it automatically; `uv sync --frozen` fails loudly instead
of re-resolving if the lock and `pyproject.toml` ever drift apart.

If PowerShell blocks the script, start it as:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 --serve
```

## Import sessions

Import every Codex session found under `CODEX_SESSIONS_DIR`, then serve:

```bash
./run.sh --all --serve
```

Reimport only the sessions whose raw rollout changed after the last import:

```bash
./run.sh --all --refresh-stale
```

Import one file:

```bash
./run.sh --file 2026/08/08/rollout-....jsonl
```

Use a different source directory for one run:

```bash
CODEX_SESSIONS_DIR="/path/to/.codex/sessions" ./run.sh --all --serve
```

```powershell
$env:CODEX_SESSIONS_DIR = "C:\Users\me\.codex\sessions"; .\run.ps1 --all --serve
```

Sessions can also be imported from the UI at <http://127.0.0.1:8000/logs/>.
The Codex session directory is only ever read.

## Any other command

`uv run` executes anything inside the project environment:

```bash
uv run python manage.py check
uv run python codex_prettify.py --all --force --replace-v3
uv run python scripts/export_graph.py \
  visualization/data/sessions_json/demo-session.v4.json --graph-output demo.graph.json
```

## Tests

```bash
uv run pytest -q
uv run python manage.py check
```

The JavaScript smoke tests additionally need Node.js:

```bash
npm install
node tests/smoke/units_fields.mjs
```

## Without uv

`requirements.txt` and `requirements-dev.txt` mirror `pyproject.toml`, so a
plain virtualenv still works on Python 3.10 or newer:

```bash
python3 -m venv .venv
source .venv/bin/activate          # .venv\Scripts\activate on Windows
pip install -r requirements-dev.txt
cp .env.example .env
python manage.py runserver 127.0.0.1:8000
```
