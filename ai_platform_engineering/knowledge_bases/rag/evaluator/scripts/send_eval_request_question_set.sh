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
SET_ID="${SET_ID:-1}"
ANSWER_MODE="${ANSWER_MODE:-generate}"
MAX_ITEMS="${MAX_ITEMS:-1}"
LIMIT_PER_CATEGORY="${LIMIT_PER_CATEGORY:-}"
TOP_K="${TOP_K:-3}"
MAX_CONTEXT_CHARS="${MAX_CONTEXT_CHARS:-12000}"
AGENTIC="${AGENTIC:-true}"
FORCE_RERUN="${FORCE_RERUN:-false}"
DATASOURCE_ID="${DATASOURCE_ID:-enterprise_rag_bench}"

# Usage: ./scripts/send_eval_request_question_set.sh [set_id] [max_items] [top_k] [datasource_id]
if [ -n "$1" ]; then
  SET_ID="$1"
fi
if [ -n "$2" ]; then
  MAX_ITEMS="$2"
fi
if [ -n "$3" ]; then
  TOP_K="$3"
fi
if [ -n "$4" ]; then
  DATASOURCE_ID="$4"
fi

echo "=================================================================="
echo " Question Set Database Evaluation Job Submission"
echo "=================================================================="
echo "API Server:     ${API_URL}"
echo "Target Set ID:  ${SET_ID}"
echo "Datasource ID:  ${DATASOURCE_ID}"
echo "Answer Mode:    ${ANSWER_MODE}"
echo "Top K Docs:     ${TOP_K}"
echo "=================================================================="

CLIENT_ID="${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}"
CLIENT_SECRET="${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
TOKEN_URL="${CAIPE_TOKEN_URL:-https://caipe.homelab/auth/realms/caipe/protocol/openid-connect/token}"

# If no token is provided, attempt client_credentials grant
if [ -z "${CAIPE_OIDC_TOKEN:-}" ]; then
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
AUTH_HEADER=()
if [ -n "$AUTH_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${AUTH_TOKEN}")
fi

# Submit evaluation job targeting PostgreSQL Question Set ID
PAYLOAD="{
  \"question_set_id\": ${SET_ID},
  \"answer_mode\": \"${ANSWER_MODE}\",
  \"top_k\": ${TOP_K},
  \"max_context_chars\": ${MAX_CONTEXT_CHARS},
  \"agentic\": ${AGENTIC},
  \"force_rerun\": ${FORCE_RERUN}
}"

if [ -n "$DATASOURCE_ID" ]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq ". + {\"datasource_id\": \"${DATASOURCE_ID}\"}")
fi
if [ -n "$MAX_ITEMS" ]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq ". + {\"max_items\": ${MAX_ITEMS}}")
fi
if [ -n "$LIMIT_PER_CATEGORY" ]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq ". + {\"limit_per_category\": ${LIMIT_PER_CATEGORY}}")
fi

echo "Submitting evaluation job payload:"
echo "$PAYLOAD" | jq .

RESPONSE=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" -H "Content-Type: application/json" \
  -X POST "${API_URL}/eval/jobs/question-sets/${SET_ID}" \
  -d "$PAYLOAD")

echo ""
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

while true; do
  STATUS_RESP=$(curl -k -s "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}")
  JOB_STATUS=$(echo "$STATUS_RESP" | jq -r '.status // empty')
  echo "Status: ${JOB_STATUS}"

  if [ "$JOB_STATUS" = "completed" ] || [ "$JOB_STATUS" = "failed" ]; then
    echo ""
    echo "Final Job Status: ${JOB_STATUS}"
    echo "$STATUS_RESP" | jq . 2>/dev/null || echo "$STATUS_RESP"
    if [ "$JOB_STATUS" = "completed" ]; then
      echo ""
      echo "=================================================================="
      echo " Job Results (${API_URL}/jobs/${JOB_ID}/results):"
      echo "=================================================================="
      RESULTS_RESP=$(curl -k -s "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}/results")
      echo "$RESULTS_RESP" | jq . 2>/dev/null || echo "$RESULTS_RESP"
    fi
    break
  fi
  sleep 2
done
