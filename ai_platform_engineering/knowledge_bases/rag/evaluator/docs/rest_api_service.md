# REST API Evaluation & Results Management Service (`api.py`)

The REST API Evaluation Service provides an asynchronous HTTP REST interface and interactive OpenAPI/Swagger UI (`/docs`, `/redoc`) for running evaluation pipelines, submitting custom datasets, managing background evaluation jobs, querying results, downloading CSV reports, and persisting evaluation runs in PostgreSQL.

---

## Architectural Overview & Design Patterns

The service is implemented in [`src/deepeval_eval/api/app.py`](../src/deepeval_eval/api/app.py) using **FastAPI** and **ASGI (`uvicorn`)**. It incorporates key enterprise software design patterns:

### 1. Repository / Sink Pattern (Data Abstraction)
- **Concept**: Decouples evaluation business logic from persistent storage mechanisms.
- **Implementation**: Uses `ResultSink` Protocol with `PostgresResultSink` for central database persistence in REST API workers, and `FileResultSink` for local timestamped JSON/CSV generation in standalone CLI runs.
- **Benefit**: Background worker jobs write directly to the database without generating ephemeral disk files, while streaming CSV/JSON endpoints query DB/memory dynamically.

### 2. Job Queue & State Machine Pattern (Asynchronous Operations)
- **Concept**: Long-running LLM evaluations execute asynchronously via background tasks or persistent job queues without blocking client HTTP connections or risking gateway timeouts.
- **State Machine Transitions**:
  $$\text{PENDING} \longrightarrow \text{RUNNING} \longrightarrow \text{COMPLETED} \quad / \quad \text{FAILED}$$
- **Workflow**: `JobManager` manages job states in memory with fallback to PostgreSQL `evaluation_runs`/`evaluation_results`, returning an immediate `202 Accepted` response containing a unique `job_id`.

### 3. Cache-Aside / Memoization Pattern (Evaluation Deduplication)
- **Concept**: Prevents redundant LLM evaluation calls when workload parameters and dataset content are unchanged.
- **Fingerprinting Algorithm**:
  $$\text{eval\_hash} = \text{UUID}(\text{SHA256}(\text{normalized\_workload\_config\_json} + \text{dataset\_bytes})[:16])$$
  Transient credentials, ephemeral files, and caller metadata (`submitter_subject`, `submitter_email`, `submitter_role`, `owner_team`, `visibility`, `force_rerun`, `llm_api_key`, `auth_token`, `client_secret`) are excluded from the fingerprint, enabling **global parameter caching** across all authorized users.
- **Workflow**:
  - `JobManager` checks PostgreSQL-backed caching via `EvaluationDBManager.get_cached_job_by_hash` (24-hour TTL) for matching `eval_hash`.
  - If a valid cache entry exists and `force_rerun=False`, the API immediately returns a completed job response (`cached=True`) and writes OpenFGA reader permissions for the new caller on `evaluation:<job_id>`.
  - Setting `force_rerun=True` invalidates cache and forces fresh evaluation.

### 4. DTO (Data Transfer Object) & Schema Validation Pattern
- **Concept**: Strongly typed Pydantic request/response DTO models (`EvaluationRequest`, `JobResponse`, `EvaluationResultsResponse`).
- **Benefit**: Enforces strict input validation constraints (`max_items >= 1`, `top_k >= 1`, `max_context_chars >= 100`) and auto-generates interactive Swagger UI at `/docs` and ReDoc at `/redoc`.

---

## Security & Authentication

The API integrates with [`deepeval_eval.auth`](../src/deepeval_eval/api/auth.py) for token verification, static key validation, and role-based access control.

### Supported Authentication Methods

| Auth Header | Format / Parameter | Description |
| :--- | :--- | :--- |
| `Authorization` | `Bearer <TOKEN>` | OIDC JWT token or static API key. |
| `X-API-Key` | `<API_KEY>` | Static API key string matching `DEEPEVAL_API_KEY` or `API_KEY` in environment. |

### Environment Configuration

