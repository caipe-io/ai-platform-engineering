# Upstream CAIPE Changes Required to Support the Evaluator

This document lists all changes required in upstream CAIPE services (outside the evaluator codebase) to support evaluator features. For each requirement, the triggering evaluator feature and the precise API contract expected are described.

---

## 1. RAG Server (`rag/server`)

### 1.1 Custom MCP Tool Lifecycle Endpoints

**Evaluator feature**: Dynamic ephemeral MCP tool provisioning (`dynamic_tool=true` in `EvaluationRequest`).

**Code**: `clients/mcp_tool_manager.py`

The evaluator calls two RAG Server endpoints to create and delete ephemeral MCP search tools:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/mcp/custom-tools` | Create ephemeral tool |
| `DELETE` | `/v1/mcp/custom-tools/{tool_id}` | Delete ephemeral tool |

**Required `POST /v1/mcp/custom-tools` request body**:

```json
{
  "tool_id": "eval-<16-char-run-id>",
  "description": "<tool description shown to the LLM agent>",
  "parallel_searches": [
    {
      "label": "results",
      "datasource_ids": ["<datasource_id>"],
      "semantic_weight": 0.5,
      "extra_filters": {}
    }
  ],
  "allow_runtime_filters": true,
  "shared_with_org": true,
  "enabled": true,
  "expires_at": 1750000000
}
```

**Required behaviour**:
- `POST` must be idempotent — if `tool_id` already exists, upsert or return success.
- `DELETE` is best-effort: non-`2xx` responses are logged as warnings, not errors.
- Tools must expire automatically at `expires_at` (evaluator sets a 2-hour TTL by default).
- Tools created with `shared_with_org: true` must be visible to agents via MCP server discovery.
- The tool must register the `tool_id` (e.g. `eval-<run_id>`) as a callable MCP tool the dynamic agents supervisor can invoke.

---

### 1.2 `POST /v1/query` — Metadata Filter Support

**Evaluator feature**: `extra_filters` in `EvaluationRequest`; `datasource_id` scoping.

**Code**: `clients/search_rag.py::query_raw`

```
POST /v1/query
{
  "query": "<question text>",
  "limit": <top_k>,
  "filters": {
    "datasource_id": "<datasource_id>",
    "<extra_filter_key>": "<extra_filter_value>"
  }
}
```

**Required behaviour**:
- `filters.datasource_id` must scope results to a single datasource.
- Additional keys in `filters` (from `extra_filters`) must be treated as metadata column filter predicates.
- Response must be either a `list` of result dicts or `{"results": [...]}`.
- Each result must expose `document.page_content` (or `page_content`/`content`) and `document.metadata.document_id`.

---

### 1.3 `POST /v1/query` — `document_id` in Response Metadata

**Evaluator feature**: Retrieval recall and precision metrics.

**Required response shape** per result item:

```json
{
  "document": {
    "page_content": "<text chunk>",
    "metadata": {
      "document_id": "<stable-document-id>",
      "title": "<optional>",
      "metadata": {
        "source_type": "<optional>"
      }
    }
  },
  "score": 0.92
}
```

**Required behaviour**: `document.metadata.document_id` must be a stable, queryable identifier. The evaluator uses it to compute recall/precision vs the question's `expected_doc_ids`.

---

### 1.4 Ingestion Endpoints

**Evaluator feature**: Benchmark corpus ingestion.

The evaluator drives the ingestion pipeline via these endpoints in sequence:

| Step | Method | Path | Description |
|---|---|---|---|
| 1 | `POST` | `/v1/ingestor/heartbeat` | Register ingestor; receive `ingestor_id` and batch limit |
| 2 | `DELETE` | `/v1/datasource?datasource_id=<id>` | Optional reset of existing datasource |
| 3 | `POST` | `/v1/datasource` | Create/upsert datasource record |
| 4 | `POST` | `/v1/job?datasource_id=<id>&job_status=in_progress` | Open ingestion job |
| 5 | `POST` | `/v1/ingest` | Send document batches |
| 6 | `POST` | `/v1/job/{job_id}/increment-document-count` | Update counter per batch |
| 7 | `POST` | `/v1/job/{job_id}/increment-progress` | Update progress |
| 8 | `PATCH` | `/v1/job/{job_id}?job_status=completed` | Close job |

All calls use Bearer token auth (static or `client_credentials`).

---

## 2. Next.js BFF

### 2.1 Conversation Creation Endpoint

**Evaluator feature**: Agentic evaluation mode (`agentic=true`). The evaluator creates a fresh conversation session per question.

**Code**: `engine/agentic_rag.py::_query_gateway`

```
POST /api/chat/conversations
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Agentic Session",
  "client_type": "webui",
  "agent_id": "<agent_id>"
}

