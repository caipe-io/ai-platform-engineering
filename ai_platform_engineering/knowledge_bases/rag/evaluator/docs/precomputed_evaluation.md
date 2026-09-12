# Precomputed Evaluation

This page documents the precomputed (ground-truth) evaluation workflow implemented in `src/deepeval_eval/precomputed_deepeval.py` and `src/deepeval_eval/precomputed_client.py`.

## Purpose

The precomputed evaluation mode tests DeepEval against a benchmark's ground-truth question file **without calling CAIPE retrieval**. It uses the `context` field in the generated question JSONL as the retrieval context. By default it uses the benchmark `reference` answer as `actual_output`, which gives an upper-bound style run for checking the metric behaviour against the reference solution.

This is useful for:
- Validating metric behaviour before running against a live CAIPE system.
- Isolating retrieval quality from answer generation quality.
- Running evaluations in environments where CAIPE is not available.

## Workflow Summary

~~~mermaid
flowchart TD
    A[Load benchmark question JSONL] --> B[Select questions by category/limit]
    B --> C[Extract gold context from question record]
    C --> D[Determine answer mode]
    D -->|reference| E[Use benchmark reference as answer]
    D -->|generate| F[Query LLM with gold context]
    F --> G[Generate answer from context]
    E --> H[Build DeepEval test case]
    G --> H
    H --> I[Run 8 metrics + retrieval checks]
    I --> J[Write results JSON, CSV, summary]
~~~

## PrecomputedRagClient

`PrecomputedRagClient` (`src/deepeval_eval/precomputed_client.py`) is a thin RAG client that matches the `SearchRagClient` interface but operates differently:

| Aspect | SearchRagClient | PrecomputedRagClient |
| --- | --- | --- |
| Query method | Sends question to CAIPE `/v1/query` | Sends `question + reference` as oracle to CAIPE `/v1/query` |
| Purpose | Live retrieval evaluation | Gold-source oracle retrieval |
| Answer mode | Always generates via LLM | Can use `reference` answer directly or generate |

### How It Works

1. **Oracle Query**: Constructs `reference_query = f"{question} {reference}".strip()` and sends it to CAIPE `/v1/query`. This is designed to retrieve the gold-standard documents by including the reference answer in the query.
2. **Context Extraction**: Parses the response using `extract_contexts_and_sources()` from `deepeval_eval/clients/search_rag.py`.
3. **Answer Selection**:
     - If `answer_mode == "reference"`: Returns the benchmark reference answer directly (no LLM call).
     - If `answer_mode == "generate"`: Calls the LLM with the gold context to generate an answer.

### Code Example

```python
from deepeval_eval.clients.oracle import PrecomputedRagClient
from deepeval_eval.clients.search_rag import build_search_rag_client

env_values = {"CAIPE_BASE_URL": "http://localhost:9446"}
caipe_client = build_search_rag_client(env_values)
precomputed_client = PrecomputedRagClient(caipe_client)

result = precomputed_client.query(
    question="What is the capital of France?",
    reference="Paris",
    datasource_id="enterprise_rag_bench",
    top_k=5,
    answer_mode="reference",  # or "generate"
    benchmark="enterprise",
    llm_client=llm_client,
    max_context_chars=12000,
)
```

## CLI Usage

### Via the Unified Evaluator (Recommended)

```bash
python src/deepeval_eval/deepeval_evaluator.py eval \
    --benchmark enterprise \
    --precompute \
    --answer-mode reference \
    --top-k 5 \
    --max-items 10
```

### Via the Legacy Entry Point (Deprecated)

```bash
python src/deepeval_eval/precomputed_deepeval.py \
    --benchmark enterprise \
    --answer-mode reference \
    --top-k 5 \
    --max-items 10
```

> **Note:** `precomputed_deepeval.py eval` is deprecated in favour of `deepeval_evaluator.py eval --precompute`. The legacy entry point still works but emits a deprecation warning.