- **Static Key Auth**: Set `DEEPEVAL_API_KEY=your_secret_key` in `.env`.
- **OIDC JWT Auth**: Set `OIDC_ISSUER_URL` and `OIDC_AUDIENCE`.
- **Local Dev Bypass**: Set `ALLOW_UNAUTHENTICATED_ACCESS=true` (default in local dev when no auth key is configured).

---

## Data Transfer Objects & Schemas

### `JobStatusEnum`

Enum representing evaluation job status:
- `"pending"`: Job queued, waiting for background task execution.
- `"running"`: Evaluation pipeline currently executing.
- `"completed"`: Job completed successfully. Results available.
- `"failed"`: Execution failed due to an exception. Error message recorded.

---

### `EvaluationRequest` (Request Body Schema)

JSON payload used when submitting evaluation jobs via `POST /eval/jobs`.

| Field Name | Type | Default | Validation / Constraint | Description |
| :--- | :--- | :--- | :--- | :--- |
| `dataset_name` | `str` | `"enterprise"` | - | Benchmark dataset name (e.g. `"enterprise"`, `"hotpotqa"`, or custom). |
| `question_set_id` | `int \| null` | `null` | - | Database ID of a stored question set in PostgreSQL to evaluate against. |
| `answer_mode` | `str` | `"generate"` | `"generate"` \| `"ground_truth"` | Mode for answer generation. |
| `oracle_testing` | `bool` | `false` | - | Enables oracle retrieval and ground truth answer mode. |
| `datasource_id` | `str \| null` | `null` | - | Target CAIPE RAG datasource ID. |
| `search_tool_name` | `str \| null` | `null` | - | Target MCP search tool name (default: `"knowledge-base_search"`). |
| `fetch_tool_name` | `str \| null` | `null` | - | Target MCP document fetch tool name (default: `"knowledge-base_fetch_document"`). |
| `dynamic_tool` | `bool` | `false` | - | Provision ephemeral MCP custom search tool before eval and delete after. |
| `semantic_weight` | `float` | `0.5` | `0.0 .. 1.0` | Semantic hybrid search weight for ephemeral dynamic MCP tool. |
| `tool_description` | `str \| null` | `null` | - | Custom description for ephemeral MCP search tool presented to agent. |
| `extra_filters` | `dict` | `{}` | - | Additional metadata filters applied to RAG search queries. |
| `prompt_style` | `str \| null` | `"generation"` | - | Prompt style (`"generation"`, `"short"`, `"agentic_generation"`, `"agentic_short"`, custom). |
| `prompt_args` | `dict` | `{}` | - | Dynamic key-value dictionary for prompt template variable substitution. |
| `owner_team` | `str \| null` | `null` | - | Team slug written to OpenFGA to grant team members reader access. |
| `visibility` | `str \| null` | `"private"` | `"private"` \| `"team"` \| `"public"` | Resource visibility controlling OpenFGA reader tuple scoping. |
| `experiment_name` | `str \| null` | `null` | - | Custom experiment label to group runs and prefix trace logs. |
| `max_items` | `int \| null` | `null` | `ge=1` | Maximum total evaluation items to process. |
| `limit_per_category` | `int \| null` | `null` | `ge=1` | Limit items per dataset category. |
| `top_k` | `int` | `3` | `ge=1` | Number of context documents to retrieve from RAG server. |
| `max_context_chars` | `int` | `12000` | `ge=100` | Max context characters passed to LLM evaluator. |
| `llm_model` | `str \| null` | `null` | - | Custom LLM model name (e.g., `"gpt-4o"`). |
| `agentic` | `bool` | `true` | - | Route queries through CAIPE dynamic agents streaming gateway. |
| `agent_id` | `str \| null` | `null` | - | Target CAIPE agent ID for agentic RAG evaluation (defaults to `CAIPE_AGENT_ID` env var or `"hello-world"`). |
| `fail_on_error` | `bool` | `false` | - | Fail job loudly if a single query fails. |
| `oracle_retrieval` | `bool` | `false` | - | Enable question + reference ground truth retrieval. |
| `gate` | `bool` | `false` | - | Apply pass/fail quality gate check to results. |
| `force_rerun` | `bool` | `false` | - | Bypass 24-hour deduplication cache and force rerun. |
| `question_ids` | `list[str] \| null` | `null` | - | List of specific question IDs to evaluate. |
| `question_indices` | `list[int] \| null` | `null` | - | List of question indices (or range expressions like `"1-5,10"`) to evaluate. |

