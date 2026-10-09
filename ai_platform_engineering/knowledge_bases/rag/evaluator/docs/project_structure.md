# Project Structure

This document explains the important files and directories in the repository.

## Top-Level Files

| Path | Purpose |
| --- | --- |
| README.md | Main project overview and quick start. |
| pyproject.toml | Python package metadata and dependency list. |
| .env.example | Example environment variables for local model settings. |
| .gitignore | Excludes local secrets, caches, generated data, results, and runtime artefacts. |

## Entry Points

| Path | Type | Purpose |
| --- | --- | --- |
| src/deepeval_eval/engine/deepeval_evaluator.py | Python CLI | Unified entrypoint for DeepEval evaluation (enterprise, hotpotqa, precomputed modes). |
| src/deepeval_eval/api/app.py | Python module | FastAPI REST API service entry point; run via `python -m deepeval_eval.api`. |
| src/deepeval_eval/ingest/ingest_cli.py | Python CLI | Standalone CLI entrypoint for dataset ingestion into CAIPE datasources. |
| scripts/ingest_enterprise.cmd | Windows CMD wrapper | Runs EnterpriseRAG-Bench ingestion with project defaults. |
| scripts/eval_enterprise.cmd | Windows CMD wrapper | Runs EnterpriseRAG-Bench evaluation with project defaults. |
| scripts/ingest_hotpotqa.cmd | Windows CMD wrapper | Runs HotpotQA ingestion with project defaults. |
| scripts/eval_hotpotqa.cmd | Windows CMD wrapper | Runs HotpotQA evaluation with project defaults. |
| scripts/ingest_enterprise.sh | POSIX shell wrapper | Runs EnterpriseRAG-Bench ingestion with project defaults. |
| scripts/eval_enterprise.sh | POSIX shell wrapper | Runs EnterpriseRAG-Bench evaluation with project defaults. |
| scripts/ingest_hotpotqa.sh | POSIX shell wrapper | Runs HotpotQA ingestion with project defaults. |
| scripts/eval_hotpotqa.sh | POSIX shell wrapper | Runs HotpotQA evaluation with project defaults. |

All wrapper scripts resolve the repository root from the script location and pass extra command-line arguments through to the Python CLI.

## Shared Utility Modules

| Path | Responsibility |
| --- | --- |
| src/deepeval_eval/clients/search_rag.py | `SearchRagClient`: CAIPE rag-server client, ingestion job operations, query calls, and retrieval response parsing. Includes proactive 30s token refresh before expiry. |
| src/deepeval_eval/clients/ingest_rag.py | `IngestRagClient`: batched document ingestion jobs against RAG Server endpoints. |
| src/deepeval_eval/clients/mcp_tool_manager.py | `DynamicMCPToolManager`: ephemeral custom MCP search tool lifecycle (create, delete, context-manager). |
| [src/deepeval_eval/core/config.py](../src/deepeval_eval/core/config.py) | Centralized Pydantic-based configuration management (`EvalConfig`, domain settings, alias resolution, secret protection). |
| src/deepeval_eval/core/io_utils.py | Cached download helpers and JSONL evaluation question loading. |
| src/deepeval_eval/clients/llm.py | OpenAI compatible LLM client, DeepEval model adapter, and prompt builders. |
| src/deepeval_eval/engine/metrics.py | DeepEval metric construction, document ID scoring, and HotpotQA short-answer scoring. |

## Dataset-Specific Modules

| Path | Dataset | Responsibility |
| --- | --- | --- |
| src/deepeval_eval/datasets/enterprise.py | EnterpriseRAG-Bench | Load questions, download zip slices, sample documents, build CAIPE document payloads, and write generated data files. |
| src/deepeval_eval/datasets/hotpotqa.py | HotpotQA | Read preprocessed zip files, select questions, select gold documents plus distractors, build CAIPE payloads, and write generated data files. |

## Package Architecture (`src/deepeval_eval/`)

The core package is structured into functional modules based on responsibility:

