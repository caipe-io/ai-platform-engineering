#!/usr/bin/env sh
set -eu

# Run EnterpriseRAG-Bench evaluation using the repository defaults.
# Additional CLI arguments can be passed to override the defaults.

SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
PYTHON_BIN=${PYTHON:-python3}

# Load environment variables from .env file if it exists
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  . "$REPO_ROOT/.env"
  set +a
fi

exec "$PYTHON_BIN" \
  "$REPO_ROOT/src/deepeval_eval/engine/deepeval_evaluator.py" \
  eval \
  --dataset-name enterprise \
  --max-items 10 \
  --top-k 3 \
  --max-context-chars 6000 \
  "$@"