#### Request JSON Example

```json
{
  "dataset_name": "enterprise",
  "datasource_id": "enterprise_rag_bench_deepeval",
  "owner_team": "platform-engineering",
  "visibility": "team",
  "experiment_name": "exp-hybrid-50-50",
  "answer_mode": "generate",
  "top_k": 3,
  "max_items": 5,
  "max_context_chars": 6000,
  "force_rerun": false
}
```

---

### `JobResponse` (Response Schema)

Returned by `POST /eval/jobs`, `POST /eval/jobs/upload`, `GET /jobs`, and `GET /jobs/{job_id}`.

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `job_id` | `str` | UUID v4 string identifying the evaluation job. |
| `status` | `JobStatusEnum` | Current status (`"pending"`, `"running"`, `"completed"`, `"failed"`). |
| `created_at` | `float` | Unix timestamp of job creation. |
| `completed_at` | `float \| null` | Unix timestamp of job completion (or `null` if pending/running). |
| `cached` | `bool` | `true` if job result was retrieved from 24-hour deduplication cache. |
| `eval_hash` | `str` | 16-character SHA-256 evaluation fingerprint. |
| `error` | `str \| null` | Error traceback or message if job status is `"failed"`. |
| `config_args` | `dict` | Configuration parameters and dataset details (dataset_name, question_set_id, max_items, top_k, prompt_style, etc.). |
| `user_info` | `dict \| null` | Authenticated user context (`subject`, `email`, `role`). |

#### Response JSON Example

```json
{
  "job_id": "c7a8b9e0-1234-4567-89ab-cdef01234567",
  "status": "pending",
  "created_at": 1784683200.0,
  "completed_at": null,
  "cached": false,
  "eval_hash": "a1b2c3d4e5f67890",
  "error": null,
  "config_args": {
    "dataset_name": "Enterprise RAG Bench",
    "question_set_id": 1,
    "max_items": 10,
    "top_k": 3,
    "prompt_style": "generation",
    "answer_mode": "generate"
  },
  "user_info": {
    "subject": "service-account-key",
    "email": "service-account@deepeval",
    "role": "admin"
  }
}
```

---

### `EvaluationResultsResponse` (Full Results Schema)

Returned by `GET /jobs/{job_id}/results?format=json`.

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `job_id` | `str` | Job UUID. |
| `status` | `JobStatusEnum` | Job status (`"completed"`). |
| `created_at` | `float` | Job creation timestamp. |
| `completed_at` | `float \| null` | Job completion timestamp. |
| `cached` | `bool` | Cache hit boolean flag. |
| `eval_hash` | `str` | Evaluation fingerprint hash. |
| `evaluation_time` | `float` | Total duration of LLM evaluation run in seconds. |
| `config_args` | `dict` | Sanitized evaluation parameters used for run. |
| `summary` | `dict` | Aggregated evaluation metrics summary (overall score, pass rates, latency). |
| `results` | `list[dict]` | Per-question detail objects (query, actual output, expected output, metrics). |
| `user_info` | `dict \| null` | Identity details of submitter. |

#### Response JSON Example

