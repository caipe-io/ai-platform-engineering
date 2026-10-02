#!/bin/bash
# ==============================================================================
# Script: list_eval_jobs.sh
# Purpose: List Evaluation Jobs & Query Job Details from RAG Evaluator API
# Usage: ./list_eval_jobs.sh [job_id] [status] [limit]
# Example: ./list_eval_jobs.sh
# Example: ./list_eval_jobs.sh job-01HABCDEF123456
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

API_URL="${API_URL:-${CAIPE_API_URL:+${CAIPE_API_URL}/api/rag-evaluator}}"
API_URL="${API_URL:-http://localhost:8000}"
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
echo "📊 CAIPE RAG Evaluator Jobs Listing Script"
echo "=================================================================="
echo "API Server: ${API_URL}"
if [ -n "$JOB_ID" ]; then
  echo "Target:     Inspecting Job ID=${JOB_ID}"
else
  echo "Target:     Listing Jobs (Status Filter: ${STATUS:-ALL}, Limit: ${LIMIT})"
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
  # Fetch specific evaluation job by ID
  echo "Fetching details for Job ID '${JOB_ID}'..."
  RESPONSE=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" "${API_URL}/jobs/${JOB_ID}")
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
else
  # List evaluation jobs
  echo "Listing evaluation jobs from ${API_URL}/jobs..."
  RESPONSE=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" "${API_URL}/jobs")
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
fi
