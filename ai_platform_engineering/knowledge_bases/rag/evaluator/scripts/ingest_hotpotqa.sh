#!/usr/bin/env sh
set -eu

# Run HotpotQA ingestion using the repository defaults.
# Additional CLI arguments can be passed to override the defaults.

SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

# Load environment variables from .env file if it exists
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  . "$REPO_ROOT/.env"
  set +a
fi

UI_BASE_URL="${UI_URL:-${CAIPE_BASE_URL:-${CAIPE_API_URL:-http://localhost:3000}}}"
RAG_URL="${RAG_URL:-${CAIPE_RAG_URL:-http://localhost:9446}}"

CLIENT_ID="${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}"
CLIENT_SECRET="${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
TOKEN_URL="${CAIPE_SA_TOKEN_URL:-${KEYCLOAK_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/token}}"
KUBE_INGESTOR_SECRET="${KUBE_INGESTOR_SECRET:-rag-ingestor-secret}"
KUBE_NAMESPACE="${KUBE_NAMESPACE:-caipe}"
KUBECONFIG_PATH="${KUBECONFIG:-}"

# 1. Machine Service Account Token Retrieval via client_credentials (Preferred for Ingestion)
if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  echo "Authenticating via CAIPE service account (client_credentials) for client '${CLIENT_ID}'..."
  FETCHED_TOKEN=$(curl -sk -X POST "$TOKEN_URL" \
    -d "grant_type=client_credentials" \
    -d "client_id=${CLIENT_ID}" \
    -d "client_secret=${CLIENT_SECRET}" | jq -r '.access_token // empty' 2>/dev/null || true)
  if [ -n "$FETCHED_TOKEN" ] && [ "$FETCHED_TOKEN" != "null" ]; then
    export CAIPE_OIDC_TOKEN="$FETCHED_TOKEN"
    echo "CAIPE_OIDC_TOKEN retrieved via service account for ${CLIENT_ID}."
  fi
fi

# 2. Machine Ingestor Token Retrieval via ingestor secret in Kube (Fallback)
if [ -z "${CAIPE_OIDC_TOKEN:-}" ] && command -v kubectl >/dev/null 2>&1; then
  KUBECMD="kubectl"
  if [ -n "$KUBECONFIG_PATH" ]; then
    KUBECMD="kubectl --kubeconfig=$KUBECONFIG_PATH"
  fi
  if $KUBECMD get secret "$KUBE_INGESTOR_SECRET" -n "$KUBE_NAMESPACE" >/dev/null 2>&1; then
    SECRET_CLIENT_ID=$($KUBECMD get secret "$KUBE_INGESTOR_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.INGESTOR_OIDC_CLIENT_ID}' 2>/dev/null | base64 --decode 2>/dev/null || true)
    SECRET_CLIENT_SECRET=$($KUBECMD get secret "$KUBE_INGESTOR_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.INGESTOR_OIDC_CLIENT_SECRET}' 2>/dev/null | base64 --decode 2>/dev/null || true)

    if [ -n "$SECRET_CLIENT_ID" ] && [ -n "$SECRET_CLIENT_SECRET" ]; then
      CLIENT_ID="$SECRET_CLIENT_ID"
      CLIENT_SECRET="$SECRET_CLIENT_SECRET"
      echo "Authenticating via Keycloak client_credentials for ingestor '${SECRET_CLIENT_ID}'..."
      FETCHED_TOKEN=$(curl -sk -X POST "$TOKEN_URL" \
        -d "grant_type=client_credentials" \
        -d "client_id=${SECRET_CLIENT_ID}" \
        -d "client_secret=${SECRET_CLIENT_SECRET}" | jq -r '.access_token // empty' 2>/dev/null || true)
      if [ -n "$FETCHED_TOKEN" ] && [ "$FETCHED_TOKEN" != "null" ]; then
        export CAIPE_OIDC_TOKEN="$FETCHED_TOKEN"
        echo "CAIPE_OIDC_TOKEN retrieved successfully for ${SECRET_CLIENT_ID}."
      fi
    fi
  fi
fi

if [ -n "$CLIENT_ID" ]; then
  export CAIPE_CLIENT_ID="$CLIENT_ID"
  export CAIPE_SA_CLIENT_ID="$CLIENT_ID"
fi
if [ -n "$CLIENT_SECRET" ]; then
  export CAIPE_CLIENT_SECRET="$CLIENT_SECRET"
  export CAIPE_SA_CLIENT_SECRET="$CLIENT_SECRET"
fi
if [ -n "$TOKEN_URL" ]; then
  export KEYCLOAK_URL="$TOKEN_URL"
  export CAIPE_SA_TOKEN_URL="$TOKEN_URL"
fi

AUTH_TOKEN="${CAIPE_OIDC_TOKEN:-${DEEPEVAL_API_KEY:-}}"
export AUTH_TOKEN
export CAIPE_OIDC_TOKEN="${AUTH_TOKEN}"

if [ -n "${PYTHON:-}" ]; then
  PYTHON_BIN="$PYTHON"
elif command -v uv >/dev/null 2>&1; then
  PYTHON_BIN="uv run python"
else
  PYTHON_BIN="python3"
fi

AUTH_ARGS=""
if [ -n "$AUTH_TOKEN" ]; then
  AUTH_ARGS="--auth-token $AUTH_TOKEN"
fi

echo "Running ingestion via Next.js UI BFF: ${RAG_URL}"

exec $PYTHON_BIN \
  "$REPO_ROOT/src/deepeval_eval/ingest/ingest.py" \
  --data-dir "$REPO_ROOT/data" \
  --rag-url "$RAG_URL" \
  --insecure \
  $AUTH_ARGS \
  --dataset-name hotpotqa \
  --limit 100 \
  --questions-per-category 50 \
  --max-docs 1000 \
  --batch-size 50 \
  "$@"