```json
{
  "job_id": "c7a8b9e0-1234-4567-89ab-cdef01234567",
  "status": "completed",
  "created_at": 1784683200.0,
  "completed_at": 1784683245.5,
  "cached": false,
  "eval_hash": "a1b2c3d4e5f67890",
  "evaluation_time": 45.5,
  "config_args": {
    "dataset_name": "enterprise",
    "answer_mode": "generate",
    "top_k": 3,
    "max_items": 5
  },
  "summary": {
    "total_items": 5,
    "evaluation_time_seconds": 45.5,
    "p50_latency": 1.25,
    "p95_latency": 2.10,
    "total_tokens": 3665,
    "metrics": {
      "faithfulness": 0.95,
      "answer_relevancy": 0.92,
      "retrieval_recall": 1.0,
      "retrieval_precision": 0.88
    },
    "deepeval_evaluator_usage": {
      "evaluation_time_seconds": 45.5,
      "prompt_tokens": 28317,
      "completion_tokens": 3477,
      "total_tokens": 31794
    }
  },
  "results": [
    {
      "question_id": "q1",
      "category": "confluence",
      "level": "intermediate",
      "user_input": "What is the security compliance process?",
      "reference": "Quarterly audits and SOC2 verification.",
      "actual_output": "The security compliance process involves quarterly audits...",
      "context": "Ground truth context documentation...",
      "retrieved_contexts": [
        "Retrieved context chunk 1...",
        "Retrieved context chunk 2..."
      ],
      "expected_doc_ids": ["doc_sec_1"],
      "retrieved_doc_ids": ["doc_sec_1"],
      "latency": 1.25,
      "metrics": {
        "faithfulness": 0.96,
        "answer_relevancy": 0.94
      }
    }
  ],
  "user_info": {
    "subject": "service-account-key",
    "email": "service-account@deepeval",
    "role": "admin"
  }
}
```

---

## API Endpoints Reference

| Method | Path | Summary | Auth Required | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/health` | Health Check | No | Check server health status (`{"status": "healthy"}`). |
| `POST` | `/eval/jobs` | Submit Evaluation Job | Yes | Submit async evaluation job with JSON request body. |
| `POST` | `/eval/jobs/upload` | Submit Job with Dataset File | Yes | Upload dataset file (`.json`, `.csv`, `.jsonl`) via `multipart/form-data`. |
| `POST` | `/eval/jobs/question-sets/{set_id}` | Submit Job for Question Set | Yes | Submit async evaluation job targeting a Question Set in PostgreSQL. |
| `GET` | `/jobs` | List Evaluation Jobs | Yes | List all submitted jobs and status (filtered by ReBAC permissions). |
| `GET` | `/jobs/{job_id}` | Poll Job Status | Yes | Poll execution state of a specific job ID. |
| `PATCH` | `/jobs/{job_id}/visibility` | Update Job Visibility | Yes | Update visibility (`private`, `team`, `public`) and owning team in OpenFGA. |
| `GET` | `/jobs/{job_id}/results` | Get Job Results | Yes | Download evaluation results in JSON or CSV format (`?format=json\|csv`). |
| `GET` | `/jobs/{job_id}/summary` | Get Job Summary | Yes | Retrieve lightweight aggregated metric summary without full question details (`?format=json\|csv`). |
| `POST` | `/jobs/{job_id}/save-db` | Save Results to Database | Yes | Manually persist completed job results to PostgreSQL DB on demand. |
| `GET` | `/results/db` | Query Database Runs | Yes | Retrieve recent evaluation runs stored in PostgreSQL DB. |
| `GET` | `/results/db/{run_id}` | Query Run Details by ID | Yes | Retrieve per-question results for a specific historical run from PostgreSQL. |

---

### Endpoint Details & Curl Examples

#### 1. Submit Evaluation Job (JSON)

- **HTTP Method**: `POST`
- **Path**: `/eval/jobs`
- **Headers**: `Content-Type: application/json`, `Authorization: Bearer <TOKEN>` (or `X-API-Key`)

```bash
curl -X POST "http://localhost:8000/eval/jobs" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: secret-key-123" \
  -d '{
    "dataset_name": "enterprise",
    "datasource_id": "enterprise_rag_bench_deepeval",
    "owner_team": "platform-engineering",
    "visibility": "team",
    "answer_mode": "generate",
    "top_k": 3,
    "max_items": 5,
    "force_rerun": false
  }'
