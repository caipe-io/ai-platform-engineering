# Setup and Usage

This guide explains how to set up the Python environment and run both evaluation pipelines.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Python 3.13 | Required by pyproject.toml (pinned via `.python-version`). |
| CAIPE rag-server | Expected at http://localhost:9446 by default. |
| OpenAI compatible LLM endpoint | Used for answer generation and DeepEval judge calls. |
| EnterpriseRAG-Bench network access | Needed when downloading EnterpriseRAG-Bench files. |
| HotpotQA preprocessed files | Required for HotpotQA ingestion. |

Network access is required during EnterpriseRAG-Bench dataset download unless files already exist in cache.

## Python Environment Setup

Create a virtual environment:

~~~powershell
py -3.13 -m venv .venv
~~~

Install the project in editable mode:

~~~powershell
.\.venv\Scripts\python.exe -m pip install -e .
~~~

The dependencies are declared in pyproject.toml:

| Dependency | Used for |
| --- | --- |
| deepeval | Evaluation metrics and test case objects. |
| httpx | OpenAI compatible LLM endpoint requests. |
| requests | CAIPE and dataset download requests. |
| pydantic | Structured schema handling in the LLM adapter and REST API DTOs. |
| pydantic-settings | Pydantic `BaseSettings` for environment-variable-driven configuration. |
| pyyaml | Gate threshold YAML configuration loading. |
| fastapi | REST API Evaluation Service and OpenAPI Swagger UI. |
| uvicorn | ASGI web server launcher. |
| python-multipart | Dataset file upload handling. |
| pyjwt + cryptography | JWT signature verification for OIDC tokens. |
| psycopg2-binary | PostgreSQL database driver for job queue and result sinks. |
| prometheus-client | Prometheus metrics exposition at `/metrics`. |
| opentelemetry-api/sdk | OpenTelemetry tracing and span management. |
| opentelemetry-exporter-otlp-proto-grpc | OTLP gRPC exporter for distributed traces. |
| opentelemetry-instrumentation-fastapi | Auto-instrumentation for FastAPI request spans. |

## Environment Variables

The scripts load environment values from a configured env file and from the current shell. Shell values take priority when already set.

Required model settings:

~~~text
OPENAI_API_KEY=replace-with-api-key
OPENAI_ENDPOINT=https://api.openai.com/v1
OPENAI_MODEL_NAME=azure/gpt-5.4
~~~

The repository includes .env.example as a template. The default env file path used by config.py is:

~~~text
~/ai-platform-engineering/.env
~~~

To use another env file, pass --env-file to the Python entry point or append it after a wrapper script name.

## CAIPE Configuration

The default CAIPE RAG server URL is:

~~~text
http://localhost:9446
~~~

When running against a full CAIPE deployment (Kubernetes or Docker Compose) via the Next.js UI BFF proxy without direct RAG server ingress:

~~~text
https://caipe.example.com/api/rag
~~~

Override it with:

~~~bash
python src/deepeval_eval/engine/deepeval_evaluator.py eval --rag-url https://caipe.example.com/api/rag
~~~

### Authentication & Authorization Modes

The evaluation scripts support two complementary authentication methods:

#### 1. Direct JWT Token (`CAIPE_OIDC_TOKEN`)
- Pre-set `CAIPE_OIDC_TOKEN="<access_token>"` in `.env` or export in your terminal.
- Or use the interactive OAuth2 PKCE CLI helper:
  ```bash
  python3 scripts/oauth_login.py --save-env
  ```
- All scripts prioritize `CAIPE_OIDC_TOKEN` if defined, passing it directly as `Authorization: Bearer <token>`.
- **Lifespan & Refresh Limitation**:
  - Direct JWT access tokens (including tokens copied from the UI session object) are static and have a fixed lifespan (typically 1 hour / 3,600s).
  - Standalone access tokens cannot be renewed or refreshed by CLI/Python scripts once expired (even if the originating web UI session has `hasRefreshToken: true`, as refresh tokens are retained in backend HTTP-only cookies).
  - If a static token expires during an evaluation run, subsequent API requests will fail with `401 Unauthorized`.

