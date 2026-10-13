#!/usr/bin/env bash
# One command to get the decision-model frontend running.
#   ./run.sh               serve on http://127.0.0.1:8787
#   ./run.sh --port 8788   extra args go to server.py
# First run bootstraps .env from .env.example (fill in CLEF_API_TOKEN).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "run.sh: created .env from .env.example — fill in CLEF_API_TOKEN before making decisions." >&2
fi

exec uv run python server.py "$@"