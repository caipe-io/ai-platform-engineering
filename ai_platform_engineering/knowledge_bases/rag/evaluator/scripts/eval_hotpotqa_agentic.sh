#!/usr/bin/env sh
set -eu

# Run HotpotQA agentic evaluation via CAIPE supervisor streaming endpoint.

SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
PYTHON_BIN=${PYTHON:-python3}

# Load environment variables from .env file if it exists
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  . "$REPO_ROOT/.env"
  set +a
fi

AGENT_URL=${CAIPE_AGENT_URL:-${CAIPE_API_URL:-${CAIPE_SUPERVISOR_URL:-http://localhost:8000}}}

exec "$PYTHON_BIN" \
  "$REPO_ROOT/src/deepeval_eval/engine/deepeval_evaluator.py" \
  eval \
  --dataset-name hotpotqa \
  --agentic \
  --agent-url "$AGENT_URL" \
  --max-items 10 \
  --top-k 5 \
  --max-context-chars 12000 \
  "$@"
