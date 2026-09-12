#!/bin/bash
set -e

# Ensure we are in the project root directory
cd "$(dirname "$0")/.."

# Load environment variables from .env file if it exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Enable unauthenticated access for local development (no auth, DB-connected)
export ALLOW_UNAUTHENTICATED_ACCESS="${ALLOW_UNAUTHENTICATED_ACCESS:-true}"
export CAIPE_UNSAFE_RBAC_BYPASS="${CAIPE_UNSAFE_RBAC_BYPASS:-true}"

# KUBECONFIG fallback for Kubernetes secret retrieval
KUBECONFIG_ARG=""
if [ -n "$KUBECONFIG" ] && [ -f "$KUBECONFIG" ]; then
  KUBECONFIG_ARG="--kubeconfig=$KUBECONFIG"
fi

# Retrieve PostgreSQL Admin Password from Kubernetes secret if not set
if [ -z "$POSTGRES_PASSWORD" ] && command -v kubectl >/dev/null 2>&1; then
  if kubectl $KUBECONFIG_ARG get secret caipe-postgres-credentials -n caipe >/dev/null 2>&1; then
    FETCHED_PG_PASS=$(kubectl $KUBECONFIG_ARG get secret caipe-postgres-credentials -n caipe -o jsonpath='{.data.POSTGRES_ADMIN_PASSWORD}' | base64 --decode 2>/dev/null || true)
    if [ -n "$FETCHED_PG_PASS" ]; then
      export POSTGRES_PASSWORD="$FETCHED_PG_PASS"
      echo "POSTGRES_PASSWORD retrieved successfully from Kubernetes secret 'caipe-postgres-credentials'."
    fi
  fi
fi

# PostgreSQL Database Configuration Defaults
export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
export POSTGRES_DB="${POSTGRES_DB:-evaluator}"
export POSTGRES_USER="${POSTGRES_USER:-postgres}"

# Construct DATABASE_URL if not explicitly set
if [ -z "$DATABASE_URL" ] && [ -n "$POSTGRES_PASSWORD" ]; then
  export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
fi

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

echo "Starting DB-Connected CAIPE DeepEval REST API server (Unauthenticated Dev Mode) on ${HOST}:${PORT}..."
echo "  - ALLOW_UNAUTHENTICATED_ACCESS: ${ALLOW_UNAUTHENTICATED_ACCESS}"
echo "  - CAIPE_UNSAFE_RBAC_BYPASS: ${CAIPE_UNSAFE_RBAC_BYPASS}"
echo "  - OPENAI_ENDPOINT: ${OPENAI_ENDPOINT}"
echo "  - OPENAI_API_KEY: ${OPENAI_API_KEY:0:7}... (len=${#OPENAI_API_KEY})"
if [ -n "$DATABASE_URL" ]; then
  echo "  - DATABASE_URL: postgresql://${POSTGRES_USER}:****@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB} [CONFIGURED]"
else
  echo "  - DATABASE_URL: [NOT SET - DB persistence disabled or credentials missing]"
fi

# Run the API server via uv
uv run python3 -c "from deepeval_eval.api.app import run_server; run_server(host='${HOST}', port=${PORT})"