#### 2. Machine-to-Machine Client Credentials (`grant_type=client_credentials`)
- Recommended for automated, headless, and long-running evaluation benchmarks.
- Set service account credentials in `.env`:
  ```env
  CAIPE_SA_CLIENT_ID="caipe-sa-evaluator-bot"
  CAIPE_SA_CLIENT_SECRET="<secret>"
  CAIPE_SA_TOKEN_URL="https://caipe.example.com/realms/caipe/protocol/openid-connect/token"
  ```
- **Automatic Renewal**: When `CAIPE_OIDC_TOKEN` is unset or upon receiving `401 Unauthorized`, runner scripts and the evaluator engine automatically request and refresh fresh access tokens from Keycloak using `grant_type=client_credentials`.

### Ephemeral Dynamic MCP Search Tools

To run evaluations using dynamically provisioned MCP custom search tools with configurable weights (e.g. 0.5 semantic + 0.5 keyword):

~~~bash
./scripts/run_eval_enterprise_dynamic_mcp.sh --max-items 1
~~~

This script:
1. Resolves authentication via `CAIPE_OIDC_TOKEN` or service account `client_credentials`.
2. Automatically provisions a temporary MCP search tool (`eval-<run_id>`) via `POST /api/rag/v1/mcp/custom-tools`.
3. Executes the agentic evaluation using the custom tool.
4. Cleanly deletes the ephemeral tool on exit.

