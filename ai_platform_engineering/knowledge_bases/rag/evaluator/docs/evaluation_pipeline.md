# Evaluation Pipeline

This document describes the full evaluation flow implemented in the repository.

## Pipeline Overview

~~~mermaid
sequenceDiagram
    participant Dataset
    participant LocalData as data/
    participant BFF as Next.js BFF
    participant CAIPE as CAIPE rag-server
    participant LLM as OpenAI Compatible LLM
    participant Eval as DeepEval
    participant FileSink as FileResultSink (results/)
    participant PGSink as PostgresResultSink

    Dataset->>LocalData: write corpus and questions
    LocalData->>CAIPE: ingest corpus documents (direct, all topologies)
    LocalData->>BFF: send question via CAIPE_BASE_URL/v1/query
    BFF->>CAIPE: proxy to rag-server /v1/query
    CAIPE-->>BFF: retrieved contexts and source metadata
    BFF-->>LocalData: contexts
    LocalData->>LLM: prompt with question and retrieved contexts
    LLM-->>LocalData: generated answer
    LocalData->>Eval: test case with input, answer, context, expected output
    Eval-->>FileSink: metric scores — JSON + CSV (always)
    Eval-->>PGSink: metric scores — evaluation_runs + evaluation_results (if DATABASE_URL set)
~~~

## 1. Ingestion Step

Ingestion is implemented separately for each dataset.

| Pipeline | Entry point | Dataset module |
| --- | --- | --- |
| EnterpriseRAG-Bench | enterprise_deepeval.py ingest | enterprise_dataset.py |
| HotpotQA | hotpotqa_deepeval.py ingest | hotpotqa_dataset.py |

The ingestion step:

1. Loads or downloads dataset inputs.
2. Selects a bounded set of evaluation questions.
3. Selects documents to ingest, prioritising expected document IDs when available.
4. Registers an ingestor with CAIPE.
5. Creates or updates a datasource.
6. Opens an ingestion job.
7. Sends documents to /v1/ingest in batches.
8. Writes generated corpus and question files to data.

Generated question files are important because evaluation reads from them later.

## 2. Retrieval Step

All evaluation queries route through the **Next.js BFF** in cluster deployments. Direct service access to `rag-server:9446` has been removed in favour of the standardised BFF path — see [api_access_patterns.md](api_access_patterns.md).

### Non-Agentic Mode (SearchRagClient)

The request resolves to `{CAIPE_BASE_URL}/v1/query`, where `CAIPE_BASE_URL` is:

| Topology | Resolved URL |
| --- | --- |
| Local dev | `http://localhost:9446` (code default) |
| Docker Compose | `http://caipe-ui:3000/api/rag` |
| Kubernetes | `http://caipe-caipe-ui:3000/api/rag` (injected by Helm) |
| Remote/CI | `https://<domain>/api/rag` |

The request body contains:

| Field | Meaning |
| --- | --- |
| query | Evaluation question text. |
| limit | Maximum number of retrieved results. |
| filters.datasource_id | Datasource filter when a datasource ID is supplied. |

The response is parsed by `extract_contexts_and_sources()` in `search_rag.py`. The parser extracts:

| Output | Meaning |
| --- | --- |
| contexts | Retrieved document text passed to answer generation and DeepEval. |
| sources | Document ID, title, source type, and score metadata used for retrieval checks. |

### Agentic Mode (AgenticRagAdapter)

In agentic mode (`agentic=true`), queries route through `{CAIPE_API_URL}/api/dynamic-agents` (or `/api/v1/chat/stream/start` via the BFF), and `rag_context` artifacts are parsed from the SSE event stream. See [agentic_rag.md](agentic_rag.md) for the full protocol reference.

## 3. LLM Answer Generation & System Prompts

Answer generation and query formatting are managed via `prompt_style.py` supporting **two distinct types of system prompts**:

1. **Non-Agentic RAG Mode (Post-Retrieval)**: Formats prompt after retrieval (`build_prompt`). Combines `{question}`, `{contexts}`, and dynamic `prompt_args` (e.g. `generation`, `short`, or custom DB templates).
2. **Agentic RAG Mode (Pre-Retrieval)**: Formats pre-retrieval instructions (`build_agentic_prompt`) and builds dynamic retriever system instructions (`enriched_query`) specifying target MCP tools (`search_tool_name`, `fetch_tool_name`), datasource filtering (`datasource_id`), and top-k limits.

The code uses:

| Setting | Source |
| --- | --- |
| OPENAI_ENDPOINT | Environment variable or env file. |
| OPENAI_API_KEY | Environment variable or env file. |
| OPENAI_MODEL_NAME | Environment variable or env file. |

## 4. DeepEval Metrics

metrics.py builds five DeepEval metrics for both datasets.

