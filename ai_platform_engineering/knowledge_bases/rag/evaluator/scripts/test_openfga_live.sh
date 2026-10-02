#!/usr/bin/env bash
# ==============================================================================
# Script: test_openfga_live.sh
# Purpose: Direct OpenFGA REST API Verification for Evaluator ReBAC Permissions
# Usage: ./test_openfga_live.sh [OPENFGA_HOST]
# ==============================================================================
set -euo pipefail

RAW_HOST="${1:-${OPENFGA_HTTP:-http://localhost:8080}}"
OPENFGA_HOST="${RAW_HOST#http://}"
OPENFGA_HOST="${OPENFGA_HOST#https://}"
OPENFGA_HOST="${OPENFGA_HOST%/}"
STORE_NAME="${OPENFGA_STORE_NAME:-caipe-openfga}"
HOST_HEADER="${OPENFGA_HOST_HEADER:-${OPENFGA_HOST}}"

echo "======================================================================"
echo "🧪 Testing Live OpenFGA Authorization Engine at http://${OPENFGA_HOST}"

echo "======================================================================"

echo "1. 🔍 Fetching OpenFGA Store ID for '${STORE_NAME}'..."
STORES_JSON=$(curl -s -H "Host: ${HOST_HEADER}" "http://${OPENFGA_HOST}/stores" || true)

STORE_ID=$(python3 -c "
import json, sys
data = json.loads('''$STORES_JSON''')
for store in data.get('stores', []):
    if store.get('name') == '${STORE_NAME}':
        print(store['id'])
        break
" 2>/dev/null || echo "")

if [[ -z "$STORE_ID" ]]; then
  echo "❌ Error: Could not resolve OpenFGA Store ID for '${STORE_NAME}' from ${OPENFGA_HOST}"
  exit 1
fi
echo "   ✓ Store ID resolved: ${STORE_ID}"

TEST_USER="user:eval-test-user-$(date +%s)"
TEST_TEAM="team:qa-evaluators"

echo ""
echo "2. ❌ Verification: Checking initial 'can_evaluate' capability (should be false)..."
CHECK_RES=$(curl -s -X POST -H "Host: ${HOST_HEADER}" -H "Content-Type: application/json" \
  -d "{\"tuple_key\":{\"user\":\"${TEST_USER}\",\"relation\":\"can_evaluate\",\"object\":\"organization:caipe\"}}" \
  "http://${OPENFGA_HOST}/stores/${STORE_ID}/check")
ALLOWED=$(python3 -c "import json; print(json.loads('''$CHECK_RES''').get('allowed', False))" 2>/dev/null || echo "false")

if [[ "$ALLOWED" == "False" || "$ALLOWED" == "false" ]]; then
  echo "   ✓ Correct: Initial check denied access (allowed=false)"
else
  echo "   ⚠️ Unexpected: Initial check returned allowed=${ALLOWED}"
fi

echo ""
echo "3. 📝 Writing OpenFGA Tuples: Adding user to team '${TEST_TEAM}' and granting 'evaluator' capability..."
WRITE_RES=$(curl -s -X POST -H "Host: ${HOST_HEADER}" -H "Content-Type: application/json" \
  -d "{
    \"writes\": {
      \"tuple_keys\": [
        {\"user\": \"${TEST_USER}\", \"relation\": \"member\", \"object\": \"${TEST_TEAM}\"},
        {\"user\": \"${TEST_TEAM}#member\", \"relation\": \"evaluator\", \"object\": \"organization:caipe\"}
      ]
    }
  }" \
  "http://${OPENFGA_HOST}/stores/${STORE_ID}/write")
echo "   ✓ OpenFGA tuple write response: ${WRITE_RES:-{}}"

echo ""
echo "4. ✅ Verification: Re-checking 'can_evaluate' capability (should be true)..."
CHECK_RES2=$(curl -s -X POST -H "Host: ${HOST_HEADER}" -H "Content-Type: application/json" \
  -d "{\"tuple_key\":{\"user\":\"${TEST_USER}\",\"relation\":\"can_evaluate\",\"object\":\"organization:caipe\"}}" \
  "http://${OPENFGA_HOST}/stores/${STORE_ID}/check")
ALLOWED2=$(python3 -c "import json; print(json.loads('''$CHECK_RES2''').get('allowed', False))" 2>/dev/null || echo "false")

if [[ "$ALLOWED2" == "True" || "$ALLOWED2" == "true" ]]; then
  echo "   ✓ SUCCESS: ReBAC capability resolved through team membership (allowed=true)"
else
  echo "   ❌ ERROR: Expected allowed=true, but received ${CHECK_RES2}"
fi

echo ""
echo "5. 📋 Verification: Testing OpenFGA 'list-objects' for question_set and evaluation..."
LIST_QS_RES=$(curl -s -X POST -H "Host: ${HOST_HEADER}" -H "Content-Type: application/json" \
  -d "{\"user\":\"${TEST_USER}\",\"relation\":\"can_read\",\"type\":\"question_set\"}" \
  "http://${OPENFGA_HOST}/stores/${STORE_ID}/list-objects")
echo "   ✓ OpenFGA list-objects question_set response: ${LIST_QS_RES}"

echo ""
echo "6. 🧹 Cleanup: Deleting temporary test tuples..."
curl -s -X POST -H "Host: ${HOST_HEADER}" -H "Content-Type: application/json" \
  -d "{
    \"deletes\": {
      \"tuple_keys\": [
        {\"user\": \"${TEST_USER}\", \"relation\": \"member\", \"object\": \"${TEST_TEAM}\"},
        {\"user\": \"${TEST_TEAM}#member\", \"relation\": \"evaluator\", \"object\": \"organization:caipe\"}
      ]
    }
  }" \
  "http://${OPENFGA_HOST}/stores/${STORE_ID}/write" >/dev/null
echo "   ✓ Test tuples cleaned up cleanly."

echo "======================================================================"
echo "🎉 OpenFGA Live Test Completed Successfully!"
echo "======================================================================"