> **Note on Audience Mapping**: For tokens minted via Keycloak clients (e.g., `caipe-platform` or `caipe-sa-*`) to pass verification at the Next.js UI BFF, an **Audience Protocol Mapper** (`caipe-ui`) must be configured on the client scope. See [integration_and_security.md](./integration_and_security.md#56-keycloak-client-audience-mapping-caipe-platform--caipe-ui).
>
> **Note on OpenFGA Administrative Privileges**: If using a machine service account for dynamic MCP tool creation, write the direct OpenFGA organization tuple:
> ```bash
> fga tuple write --store-id <store_id> service_account:<sa_sub_uuid> admin organization:caipe
> ```

## Wrapper Scripts

The scripts directory contains platform wrappers around the Python entry points.

| Platform | Scripts |
| --- | --- |
| Windows | scripts\*.cmd |
| Linux or macOS | scripts/*.sh |

The wrappers include the repository default options and pass through any extra CLI arguments. Because extra arguments are appended last, they can override defaults where argparse accepts repeated options.

Windows example:

~~~powershell
.\scripts\eval_enterprise.cmd --max-items 1
~~~

Linux or macOS example:

~~~bash
./scripts/eval_enterprise.sh --max-items 1
~~~

## EnterpriseRAG-Bench Usage

Run ingestion on Windows:

~~~powershell
.\scripts\ingest_enterprise.cmd
~~~

Run evaluation on Windows:

~~~powershell
.\scripts\eval_enterprise.cmd
~~~

Run a one-question smoke test on Windows:

~~~powershell
.\scripts\eval_enterprise.cmd --max-items 1 --top-k 3 --max-context-chars 6000
~~~

Linux or macOS equivalents:

~~~bash
./scripts/ingest_enterprise.sh
./scripts/eval_enterprise.sh
./scripts/eval_enterprise.sh --max-items 1 --top-k 3 --max-context-chars 6000
~~~

Use direct Python if preferred:

~~~powershell
python src\deepeval_eval\enterprise_deepeval.py ingest --sources confluence jira github hubspot fireflies linear google_drive gmail slack --limit-per-source 1000 --num-questions 10 --questions-per-category 3 --batch-size 50
python src\deepeval_eval\enterprise_deepeval.py eval --max-items 10 --top-k 3 --max-context-chars 6000
~~~

## HotpotQA Usage

Place these files in cache or ~/Downloads:

~~~text
hotpotqa_full_questions.jsonl.zip
hotpotqa_full_document_pool.jsonl.zip
~~~

Run ingestion on Windows:

~~~powershell
.\scripts\ingest_hotpotqa.cmd
~~~

Run evaluation on Windows:

~~~powershell
.\scripts\eval_hotpotqa.cmd
~~~

Run a one-question smoke test on Windows:

~~~powershell
.\scripts\eval_hotpotqa.cmd --max-items 1 --top-k 5 --max-context-chars 12000
~~~

Linux or macOS equivalents:

~~~bash
./scripts/ingest_hotpotqa.sh
./scripts/eval_hotpotqa.sh
./scripts/eval_hotpotqa.sh --max-items 1 --top-k 5 --max-context-chars 12000
~~~

Use direct Python if preferred:

~~~powershell
python src\deepeval_eval\hotpotqa_deepeval.py ingest --limit 100 --questions-per-category 50 --max-docs 1000 --batch-size 50
python src\deepeval_eval\hotpotqa_deepeval.py eval --max-items 10 --top-k 5 --max-context-chars 12000
~~~

## Common Options

| Option | Applies to | Purpose |
| --- | --- | --- |
| --rag-url | ingest and eval | Override the CAIPE rag-server URL. |
| --auth-token | ingest and eval | Send a Bearer token to CAIPE. |
| --env-file | ingest and eval | Load model settings from a different env file. |
| --data-dir | ingest and eval | Override generated data folder. |
| --cache-dir | ingest and eval | Override cache folder. |
| --results-dir | eval | Override results folder. |
| --max-context-chars | eval | Max character cutoff per retrieved context chunk (default: 12000/16000) to prevent LLM context window overflow. |
| --reset | ingest | Clear datasource before ingestion. |
| --skip-ingest | ingest | Generate local data files without sending documents to CAIPE. |

## REST API Evaluation Service & Swagger UI

As an alternative to CLI execution, launch the REST API Evaluation Service:

~~~bash
uv run python -m deepeval_eval.api
~~~

Access interactive Swagger UI documentation at `http://localhost:8000/docs` (or ReDoc at `/redoc`). See [rest_api_service.md](rest_api_service.md) for endpoint details and usage examples.

### Worker Concurrency & Job Queue Configuration

The REST API service utilizes a persistent job queue backed by PostgreSQL (`eval_job_queue` table). You can configure background worker concurrency using environment variables:

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `EVAL_MAX_CONCURRENT_JOBS` | `1` | Number of parallel evaluation jobs processed simultaneously by background worker threads. |
| `MAX_CONCURRENT_JOBS` | `1` | Fallback alias for `EVAL_MAX_CONCURRENT_JOBS`. |

Setting `EVAL_MAX_CONCURRENT_JOBS=4` allows the service to process up to 4 evaluation jobs in parallel while keeping extra submissions safely queued in PostgreSQL.

## Testing & Pytest Usage

Run automated test suites using `pytest` (managed via `uv` or standard Python virtual environment):

Run the entire test suite:

~~~bash
uv run pytest
~~~

Run specific module test suites:

~~~bash
uv run pytest tests/test_gate.py
uv run pytest tests/test_api.py
uv run pytest tests/test_agentic_rag.py
~~~

Run test coverage checks:

~~~bash
uv run pytest --cov=src
~~~

See [cicd_quality_gate.md](cicd_quality_gate.md) for detailed instructions on writing quality gate tests in pytest and setting up GitHub Actions CI/CD pipelines.

## Troubleshooting


| Problem | Likely cause | What to check |
| --- | --- | --- |
| Connection error to localhost:9446 | CAIPE rag-server is not running. | Start CAIPE and confirm rag-server is reachable. |
| Missing OPENAI settings | Env file missing or variables not set. | Check OPENAI_API_KEY, OPENAI_ENDPOINT, and OPENAI_MODEL_NAME. |
| HotpotQA file not found | Preprocessed zip files are missing. | Place the two zip files in cache or ~/Downloads. |
| Ingestion is slow | Large source count or batch size. | Reduce source list, limit per source, max docs, or question count. |
| Wrapper script cannot run | Shell, Python, or file permissions are not configured for the platform. | Use direct Python commands, confirm Python is on PATH, or use the platform-specific wrapper. |
| Evaluation question file missing | Ingestion has not generated data files. | Run the relevant ingest command first. |