```

---

#### 2. Submit Job with Dataset File Upload

- **HTTP Method**: `POST`
- **Path**: `/eval/jobs/upload`
- **Content-Type**: `multipart/form-data`
- **Query Parameters**:
  - `dataset_name` (string, default: `"custom_upload"`)
  - `top_k` (int, default: `3`)
  - `max_items` (int, optional)
  - `force_rerun` (bool, default: `false`)

```bash
curl -X POST "http://localhost:8000/eval/jobs/upload?dataset_name=my_benchmark&top_k=3" \
  -H "X-API-Key: secret-key-123" \
  -F "file=@my_questions.json"
```

---

#### 3. Submit Evaluation Job for Stored Question Set

- **HTTP Method**: `POST`
- **Path**: `/eval/jobs/question-sets/{set_id}`
- **Headers**: `Content-Type: application/json`, `Authorization: Bearer <TOKEN>` (or `X-API-Key`)

```bash
curl -X POST "http://localhost:8000/eval/jobs/question-sets/1" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: secret-key-123" \
  -d '{
    "top_k": 3,
    "max_items": 10,
    "agentic": true
  }'
```

---

#### 4. List Evaluation Jobs

- **HTTP Method**: `GET`
- **Path**: `/jobs`

```bash
curl -H "X-API-Key: secret-key-123" "http://localhost:8000/jobs"
```

---

#### 5. Poll Job Status

- **HTTP Method**: `GET`
- **Path**: `/jobs/{job_id}`

```bash
curl -H "X-API-Key: secret-key-123" \
  "http://localhost:8000/jobs/c7a8b9e0-1234-4567-89ab-cdef01234567"
```

---

#### 6. Update Job Visibility & Team Ownership

- **HTTP Method**: `PATCH`
- **Path**: `/jobs/{job_id}/visibility`
- **Headers**: `Content-Type: application/json`, `Authorization: Bearer <TOKEN>` (or `X-API-Key`)

```bash
curl -X PATCH "http://localhost:8000/jobs/c7a8b9e0-1234-4567-89ab-cdef01234567/visibility" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: secret-key-123" \
  -d '{
    "visibility": "team",
    "owner_team": "platform-engineering"
  }'
```

---

#### 7. Retrieve Job Results (JSON / CSV)

- **HTTP Method**: `GET`
- **Path**: `/jobs/{job_id}/results`
- **Query Parameter**: `format=json` (default) or `format=csv`

##### Fetch JSON Results:

```bash
curl -H "X-API-Key: secret-key-123" \
  "http://localhost:8000/jobs/c7a8b9e0-1234-4567-89ab-cdef01234567/results?format=json"
```

##### Download CSV Report:

```bash
curl -H "X-API-Key: secret-key-123" \
  -o evaluation_report.csv \
  "http://localhost:8000/jobs/c7a8b9e0-1234-4567-89ab-cdef01234567/results?format=csv"
```

---

#### 8. Retrieve Job Summary (JSON / Single-Row CSV)

- **HTTP Method**: `GET`
- **Path**: `/jobs/{job_id}/summary`
- **Query Parameter**: `format=json` (default) or `format=csv`

Returns aggregated run metrics (averages, pass rates, latency) without the full list of question results, ideal for dashboards and automated pipelines.

```bash
curl -H "X-API-Key: secret-key-123" \
  "http://localhost:8000/jobs/c7a8b9e0-1234-4567-89ab-cdef01234567/summary?format=json"
```

---

#### 9. Save Results to PostgreSQL DB

- **HTTP Method**: `POST`
- **Path**: `/jobs/{job_id}/save-db`

```bash
curl -X POST -H "X-API-Key: secret-key-123" \
  "http://localhost:8000/jobs/c7a8b9e0-1234-4567-89ab-cdef01234567/save-db"
```

---

#### 10. Query PostgreSQL Database Runs

- **HTTP Method**: `GET`
- **Path**: `/results/db`
- **Query Parameter**: `limit=10` (default: `10`, range: `1..100`)

```bash
curl -H "X-API-Key: secret-key-123" \
  "http://localhost:8000/results/db?limit=5"
```

---

#### 11. Query Historical Run Details by Run ID

- **HTTP Method**: `GET`
- **Path**: `/results/db/{run_id}`

Fetches per-question evaluation results for a specific historical evaluation run stored in PostgreSQL.

```bash
curl -H "X-API-Key: secret-key-123" \
  "http://localhost:8000/results/db/exp-2026-07-23-001"
