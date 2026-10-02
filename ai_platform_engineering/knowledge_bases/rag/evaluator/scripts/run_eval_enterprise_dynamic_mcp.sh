#!/bin/bash

# Ensure we are in the project root directory
cd "$(dirname "$0")/.."

# Load environment variables from .env file if it exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Override configuration variables for Enterprise RAG Bench (sourced from .env)
export CAIPE_DATASOURCE_ID="${CAIPE_DATASOURCE_ID:-${ENTERPRISE_CAIPE_DATASOURCE_ID}}"
export DATASET_NAME="${DATASET_NAME:-${ENTERPRISE_DATASET_NAME}}"
export QUESTIONS_PATH="${QUESTIONS_PATH:-${ENTERPRISE_QUESTIONS_PATH}}"
export RAG_URL="${RAG_URL_OVERRIDE:-${RAG_URL:-${CAIPE_API_URL:+${CAIPE_API_URL}/api/rag}}}"
export RAG_URL="${RAG_URL:-http://localhost:9446}"

# Authenticate using CAIPE Service Account credentials with grant_type=client_credentials
CLIENT_ID="${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}"
CLIENT_SECRET="${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
TOKEN_URL="${CAIPE_SA_TOKEN_URL:-${KEYCLOAK_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/token}}"
KUBE_PLATFORM_SECRET="${KUBE_PLATFORM_SECRET:-caipe-platform-secret}"
KUBE_NAMESPACE="${KUBE_NAMESPACE:-caipe}"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  if command -v kubectl >/dev/null 2>&1 && kubectl get secret "$KUBE_PLATFORM_SECRET" -n "$KUBE_NAMESPACE" >/dev/null 2>&1; then
    CLIENT_ID=$(kubectl get secret "$KUBE_PLATFORM_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.OIDC_CLIENT_ID}' 2>/dev/null | base64 --decode 2>/dev/null || true)
    CLIENT_SECRET=$(kubectl get secret "$KUBE_PLATFORM_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.OIDC_CLIENT_SECRET}' 2>/dev/null | base64 --decode 2>/dev/null || true)
  fi
fi

if [ -z "$CAIPE_OIDC_TOKEN" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  export CAIPE_OIDC_TOKEN=$(curl -sk -X POST "$TOKEN_URL" \
    -d "client_id=${CLIENT_ID}" \
    -d "client_secret=${CLIENT_SECRET}" \
    -d "grant_type=client_credentials" | jq -r '.access_token // empty')
fi

# Run deepeval evaluation with dynamic ephemeral MCP custom search tool creation
uv run python3 src/deepeval_eval/engine/deepeval_evaluator.py \
  eval \
  --dataset-name "${DATASET_NAME}" \
  --datasource-id "${CAIPE_DATASOURCE_ID}" \
  --rag-url "${RAG_URL}" \
  --questions-file "${QUESTIONS_PATH}" \
  --agent-url "${CAIPE_AGENT_URL:-${CAIPE_API_URL:-http://localhost:8000}}" \
  --agentic \
  --trace-log \
  --max-items 1 \
  --top-k 2 \
  --max-context-chars 16000 \
  --dynamic-tool \
  --semantic-weight 0.5 \
  --tool-description "Ephemeral dynamic MCP search tool with 0.5 semantic weight" \
  "$@"
