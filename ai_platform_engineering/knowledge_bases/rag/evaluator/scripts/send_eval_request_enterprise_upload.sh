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
QUESTIONS_PATH="${QUESTIONS_PATH:-${ENTERPRISE_QUESTIONS_PATH}}"
DATASET_NAME="${DATASET_NAME:-${ENTERPRISE_DATASET_NAME}}"
DATASOURCE_ID="${DATASOURCE_ID:-${ENTERPRISE_CAIPE_DATASOURCE_ID}}"
ANSWER_MODE="${ANSWER_MODE:-generate}"
MAX_ITEMS="${MAX_ITEMS:-1}"
LIMIT_PER_CATEGORY="${LIMIT_PER_CATEGORY:-}"
TOP_K="${TOP_K:-5}"
MAX_CONTEXT_CHARS="${MAX_CONTEXT_CHARS:-16000}"
AGENTIC="${AGENTIC:-true}"
FORCE_RERUN="${FORCE_RERUN:-false}"

if [ ! -f "$QUESTIONS_PATH" ]; then
  echo "Error: Questions dataset file not found at '$QUESTIONS_PATH'"
  exit 1
fi

echo "Submitting evaluation job with uploaded dataset: ${QUESTIONS_PATH}"
echo "API Endpoint: ${API_URL}/eval/jobs/upload"

QUERY_PARAMS="dataset_name=${DATASET_NAME}&datasource_id=${DATASOURCE_ID}&answer_mode=${ANSWER_MODE}&max_items=${MAX_ITEMS}&top_k=${TOP_K}&max_context_chars=${MAX_CONTEXT_CHARS}&agentic=${AGENTIC}&force_rerun=${FORCE_RERUN}"
if [ -n "$LIMIT_PER_CATEGORY" ]; then
  QUERY_PARAMS="${QUERY_PARAMS}&limit_per_category=${LIMIT_PER_CATEGORY}"
fi

CLIENT_ID="${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}"
CLIENT_SECRET="${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
TOKEN_URL="${CAIPE_SA_TOKEN_URL:-${KEYCLOAK_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/token}}"

# 1. Machine Service Account Token Retrieval via client_credentials
if [ -z "$CAIPE_OIDC_TOKEN" ]; then
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
fi

AUTH_TOKEN="${CAIPE_OIDC_TOKEN:-${DEEPEVAL_API_KEY}}"
if [ -z "$AUTH_TOKEN" ]; then
  echo "Error: No authentication credentials found (CAIPE_OIDC_TOKEN or DEEPEVAL_API_KEY is not set and Kubernetes secret retrieval failed)."
  echo "Please set CAIPE_OIDC_TOKEN or DEEPEVAL_API_KEY in your .env file or export it in your terminal."
  exit 1
fi

AUTH_HEADER=(-H "Authorization: Bearer ${AUTH_TOKEN}")

# Upload dataset file and submit eval job
RESPONSE=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" -X POST "${API_URL}/eval/jobs/upload?${QUERY_PARAMS}" \
  -F "file=@${QUESTIONS_PATH}")

echo "Response from API:"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

JOB_ID=$(echo "$RESPONSE" | jq -r '.job_id // empty')

if [ -z "$JOB_ID" ]; then
  echo "Failed to obtain job_id from API response."
  exit 1
fi

echo ""
echo "Evaluation job submitted successfully. Job ID: ${JOB_ID}"
echo "Polling job status at ${API_URL}/jobs/${JOB_ID}..."

# Poll job status until complete or failed
while true; do
  STATUS_RESP=$(curl -k -s "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}")
  JOB_STATUS=$(echo "$STATUS_RESP" | jq -r '.status')
  echo "[$(date +'%H:%M:%S')] Job status: ${JOB_STATUS}"

  if [ "$JOB_STATUS" = "completed" ]; then
    echo ""
    echo "=========================================="
    echo "Job Completed Successfully!"
    echo "=========================================="
    echo "Fetching detailed job results..."
    RESULTS_DIR="results"
    mkdir -p "$RESULTS_DIR"
    CSV_FILE="${RESULTS_DIR}/job_${JOB_ID}_results.csv"
    JSON_FILE="${RESULTS_DIR}/job_${JOB_ID}_results.json"
    
    # Save CSV option for download
    curl -k -s "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}/results?format=csv" > "$CSV_FILE"
    
    # Save and print JSON to console
    curl -k -s "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}/results?format=json" > "$JSON_FILE"
    cat "$JSON_FILE" | jq . 2>/dev/null || cat "$JSON_FILE"
    
    echo ""
    echo "Results saved to:"
    echo "  - JSON (console standard): ${JSON_FILE}"
    echo "  - CSV (download option): ${CSV_FILE}"
    break
  elif [ "$JOB_STATUS" = "failed" ]; then
    echo ""
    echo "Job failed!"
    echo "$STATUS_RESP" | jq .
    exit 1
  fi

  sleep 3
done
