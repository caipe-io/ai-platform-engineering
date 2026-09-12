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

API_URL="${API_URL:-${CAIPE_API_URL:+${CAIPE_API_URL}/api/rag-evaluator}}"
API_URL="${API_URL:-http://localhost:8000}"
JOB_ID="${1:-${JOB_ID}}"

# Parse format and view arguments
FORMAT="json"
VIEW="results"

for arg in "$2" "$3"; do
  case "$arg" in
    summary|--summary)
      VIEW="summary"
      ;;
    csv|json)
      FORMAT="$arg"
      ;;
  esac
done

CLIENT_ID="${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}"
CLIENT_SECRET="${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
TOKEN_URL="${CAIPE_SA_TOKEN_URL:-${KEYCLOAK_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/token}}"
KUBE_UI_SECRET="${KUBE_UI_SECRET:-caipe-ui-secret}"
KUBE_NAMESPACE="${KUBE_NAMESPACE:-caipe}"

# 1. Machine Service Account Token Retrieval via client_credentials (Preferred)
if [ -z "$CAIPE_OIDC_TOKEN" ]; then
  if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
    echo "Authenticating via CAIPE service account (client_credentials) for client '${CLIENT_ID}'..."
    FETCHED_TOKEN=$(curl -sk -X POST "$TOKEN_URL" \
      -d "grant_type=client_credentials" \
      -d "client_id=${CLIENT_ID}" \
      -d "client_secret=${CLIENT_SECRET}" | jq -r '.access_token // empty' 2>/dev/null || true)
    if [ -n "$FETCHED_TOKEN" ] && [ "$FETCHED_TOKEN" != "null" ]; then
      export CAIPE_OIDC_TOKEN="$FETCHED_TOKEN"
      echo "CAIPE_OIDC_TOKEN retrieved successfully from service account endpoint."
    fi
  fi
fi

# 2. Fallback: Retrieve OIDC token from Kubernetes secret if unconfigured
if [ -z "$CAIPE_OIDC_TOKEN" ] && command -v kubectl >/dev/null 2>&1; then
  if kubectl get secret "$KUBE_UI_SECRET" -n "$KUBE_NAMESPACE" >/dev/null 2>&1; then
    K_CLIENT_ID=$(kubectl get secret "$KUBE_UI_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.OIDC_CLIENT_ID}' | base64 --decode 2>/dev/null || true)
    K_CLIENT_SECRET=$(kubectl get secret "$KUBE_UI_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.OIDC_CLIENT_SECRET}' | base64 --decode 2>/dev/null || true)

    if [ -n "$K_CLIENT_ID" ] && [ -n "$K_CLIENT_SECRET" ]; then
      FETCHED_TOKEN=$(curl -sk -X POST "$TOKEN_URL" \
        -d "client_id=${K_CLIENT_ID}" \
        -d "client_secret=${K_CLIENT_SECRET}" \
        -d "grant_type=client_credentials" | jq -r '.access_token // empty' 2>/dev/null || true)
      if [ -n "$FETCHED_TOKEN" ] && [ "$FETCHED_TOKEN" != "null" ]; then
        export CAIPE_OIDC_TOKEN="$FETCHED_TOKEN"
        echo "CAIPE_OIDC_TOKEN retrieved successfully from Keycloak OIDC endpoint."
      fi
    fi

    if [ -z "$CAIPE_OIDC_TOKEN" ]; then
      FETCHED_KEY=$(kubectl get secret "$KUBE_UI_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.AGENTGATEWAY_TARGETS_TOKEN}' | base64 --decode 2>/dev/null || true)
      if [ -z "$FETCHED_KEY" ]; then
        FETCHED_KEY=$(kubectl get secret "$KUBE_UI_SECRET" -n "$KUBE_NAMESPACE" -o jsonpath='{.data.NEXTAUTH_SECRET}' | base64 --decode 2>/dev/null || true)
      fi
      if [ -n "$FETCHED_KEY" ]; then
        export DEEPEVAL_API_KEY="$FETCHED_KEY"
      fi
    fi
  fi
fi

AUTH_TOKEN="${CAIPE_OIDC_TOKEN:-${DEEPEVAL_API_KEY}}"
if [ -z "$AUTH_TOKEN" ]; then
  echo "Error: No authentication credentials found (CAIPE_OIDC_TOKEN or DEEPEVAL_API_KEY is not set and Kubernetes secret retrieval failed)."
  echo "Please set CAIPE_OIDC_TOKEN or DEEPEVAL_API_KEY in your .env file or export it in your terminal."
  exit 1
fi

AUTH_HEADER=(-H "Authorization: Bearer ${AUTH_TOKEN}")

if [ -z "$JOB_ID" ]; then
  echo "No JOB_ID provided. Fetching available evaluation jobs from ${API_URL}/jobs..."
  JOBS_RESP=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" "${API_URL}/jobs")
  echo "$JOBS_RESP" | jq . 2>/dev/null || echo "$JOBS_RESP"
  echo ""
  echo "Usage: $0 <JOB_ID> [FORMAT] [--summary]"
  echo "  FORMAT options: json (default), csv"
  echo "  VIEW options:   summary (or --summary flag to return result summary only)"
  exit 0
fi

echo "Retrieving evaluation job details for Job ID: ${JOB_ID}"
echo "API Endpoint: ${API_URL}/jobs/${JOB_ID}"

STATUS_RESP=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}")
JOB_STATUS=$(echo "$STATUS_RESP" | jq -r '.status // empty')

echo "Job Status: ${JOB_STATUS}"

if [ "$JOB_STATUS" = "completed" ]; then
  echo ""
  echo "=========================================="
  echo "Fetching Evaluation Results (${VIEW})..."
  echo "=========================================="
  RESULTS_DIR="results"
  mkdir -p "$RESULTS_DIR"
  
  CSV_FILE="${RESULTS_DIR}/job_${JOB_ID}_results.csv"
  JSON_FILE="${RESULTS_DIR}/job_${JOB_ID}_results.json"
  SUMMARY_FILE="${RESULTS_DIR}/job_${JOB_ID}_summary.json"
  SUMMARY_CSV_FILE="${RESULTS_DIR}/job_${JOB_ID}_summary.csv"

  if [ "$VIEW" = "summary" ]; then
    if [ "$FORMAT" = "csv" ]; then
      curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}/summary?format=csv" > "$SUMMARY_CSV_FILE"
      cat "$SUMMARY_CSV_FILE"
      echo ""
      echo "Saved to: ${SUMMARY_CSV_FILE}"
    else
      curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}/summary?format=json" > "$SUMMARY_FILE"
      cat "$SUMMARY_FILE" | jq . 2>/dev/null || cat "$SUMMARY_FILE"
      echo ""
      echo "Saved to: ${SUMMARY_FILE}"
    fi
  elif [ "$FORMAT" = "csv" ]; then
    curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}/results?format=csv" > "$CSV_FILE"
    cat "$CSV_FILE"
    echo ""
    echo "Saved to: ${CSV_FILE}"
  else
    curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}/results?format=json" > "$JSON_FILE"
    cat "$JSON_FILE" | jq . 2>/dev/null || cat "$JSON_FILE"
    echo ""
    echo "Saved to: ${JSON_FILE}"
  fi
elif [ "$JOB_STATUS" = "failed" ]; then
  echo "Job failed!"
  echo "$STATUS_RESP" | jq . 2>/dev/null || echo "$STATUS_RESP"
  exit 1
else
  echo "Job is currently in '${JOB_STATUS}' state."
  echo "$STATUS_RESP" | jq . 2>/dev/null || echo "$STATUS_RESP"
fi
