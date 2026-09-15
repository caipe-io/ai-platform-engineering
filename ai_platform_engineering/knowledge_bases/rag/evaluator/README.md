# CAIPE DeepEval Evaluation

This repository contains DeepEval based evaluation pipelines for CAIPE RAG over two benchmark datasets:

- EnterpriseRAG-Bench
- HotpotQA

The project supports controlled document ingestion into CAIPE, evaluation question generation, retrieval checks against expected document IDs, answer generation from retrieved context, and metric scoring with DeepEval.

## Problem This Project Solves

CAIPE can retrieve documents from a knowledge base through its rag-server. This repository provides a repeatable way to check whether CAIPE retrieves the expected source documents and whether answers generated from those retrieved contexts are relevant and faithful.

The current implementation evaluates CAIPE rag-server retrieval and context-grounded answer generation. Full CAIPE agentic chat evaluation is to be confirmed.

## Main Features

| Area | What is implemented |
| --- | --- |
| Dataset ingestion | Ingests bounded samples from EnterpriseRAG-Bench and HotpotQA into CAIPE. |
| Retrieval evaluation | Compares CAIPE retrieved document IDs with expected document IDs. |
| Answer generation | Uses an OpenAI compatible LLM endpoint to answer from retrieved context. |
| DeepEval scoring | Runs AnswerRelevancyMetric, FaithfulnessMetric, ContextualRelevancyMetric, ContextualPrecisionMetric, and ContextualRecallMetric. |
| Ground-truth benchmark evaluation | Runs DeepEval against benchmark reference contexts and reference answers without calling CAIPE retrieval. |
| HotpotQA checks | Adds normalized exact match and contains reference checks for short answers. |
| Output files | Writes JSON and CSV outputs under data and results. |

## Repository Structure

~~~text
caipe_deepeval_evaluation/
|-- README.md
|-- pyproject.toml
|-- .env.example
|-- .gitignore
|-- scripts/
|   |-- ingest_enterprise.cmd
|   |-- eval_enterprise.cmd
|   |-- ingest_hotpotqa.cmd
|   |-- eval_hotpotqa.cmd
|   |-- eval_precomputed.cmd
|   |-- ingest_enterprise.sh
|   |-- eval_enterprise.sh
|   |-- ingest_hotpotqa.sh
|   |-- eval_hotpotqa.sh
|   |-- eval_precomputed.sh
|-- src/
|   |-- deepeval_eval/
|       |-- api/
|       |-- clients/
|       |-- core/
|       |-- datasets/
|       |-- engine/
|       |-- ingest/
|       |-- sinks/

|-- docs/
    |-- architecture.md
    |-- evaluation_pipeline.md
    |-- enterprise_rag_bench.md
    |-- hotpotqa.md
    |-- project_structure.md
    |-- setup_and_usage.md
~~~

Generated local folders are ignored by Git:

~~~text
cache/
data/
results/
~~~

## Quick Start

From the repository root:

~~~powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
~~~

Make sure CAIPE rag-server is running at the default URL:

~~~text
http://localhost:9446
~~~

Create a local .env file or use the CAIPE .env file configured in src/deepeval_eval/config.py.

## Configuration

The evaluation code reads model settings from environment variables or from the configured CAIPE .env file.

| Variable | Required | Purpose |
| --- | --- | --- |
| OPENAI_API_KEY | Yes | API key for the OpenAI compatible LLM endpoint. |
| OPENAI_ENDPOINT | Yes | Base URL for the OpenAI compatible LLM endpoint. |
| OPENAI_MODEL_NAME | Yes | Model name passed to answer generation and DeepEval judge calls. |

Default paths and folders are defined in src/deepeval_eval/config.py.

| Setting | Default |
| --- | --- |
| CAIPE rag-server URL | http://localhost:9446 |
| Data directory | data |
| Cache directory | cache |
| Results directory | results |
| Default env file | ~/ai-platform-engineering/.env |

## Wrapper Scripts

Windows users can run the .cmd scripts. Linux and macOS users can run the .sh scripts. Each script sets the repository root from its own location and then calls the correct Python entry point.

Extra CLI options can be appended after the script name. For example, this runs only one EnterpriseRAG-Bench evaluation item:

~~~powershell
.\scripts\eval_enterprise.cmd --max-items 1
~~~

The shell scripts accept the same extra options:

~~~bash
./scripts/eval_enterprise.sh --max-items 1
~~~

## Ground-Truth / Precomputed DeepEval Evaluation

The precomputed evaluation mode tests DeepEval against a benchmark's ground-truth
question file instead of querying CAIPE retrieval. It uses the `context` field in
the generated question JSONL as the retrieval context. By default it uses the
benchmark `reference` answer as `actual_output`, which gives an upper-bound style
run for checking the metric behaviour against the reference solution.

Run the default HotpotQA ground-truth evaluation on Windows:

~~~powershell
.\scripts\eval_precomputed.cmd
~~~

Run it for EnterpriseRAG-Bench:

~~~powershell
.\scripts\eval_precomputed.cmd --benchmark enterprise --questions-file data\enterprise_deepeval_questions.jsonl
~~~

To ask the configured LLM to answer from the gold context instead of using the
reference answer directly:

~~~powershell
.\scripts\eval_precomputed.cmd --answer-mode generate
~~~

The output files are written to `results/` with names like:

~~~text
precomputed_deepeval_hotpotqa_reference_timestamp.json
precomputed_deepeval_hotpotqa_reference_timestamp.csv
~~~