```

##### Response JSON:

```json
{
  "count": 1,
  "runs": [
    {
      "experiment_id": "exp-2026-07-23-001",
      "timestamp": "2026-07-23T18:00:00Z",
      "datasource": "enterprise",
      "evaluation_time": 45.5,
      "total_questions": 5,
      "passed_questions": 5,
      "pass_rate": 1.0,
      "avg_faithfulness": 0.95
    }
  ]
}
```

---

## Error Handling & HTTP Status Codes

The API returns standard HTTP status codes and JSON error objects formatted as `{"detail": "<error message>"}`.

| Code | Reason | Common Causes |
| :--- | :--- | :--- |
| `200 OK` | Request succeeded | Results returned or DB query succeeded. |
| `202 Accepted` | Job accepted | Asynchronous job submitted and queued in background. |
| `400 Bad Request` | Invalid input | Validation error in parameters (`max_items < 1`), unsupported format, or empty file upload. |
| `401 Unauthorized` | Authentication failed | Missing or invalid Bearer token / `X-API-Key`. |
| `404 Not Found` | Resource not found | Specified `job_id` does not exist. |
| `500 Internal Server Error` | Backend execution error | Job evaluation failed or PostgreSQL DB query error. |

---

## Python Integration SDK Example

You can interact with the REST API using Python's `httpx` or `requests` library:

```python
import time
import httpx

API_BASE_URL = "http://localhost:8000"
API_KEY = "secret-key-123"
headers = {"X-API-Key": API_KEY}

with httpx.Client(base_url=API_BASE_URL, headers=headers) as client:
    # 1. Submit evaluation job
    response = client.post("/eval/jobs", json={
        "dataset_name": "enterprise",
        "top_k": 3,
        "max_items": 5
    })
    job_info = response.json()
    job_id = job_info["job_id"]
    print(f"Submitted job {job_id}, status: {job_info['status']}")

    # 2. Poll until completed or failed
    while True:
        status_resp = client.get(f"/jobs/{job_id}").json()
        current_status = status_resp["status"]
        print(f"Job {job_id} status: {current_status}")

        if current_status in ("completed", "failed"):
            break
        time.sleep(2)

    # 3. Fetch full JSON results
    if current_status == "completed":
        results_resp = client.get(f"/jobs/{job_id}/results?format=json").json()
        print("Summary:", results_resp["summary"])

---

## Question Sets & Questions Management API (`/api/v1/question-sets`)

The `/api/v1/question-sets` endpoints allow managing question sets and individual question items stored in PostgreSQL.

### Endpoints Overview

| Method | Endpoint Path | Description |
| :--- | :--- | :--- |
| `POST` | `/eval/jobs` | Submit an async evaluation job (accepts `question_set_id` in JSON body). |
| `POST` | `/eval/jobs/question-sets/{set_id}` | Submit an async evaluation job targeting a Question Set stored in PostgreSQL database. |
| `POST` | `/api/v1/question-sets` | Create a new question set (blank or initialized from `.jsonl`, `.csv`, `.json` file upload). |
| `GET` | `/api/v1/question-sets` | List question sets with pagination (`page`, `limit`) and search query (`query`). |
| `GET` | `/api/v1/question-sets/{set_id}` | Get question set details, total question count, and category breakdown. |
| `PUT` | `/api/v1/question-sets/{set_id}` | Update question set metadata (`name`, `description`, `source_format`). |
| `DELETE` | `/api/v1/question-sets/{set_id}` | Delete a question set and cascade-delete all associated questions. |
| `POST` | `/api/v1/question-sets/{set_id}/questions` | Add single or multiple questions via REST JSON body. |
| `POST` | `/api/v1/question-sets/{set_id}/questions/upload` | Add questions via file upload (`.jsonl`, `.csv`, `.json`). |
| `GET` | `/api/v1/question-sets/{set_id}/questions` | List questions in a set with pagination, category/level filters, and text query search. |
| `GET` | `/api/v1/question-sets/{set_id}/questions/{qid}` | Fetch a single question by database `id` or string `question_id`. |
| `PUT` | `/api/v1/question-sets/{set_id}/questions/{qid}` | Edit a question in a set. |
| `DELETE` | `/api/v1/question-sets/{set_id}/questions/{qid}` | Delete a single question from a set. |
| `POST` | `/api/v1/question-sets/{set_id}/questions/batch-delete` | Batch delete questions by a list of IDs. |
| `GET` | `/api/v1/question-sets/{set_id}/export` | Export question set as `.jsonl` or `.csv` file download (`format=jsonl|csv`). |

