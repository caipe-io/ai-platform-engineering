#!/usr/bin/env sh
set -eu

# Run DeepEval against benchmark ground-truth contexts/reference answers.
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
  --dataset-name hotpotqa \
  --oracle-testing \
  --max-items 20 \
  "$@"