Response 200:
{ "id": "<conversation_id>" }
```

**Required behaviour**:
- Must return `conversation_id` (key `id`) for use in the subsequent streaming call.
- Must accept the evaluator's service account token or OBO-delegated user token.

---

### 2.2 SSE Streaming Endpoint

**Evaluator feature**: Agentic evaluation — captures `rag_context` artifacts and final answer.

**Code**: `engine/agentic_rag.py::_query_gateway`

```
POST /api/v1/chat/stream/start
Authorization: Bearer <token>
Content-Type: application/json

{
  "message": "<enriched_query with system instructions>",
  "conversation_id": "<conversation_id>",
  "agent_id": "<agent_id>",
  "protocol": "custom",
  "client_context": {
    "source": "eval",
    "tool_result_display_limit": -1
  }
}
```

**SSE event contract the evaluator depends on**:

| Event type | Data field | Evaluator consumption |
|---|---|---|
| `event: content` | `data.text` | Concatenated as the agent's final answer |
| `event: tool_end` | `data.result` (dict with `rag_context` key) | Parsed for document text and `document_id` |
| `event: tool_start` | (any) | Ignored |
| `event: done` / `[DONE]` | (any) | Signals stream completion |

**`rag_context` payload for `knowledge-base_search` tool**:

```json
{
  "results": [
    {
      "text_content": "<chunk text>",
      "snippet": "<optional>",
      "metadata": {
        "document_id": "<id>"
      }
    }
  ],
  "semantic_results": [...],
  "keyword_results": [...]
}
```

> [!IMPORTANT]
> The top-level key in the `rag_context` dict **must** end with `results` (e.g. `results`, `semantic_results`, `keyword_results`). The evaluator's `_parse_rag_context_artifact()` only processes keys matching `k.endswith("results")`. A misnamed key (e.g. `hits`, `documents`) causes empty context and zeroed retrieval metrics.

**`rag_context` payload for `knowledge-base_fetch_document` tool**:

```json
[
  {
    "document": {
      "page_content": "<full text>",
      "document_id": "<id>",
      "metadata": {}
    }
  }
]
```

**Token usage the evaluator extracts from SSE events**:

The evaluator walks `result.metadata.usage_metadata` → `resp.metadata.usage_metadata` → `artifacts[].metadata.usage_metadata`:

```json
{
  "usage_metadata": {
    "input_tokens": 1234,
    "output_tokens": 456,
    "total_tokens": 1690
  }
}
```

Aliases accepted: `prompt_tokens`, `completion_tokens`, `input_token_count`, `output_token_count`.

---

### 2.3 BFF Proxy Route for Evaluator REST API

**Evaluator feature**: Cluster deployment — evaluator REST API exposed under the CAIPE BFF.

The BFF must proxy `/api/rag-evaluator/*` → evaluator service (`http://rag-evaluator:8000/*`), preserving all headers including `Authorization`. The proxy must:

- Support `GET` and `POST` with streaming responses (for `GET /jobs/{id}/results`).
- Pass `Authorization: Bearer <token>` through unmodified.
- Not re-validate tokens (the evaluator's own OIDC middleware handles this).

---

## 3. OpenFGA

### 3.1 Authorization Model — New Object Types

**Evaluator feature**: ReBAC access control on evaluation jobs, question sets, datasources, and agents.

Required object types and relations:

| Object Type | Relations Required | Used For |
|---|---|---|
| `evaluation` | `creator`, `reader`, `manager` | Job ownership and access |
| `question_set` | `creator`, `reader`, `manager` | Question set ownership and access |
| `datasource` | `reader` | Authorize datasource access before evaluating |
| `agent` | `reader` | Authorize agent access before targeting |
| `organization` | `admin`, `member` | Admin escalation (`can_manage organization:caipe`) |

**Tuples written at job submission**:

```
(user:<subject>, creator, evaluation:<job_id>)
(team:<slug>#member, reader, evaluation:<job_id>)   -- if owner_team set
(team:<slug>#admin, manager, evaluation:<job_id>)   -- if owner_team set
(user:*, reader, evaluation:<job_id>)               -- if visibility=public
```

Same pattern for `question_set:<set_id>`.

**Checks performed at runtime**:

| Permission | Endpoint |
|---|---|
| `can_evaluate` on `organization:caipe` | `POST /eval/jobs` |
| `can_read` on `evaluation:<job_id>` | `GET /jobs/{id}`, `/jobs/{id}/results`, `/jobs/{id}/summary` |
| `can_manage` on `evaluation:<job_id>` | `POST /jobs/{id}/save-db`, `PATCH /jobs/{id}/visibility` |
| `can_read` on `question_set:<set_id>` | `GET /api/v1/question-sets/{id}`, evaluation using a set |
| `can_manage` on `question_set:<set_id>` | `PUT`, `DELETE` question set |

The evaluator also calls OpenFGA `list-objects` for listing endpoints; the authorization model must support this efficiently.

---

### 3.2 Machine Service Account Tuples

**Evaluator feature**: CI/CD M2M headless evaluation.

```bash
# Grant evaluator submit permission
fga tuple write service_account:<sa_sub_uuid> can_evaluate organization:caipe

# Grant RAG admin access for ingestion
fga tuple write service_account:<sa_sub_uuid> admin organization:caipe
```

The service account's Keycloak client must have an **Audience Protocol Mapper** for `caipe-ui` so the BFF accepts the M2M token.

---

## 4. Keycloak

### 4.1 Evaluator Service Account

**Evaluator feature**: M2M token for calling RAG Server and dynamic agents from background worker jobs.

Required configuration:
- A confidential client with `client_credentials` grant enabled.
- Env vars: `CAIPE_SA_CLIENT_ID`, `CAIPE_SA_CLIENT_SECRET`, `CAIPE_SA_TOKEN_URL`.
- **Audience Protocol Mapper** mapping `caipe-ui` into `aud` claim so BFF and RAG Server accept it.

---

### 4.2 RFC 8693 OBO Token Exchange

**Evaluator feature**: When `EVALUATOR_OBO_ENABLED=true`, background worker exchanges the original user's `subject` for a delegated bearer token.

**Code**: `auth/obo_exchange.py`

Required Keycloak configuration:
1. Enable the **Token Exchange** feature (Keycloak >= 22 or preview feature flag).
2. Configure the OBO client with `urn:ietf:params:oauth:grant-type:token-exchange` grant and `impersonation` scope.

Required environment variables:

| Env Var | Description |
|---|---|
| `EVALUATOR_OBO_ENABLED` | `true` to enable OBO mode |
| `EVALUATOR_OBO_CLIENT_ID` | OBO client ID |
| `EVALUATOR_OBO_CLIENT_SECRET` | OBO client secret |
| `EVALUATOR_OBO_TOKEN_URL` | Keycloak token endpoint |
| `EVALUATOR_OBO_AUDIENCE` | Target audience (default: `caipe-platform`) |

Token exchange request:

```
POST <EVALUATOR_OBO_TOKEN_URL>
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&requested_subject=<user_sub_uuid>
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&client_id=<EVALUATOR_OBO_CLIENT_ID>
&client_secret=<EVALUATOR_OBO_CLIENT_SECRET>
&audience=<EVALUATOR_OBO_AUDIENCE>
```

---

### 4.3 JWKS / OIDC Discovery for Evaluator API Auth

Required configuration:
- `OIDC_ISSUER_URL` — Keycloak realm URL (e.g. `https://keycloak.example.com/realms/caipe`).
- `OIDC_AUDIENCE` — `aud` claim for evaluator API users (e.g. `caipe-ui`).
- JWKS endpoint at `<OIDC_ISSUER_URL>/protocol/openid-connect/certs` must be accessible from the evaluator pod.
- Realm roles `evaluator` and `evaluator_readonly` must exist and be assignable.

---

## 5. Dynamic Agents Supervisor

### 5.1 Datasource Filter Passthrough

**Evaluator feature**: Agentic evaluation with `datasource_id` scoping.

The enriched query instructs the agent to pass `filters={"datasource_id": "<id>"}` to `knowledge-base_search`. The supervisor must relay this argument to the MCP tool unchanged.

### 5.2 `usage_metadata` in SSE Artifacts

**Evaluator feature**: Token usage tracking in agentic mode.

The supervisor must emit token usage in at least one location in the SSE stream:

```json
{
  "result": {
    "metadata": {
      "usage_metadata": {
        "input_tokens": 1234,
        "output_tokens": 456,
        "total_tokens": 1690
      }
    }
  }
}
```

Without this, the evaluator reports `0` for all token counts in agentic runs.

### 5.3 Agent Availability

The agent identified by `agent_id` (default `hello-world`) must be registered and active in the supervisor. The evaluator does not pre-check agent availability; a missing agent silently produces empty context.

---

## 6. PostgreSQL (`caipe_eval` Database)

The upstream platform must provision a PostgreSQL instance accessible to the evaluator with:
- A dedicated database (or schema) accessible to `POSTGRES_USER`.
- The evaluator initialises its own schema at startup — no manual DDL needed.

Tables created by the evaluator: `evaluation_runs`, `evaluation_results`, `eval_job_queue`, `question_sets`, `questions`, `prompt_styles`.

Connection env vars:

| Env Var | Description |
|---|---|
| `DATABASE_URL` / `POSTGRES_DSN` | Full DSN (preferred) |
| `POSTGRES_HOST` | Host |
| `POSTGRES_PORT` | Port (default: 5432) |
| `POSTGRES_DB` | Database name (default: `evaluator`) |
| `POSTGRES_USER` | User |
| `POSTGRES_PASSWORD` | Password |
| `PGSSLMODE` | SSL mode (default: `prefer`) |

---

## Quick-Reference Matrix

| Evaluator Feature | RAG Server | BFF | OpenFGA | Keycloak | Dynamic Agents | PostgreSQL |
|---|---|---|---|---|---|---|
| Standard evaluation (non-agentic) | `/v1/query` + filters | — | datasource `can_read` | SA credentials | — | Results sink |
| Agentic evaluation | — | conversations + SSE stream | agent `can_read` | SA credentials | agent active + filter passthrough | Results sink |
| Dynamic MCP tool | `/v1/mcp/custom-tools` CRUD | — | — | SA token | Tool registered in supervisor | — |
| File ingestion | All ingestion endpoints | — | — | SA credentials | — | — |
| REST API auth (human) | — | — | `can_evaluate` on org | JWKS + realm roles | — | Job queue |
| REST API auth (M2M) | — | — | SA tuples | SA + audience mapper | — | Job queue |
| OBO token exchange | — | Accepts OBO token | — | OBO grant enabled | — | — |
| ReBAC ownership | — | — | All ownership tuples | — | — | — |
| CI/CD quality gate | — | — | SA tuples | SA client | — | — |
