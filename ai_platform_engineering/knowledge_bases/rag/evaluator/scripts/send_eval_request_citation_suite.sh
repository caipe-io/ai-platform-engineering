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

# Target resource slugs
PROMPT_STYLE_NAME="${PROMPT_STYLE_NAME:-citation}"
METRIC_NAME="${METRIC_NAME:-citation_correctness}"
METRIC_SET_NAME="${METRIC_SET_NAME:-citation_bias_suite}"

# Optional command-line argument overrides:
# Usage: ./scripts/send_eval_request_citation_suite.sh [set_id] [max_items] [top_k] [datasource_id]
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
echo " Question Set Evaluation: Citation Prompt & Citation/Bias Suite"
echo "=================================================================="
echo "API Server:        ${API_URL}"
echo "Target Set ID:     ${SET_ID}"
echo "Datasource ID:     ${DATASOURCE_ID}"
echo "Prompt Style:      ${PROMPT_STYLE_NAME}"
echo "G-Eval Metric:     ${METRIC_NAME}"
echo "Metric Set Bundle: ${METRIC_SET_NAME}"
echo "Answer Mode:       ${ANSWER_MODE}"
echo "Max Items:         ${MAX_ITEMS}"
echo "Top K Docs:        ${TOP_K}"
echo "=================================================================="

CLIENT_ID="${CAIPE_SA_CLIENT_ID:-${CAIPE_CLIENT_ID:-}}"
CLIENT_SECRET="${CAIPE_SA_CLIENT_SECRET:-${CAIPE_CLIENT_SECRET:-}}"
TOKEN_URL="${CAIPE_SA_TOKEN_URL:-${KEYCLOAK_URL:-http://localhost:7080/realms/caipe/protocol/openid-connect/token}}"
KUBE_UI_SECRET="${KUBE_UI_SECRET:-caipe-ui-secret}"
KUBE_NAMESPACE="${KUBE_NAMESPACE:-caipe}"

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
        echo "CAIPE_OIDC_TOKEN retrieved from Keycloak via Kubernetes secret."
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

echo ""
echo "--- Step 1: Ensure Citation Prompt Style Exists ---"
PROMPT_RESP=$(curl -k -s -w "\n%{http_code}" "${AUTH_HEADER[@]}" "${API_URL}/api/v1/prompt-styles/${PROMPT_STYLE_NAME}")
PROMPT_STATUS=$(echo "$PROMPT_RESP" | tail -n1)
PROMPT_BODY=$(echo "$PROMPT_RESP" | sed '$d')

CITATION_TEMPLATE="Answer the following question using available search tools.

RULES:
1. Base your answer strictly on retrieved documents.
2. For EVERY key factual statement, you MUST include an inline citation citing the exact document ID or document title (e.g. '[dsid_...]' or '[Document Title]').
3. At the end of your response, provide a 'Sources:' list containing all referenced document IDs.
4. If the retrieved information is insufficient, state that the answer is not in the context.

Question:
{question}"

if [ "$PROMPT_STATUS" -eq 200 ]; then
  echo "Prompt style '${PROMPT_STYLE_NAME}' already exists. Updating template with strict citation rules..."
  UPDATE_PROMPT_PAYLOAD=$(jq -n \
    --arg desc "Instructs the agent to provide answers with mandatory inline citations and a sources section." \
    --arg tmpl "$CITATION_TEMPLATE" \
    '{description: $desc, template: $tmpl}')

  curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" -H "Content-Type: application/json" \
    -X PUT "${API_URL}/api/v1/prompt-styles/${PROMPT_STYLE_NAME}" \
    -d "$UPDATE_PROMPT_PAYLOAD" >/dev/null
  echo "Updated prompt style '${PROMPT_STYLE_NAME}'."
else
  echo "Prompt style '${PROMPT_STYLE_NAME}' not found (HTTP ${PROMPT_STATUS}). Creating citation prompt style..."
  CREATE_PROMPT_PAYLOAD=$(jq -n \
    --arg name "$PROMPT_STYLE_NAME" \
    --arg desc "Instructs the agent to provide answers with mandatory inline citations and a sources section." \
    --arg st "agentic" \
    --arg tmpl "$CITATION_TEMPLATE" \
    --arg vis "public" \
    '{name: $name, description: $desc, style_type: $st, template: $tmpl, visibility: $vis}')

  CREATE_PROMPT_RESP=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" -H "Content-Type: application/json" \
    -X POST "${API_URL}/api/v1/prompt-styles" \
    -d "$CREATE_PROMPT_PAYLOAD")
  echo "Created prompt style:"
  echo "$CREATE_PROMPT_RESP" | jq . 2>/dev/null || echo "$CREATE_PROMPT_RESP"
