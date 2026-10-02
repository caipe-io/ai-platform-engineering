# Legacy Baseline Evaluator & Prior Contributions (Commit `7f0f9a819`)

This document provides a technical record of the initial state of the **DeepEval RAG Evaluator** as inherited from upstream repository [`CaipeDeepevalEvaluation`](https://github.com/ucl-2026-comp0111-project2/CaipeDeepevalEvaluation) up to commit `7f0f9a819215f6bb84bb8c7ed92c75aec0b60f26` (authored by `@LianaW921` and `@royzheng0904`), before project takeover and subsequent platform engineering refactoring.

This reference serves as an audit trail for individual contribution attribution and report writing.

---

## 1. Baseline Summary & Architecture Overview

Prior to takeover, the evaluator was a standalone Python evaluation repository consisting of approximately 12 script-based files with no REST API, no persistent database storage, no ReBAC access control, no OpenTelemetry instrumentation, and no formal asynchronous job queue.

### Baseline Commit History (Chronological)

| Commit Hash | Author | Date | Summary Description |
| :--- | :--- | :--- | :--- |
| `37c92c8a0` | `LianaW921` | Jul 3, 2026 | Initial DeepEval evaluation pipeline |
| `6269b0992` | `LianaW921` | Jul 3, 2026 | Improve DeepEval documentation |
| `cbafe32ca` | `LianaW921` | Jul 3, 2026 | Improve repository documentation and config templates |
| `a64602bc0` | `LianaW921` | Jul 3, 2026 | Refactor DeepEval evaluation pipeline |
| `36be59a86` / `4cf4c6c85` | `LianaW921` | Jul 3, 2026 | Clean up requirements and remove unused scripts |
| `87b45ba48` | `LianaW921` | Jul 4, 2026 | Add DeepEval evaluation pipeline docs and scripts |
| `b21b6c8c6` | `LianaW921` | Jul 4, 2026 | Add DeepEval evaluation pipeline |
| `032db3731` / `e6ae2b5cc` | `LianaW921` | Jul 4, 2026 | Refactor `eval_enterprise.sh` / `.cmd` for improved readability |
| `69010fa4c` / `4dc73dd0a` | `LianaW921` | Jul 4, 2026 | Refactor HotpotQA evaluation script |
| `bb3a92b9a` / `5bd29a777` | `LianaW921` | Jul 4, 2026 | Refactor ingestion script for better readability |
| `6f831562f` / `75f93a7ad` | `LianaW921` | Jul 4, 2026 | Refactor HotpotQA ingestion script |
| `6a427bd7e` | `royzheng0904` | Jul 3, 2026 | Added agentic eval script (initial prototype) |
| `a0bb4727f` | `royzheng0904` | Jul 4, 2026 | Added `eval_parser` and modified functions to process agentic eval |
| `409cfba25` | `royzheng0904` | Jul 4, 2026 | Added shell scripts for agentic evals (Mac & Windows) |
| `618b3edc7` | `royzheng0904` | Jul 9, 2026 | Changed agentic call from send to stream to track `rag_context` artifacts; added parsing strategies |
| `24f0c19e9` | `LianaW921` | Jul 11, 2026 | Add precomputed DeepEval benchmark evaluation (`precomputed_deepeval.py`) |
| `a2d37b10f` | `royzheng0904` | Jul 13, 2026 | Added usage and latency metrics to agentic evaluation |
| `a3a48ddd8` | `royzheng0904` | Jul 14, 2026 | Fixed unaccessible local variable error for agentic eval |
| `7f0f9a819` | `royzheng0904` | Jul 14, 2026 | Synchronized HotpotQA & agentic eval, added shell scripts (**Handover Point**) |

---

## 2. Inherited Directory Layout (as of `7f0f9a819`)

```
CaipeDeepevalEvaluation/
├── .env.example
├── .gitignore
├── README.md
├── pyproject.toml
├── requirements.txt
├── docs/
│   ├── architecture.md
│   ├── enterprise_rag_bench.md
│   ├── evaluation_pipeline.md
│   ├── hotpotqa.md
│   ├── project_structure.md
│   └── setup_and_usage.md
├── scripts/
│   ├── eval_enterprise.cmd / .sh
│   ├── eval_enterprise_agentic.cmd / .sh
│   ├── eval_hotpotqa.cmd / .sh
│   ├── eval_hotpotqa_agentic.cmd / .sh
│   ├── eval_precomputed.cmd / .sh
│   ├── ingest_enterprise.cmd / .sh
│   └── ingest_hotpotqa.cmd / .sh
└── src/deepeval_eval/
    ├── __init__.py
    ├── agentic_rag.py           # Basic SSE streaming query & rag_context parser
    ├── caipe.py                 # Synchronous CAIPE REST client (ingest + query)
    ├── config.py                # Flat environment variable loader
    ├── enterprise_dataset.py    # EnterpriseRAG-Bench download & preprocessing
    ├── enterprise_deepeval.py   # CLI entry point for EnterpriseRAG-Bench evaluation
    ├── hotpotqa_dataset.py      # HotpotQA zip archive loader & distractor generator
    ├── hotpotqa_deepeval.py     # CLI entry point for HotpotQA evaluation
    ├── io_utils.py              # Download cache & JSONL file utilities
    ├── llm.py                   # Minimal HTTP client wrapping OpenAI-compatible endpoint
    ├── metrics.py               # DeepEval metric factory (faithfulness, relevancy, etc.)
    └── precomputed_deepeval.py  # Oracle/precomputed evaluation runner
```

---

## 3. Detailed Component Breakdown of Prior Contributions

### 3.1 Dataset Ingestion & Preprocessing (`LianaW921`)
- **EnterpriseRAG-Bench (`enterprise_dataset.py`, `enterprise_deepeval.py`)**:
  - Implemented the automated download from HuggingFace / GitHub for Enterprise benchmark slices (`confluence`, `jira`, `github`, `slack`, etc.).
  - Sampling algorithm to cap questions per category and generate local JSONL datasets.
- **HotpotQA (`hotpotqa_dataset.py`, `hotpotqa_deepeval.py`)**:
  - Zip file extraction and parsing for gold documents, questions, and distractors.
- **Precomputed / Oracle Mode (`precomputed_deepeval.py`)**:
  - Upper-bound baseline runner using ground truth reference documents directly as context to measure LLM reasoning without retrieval error.

### 3.2 Agentic Retrieval & SSE Gateway Hook (`royzheng0904`)
- **SSE Streaming Client (`agentic_rag.py`)**:
  - Initial implementation of the two-step SSE conversation lifecycle (`POST /api/chat/conversations` and `POST /api/v1/chat/stream/start`).
  - Parsing logic for `event: tool_end` payloads to extract `rag_context` artifacts containing text and document IDs.
  - Basic text deduplication and cleaning of `**Snippet:**` markdown from search results.
  - Token tracking from `usage_metadata` in streaming events.

### 3.3 Core Evaluation Loop & Metric Harness (`LianaW921`)
- **LLM Adapter (`llm.py`)**:
  - Basic synchronous `requests`-based wrapper for OpenAI-compatible chat completion endpoints.
- **DeepEval Integration (`metrics.py`)**:
  - Factory functions constructing DeepEval metrics: `AnswerRelevancyMetric`, `FaithfulnessMetric`, `ContextualRelevancyMetric`, `ContextualPrecisionMetric`, and `ContextualRecallMetric`.
  - Manual computation for document ID Recall and Precision against `expected_doc_ids`.
- **File Result Sink**:
  - Direct local file writing to timestamped JSON files under `results/`.

---

## 4. Key Limitations of the Baseline Codebase

At the handover point (`7f0f9a819`), the codebase had several architectural and operational limitations that necessitated extensive platform engineering:

1. **No REST API or Webhooks**:
   - Only executed via local CLI scripts (`eval_enterprise.sh`). No asynchronous HTTP submission, status polling, or OpenAPI endpoints existed.
2. **Ephemeral File-Only Storage**:
   - Results were only saved as local disk files. There was no database integration (PostgreSQL), no relational schema, no historical run querying, and no run deduplication caching.
3. **No Authentication & Authorization (ReBAC)**:
   - Evaluator had no OIDC JWT token validation, no role enforcement, and zero integration with OpenFGA or Keycloak ReBAC policies.
4. **Synchronous Single-Thread Execution**:
   - No background worker threads, persistent job queue, or concurrent job processing (`EVAL_MAX_CONCURRENT_JOBS`).
5. **Rigid Configuration Management**:
   - Global mutable configuration without Pydantic dependency injection or `SecretStr` masking for passwords/keys.
6. **No Dynamic MCP Tool Lifecycle**:
   - Could only query the default `knowledge-base_search` tool; could not provision ephemeral MCP tools with custom hybrid weights.
7. **No Quality Gate Engine**:
   - No structured hard/soft CI/CD quality gate checking with exit codes or markdown summaries.
8. **Static Dataset Dependency**:
   - Questions could only be loaded from disk files; no database-backed Question Sets (`question_sets` CRUD).

---

## 5. Architectural Transformation Matrix

| Dimension | Baseline State (`7f0f9a819`) | Current Platform State (`HEAD`) |
| :--- | :--- | :--- |
| **Interface** | CLI / Shell scripts only | Async FastAPI REST API (`/eval/jobs`, `/question-sets`, `/prompt-styles`) + CLI + OpenAPI UI |
| **Persistence** | Local JSON file sink only | Dual-Sink: JSON/CSV files + PostgreSQL (`evaluation_runs`, `eval_job_queue`, `question_sets`, `prompt_styles`) |
| **Job Execution** | Blocking synchronous execution | `PersistentJobQueue` state machine with configurable concurrency (`EVAL_MAX_CONCURRENT_JOBS`) and PostgreSQL persistence |
| **Caching / Dedup** | None (always re-ran) | SHA-256 evaluation fingerprint memoization cache (24h TTL) |
| **Auth & Security** | None | OIDC JWT verification, Role Hierarchy (`ADMIN`, `EVALUATOR`, `READONLY`), RFC 8693 OBO Token Exchange |
| **Authorization (ReBAC)** | None | Full OpenFGA ReBAC integration on jobs, question sets, datasources, and agents with JIT worker re-checks |
| **Tool Provisioning** | Static `knowledge-base_search` tool | Ephemeral dynamic MCP custom search tools with automated TTL and cleanup (`DynamicMCPToolManager`) |
| **Prompt Engineering** | Hardcoded format strings | Dynamic PostgreSQL Prompt Styles engine (`/api/v1/prompt-styles`) supporting pre/post-retrieval styles |
| **Quality Gate** | Basic pass/fail count | Configurable soft/hard gate engine (`engine/gate.py`) producing Markdown reports for CI/CD |
| **Telemetry** | None | OpenTelemetry tracing, Prometheus `/metrics`, and `/health` readiness/liveness probes |
| **Test Suite** | 0 unit tests | Comprehensive Pytest suite (>35 test files, >90% branch/line coverage) |
