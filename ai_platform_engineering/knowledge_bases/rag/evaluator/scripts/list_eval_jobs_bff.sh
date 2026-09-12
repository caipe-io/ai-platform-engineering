#!/bin/bash
# ==============================================================================
# Script: list_eval_jobs_bff.sh
# Purpose: List Evaluation Jobs & Query Job Details via Next.js UI BFF Proxy
# Usage: ./list_eval_jobs_bff.sh [job_id] [status] [limit]
# Example: ./list_eval_jobs_bff.sh
# Example: ./list_eval_jobs_bff.sh job-01HABCDEF123456
# ==============================================================================
set -e

# Ensure we are in the project root directory
cd "$(dirname "$0")/.."

# Load environment variables from .env file if it exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

UI_BASE_URL="${UI_URL:-${CAIPE_BASE_URL:-${CAIPE_API_URL:-http://localhost:3000}}}"
BFF_URL="${BFF_URL:-${UI_BASE_URL}/api/rag-evaluator}"

JOB_ID="${JOB_ID:-}"
STATUS="${STATUS:-}"
LIMIT="${LIMIT:-20}"

if [ -n "$1" ]; then
  # If $1 looks like a job_id (starts with job- or hex), assign to JOB_ID, otherwise to STATUS
  if [[ "$1" =~ ^job- ]] || [[ "$1" =~ ^[0-9a-fA-F-]{8,} ]]; then
    JOB_ID="$1"
  else
    STATUS="$1"
  fi
fi
if [ -n "$2" ]; then
  LIMIT="$2"
fi

CLIENT_ID="${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}"
CLIENT_SECRET="${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
TOKEN_URL="${CAIPE_SA_TOKEN_URL:-${KEYCLOAK_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/token}}"

echo "=================================================================="
echo "📊 CAIPE RAG Evaluator Jobs Listing Script (via UI BFF)"
echo "=================================================================="
echo "UI BFF Endpoint: ${BFF_URL}"
if [ -n "$JOB_ID" ]; then
  echo "Target:          Inspecting Job ID=${JOB_ID}"
else
  echo "Target:          Listing Jobs (Status Filter: ${STATUS:-ALL}, Limit: ${LIMIT})"
fi
echo "=================================================================="

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
AUTH_HEADER=()
if [ -n "$AUTH_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${AUTH_TOKEN}")
fi

if [ -n "$JOB_ID" ]; then
  # Fetch specific evaluation job by ID via UI BFF
  echo "Fetching details for Job ID '${JOB_ID}' via UI BFF..."
  RESPONSE=$(curl -k -sS "${AUTH_HEADER[@]}" "${BFF_URL}/jobs/${JOB_ID}" 2>/dev/null || true)
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

  echo ""
  echo "Fetching Database Evaluation Results for '${JOB_ID}'..."
  DB_RESPONSE=$(curl -k -sS "${AUTH_HEADER[@]}" "${BFF_URL}/results/db/${JOB_ID}" 2>/dev/null || true)
  echo "$DB_RESPONSE" | jq . 2>/dev/null || echo "$DB_RESPONSE"
else
  # List evaluation jobs via UI BFF
  echo "1. Active Submitted Job Queue (${BFF_URL}/jobs):"
  RESPONSE=$(curl -k -sS "${AUTH_HEADER[@]}" "${BFF_URL}/jobs" 2>/dev/null || true)
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

  echo ""
  echo "2. Database Evaluation Runs (${BFF_URL}/results/db?limit=${LIMIT}):"
  DB_RESPONSE=$(curl -k -sS "${AUTH_HEADER[@]}" "${BFF_URL}/results/db?limit=${LIMIT}" 2>/dev/null || true)
  echo "$DB_RESPONSE" | jq . 2>/dev/null || echo "$DB_RESPONSE"
fi