| Metric | Purpose |
| --- | --- |
| AnswerRelevancyMetric | Checks whether the answer addresses the input question. |
| FaithfulnessMetric | Checks whether the answer is grounded in retrieved context. |
| ContextualRelevancyMetric | Checks whether retrieved context is relevant to the question. |
| ContextualPrecisionMetric | Checks whether relevant context is ranked highly. |
| ContextualRecallMetric | Checks whether retrieved context covers expected output. |

Each metric is configured with:

| Option | Value in code |
| --- | --- |
| threshold | 0.5 |
| include_reason | True |
| async_mode | False |

### Context Window Management & DeepEval Integration

According to the official [DeepEval Metrics Documentation](https://docs.confident-ai.com/docs/metrics-introduction), DeepEval formats `retrieval_context` strings directly into judge LLM prompts (such as for [`FaithfulnessMetric`](https://docs.confident-ai.com/docs/metrics-faithfulness) and [`AnswerRelevancyMetric`](https://docs.confident-ai.com/docs/metrics-answer-relevancy)) via [`LLMTestCase`](https://docs.confident-ai.com/docs/evaluation-test-cases) objects.

* **No Built-In Sliding Window**: DeepEval does not automatically perform sliding-window chunking or multi-step windowing across large context items during metric evaluation.
* **Role of `--max-context-chars`**: To prevent evaluator LLM context window overflow (or token ceiling errors) when processing massive enterprise search results, our client pre-truncates retrieved contexts (`c[:max_context_chars]`) before constructing test cases.
* **When it Impacts Results**: `--max-context-chars` (defaulting to 12,000–16,000 characters / ~3,000–4,000 tokens per chunk) only affects evaluation scores if a single retrieved document chunk exceeds this length. For standard RAG pipelines with typical chunk sizes (~500–2,000 tokens), it serves purely as a protective ceiling without altering metric precision.

## 5. Additional Checks

Both pipelines compute retrieval checks from expected document IDs:

| Check | Formula |
| --- | --- |
| doc_id_recall | Expected document IDs retrieved divided by expected document IDs. |
| doc_id_precision | Expected document IDs retrieved divided by retrieved document IDs. |

HotpotQA also records short answer checks:

| Check | Purpose |
| --- | --- |
| answer_exact_match | Normalized answer equals normalized reference. |
| answer_contains_reference | Normalized answer contains normalized reference. |

## 6. Output Files — Result Persistence Architecture

Evaluation results are persisted through pluggable `ResultSink` implementations orchestrated by `write_evaluation_results()`:

### FileResultSink (Active in CLI / Standalone Runs)

When running evaluations from the command line, evaluation outputs are written to `results/` as timestamped files:

~~~text
enterprise_deepeval_results_<timestamp>.json
enterprise_deepeval_results_<timestamp>.csv
enterprise_deepeval_results_<timestamp>_summary.json
hotpotqa_deepeval_results_<timestamp>.json
hotpotqa_deepeval_results_<timestamp>.csv
hotpotqa_deepeval_results_<timestamp>_summary.json
~~~

The JSON files include detailed per-question results and metric reasons. The CSV files include compact score columns for quick inspection, and the summary JSON contains aggregate latencies and quality score averages.

> [!NOTE]
> The `results/` directory is git-ignored. In REST API worker execution, `FileResultSink` is omitted to prevent ephemeral disk clutter in worker pods; the REST API streams JSON and CSV exports dynamically from database/RAM.

### PostgresResultSink (active when DATABASE_URL is configured)

When `DATABASE_URL` is set, results are also written to PostgreSQL in two tables:

| Table | Contents |
| --- | --- |
| `evaluation_runs` | One row per evaluation run: `run_id`, `experiment_name`, `datasource`, `config_args` (JSONB), summary metrics (`p50_latency`, `p95_latency`, metric averages, token totals). |
| `evaluation_results` | One row per question: all DeepEval metric scores + reasons, retrieved contexts, doc ID recall/precision, token usage, latency. |

The sink is **idempotent** on `run_id` — re-running the same evaluation config replaces the previous run's rows rather than creating duplicates.

To query results across experiments:

```sql
-- Average faithfulness per experiment
SELECT experiment_name, AVG((row_data->>'faithfulness')::float) AS avg_faithfulness
FROM evaluation_results
JOIN evaluation_runs USING (run_id)
GROUP BY experiment_name
ORDER BY avg_faithfulness DESC;
```

See [eval_results_database.md](eval_results_database.md) for the full schema and example queries.

### REST API Results Access

When running via the REST API (`POST /eval/jobs`), job status and results are persisted in `eval_job_queue`, `evaluation_runs`, and `evaluation_results` tables. Results are queryable via:

- `GET /eval/jobs` — list all accessible jobs (filtered by OpenFGA `can_read`)
- `GET /eval/jobs/{job_id}` — job status + summary
- `GET /eval/jobs/{job_id}/results` — full per-question result rows
- `GET /eval/jobs/{job_id}/results/csv` — CSV download
