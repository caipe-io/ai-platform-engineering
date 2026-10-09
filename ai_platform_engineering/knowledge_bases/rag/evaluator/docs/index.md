# CAIPE RAG Evaluator — Documentation Index

This directory contains the complete technical reference for the **CAIPE DeepEval RAG Evaluator** — a FastAPI-based evaluation harness for measuring retrieval and answer quality in the CAIPE AI Platform Engineering system.

---

## What This System Does

The RAG Evaluator provides:

- **Benchmarked retrieval quality assessment** against EnterpriseRAG-Bench and HotpotQA datasets
- **End-to-end agentic pipeline evaluation** through the CAIPE streaming gateway (SSE protocol)
- **Async REST API** for submitting, tracking, and retrieving evaluation jobs
- **CI/CD quality gate** for blocking deployments on metric regressions
- **Persistent question sets and result storage** in PostgreSQL with OpenFGA access control

---

## Design Principles

1. **Dependency injection over global singletons** — runtime classes (`CAIPEClient`, `AgenticRetriever`, `PostgresResultSink`) accept explicit settings objects. The global `get_eval_config()` singleton is reserved for CLI entry points only.

2. **Localhost defaults, environment overrides** — all Python defaults point to `localhost:<port>`. Deployment topology (Docker Compose, Kubernetes, remote) is injected exclusively via environment variables or Helm values.

3. **Proactive token refresh** — `SearchRagClient.ensure_authenticated()` refreshes Keycloak tokens 30 seconds before expiry, preventing mid-job 401 failures on long benchmark runs.

4. **Front-door authorization, background machine execution** — human OIDC JWT validates intent at submission time; the background worker acquires an auto-refreshing machine token (`client_credentials`) and runs without holding the user's short-lived token.

5. **Zero-DDL schema evolution** — operational metadata (`owner_team`, `visibility`) is stored in a `config_json` JSONB column, avoiding mandatory migrations on schema extensions.

6. **Evaluation deduplication** — a 16-char SHA-256 fingerprint of normalized config + dataset bytes avoids re-running identical evaluations within 24 hours.

7. **All credentials are `SecretStr`** — `to_config_args()` sanitizes log output by filtering keys matching `key`, `secret`, `token`, `password`, `dsn`.

8. **Soft/hard quality gates** — metric threshold violations are classified `soft` (warn) or `hard` (fail the build), enabling gradual quality baseline enforcement.

---

## Architecture Overview

```
Benchmarks (EnterpriseRAG-Bench / HotpotQA)
    │
    ▼
Dataset Modules (datasets/enterprise.py, hotpotqa.py)
    │
    ├──► Corpus & Question JSONL files (data/)
    │
    ├──► RAG Server Ingestion (SearchRagClient → POST /v1/ingest)
    │
    └──► Evaluation Engine (engine/eval_engine.py)
              │
              ├──── Standard mode: SearchRagClient
              │         → {CAIPE_BASE_URL}/v1/query
              │         (local: localhost:9446 | cluster: BFF /api/rag)
              │         ▼
              │     LLM Answer Generation (clients/llm.py)
              │         ▼
              │     DeepEval Judge (5 metrics + retrieval)
              │
              └──── Agentic mode: AgenticRetriever
                        → {CAIPE_API_URL}/api/dynamic-agents (via BFF)
                        ▼
                    rag_context artifact parsing
                        ▼
                    DeepEval Judge (5 metrics + retrieval)
              │
              ▼
        Results written to TWO sinks simultaneously:
              ├── FileResultSink → results/<timestamp>.json + .csv (always)
              └── PostgresResultSink → evaluation_runs + evaluation_results (if DATABASE_URL set)
              │
              ▼
        Quality Gate (engine/gate.py) → exit 0/1
```

> **BFF is mandatory for cluster deployments.** Direct service access to `rag-server:9446` or `dynamic-agents:8001` bypasses session management and OpenFGA — see [api_access_patterns.md](docs/api_access_patterns.md) for the full rationale and topology matrix.

The REST API (`api/app.py`) wraps the engine in an async job queue, returning `202 Accepted` immediately and executing evaluations in background tasks backed by a PostgreSQL-persistent `PersistentJobQueue`.

