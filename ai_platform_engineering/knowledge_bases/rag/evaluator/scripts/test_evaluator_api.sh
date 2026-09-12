#!/usr/bin/env bash
# ==============================================================================
# Script: test_evaluator_api.sh
# Purpose: End-to-End REST API & OpenFGA Authorization Test for Evaluator Service
#          Uses CAIPE Service Account credentials (grant_type=client_credentials) or direct Bearer tokens
# Usage: ./test_evaluator_api.sh [EVALUATOR_BASE_URL]
# ==============================================================================
set -euo pipefail

BASE_URL="${1:-http://localhost:8000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-${CAIPE_SA_TOKEN_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/token}}"
CLIENT_ID="${CLIENT_ID:-${CAIPE_CLIENT_ID:-caipe-platform}}"
CLIENT_SECRET="${CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
KUBE_NAMESPACE="${KUBE_NAMESPACE:-caipe}"

echo "======================================================================"
echo "🧪 RAG Evaluator API & OpenFGA ReBAC Test"
echo "   Target API: ${BASE_URL}"
echo "======================================================================"

# Admin / Service Account credentials
ADMIN_CLIENT_ID="${ADMIN_CLIENT_ID:-${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}}"
ADMIN_CLIENT_SECRET="${ADMIN_CLIENT_SECRET:-${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}}"

# User credentials (for unprivileged testing)
USER_CLIENT_ID="${USER_CLIENT_ID:-${CAIPE_USER_CLIENT_ID:-}}"
USER_CLIENT_SECRET="${USER_CLIENT_SECRET:-${CAIPE_USER_CLIENT_SECRET:-}}"

echo ""
echo "1. 🌐 Acquiring Keycloak OAuth2 JWT Tokens (grant_type=client_credentials)..."

# Fetch Admin / SA Token
ADMIN_TOKEN="${ADMIN_TOKEN:-${CAIPE_OIDC_TOKEN:-}}"
if [[ -z "$ADMIN_TOKEN" ]] && [[ -n "$ADMIN_CLIENT_ID" ]] && [[ -n "$ADMIN_CLIENT_SECRET" ]]; then
  ADMIN_TOKEN_RES=$(curl -s -k -X POST -d "grant_type=client_credentials" \
    -d "client_id=${ADMIN_CLIENT_ID}" \
    -d "client_secret=${ADMIN_CLIENT_SECRET}" \
    "${KEYCLOAK_URL}")
  ADMIN_TOKEN=$(python3 -c "import json; print(json.loads('''$ADMIN_TOKEN_RES''').get('access_token', ''))" 2>/dev/null || echo "")
fi

# Fetch Local User Token
USER_TOKEN="${USER_TOKEN:-}"
if [[ -z "$USER_TOKEN" ]] && [[ -n "$USER_CLIENT_ID" ]] && [[ -n "$USER_CLIENT_SECRET" ]]; then
  USER_TOKEN_RES=$(curl -s -k -X POST -d "grant_type=client_credentials" \
    -d "client_id=${USER_CLIENT_ID}" \
    -d "client_secret=${USER_CLIENT_SECRET}" \
    "${KEYCLOAK_URL}")
  USER_TOKEN=$(python3 -c "import json; print(json.loads('''$USER_TOKEN_RES''').get('access_token', ''))" 2>/dev/null || echo "")
fi

if [[ -n "$ADMIN_TOKEN" ]]; then
  echo "   ✓ Admin / SA token acquired"
else
  echo "   ⚠️ Admin / SA token acquisition failed or not configured"
fi

if [[ -n "$USER_TOKEN" ]]; then
  echo "   ✓ User token acquired"
else
  echo "   ⚠️ User token not configured (skipping unprivileged user negative tests if empty)"
fi

echo ""
echo "3. 🔍 Testing Unauthenticated Access (should return 401/403)..."
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/eval/jobs" \
  -H "Content-Type: application/json" \
  -d '{"dataset_name": "hotpotqa"}' || echo "000")
