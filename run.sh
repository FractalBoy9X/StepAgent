#!/usr/bin/env bash
# StepAgent launcher for macOS and Linux. The Windows equivalent is run.ps1.
#
#   ./run.sh --serve          start the server
#   ./run.sh --all --serve    import every session, then start the server
#   ./run.sh --all            import only
#
# Arguments other than --serve are forwarded to codex_prettify.py unchanged.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v uv >/dev/null 2>&1; then
  cat >&2 <<'MSG'
uv was not found on PATH.

uv installs the right Python version and the project dependencies for you, so
it is the only prerequisite. Install it with one of:

  curl -LsSf https://astral.sh/uv/install.sh | sh    # macOS / Linux
  brew install uv                                    # Homebrew
  pipx install uv                                    # existing Python

Then run this script again. Full instructions: https://docs.astral.sh/uv/
MSG
  exit 1
fi

# A first run without .env gets the documented defaults rather than an error.
if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

SERVE=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--serve" ]]; then
    SERVE=true
  else
    ARGS+=("$arg")
  fi
done

if [[ ${#ARGS[@]} -gt 0 ]] || [[ "$SERVE" == false ]]; then
  uv run --no-dev python codex_prettify.py "${ARGS[@]}"
fi

if [[ "$SERVE" == true ]]; then
  HOST="${DJANGO_HOST:-127.0.0.1}"
  PORT="${DJANGO_PORT:-8000}"
  echo "StepAgent: http://${HOST}:${PORT}/visualization/"
  exec uv run --no-dev python manage.py runserver "${HOST}:${PORT}"
fi