---

## Integration Map

| Service | Role | Evaluator Relationship |
| :--- | :--- | :--- |
| **RAG Server** | Vector + graph hybrid search, document ingestion | Evaluator ingests corpora and queries `/v1/query` for context retrieval |
| **Dynamic Agents Supervisor** | LangGraph multi-agent runtime | Agentic mode routes queries through dynamic agents via SSE streaming gateway |
| **Next.js BFF** | Browser-facing API gateway; manages SSE sessions, OpenFGA checks | SSE mode uses BFF `/api/chat/conversations` + `/api/v1/chat/stream/start`; MCP tool registration goes through `/api/rag/v1/mcp/custom-tools` |
| **Keycloak** | OIDC identity provider | Both evaluator API and RAG server validate JWTs from this issuer; machine tokens fetched via `client_credentials` |
| **OpenFGA** | ReBAC engine | Evaluator checks `can_evaluate`, `can_read` on evaluation jobs, question sets, data sources, and agents |
| **PostgreSQL** | Relational store | Job queue, run history, question sets, questions, result sinks |
| **OpenAI-compatible LLM** | Answer generation and DeepEval judge | Both roles use `OPENAI_ENDPOINT` / `OPENAI_API_KEY` / `OPENAI_MODEL_NAME` |

---

## Security Summary

### Authentication Modes (Evaluator REST API)

| Method | Header | Details |
| :--- | :--- | :--- |
| Static API key | `X-API-Key` or `Authorization: Bearer` | Matches `DEEPEVAL_API_KEY`; grants `Role.ADMIN` |
| Human OIDC JWT | `Authorization: Bearer <jwt>` | Validated against Keycloak JWKS; roles extracted from `realm_access.roles` or groups |
| Machine M2M JWT | `Authorization: Bearer <jwt>` | Detected by `gty=client-credentials` or `sub==client_id`; auto-assigned `Role.EVALUATOR` |
| Dev bypass | _(no header)_ | Allowed when `ALLOW_UNAUTHENTICATED_ACCESS=true`; grants `Role.ADMIN` |

### Role Hierarchy

```
READONLY (1) < EVALUATOR (2) / INGESTONLY (2) < ADMIN (3)
```

`require_role()` promotes standard OIDC users to `ADMIN` if they hold an OpenFGA `can_manage organization:caipe` tuple, avoiding hardcoded admin email lists.

### ReBAC (OpenFGA)

Every evaluation job and question set submission writes four OpenFGA tuples:
- `(user:<sub>, creator, evaluation:<job_id>)`
- `(team:<slug>#member, reader, evaluation:<job_id>)` — if `owner_team` set
- `(team:<slug>#admin, manager, evaluation:<job_id>)` — if `owner_team` set
- `(user:*, reader, evaluation:<job_id>)` — if `visibility=public`

Listing endpoints filter through `OpenFGA list-objects` before any DB query, ensuring users only see resources they can read.

### Machine Service Account Access

For headless CI/CD:
1. Configure `CAIPE_SA_CLIENT_ID` + `CAIPE_SA_CLIENT_SECRET` + `CAIPE_SA_TOKEN_URL`.
2. Add an **Audience Protocol Mapper** (`caipe-ui`) to the client's dedicated scope in Keycloak so the Next.js BFF accepts the token.
3. Write the OpenFGA tuple for admin-level RAG operations:
   ```bash
   fga tuple write --store-id <store_id> service_account:<sa_sub_uuid> admin organization:caipe
   ```

---

## Key Environment Variables