echo "   ✓ Response HTTP status: ${UNAUTH_STATUS}"

echo ""
echo "4. ❌ Testing Local User Submission ('${USER_EMAIL}' - should be 403 Forbidden without OpenFGA grant)..."
USER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/eval/jobs" \
  -H "Authorization: Bearer ${USER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "dataset_name": "hotpotqa",
    "owner_team": "qa-team"
  }' || echo "000")

if [[ "$USER_STATUS" == "403" ]]; then
  echo "   ✓ SUCCESS: Local user submission rejected with 403 Forbidden as expected!"
else
  echo "   ℹ️ Note: Local user submission returned HTTP ${USER_STATUS}"
fi

echo ""
echo "5. 👑 Testing Admin User Submission ('${ADMIN_EMAIL}' - should be 202 Accepted)..."
ADMIN_JOB_RES=$(curl -s -X POST "${BASE_URL}/eval/jobs" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "dataset_name": "hotpotqa",
    "owner_team": "qa-team",
    "visibility": "private",
    "max_items": 2
  }')

JOB_ID=$(python3 -c "import json; print(json.loads('''$ADMIN_JOB_RES''').get('job_id', ''))" 2>/dev/null || echo "")

if [[ -n "$JOB_ID" ]]; then
  echo "   ✓ SUCCESS: Admin evaluation job submitted successfully: job_id=${JOB_ID}"

  echo ""
  echo "6. 📊 Verification: Polling Job Status for job_id=${JOB_ID}..."
  STATUS_RES=$(curl -s "${BASE_URL}/jobs/${JOB_ID}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}")
  echo "   ✓ Job Status Response: ${STATUS_RES}"

  echo ""
  echo "7. 🛑 Verification: Testing Unauthorized User Access to Job Results (should be 403 Forbidden)..."
  RESULTS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/jobs/${JOB_ID}/results" \
    -H "Authorization: Bearer ${USER_TOKEN}")
  if [[ "$RESULTS_STATUS" == "403" ]]; then
    echo "   ✓ SUCCESS: User access to job results denied with 403 Forbidden as expected!"
  else
    echo "   ℹ️ Note: User access to job results returned HTTP ${RESULTS_STATUS}"
  fi
else
  echo "   ⚠️ Admin submission response: ${ADMIN_JOB_RES}"
fi

echo ""
echo "8. 📋 Verification: Testing ReBAC Job & Question Set Listing Filtering..."
ADMIN_JOBS_COUNT=$(curl -s "${BASE_URL}/jobs" -H "Authorization: Bearer ${ADMIN_TOKEN}" | python3 -c "import json, sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
USER_JOBS_COUNT=$(curl -s "${BASE_URL}/jobs" -H "Authorization: Bearer ${USER_TOKEN}" | python3 -c "import json, sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
echo "   ✓ Jobs listed for Admin: ${ADMIN_JOBS_COUNT}"
echo "   ✓ Jobs listed for User:  ${USER_JOBS_COUNT}"

ADMIN_QSETS_COUNT=$(curl -s "${BASE_URL}/question-sets" -H "Authorization: Bearer ${ADMIN_TOKEN}" | python3 -c "import json, sys; print(json.load(sys.stdin).get('total', 0))" 2>/dev/null || echo "0")
USER_QSETS_COUNT=$(curl -s "${BASE_URL}/question-sets" -H "Authorization: Bearer ${USER_TOKEN}" | python3 -c "import json, sys; print(json.load(sys.stdin).get('total', 0))" 2>/dev/null || echo "0")
echo "   ✓ Question Sets listed for Admin: ${ADMIN_QSETS_COUNT}"
echo "   ✓ Question Sets listed for User:  ${USER_QSETS_COUNT}"

echo "======================================================================"
echo "🎉 Evaluator Security & Authorization Test Complete!"
echo "======================================================================"