### Data Model & Column Conventions

In PostgreSQL and across API DTOs, evaluation questions are stored with dedicated top-level columns:

| Column / Field | Type | Description |
| :--- | :--- | :--- |
| `question_id` | `TEXT` | Unique identifier string for the question within the set (e.g. `"qst_0001"`). |
| `input` / `user_input` | `TEXT` | Prompt or query input text (required). |
| `expected_output` / `reference` | `TEXT` | Ground truth reference answer. |
| `category` | `TEXT` | Domain, datasource, or scenario category (e.g. `"confluence"`, `"basic"`). |
| `level` | `TEXT` | Difficulty level classification (e.g. `"easy"`, `"medium"`, `"hard"`). |
| `expected_doc_ids` | `TEXT[]` | Ground truth source document IDs required for retrieval metric scoring (Recall, Precision, MRR, nDCG). |
| `context` | `JSONB` | Optional ground truth or reference context chunks. |
| `extra` | `JSONB` | Additional custom metadata (e.g. `supporting_facts`, `answer_facts`, `source_types`). |

#### Handling `additional_metadata` Sub-Dictionaries

External benchmark datasets (e.g. standard Ragas datasets or synthetic generation pipelines) often nest metadata under `additional_metadata: {...}`. When questions are added (via API or file upload):

- `category`, `level`, `expected_doc_ids`, and `context` are **unpacked** into their designated top-level SQL columns if they are not already set at the root level.
- Non-column fields (such as `supporting_facts`, `answer_facts`, etc.) remain safely preserved in the `extra` JSONB column.

This ensures retrieval metrics receive the required `expected_doc_ids` while preserving custom metadata for analysis.

### Shell Scripts
- **Submit Evaluation Job for DB Question Set**: [`scripts/send_eval_request_question_set.sh`](../scripts/send_eval_request_question_set.sh)
- **Upload / Ingest Question Set**: [`scripts/upload_question_set.sh`](../scripts/upload_question_set.sh)
- **List Question Sets / Questions**: [`scripts/list_question_sets.sh`](../scripts/list_question_sets.sh)

---

## Prompt Styles Management API (`/api/v1/prompt-styles`)

The `/api/v1/prompt-styles` endpoints manage custom and system prompt styles stored in PostgreSQL for post-retrieval and agentic answer generation.

### Endpoints Overview

| Method | Endpoint Path | Auth Requirement | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/prompt-styles` | Authenticated | List accessible prompt styles (filtered by app-level visibility: public, team, private). |
| `GET` | `/api/v1/prompt-styles/{name}` | Authenticated | Fetch prompt style details and template by unique name/slug. |
| `POST` | `/api/v1/prompt-styles` | **Admin Only** (`Role.ADMIN`) | Create / upload a new custom prompt style template. |
| `PUT` | `/api/v1/prompt-styles/{name}` | **Admin Only** (`Role.ADMIN`) | Update an existing custom prompt style template, description, or visibility. |
| `DELETE` | `/api/v1/prompt-styles/{name}` | **Admin Only** (`Role.ADMIN`) | Delete a custom prompt style (system styles are immutable and read-only). |

> [!NOTE]
> **Admin Authorization Guard**: Prompt style creation (`POST`), modification (`PUT`), and deletion (`DELETE`) are restricted strictly to users with the **`admin`** role via `require_role(Role.ADMIN)`. Standard users (`evaluator`, `readonly`) may read and list styles based on visibility rules. System-seeded styles cannot be modified or deleted.