fi

echo ""
echo "--- Step 2: Ensure Citation Correctness G-Eval Metric Exists ---"
METRIC_RESP=$(curl -k -s -w "\n%{http_code}" "${AUTH_HEADER[@]}" "${API_URL}/api/v1/metrics/${METRIC_NAME}")
METRIC_STATUS=$(echo "$METRIC_RESP" | tail -n1)
METRIC_BODY=$(echo "$METRIC_RESP" | sed '$d')

if [ "$METRIC_STATUS" -eq 200 ]; then
  echo "Metric '${METRIC_NAME}' already exists."
else
  echo "Metric '${METRIC_NAME}' not found (HTTP ${METRIC_STATUS}). Creating custom G-Eval metric..."
  CREATE_METRIC_PAYLOAD='{
    "name": "'"${METRIC_NAME}"'",
    "display_name": "Citation Correctness",
    "description": "Evaluates whether the generated response accurately cites the expected reference documents and sources.",
    "metric_type": "g_eval",
    "threshold": 0.7,
    "evaluation_params": ["input", "actual_output", "expected_output", "retrieval_context"],
    "criteria": "Evaluate whether the answer accurately and correctly cites the source documents corresponding to expected reference outputs without fabricating citation IDs.",
    "evaluation_steps": [
      "Check if citations or document identifiers are present in actual_output.",
      "Verify that cited documents match the retrieved context and expected reference documents.",
      "Penalize hallucinated or missing citations.",
      "Assign a score between 0.0 and 1.0 reflecting citation precision and coverage."
    ]
  }'

  CREATE_METRIC_RESP=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" -H "Content-Type: application/json" \
    -X POST "${API_URL}/api/v1/metrics" \
    -d "$CREATE_METRIC_PAYLOAD")
  echo "Created G-Eval metric:"
  echo "$CREATE_METRIC_RESP" | jq . 2>/dev/null || echo "$CREATE_METRIC_RESP"
fi

echo ""
echo "--- Step 3: Ensure Metric Set Bundle Exists (bias + citation_correctness) ---"
SET_RESP=$(curl -k -s -w "\n%{http_code}" "${AUTH_HEADER[@]}" "${API_URL}/api/v1/metric-sets/${METRIC_SET_NAME}")
SET_STATUS=$(echo "$SET_RESP" | tail -n1)
SET_BODY=$(echo "$SET_RESP" | sed '$d')

if [ "$SET_STATUS" -eq 200 ]; then
  echo "Metric set '${METRIC_SET_NAME}' already exists."
else
  echo "Metric set '${METRIC_SET_NAME}' not found (HTTP ${SET_STATUS}). Creating bundle with bias and citation_correctness..."
  CREATE_SET_PAYLOAD='{
    "name": "'"${METRIC_SET_NAME}"'",
    "display_name": "Citation Correctness & Bias Suite",
    "description": "Evaluates response citation precision alongside built-in bias detection.",
    "visibility": "public",
    "metrics": [
      {
        "metric_name": "bias",
        "custom_threshold": 0.3
      },
      {
        "metric_name": "'"${METRIC_NAME}"'",
        "custom_threshold": 0.7
      }
    ]
  }'

  CREATE_SET_RESP=$(curl -k -sS --fail-with-body "${AUTH_HEADER[@]}" -H "Content-Type: application/json" \
    -X POST "${API_URL}/api/v1/metric-sets" \
    -d "$CREATE_SET_PAYLOAD")
  echo "Created metric set bundle:"
  echo "$CREATE_SET_RESP" | jq . 2>/dev/null || echo "$CREATE_SET_PAYLOAD"
fi

echo ""
echo "--- Step 4: Submit Evaluation Job Targeting Question Set ID=${SET_ID} ---"
PAYLOAD="{
  \"question_set_id\": ${SET_ID},
  \"prompt_style\": \"${PROMPT_STYLE_NAME}\",
  \"metric_set\": \"${METRIC_SET_NAME}\",
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
