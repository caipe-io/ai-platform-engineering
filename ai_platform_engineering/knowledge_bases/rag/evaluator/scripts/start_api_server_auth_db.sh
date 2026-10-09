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

# Explicitly enforce authentication by turning off dev bypass flags
export ALLOW_UNAUTHENTICATED_ACCESS="${ALLOW_UNAUTHENTICATED_ACCESS:-false}"
export CAIPE_UNSAFE_RBAC_BYPASS="${CAIPE_UNSAFE_RBAC_BYPASS:-false}"

# Default OIDC Provider Configuration (for JWT Bearer token validation)
export OIDC_ISSUER="${OIDC_ISSUER:-${OIDC_ISSUER_URL:-http://localhost:7080/realms/caipe}}"
export OIDC_AUDIENCE="${OIDC_AUDIENCE:-caipe-ui}"
export OIDC_JWKS_URL="${OIDC_JWKS_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/certs}"
KUBE_TLS_SECRET="${KUBE_TLS_SECRET:-caipe-tls}"
KUBE_UI_SECRET="${KUBE_UI_SECRET:-caipe-ui-secret}"
KUBE_NAMESPACE="${KUBE_NAMESPACE:-caipe}"

# KUBECONFIG fallback for Kubernetes secret retrieval
KUBECONFIG_ARG=""
if [ -n "$KUBECONFIG" ] && [ -f "$KUBECONFIG" ]; then
  KUBECONFIG_ARG="--kubeconfig=$KUBECONFIG"
fi

# Retrieve Kubernetes CA/TLS certificate for Keycloak SSL verification
if command -v kubectl >/dev/null 2>&1; then
  if kubectl $KUBECONFIG_ARG get secret "$KUBE_TLS_SECRET" -n "$KUBE_NAMESPACE" >/dev/null 2>&1; then
    kubectl $KUBECONFIG_ARG get secret "$KUBE_TLS_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.tls\.crt}' | base64 --decode > /tmp/caipe_tls.crt 2>/dev/null || true
    if [ -s /tmp/caipe_tls.crt ]; then
      export SSL_CERT_FILE=/tmp/caipe_tls.crt
      export REQUESTS_CA_BUNDLE=/tmp/caipe_tls.crt
      export OIDC_VERIFY_SSL=true
      echo "${KUBE_TLS_SECRET} certificate retrieved successfully from Kubernetes. Strict SSL verification enabled."
    fi
  fi
fi

# Retrieve and set DEEPEVAL_API_KEY from Kubernetes secret if not already set
if [ -z "$DEEPEVAL_API_KEY" ] && command -v kubectl >/dev/null 2>&1; then
  if kubectl $KUBECONFIG_ARG get secret "$KUBE_UI_SECRET" -n "$KUBE_NAMESPACE" >/dev/null 2>&1; then
    FETCHED_KEY=$(kubectl $KUBECONFIG_ARG get secret caipe-ui-secret -n caipe -o jsonpath='{.data.AGENTGATEWAY_TARGETS_TOKEN}' | base64 --decode 2>/dev/null || true)
    if [ -z "$FETCHED_KEY" ]; then
      FETCHED_KEY=$(kubectl $KUBECONFIG_ARG get secret caipe-ui-secret -n caipe -o jsonpath='{.data.NEXTAUTH_SECRET}' | base64 --decode 2>/dev/null || true)
    fi
    if [ -n "$FETCHED_KEY" ]; then
      export DEEPEVAL_API_KEY="$FETCHED_KEY"
      echo "DEEPEVAL_API_KEY retrieved successfully from Kubernetes secret 'caipe-ui-secret'."
    fi
  fi
fi

# Retrieve and set CAIPE_CLIENT_ID and CAIPE_CLIENT_SECRET from Kubernetes secret if not set
if [ -z "$CAIPE_CLIENT_ID" ] && command -v kubectl >/dev/null 2>&1; then
  if kubectl $KUBECONFIG_ARG get secret caipe-ui-secret -n caipe >/dev/null 2>&1; then
    FETCHED_CID=$(kubectl $KUBECONFIG_ARG get secret caipe-ui-secret -n caipe -o jsonpath='{.data.OIDC_CLIENT_ID}' | base64 --decode | tr -d '\r\n' 2>/dev/null || true)
    FETCHED_CSEC=$(kubectl $KUBECONFIG_ARG get secret caipe-ui-secret -n caipe -o jsonpath='{.data.OIDC_CLIENT_SECRET}' | base64 --decode | tr -d '\r\n' 2>/dev/null || true)
    if [ -n "$FETCHED_CID" ] && [ -n "$FETCHED_CSEC" ]; then
      export CAIPE_CLIENT_ID="$FETCHED_CID"
      export CAIPE_CLIENT_SECRET="$FETCHED_CSEC"
      echo "CAIPE_CLIENT_ID & CAIPE_CLIENT_SECRET retrieved successfully from Kubernetes secret 'caipe-ui-secret'."
    fi
  fi
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

echo "Starting Auth-Protected & DB-Connected CAIPE DeepEval REST API server on ${HOST}:${PORT}..."
echo "  - ALLOW_UNAUTHENTICATED_ACCESS: ${ALLOW_UNAUTHENTICATED_ACCESS}"
echo "  - CAIPE_UNSAFE_RBAC_BYPASS: ${CAIPE_UNSAFE_RBAC_BYPASS}"
echo "  - OIDC_ISSUER: ${OIDC_ISSUER}"
echo "  - OIDC_AUDIENCE: ${OIDC_AUDIENCE}"
echo "  - OIDC_VERIFY_SSL: ${OIDC_VERIFY_SSL:-false}"
echo "  - OPENAI_ENDPOINT: ${OPENAI_ENDPOINT}"
echo "  - OPENAI_API_KEY: ${OPENAI_API_KEY:0:7}... (len=${#OPENAI_API_KEY})"
if [ -n "$DEEPEVAL_API_KEY" ]; then
  echo "  - DEEPEVAL_API_KEY: [CONFIGURED - static API key validation enabled]"
else
  echo "  - DEEPEVAL_API_KEY: [NOT SET - provide DEEPEVAL_API_KEY in .env or environment]"
fi
if [ -n "$DATABASE_URL" ]; then
  echo "  - DATABASE_URL: postgresql://${POSTGRES_USER}:****@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB} [CONFIGURED]"
else
  echo "  - DATABASE_URL: [NOT SET - DB persistence disabled or credentials missing]"
fi

# Run the protected API server via uv
uv run python3 -c "from deepeval_eval.api.app import run_server; run_server(host='${HOST}', port=${PORT})"