| Subdirectory | Role & Responsibility | Key Components / Files |
| --- | --- | --- |
| **`api/`** | REST API service layer providing FastAPI routes (`app.py`), Question Sets & Questions CRUD (`question_sets.py`), Prompt Style template management (`prompt_styles.py`), auth validation (`auth.py`), telemetry metrics (`telemetry.py`), and background job queue management (`job_queue.py`). | `app.py`, `question_sets.py`, `prompt_styles.py`, `auth.py`, `job_queue.py`, `telemetry.py` |
| **`clients/`** | High-level client abstractions and adapters for RAG backends, LLMs, precomputed oracles, and ephemeral MCP tools. Implements standard interfaces (e.g. `BaseRagClient`, `RagQueryResult`). | `rag.py` (`AgenticRagAdapter`), `search_rag.py` (`SearchRagClient`), `ingest_rag.py`, `llm.py`, `oracle.py`, `mcp_tool_manager.py` |
| **`core/`** | Core settings, Pydantic configurations, and shared I/O utility helpers. | `config.py` (`EvalConfig`, `AgenticSettings`, `LLMSettings`, `AuthSettings`, `DatabaseSettings`), `io_utils.py` |
| **`datasets/`** | Dataset loading, sampling, formatting, and payload generation for supported evaluation benchmarks. | `enterprise.py`, `hotpotqa.py`, `loader.py` |
| **`db/`** | PostgreSQL database management split into modular managers for connection pooling, question sets/questions CRUD, and evaluation runs. | `db_manager.py`, `question_db_manager.py`, `evaluation_db_manager.py` |
| **`engine/`** | Core evaluation execution engines, low-level retrieval parsers, DeepEval judges, metric scoring, and quality gates. | `agentic_rag.py` (`AgenticRetriever`, SSE event parsers, `TraceEvent`), `eval_engine.py`, `deepeval_evaluator.py`, `metrics.py`, `gate.py` |
| **`ingest/`** | Ingestion execution scripts and CLI tools for registering and pushing benchmark documents into CAIPE datasources. | `ingest_cli.py`, `enterprise_deepeval.py`, `hotpotqa_deepeval.py` |
| **`sinks/`** | Modular result sinks for writing evaluation metrics and execution logs to target storage destinations. | `base.py`, `postgres.py`, `json.py`, `csv.py` |

### Engine vs Clients Distinction

- **`clients/`**: Provides clean, standardized adapter interfaces (such as `BaseRagClient` and `AgenticRagAdapter` in `clients/rag.py`). Code in `clients/` exposes uniform `.query()` signatures for evaluation suites.
- **`engine/`**: Implements the actual underlying execution logic, low-level protocols (e.g. SSE event streaming parsing, trace capturing in `engine/agentic_rag.py`), DeepEval metric evaluation algorithms (`engine/metrics.py`), and decision gates (`engine/gate.py`).

## Generated Local Directories

These directories are ignored by Git and are produced during local runs.

| Directory | Created by | Contents |
| --- | --- | --- |
| cache | Dataset loading | Downloaded EnterpriseRAG-Bench files or copied HotpotQA zip files. |
| data | Ingestion commands | Generated corpus and question files in JSONL and CSV. |
| results | Evaluation commands | Timestamped JSON and CSV evaluation results. |
| .deepeval | DeepEval runtime | Tool-generated DeepEval artefacts, if created. |
| __pycache__ | Python runtime | Compiled Python bytecode. |

## File Ownership by Workflow

| Workflow stage | Primary files |
| --- | --- |
| Configure model and paths | core/config.py, .env.example |
| Load dataset | datasets/enterprise.py, datasets/hotpotqa.py, core/io_utils.py |
| Ingest to CAIPE | ingest/enterprise_deepeval.py, ingest/hotpotqa_deepeval.py, clients/caipe.py |
| Retrieve from CAIPE | clients/caipe.py, clients/rag.py, engine/agentic_rag.py |
| Generate answers | clients/llm.py |
| Score outputs | engine/metrics.py, engine/gate.py |
| Run from terminal | scripts/*.sh, or direct Python CLI |

## Notes for New Contributors

- Keep generated data and result files out of Git.
- Add new dataset logic in a separate dataset module under `datasets/` rather than expanding entry point files.
- Shared adapters should go in `clients/`, execution engines in `engine/`, core configurations in `core/config.py`, and persistence sinks in `sinks/`.
- If a new command changes outputs or arguments, update README.md and docs/setup_and_usage.md.