| Variable | Purpose |
| :--- | :--- |
| `OPENAI_API_KEY` | LLM answer generation + DeepEval judge |
| `OPENAI_ENDPOINT` | OpenAI-compatible base URL |
| `OPENAI_MODEL_NAME` | Model identifier |
| `DEEPEVAL_API_KEY` | Static API key for REST API auth |
| `ALLOW_UNAUTHENTICATED_ACCESS` | `true` for local dev (bypasses auth) |
| `OIDC_ISSUER` | Keycloak realm URL for JWT validation |
| `OIDC_AUDIENCE` | Expected `aud` claim (e.g. `caipe-ui`) |
| `OPENFGA_HTTP` | OpenFGA base URL |
| `OPENFGA_STORE_NAME` | Store name for discovery |
| `DATABASE_URL` | PostgreSQL connection string |
| `CAIPE_SA_CLIENT_ID` | M2M service account client ID |
| `CAIPE_SA_CLIENT_SECRET` | M2M service account client secret |
| `CAIPE_SA_TOKEN_URL` | Keycloak token endpoint for M2M |
| `CAIPE_BASE_URL` | RAG Server base URL |
| `CAIPE_SUPERVISOR_URL` | Dynamic Agents supervisor URL |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP gRPC collector (optional) |
| `OTEL_SERVICE_NAME` | Service name in OTel traces (default: `deepeval-evaluator`) |
| `ENABLE_OTEL_TRACING` | `true` to force OTel even without OTLP endpoint |
| `EVALUATOR_OBO_ENABLED` | `true` to enable RFC 8693 OBO token exchange for delegated user identity in background jobs |
| `EVAL_MAX_CONCURRENT_JOBS` | Max parallel background evaluation worker threads (default: `1`) |

See [`.env.example`](../.env.example) for the complete list.

---

## Document Map

| Document | Contents |
| :--- | :--- |
| [setup_and_usage.md](setup_and_usage.md) | Environment setup, Python 3.13 install, auth modes, CLI usage |
| [architecture.md](architecture.md) | Component table, data flow, config hierarchy (`EvalConfig`), design principles |
| [integration_and_security.md](integration_and_security.md) | Deep dive: component integration, OIDC/JWKS, OpenFGA DSL, API route table, agentic SSE protocol, deployment topology |
| [evaluator_rebac_architecture.md](evaluator_rebac_architecture.md) | ReBAC sequence diagrams, front-door vs. background worker split, listing filters, verification scripts |
| [api_access_patterns.md](api_access_patterns.md) | Topology matrix (local dev / Docker Compose / Kubernetes / remote), localhost-default rule, BFF routing rationale |
| [rest_api_service.md](rest_api_service.md) | Full endpoint reference, DTOs, curl examples, question sets API, prompt styles API |
| [agentic_rag.md](agentic_rag.md) | SSE streaming gateway protocol, `AgenticRetriever` class reference, context parsing, deduplication, OIDC token flow, dynamic MCP tools |
| [precomputed_evaluation.md](precomputed_evaluation.md) | Oracle/ground-truth mode, `PrecomputedRagClient`, CLI options, upper-bound use cases |
| [cicd_quality_gate.md](cicd_quality_gate.md) | Gate thresholds, soft/hard failure model, pytest patterns, GitHub Actions example |
| [evaluation_pipeline.md](evaluation_pipeline.md) | Step-by-step pipeline execution: data flow, metric scoring, output files |
| [eval_results_database.md](eval_results_database.md) | Batch parameter sweep pipeline, Postgres schema (`batches`, `runs`, `eval_results`), example SQL queries |
| [project_structure.md](project_structure.md) | Directory layout, module responsibilities, engine vs. clients distinction, contributor guidelines |
| [enterprise_rag_bench.md](enterprise_rag_bench.md) | EnterpriseRAG-Bench dataset format, ingestion flow, category breakdown |
| [hotpotqa.md](hotpotqa.md) | HotpotQA dataset format, preprocessing, exact-match scoring |
| [metrics_management.md](metrics_management.md) | Architecture and REST/CLI guide for dynamic DeepEval metrics and metric sets management |
| [upstream_caipe_requirements.md](upstream_caipe_requirements.md) | All upstream CAIPE platform changes required to support the evaluator (RAG Server, BFF, OpenFGA, Keycloak, Dynamic Agents, PostgreSQL) |
| [baseline_legacy_evaluator_contribution.md](baseline_legacy_evaluator_contribution.md) | Technical audit record of the legacy baseline evaluator inherited from `CaipeDeepevalEvaluation` (up to commit `7f0f9a819`) |
