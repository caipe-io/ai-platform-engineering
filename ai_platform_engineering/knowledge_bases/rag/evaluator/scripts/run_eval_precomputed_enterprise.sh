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
export QUESTIONS_PATH="${QUESTIONS_PATH:-${ENTERPRISE_QUESTIONS_PATH}}"
export DATASET_NAME="${DATASET_NAME:-${ENTERPRISE_DATASET_NAME}}"

# Authenticate using CAIPE Service Account credentials with grant_type=client_credentials
CLIENT_ID="${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}"
CLIENT_SECRET="${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
TOKEN_URL="${CAIPE_SA_TOKEN_URL:-${KEYCLOAK_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/token}}"
KUBE_UI_SECRET="${KUBE_UI_SECRET:-caipe-ui-secret}"
KUBE_NAMESPACE="${KUBE_NAMESPACE:-caipe}"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  if command -v kubectl >/dev/null 2>&1; then
    CLIENT_ID=$(kubectl get secret "$KUBE_UI_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.OIDC_CLIENT_ID}' 2>/dev/null | base64 --decode 2>/dev/null || true)
    CLIENT_SECRET=$(kubectl get secret "$KUBE_UI_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.OIDC_CLIENT_SECRET}' 2>/dev/null | base64 --decode 2>/dev/null || true)
  fi
fi

export CAIPE_CLIENT_ID="${CLIENT_ID}"
export CAIPE_CLIENT_SECRET="${CLIENT_SECRET}"

if [ -z "$CAIPE_AUTH_TOKEN" ] && [ -z "$CAIPE_OIDC_TOKEN" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  export CAIPE_AUTH_TOKEN=$(curl -sk -X POST "$TOKEN_URL" \
    -d "client_id=${CLIENT_ID}" \
    -d "client_secret=${CLIENT_SECRET}" \
    -d "grant_type=client_credentials" | jq -r '.access_token // empty')
fi

uv run python3 src/deepeval_eval/engine/deepeval_evaluator.py \
  eval \
  --oracle-testing \
  --datasource-id "${CAIPE_DATASOURCE_ID}" \
  --questions-file "${QUESTIONS_PATH}" \
  --dataset-name "${DATASET_NAME}" \
  --limit-per-category 10 \
  --max-items 1 \
  --top-k 5 \
  "$@"