## CLI Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--benchmark` | `hotpotqa` | Which benchmark to evaluate: `enterprise` or `hotpotqa`. |
| `--questions-file` | None | Override the questions file path. Falls back to `data/{benchmark}_deepeval_questions.jsonl`. |
| `--max-items` | None | Maximum number of questions to evaluate. `None` means unlimited. |
| `--limit-per-category` | None | Per-category cap during question evaluation. |
| `--answer-mode` | `reference` | `reference` uses the benchmark answer; `generate` answers from gold context. |
| `--top-k` | 3 | Number of documents to retrieve from CAIPE. |
| `--datasource-id` | None | The target CAIPE datasource ID. |
| `--max-context-chars` | 12000 | Per-context character limit. |
| `--llm-base-url` | None | Optional override for OPENAI_ENDPOINT. |
| `--llm-api-key` | None | Optional override for OPENAI_API_KEY. |
| `--llm-model` | None | Optional override for OPENAI_MODEL_NAME. |

## Output Files

Precomputed evaluation writes to `results/` with names like:

~~~text
precomputed_deepeval_enterprise_reference_timestamp.json
precomputed_deepeval_enterprise_reference_timestamp.csv
precomputed_deepeval_enterprise_reference_timestamp_summary.json
~~~

The file naming convention is:

~~~text
precomputed_deepeval_{benchmark}_{answer-mode}_timestamp.{json|csv|summary.json}
~~~

## Comparison With Standard Evaluation

| Aspect | Standard Evaluation | Precomputed Evaluation |
| --- | --- | --- |
| Query source | User question only | Question + reference answer |
| Retrieval target | Live CAIPE retrieval | Gold-source oracle retrieval |
| Answer source | Always LLM-generated | Reference or LLM-generated |
| Purpose | Full pipeline evaluation | Metric validation / upper-bound |
| CAIPE dependency | Required | Optional (can use local context) |
| Metrics | All 8 metrics | All 8 metrics + answer checks |

## Example: run_eval_precomputed_enterprise.sh

The script `scripts/run_eval_precomputed_enterprise.sh` demonstrates a production precomputed evaluation:

```bash
#!/bin/bash
cd "$(dirname "$0")/.."

# Load .env
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# Override configuration
export CAIPE_DATASOURCE_ID="enterprise_rag_bench"
export QUESTIONS_PATH="/path/to/enterprise_rag_bench_questions.jsonl"

# Fetch OIDC credentials from Kubernetes
export KUBECONFIG="${KUBECONFIG:-${HOME}/.kube/config}"
CLIENT_ID=$(kubectl get secret caipe-ui-secret -n caipe \
    -o jsonpath='{.data.OIDC_CLIENT_ID}' | base64 --decode)
CLIENT_SECRET=$(kubectl get secret caipe-ui-secret -n caipe \
    -o jsonpath='{.data.OIDC_CLIENT_SECRET}' | base64 --decode)
export CAIPE_CLIENT_ID="${CLIENT_ID}"
export CAIPE_CLIENT_SECRET="${CLIENT_SECRET}"

# Fetch OIDC token
export CAIPE_AUTH_TOKEN=$(curl -sk -X POST \
    "https://keycloak.example.com/realms/caipe/protocol/openid-connect/token" \
    -d "client_id=${CLIENT_ID}" \
    -d "client_secret=${CLIENT_SECRET}" \
    -d "grant_type=client_credentials" | jq -r '.access_token')

# Run evaluation
uv run python3 src/deepeval_eval/precomputed_deepeval.py \
    --datasource-id "${CAIPE_DATASOURCE_ID}" \
    --questions-file "${QUESTIONS_PATH}" \
    --benchmark enterprise \
    --answer-mode reference \
    --limit-per-category 10 \
    --max-items 1 \
    --top-k 5 \
    "$@"
```

Key characteristics of this script:
- Uses `enterprise_rag_bench` as the datasource ID.
- Fetches OIDC credentials from a Kubernetes secret (`caipe-ui-secret`).
- Fetches an OIDC token from Keycloak.
- Runs in `reference` answer mode (uses benchmark reference as actual output).
- Limits to 10 questions per category, max 1 total item (for smoke testing).
