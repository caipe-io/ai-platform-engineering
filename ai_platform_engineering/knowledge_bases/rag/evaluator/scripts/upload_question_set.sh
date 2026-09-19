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
SET_NAME="${SET_NAME:-Enterprise RAG Bench}"
SET_DESCRIPTION="${SET_DESCRIPTION:-Enterprise RAG Benchmark Question Set}"
QUESTIONS_FILE="${QUESTIONS_FILE:-data/enterprise_rag_bench_questions.jsonl}"
SET_ID="${SET_ID:-}"

# Parse optional command line arguments
# Usage: ./scripts/upload_question_set.sh [questions_file] [set_name] [set_id]
if [ -n "$1" ]; then
  QUESTIONS_FILE="$1"
fi
if [ -n "$2" ]; then
  SET_NAME="$2"
fi
if [ -n "$3" ]; then
  SET_ID="$3"
fi

if [ ! -f "$QUESTIONS_FILE" ]; then
  echo "Error: Questions dataset file not found at '$QUESTIONS_FILE'"
  echo "Available dataset files:"
  echo "  - data/enterprise_rag_bench_questions.jsonl"
  echo "  - data/hotpotqa_full_questions.jsonl"
  exit 1
fi

echo "=================================================================="
echo " Question Set Database Ingestion Script"
echo "=================================================================="
echo "API Server:     ${API_URL}"
echo "Questions File: ${QUESTIONS_FILE}"
echo "Set Name:       ${SET_NAME}"
if [ -n "$SET_ID" ]; then
  echo "Target Set ID:  ${SET_ID} (Uploading questions to existing set)"
else
  echo "Target Set ID:  (New question set will be created)"
fi
echo "=================================================================="

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
      -d "client_id=${CLIENT_ID}" \
      -d "client_secret=${CLIENT_SECRET}" \
      -d "grant_type=client_credentials" | jq -r '.access_token // empty' 2>/dev/null || true)
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
AUTH_HEADER=()
if [ -n "$AUTH_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${AUTH_TOKEN}")
fi

if [ -z "$SET_ID" ]; then
  echo "1. Creating new Question Set '${SET_NAME}' and uploading '${QUESTIONS_FILE}'..."
  RESPONSE=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" -X POST "${API_URL}/api/v1/question-sets" \
    -F "name=${SET_NAME}" \
    -F "description=${SET_DESCRIPTION}" \
    -F "file=@${QUESTIONS_FILE}")

  echo ""
  echo "Response from API:"
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

  CREATED_SET_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
  QUESTION_COUNT=$(echo "$RESPONSE" | jq -r '.question_count // 0')

  if [ -n "$CREATED_SET_ID" ]; then
    echo ""
    echo "Successfully created Question Set (ID: ${CREATED_SET_ID}) with ${QUESTION_COUNT} questions."
  else
    echo "Failed to create Question Set."
    exit 1
  fi

else
  echo "1. Uploading '${QUESTIONS_FILE}' to existing Question Set ID=${SET_ID}..."
  RESPONSE=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" -X POST "${API_URL}/api/v1/question-sets/${SET_ID}/questions/upload" \
    -F "file=@${QUESTIONS_FILE}")

  echo ""
  echo "Response from API:"
  UPLOADED_COUNT=$(echo "$RESPONSE" | jq -r 'length // 0' 2>/dev/null || echo "0")
  echo "$RESPONSE" | jq '.[0:3]' 2>/dev/null || echo "$RESPONSE"

  echo ""
  echo "Successfully uploaded/updated ${UPLOADED_COUNT} questions in Question Set ID=${SET_ID}."
fi