## EnterpriseRAG-Bench Evaluation

Run ingestion on Windows:

~~~powershell
.\scripts\ingest_enterprise.cmd
~~~

Run evaluation on Windows:

~~~powershell
.\scripts\eval_enterprise.cmd
~~~

Linux or macOS equivalents:

~~~bash
./scripts/ingest_enterprise.sh
./scripts/eval_enterprise.sh
~~~

Direct Python commands are also supported:

~~~powershell
python src\deepeval_eval\enterprise_deepeval.py ingest --sources confluence jira github hubspot fireflies linear google_drive gmail slack --limit-per-source 1000 --num-questions 10 --questions-per-category 3 --batch-size 50
python src\deepeval_eval\enterprise_deepeval.py eval --max-items 10 --top-k 3 --max-context-chars 6000
~~~

## HotpotQA Evaluation

HotpotQA ingestion expects these preprocessed zip files in cache, with fallback lookup in ~/Downloads:

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

Linux or macOS equivalents:

~~~bash
./scripts/ingest_hotpotqa.sh
./scripts/eval_hotpotqa.sh
~~~

Direct Python commands are also supported:

~~~powershell
python src\deepeval_eval\hotpotqa_deepeval.py ingest --limit 100 --questions-per-category 50 --max-docs 1000 --batch-size 50
python src\deepeval_eval\hotpotqa_deepeval.py eval --max-items 10 --top-k 5 --max-context-chars 12000
~~~

## Outputs and Results

Ingestion writes generated dataset files to data:

| Pipeline | Files |
| --- | --- |
| EnterpriseRAG-Bench | enterprise_deepeval_corpus.jsonl, enterprise_deepeval_corpus.csv, enterprise_deepeval_questions.jsonl, enterprise_deepeval_questions.csv |
| HotpotQA | hotpotqa_deepeval_corpus.jsonl, hotpotqa_deepeval_corpus.csv, hotpotqa_deepeval_questions.jsonl, hotpotqa_deepeval_questions.csv |

Evaluation writes timestamped result files to results:

~~~text
enterprise_deepeval_results_timestamp.json
enterprise_deepeval_results_timestamp.csv
hotpotqa_deepeval_results_timestamp.json
hotpotqa_deepeval_results_timestamp.csv
precomputed_deepeval_benchmark_answer-mode_timestamp.json
precomputed_deepeval_benchmark_answer-mode_timestamp.csv
~~~

## Authentication and Access Methods

The evaluator supports two complementary authentication modes for interacting with CAIPE RAG and the Next.js UI BFF:

### 1. Direct JWT Bearer Token (`CAIPE_OIDC_TOKEN`)
Used for interactive sessions or running scripts with a pre-authenticated user session:
- **Set in `.env`**: `CAIPE_OIDC_TOKEN="<jwt_access_token>"`
- **Or export in shell**: `export CAIPE_OIDC_TOKEN="<jwt_access_token>"`
- **Interactive login helper**: Run `python3 scripts/oauth_login.py --save-env` to authenticate via browser OAuth 2.0 PKCE.
- All runner scripts prioritize `CAIPE_OIDC_TOKEN` if defined.
- **Expiry Note**: Static JWT tokens expire after their configured lifespan (e.g. 1 hour) and cannot be renewed by standalone CLI scripts. For long evaluation runs, use M2M credentials instead.

### 2. Machine-to-Machine Client Credentials (`grant_type=client_credentials`)
Recommended for headless CI/CD automation and background evaluations without passwords:
- **Configure in `.env`**:
  ```env
  CAIPE_SA_CLIENT_ID="caipe-sa-evaluator-bot"
  CAIPE_SA_CLIENT_SECRET="<secret>"
  CAIPE_SA_TOKEN_URL="https://caipe.example.com/realms/caipe/protocol/openid-connect/token"
  ```
- Scripts and the Python evaluator engine automatically fetch and continuously refresh access tokens before API calls and upon encountering 401 Unauthorized errors.
- **Keycloak audience requirement**: Ensure an Audience Protocol Mapper (`caipe-ui`) is added to the client scope so the Next.js BFF accepts the bearer token.
- **OpenFGA authorization**: For administrative RAG actions (such as dynamic custom MCP tools), write the direct organization tuple:
  ```bash
  fga tuple write --store-id <store_id> service_account:<sa_sub_uuid> admin organization:caipe
  ```


## Documentation

Detailed documentation is available in the docs folder:

- [Setup and Usage](docs/setup_and_usage.md)
- [Architecture](docs/architecture.md)
- [Integration, Security & Routing Reference](docs/integration_and_security.md)
- [ReBAC Architecture](docs/evaluator_rebac_architecture.md)
- [API Access Patterns & Configuration Philosophy](docs/api_access_patterns.md)
- [REST API Service](docs/rest_api_service.md)
- [Agentic RAG Client](docs/agentic_rag.md)
- [Precomputed Evaluation](docs/precomputed_evaluation.md)
- [CI/CD Quality Gate & Pytest Integration](docs/cicd_quality_gate.md)
- [Evaluation Pipeline](docs/evaluation_pipeline.md)
- [Eval Results Database & Batch Pipeline](docs/eval_results_database.md)
- [Project Structure](docs/project_structure.md)
- [EnterpriseRAG-Bench](docs/enterprise_rag_bench.md)
- [HotpotQA](docs/hotpotqa.md)

## Notes

- Generated folders are intentionally excluded from Git.
- Python 3.13 is required and pinned via `.python-version` and `pyproject.toml`.

