---
sidebar_position: 5
---

# RAG & Knowledge Bases API

Reference for the **CAIPE RAG server** (FastAPI) and the **Next.js UI Backend API** routes that proxy or extend RAG functionality. The RAG server validates **Bearer JWT** access tokens (OIDC / Keycloak) via JWKS, uses human tokens as identity-only inputs, and enforces KB/datasource authorization through OpenFGA when enterprise RBAC is enabled.

**Role model (RAG server):** human users get an authenticated `readonly` baseline and resource access comes from OpenFGA. `ingestonly` and `admin` remain service-client roles for client-credentials callers. Trusted-network detection is telemetry only and does not authenticate requests.

**Common error shapes (RAG server):**

| Status | Meaning |
|--------|---------|
| `401` | Missing/invalid `Authorization: Bearer`, or malformed header |
| `403` | Authenticated but insufficient role, datasource/KB denied, or CEL policy denied |
| `404` | Resource not found |
| `409` | Conflict (e.g. duplicate MCP `tool_id`, reserved tool id) |
| `502` | UI Backend API only: upstream RAG server unreachable |

---

## UI Backend API proxy routes (UI → RAG / MongoDB)

### GET|POST|PUT|DELETE `/api/rag/[...path]`

**Auth:** NextAuth session (OIDC); UI Backend API forwards `Authorization: Bearer <accessToken>` and optional `X-Tenant-Id` from session. **Service:** CAIPE UI (UI Backend API) → RAG server.

Catch-all proxy: the path after `/api/rag/` is joined and requested against `RAG_SERVER_URL` or `NEXT_PUBLIC_RAG_URL` (default `http://localhost:9446`). Query string is forwarded on GET and DELETE. JSON body is forwarded on POST and PUT when present.

**Example:** `GET /api/rag/v1/datasources` → `GET {RAG_SERVER_URL}/v1/datasources` with Bearer token.

**Headers forwarded (typical):**

- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`
- `X-Tenant-Id` — when session includes org/tenant

**Response `502` (UI Backend API):**

```json
{
  "error": "Failed to connect to RAG server",
  "details": "TypeError: fetch failed"
}
```

---

### GET|POST|PUT|DELETE `/api/rag/kb/[...path]`

**Auth:** NextAuth session + **Keycloak AuthZ** permission on resource `rag`: `kb.query` (GET), `kb.ingest` (POST), `kb.admin` (PUT/DELETE). **Service:** CAIPE UI (UI Backend API) → RAG server.

Same forwarding rules as the catch-all proxy, but each method is gated by enterprise RBAC (FR-015). Forwards `Authorization`, `X-Tenant-Id`, and `X-Team-Id` when derived from the access token for team-scoped KB resolution on the RAG server.

**Errors:**

- `401` — `{ "error": "Unauthorized" }` if no session user
- `403` — from `requireRbacPermission` when AuthZ denies the scope

**Target URL:** `{RAG_SERVER_URL}/{pathSegments joined}` — e.g. `POST /api/rag/kb/v1/ingest` → `POST {RAG}/v1/ingest`.

---

## RAG collections

A RAG collection is a control-plane grouping of datasource IDs. It does not
copy chunks or create another Milvus collection. Datasource ingestion,
scheduled reload, and stale-chunk replacement continue to operate on the
original `datasource_id`.

Collection authorization is intentionally split into the same two concepts the
UI uses everywhere: **Owner** and **Search**. The API and OpenFGA model retain
the internal relation names for compatibility:

- Search (`reader`) can query member datasources. It never permits ingestion,
  reloads, or configuration changes.
- Owner members (`publisher`) can add or remove member datasources.
- Owner admins (`manager`) can edit collection settings.
- Adding a datasource requires Owner access to that datasource.
- Owner access does not imply Search access.
- A new personal collection gives its owner a separate Search grant. It may
  include only datasources that owner can already manage and query.
- Only organization admins can delegate Owner teams. Collection Owners can
  propose Search teams or global Search; publication policy decides whether
  the change is immediate or remains pending for an approver.

### GET `/api/rag/collections`

**Auth:** Session or Bearer JWT. **Service:** UI Backend API → MongoDB + OpenFGA.

Returns collections the caller may read, publish, or manage. Each row includes:

```json
{
  "_id": "platform-rag",
  "name": "Platform RAG",
  "is_platform": true,
  "source_ids": ["source-a", "source-b"],
  "maintainer_team_slugs": ["knowledge-maintainers"],
  "reader_team_slugs": ["all-users"],
  "global_read": false,
  "_permissions": {
    "can_read": true,
    "can_publish": false,
    "can_manage": false,
    "can_delegate": false
  }
}
```

### POST `/api/rag/collections`

Creates a personal collection. Service-account callers are rejected.

```json
{
  "name": "Team runbooks",
  "description": "Curated operational knowledge"
}
```

### GET|PATCH|DELETE `/api/rag/collections/{collectionId}`

- `GET` requires collection discovery access.
- `PATCH source_ids` requires collection membership access and datasource Owner
  access for additions.
- `PATCH name|description` requires collection management.
- `PATCH maintainer_team_slugs` requires organization administration.
- `PATCH reader_team_slugs|global_read` requires collection management. New
  audiences and company-wide audience removals go through the
  publication-approval policy. Current company-wide Search remains active
  while removal is pending.
- Adding a Search team also grants that team the coarse organization search
  capability. Removing Search does not revoke a capability that may still be
  used by another collection; datasource relationships remain authoritative.
- `DELETE` requires collection management, preserves indexed data, and removes
  stale agent references. `platform-rag` cannot be deleted.

### Agent and service-account behavior

- Direct Search/API calls use every datasource for which the caller has Search
  access.
- An agent stores optional `datasource_ids` and `rag_collection_ids`.
- Collection membership is expanded from MongoDB at each RAG tool call, then
  unioned with direct datasource pins.
- The RAG server intersects that union with the caller's current OpenFGA
  datasource access. Agent configuration can narrow access; it never grants it.
- Explicit empty arrays disable the agent's RAG tools. Missing fields are a
  temporary legacy state used only before migration.
- Service accounts can receive a collection or an individual datasource in the
  existing scope editor. Collection membership is inherited live, so changing
  the collection does not require editing each service account. Calls still
  require an assigned agent/tool as applicable.

### Legacy global-RAG migration

Admin → Settings → RAG migrates the current global corpus into `platform-rag`:

- Every unscoped datasource from the legacy global corpus becomes a Platform
  RAG member. New personal/team-scoped direct sources are excluded, including
  source types such as local-file uploads that do not have a Mongo config row.
- One selected team becomes Owner of the legacy source configuration.
- One selected team receives Platform RAG Search access and the organization
  search capability.
- Existing RAG-enabled agents with no explicit pins are attached to Platform
  RAG. Existing explicit empty selections remain opt-outs.
- Supported connector settings are adopted into MongoDB; unsupported legacy
  connectors remain usable and managed through their existing ingestors.
- The migration is retry-safe and does not replace later datasource grants or
  publish newly created scoped sources.

---

## Publication approvals

The UI Backend API uses one durable approval workflow for broader RAG Search
publication and self-service Slack or Webex onboarding.

- Creating and ingesting a personal or Owner-team datasource remains immediate.
- Search grants already in effect remain active while an expansion is pending.
- Ordinary Search revocations take effect immediately. Removing a configured
  company-wide audience requires approval, and its existing access remains
  active until approval.
- Removing a datasource from a company-wide collection follows the same rule.
- Adding a person or team outside the Owner scope creates a pending request.
- Material datasource changes require renewed approval while broad Search is
  active. These include ownership, source identity, URL/domain, crawl scope,
  and large estimated-size changes.
- Slack channels and Webex spaces remain unavailable until their onboarding
  request is approved and applied.
- Each request stores requested and effective state, the resource revision,
  risk facts, status, and append-only decision history, including the approver.
- Approval application uses a short-lived OpenFGA capability bound to the exact
  request and resource. A stale resource revision fails closed instead of
  applying an obsolete decision.

Approvers use **Admin → Security & Policy → Approvals**. RAG, Slack, and Webex
have separate reviewer lists. Trusted publishers, company-wide audiences,
self-approval, and team-specific reviewers apply only to RAG.

### GET `/api/publication-requests`

Lists requests visible to the caller. Delegated approvers see requests for
their assigned target teams; organization admins see all requests.

Optional query parameters:

- `status`: comma-separated request statuses
- `kind`: comma-separated resource kinds
- `mine=true`: requests submitted by the caller
- `limit`: bounded result count

### POST `/api/publication-requests/{id}/approve`

Atomically claims a pending request, verifies the live resource revision, and
invokes the matching RAG, Slack, or Webex adapter. Organization-wide
self-approval is denied by default.

### POST `/api/publication-requests/{id}/reject`

Rejects a pending request without changing its effective state. An optional
JSON `note` is recorded in the audit history.

### GET|PATCH `/api/publication-requests/settings`

Reads or updates approval policy. Organization-administrator access is
required.

### GET `/api/publication-requests/summary`

Returns the caller's pending count and whether they can approve requests or
manage approval settings. The application header uses this endpoint for its
approval alert.

---

### GET `/api/rag/tools`

**Auth:** Session + Keycloak AuthZ `rag#tool.view`. **Service:** CAIPE UI (MongoDB; not proxied to RAG).

Lists team-scoped RAG tool documents from collection `team_rag_tools`, filtered by tenant and team membership (or all tenant tools for `admin` / `kb_admin`).

**Response `200`:**

```json
{
  "tools": [
    {
      "tool_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "tenant_id": "acme",
      "team_id": "platform",
      "name": "Platform runbooks",
      "description": "Search internal runbooks",
      "datasource_ids": ["src_web___docs_example_com"],
      "created_by": "sub-or-email",
      "updated_at": "2026-03-25T12:00:00.000Z",
      "status": "active"
    }
  ]
}
```

---

### POST `/api/rag/tools`

**Auth:** Session + Keycloak AuthZ `rag#tool.create`. **Service:** CAIPE UI (MongoDB).

**Request body:**

```json
{
  "name": "My team tool",
  "team_id": "platform",
  "datasource_ids": ["src_web___docs_example_com"],
  "description": "Optional"
}
```

**Response `201`:**

```json
{
  "tool": {
    "tool_id": "uuid",
    "tenant_id": "acme",
    "team_id": "platform",
    "name": "My team tool",
    "description": "Optional",
    "datasource_ids": ["src_web___docs_example_com"],
    "created_by": "user-sub",
    "updated_at": "2026-03-25T12:00:00.000Z",
    "status": "active"
  }
}
```

**Errors:** `400` validation, `403` cross-team or datasource not in team `allowed_datasource_ids`.

---

### GET `/api/rag/tools/{toolId}`

**Auth:** Session + `rag#tool.view`. **Service:** CAIPE UI (MongoDB).

**Response `200`:** `{ "tool": { ... } }`  
**Response `404`:** `{ "error": "Tool not found" }` (or soft-deleted)

---

### PUT `/api/rag/tools/{toolId}`

**Auth:** Session + `rag#tool.update`; caller must be member of tool’s team (or `admin` / `kb_admin`).

**Request body (partial):**

```json
{
  "name": "Updated name",
  "datasource_ids": ["src_web___docs_example_com"],
  "description": "New description"
}
```

**Response `200`:** `{ "tool": { ... } }`

---

### DELETE `/api/rag/tools/{toolId}`

**Auth:** Session + `rag#tool.delete`; same team rules as PUT.

**Response `204`:** No content (soft delete: `status` → `deleted`).

---

## User info

### GET `/v1/user/info`

**Auth:** Bearer JWT required. **Service:** RAG server.

Returns resolved identity baseline role and permission strings for UI gating.

**Response `200`:**

```json
{
  "email": "user@example.com",
  "role": "readonly",
  "is_authenticated": true,
  "permissions": ["read"]
}
```

---

## Datasource management

RAG uses two independent resource graphs for each source ID:

- `ingestion_source` controls who can read and manage connector configuration.
- `data_source` / `knowledge_base` controls who can search indexed content.

Trusted ingestion transports may hold a separate legacy `ingestor` grant.
Selecting **Search** in the product writes only the `reader` relationship; it
never grants ingestion, reload, or configuration access.

Granting a person or team **Search** access does not let them change
the URL, channel, query, crawl options, ownership, or deletion lifecycle.
Source management does not implicitly make a team-owned source searchable, but
Owners may administer which people and teams receive Search
access. A personal owner retains access through the KB owner relation. Search
also requires the organization-level search capability.

### POST `/v1/datasource`

**Auth:** Bearer JWT — assigned trusted ingestor service, or organization admin. **Service:** RAG server.

Creates or replaces the full datasource metadata record in Redis. Human source
managers use the narrow `PATCH /v1/datasource/{datasource_id}` endpoint instead.
When a trusted ingestor updates an existing record, authorization ownership
fields are preserved from storage.

**Request body:**

```json
{
  "datasource_id": "custom_kb_001",
  "ingestor_id": "webloader:default",
  "description": "Product documentation",
  "source_type": "web",
  "last_updated": 1711363200,
  "default_chunk_size": 10000,
  "default_chunk_overlap": 2000,
  "owner_team_slug": "source-managers",
  "search_with_teams": ["search-users"],
  "search_with_users": ["example-reader-subject"],
  "metadata": {
    "config_managed": true
  }
}
```

**Response `202`:** Accepted (ingest metadata stored).

**Errors:** `401`, `403`, `500`.

---

### PATCH `/v1/datasource/{datasource_id}`

**Auth:** Bearer JWT + `ingestion_source#can_manage`; legacy records without an
`ingestion_source` policy fall back to `data_source#can_manage`. **Service:** RAG server.

Updates only the display, refresh, chunking, and connector fields valid for the
source type. The datasource ID and authorization ownership fields are immutable
through this endpoint.

### PATCH `/v1/datasource/{datasource_id}/owner-team`

**Auth:** Bearer JWT + `ingestion_source#can_manage`; legacy records may fall
back to `knowledge_base#can_manage`. **Service:** RAG server.

Persists access-policy metadata after the BFF reconciles OpenFGA. Ownership is
either `owner_team_slug` or `owner_subject`. Search grants may contain both
teams and individual user subjects. An explicit empty search list clears that
grant kind. Enforcement remains in OpenFGA.

```json
{
  "owner_team_slug": null,
  "owner_subject": "example-owner-subject",
  "search_with_teams": ["search-users"],
  "search_with_users": ["example-reader-subject"]
}
```

---

### DELETE `/v1/datasource`

**Auth:** Same datasource Owner policy as the narrow PATCH endpoint. **Service:** RAG server.

**Query parameters:**

| Name | Description |
|------|-------------|
| `datasource_id` | Required. Datasource to remove from Milvus, metadata, jobs, and graph (if enabled). |

**Response `200`:** OK (empty body or status per deployment).

**Errors:** `400` if ingestion job in progress; `404` datasource not found; `403`, `500`.

---

### GET `/v1/datasources`

**Auth:** Bearer JWT. **Service:** RAG server.

Returns the union of sources visible through content access and source-config
access. Search-only callers receive catalog/status fields but not connector
configuration. Each row includes `_permissions` flags for content Search,
trusted-ingestor operations, and source-config read/management.

**Query parameters:**

| Name | Description |
|------|-------------|
| `ingestor_id` | Optional filter |

**Response `200`:**

```json
{
  "success": true,
  "datasources": [
    {
      "datasource_id": "src_web___docs_example_com",
      "ingestor_id": "webloader:webloader",
      "description": "Web content from https://docs.example.com",
      "source_type": "web",
      "last_updated": 1711363200,
      "default_chunk_size": 10000,
      "default_chunk_overlap": 2000,
      "metadata": {}
    }
  ],
  "count": 1
}
```

---

## Ingestors

### GET `/v1/ingestors`

**Auth:** Bearer JWT. **Service:** RAG server.

**Response `200`:** Array of ingestor records. Connector type and health fields
are available to source authors; deployment-specific `description` and
`metadata` are returned only to organization admins. Other callers receive an
empty description and `{}` metadata.

```json
[
  {
    "ingestor_id": "webloader:webloader",
    "ingestor_type": "webloader",
    "ingestor_name": "webloader",
    "description": "",
    "metadata": {},
    "last_seen": 1711363200
  }
]
```

---

### POST `/v1/ingestor/heartbeat`

**Auth:** Bearer JWT for a configured trusted ingestor service account. **Service:** RAG server.

**Request body:**

```json
{
  "ingestor_type": "webloader",
  "ingestor_name": "worker-1",
  "description": "Example webloader worker",
  "metadata": {"region": "primary"}
}
```

**Response `200`:**

```json
{
  "ingestor_id": "webloader:worker-1",
  "message": "Ingestor heartbeat registered",
  "max_documents_per_ingest": 1000
}
```

---

### DELETE `/v1/ingestor/delete`

**Auth:** Bearer JWT + organization-admin grant. **Service:** RAG server.

**Query parameters:**

| Name | Description |
|------|-------------|
| `ingestor_id` | Required |

**Response `200`:** Success (metadata removed).  
**Errors:** `404` ingestor not found.

---

## Ingestion jobs

### GET `/v1/job/{job_id}`

**Auth:** Bearer JWT + either content read or source-config read access. **Service:** RAG server.

**Response `200`:**

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "in_progress",
  "message": "Processing batch",
  "created_at": 1711363200,
  "completed_at": null,
  "total": 100,
  "progress_counter": 42,
  "failed_counter": 0,
  "error_msgs": [],
  "datasource_id": "src_web___docs_example_com",
  "document_count": 40,
  "chunk_count": 120
}
```

**Errors:** `404` job not found.

---

### GET `/v1/jobs/datasource/{datasource_id}`

**Auth:** Bearer JWT + either content read or source-config read access. **Service:** RAG server.

**Query parameters:**

| Name | Description |
|------|-------------|
| `status_filter` | Optional: `pending`, `in_progress`, `completed`, `completed_with_errors`, `terminated`, `failed` |

**Response `200`:** JSON array of `JobInfo`.  
**Errors:** `404` if no jobs for datasource.

---

### POST `/v1/jobs/batch`

**Auth:** Bearer JWT; inaccessible datasource IDs are omitted. **Service:** RAG server.

**Request body:**

```json
{
  "datasource_ids": ["ds_a", "ds_b"],
  "status_filter": ["pending", "in_progress"]
}
```

**Response `200`:**

```json
{
  "jobs": {
    "ds_a": [{ "job_id": "...", "status": "pending", "datasource_id": "ds_a" }],
    "ds_b": []
  },
  "total_jobs": 1,
  "datasource_count": 2
}
```

**Errors:** `400` if more than 100 datasource IDs or invalid status strings.

---

### POST `/v1/job`

**Auth:** Bearer JWT for the trusted ingestor assigned to the datasource. **Service:** RAG server.

**Query parameters:**

| Name | Description |
|------|-------------|
| `datasource_id` | Required |
| `job_status` | Optional enum |
| `message` | Optional |
| `total` | Optional |

**Response `201`:**

```json
{
  "job_id": "new-uuid",
  "datasource_id": "src_web___docs_example_com"
}
```

**Errors:** `404` datasource not found; `400` create failed.

---

### PATCH `/v1/job/{job_id}`

**Auth:** Bearer JWT for the trusted ingestor assigned to the datasource. **Service:** RAG server.

**Query parameters:** `job_status`, `message`, `total` (all optional but at least one typically set).

**Response `200`:**

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "datasource_id": "src_web___docs_example_com"
}
```

**Errors:** `404`, `400` (e.g. terminated job).

---

### POST `/v1/job/{job_id}/terminate`

**Auth:** Bearer JWT + datasource Owner access, or the trusted ingestor assigned to the datasource. **Service:** RAG server.

**Response `200`:**

```json
{
  "message": "Job 550e8400-e29b-41d4-a716-446655440000 has been terminated."
}
```

---

### POST `/v1/job/{job_id}/increment-progress`

**Auth:** Bearer JWT for the trusted ingestor assigned to the datasource. **Service:** RAG server.

**Query parameters:**

| Name | Default | Description |
|------|---------|-------------|
| `increment` | `1` | Progress delta |

**Response `200`:**

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "progress_counter": 43
}
```

**Errors:** `400` if job terminated.

---

### POST `/v1/job/{job_id}/increment-failure`

**Auth:** Bearer JWT for the trusted ingestor assigned to the datasource. **Service:** RAG server.

**Query parameters:** `increment` (default `1`).

**Response `200`:**

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "failed_counter": 2
}
```

---

### POST `/v1/job/{job_id}/add-errors`

**Auth:** Bearer JWT for the trusted ingestor assigned to the datasource. **Service:** RAG server.

**Request body (JSON array):**

```json
[
  "Timeout fetching page 12",
  "Parse error in section FAQ"
]
```

**Response `200`:**

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "errors_added": 2,
  "total_errors": 5
}
```

**Errors:** `400` empty array or job terminated.

---

## Query & search

### POST `/v1/query`

**Auth:** Bearer JWT + organization search capability + readable datasource grant. **Service:** RAG server.

Hybrid semantic + sparse (BM25) search over the unified Milvus collection. Optional metadata `filters` (e.g. `datasource_id`). With team/KB RBAC enabled, filters may be injected or the handler returns `[]` when the user has no accessible KBs.

**Request body:**

```json
{
  "query": "How do I reset the cache?",
  "limit": 10,
  "similarity_threshold": 0.3,
  "filters": {
    "datasource_id": "src_web___docs_example_com"
  },
  "ranker_type": "weighted",
  "ranker_params": {
    "weights": [0.7, 0.3]
  }
}
```

**Response `200`:** Array of hits (LangChain `Document` + score):

```json
[
  {
    "document": {
      "page_content": "To reset the cache, run...",
      "metadata": {
        "datasource_id": "src_web___docs_example_com",
        "title": "Cache operations"
      }
    },
    "score": 0.89
  }
]
```

**Errors:** `400` if `limit` exceeds server max (env `MAX_RESULTS_PER_QUERY`, default 100).

---

## Content ingestion

### POST `/v1/ingest`

**Auth:** Bearer JWT for the trusted assigned ingestor, or `data_source#can_ingest`; the request must reference the exact active server-created job. **Service:** RAG server.

Bulk document ingestion into Milvus (and graph when enabled). Requires an existing datasource and a job in `in_progress` (ingestors usually transition job state before posting chunks).

**Request body:**

```json
{
  "documents": [
    {
      "page_content": "# Heading\nBody text...",
      "metadata": {
        "document_id": "doc-001",
        "datasource_id": "custom_kb_001",
        "ingestor_id": "webloader:webloader",
        "title": "Overview",
        "description": "",
        "is_graph_entity": false,
        "document_type": "markdown",
        "document_ingested_at": 1711363200,
        "fresh_until": 1711449600
      }
    }
  ],
  "ingestor_id": "webloader:webloader",
  "datasource_id": "custom_kb_001",
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "fresh_until": 1711449600
}
```

**Response `202`:**

```json
{
  "message": "Text data ingestion started successfully"
}
```

**Errors:** `400` document count over limit, wrong job status, or validation error; `404` datasource/job missing; `403` KB access.

---

### POST `/v1/ingest/webloader/url`

**Auth:** New source: organization author capability + selected Owner-team membership. Existing source: datasource Owner access. **Service:** RAG server.

Queues a new URL crawl on the webloader Redis queue; creates datasource and pending job.

**Request body:**

```json
{
  "url": "https://docs.example.com/guide",
  "description": "Public product guide",
  "settings": {
    "crawl_mode": "sitemap",
    "max_depth": 2,
    "max_pages": 500,
    "chunk_size": 10000,
    "chunk_overlap": 2000
  },
  "reload_interval": 86400
}
```

**Response `202`:**

```json
{
  "datasource_id": "src_web___docs_example_com",
  "job_id": "new-uuid",
  "message": "URL ingestion request queued"
}
```

**Errors:** `400` URL already ingested or job already pending; `500` queue failure.

---

### POST `/v1/ingest/webloader/reload`

**Auth:** Bearer JWT + datasource Owner access. Stored connector configuration is reused. **Service:** RAG server.

**Request body:**

```json
{
  "datasource_id": "src_web___docs_example_com"
}
```

**Response `202`:**

```json
{
  "datasource_id": "src_web___docs_example_com",
  "message": "URL reload ingestion request queued"
}
```

**Errors:** `404` unknown datasource.

---

### POST `/v1/ingest/webloader/reload-all`

**Auth:** Bearer JWT + organization-admin grant. **Service:** RAG server.

**Request body:** None.

**Response `202`:**

```json
{
  "message": "Reload all URLs request queued"
}
```

---

### POST `/v1/ingest/confluence/page`

**Auth:** New source: organization author capability + selected Owner-team membership. Existing source: datasource Owner access. **Service:** RAG server.

**Request body:**

```json
{
  "url": "https://example.atlassian.net/wiki/spaces/ENG/pages/123456789/Runbook",
  "name": "Engineering runbooks",
  "description": "Runbooks rooted at the selected page",
  "get_child_pages": true,
  "allowed_title_patterns": ["^Runbook.*"],
  "denied_title_patterns": ["Draft"]
}
```

**Response `202`:**

```json
{
  "datasource_id": "src_confluence___example_atlassian_net__ENG__123456789",
  "job_id": "new-uuid",
  "message": "Confluence page ingestion request queued"
}
```

**Errors:** `400` invalid URL format or wrong Confluence host vs `CONFLUENCE_URL`; `400` if another job is pending for that page-rooted datasource.

---

### POST `/v1/ingest/confluence/reload`

**Auth:** Bearer JWT + datasource Owner access. Stored connector configuration is reused. **Service:** RAG server.

**Request body:**

```json
{
  "datasource_id": "src_confluence___example_atlassian_net__ENG__123456789"
}
```

**Response `202`:** `{ "datasource_id": "...", "message": "Confluence page reload request queued" }`

---

### POST `/v1/ingest/confluence/reload-all`

**Auth:** Bearer JWT + organization-admin grant. **Service:** RAG server.

**Response `202`:**

```json
{
  "message": "Reload all Confluence pages request queued"
}
```

---

## Graph explore (entity & ontology)

Requires `ENABLE_GRAPH_RAG=true`, Neo4j, a Bearer JWT, and the organization search capability. Data-graph responses are limited to datasources for which the caller has Search access. Entities without datasource provenance and relations whose endpoints are not both searchable are omitted.

The ontology graph is deployment-global and does not yet carry datasource provenance. Its routes, including ontology-agent status, therefore require unrestricted datasource access. Bounded callers can use only the source-scoped data graph.

### GET `/v1/graph/explore/entity_type`

Lists entity types visible to the caller. Unrestricted callers receive the ontology type list; bounded callers receive only types found in their readable portion of the data graph.

**Response `200`:** JSON object/array as returned by the ontology graph driver.

---

### GET `/v1/graph/explore/data/entities/batch`

**Query:** `offset`, `limit` (1–1000), optional `entity_type`.

**Response `200`:**

```json
{
  "entities": [],
  "count": 0,
  "offset": 0,
  "limit": 100
}
```

---

### GET `/v1/graph/explore/data/relations/batch`

**Query:** `offset`, `limit`, optional `relation_name`.

**Response `200`:**

```json
{
  "relations": [],
  "count": 0,
  "offset": 0,
  "limit": 100
}
```

---

### POST `/v1/graph/explore/data/entity/neighborhood`

**Request body:**

```json
{
  "entity_type": "Service",
  "entity_pk": "payments-api",
  "depth": 2
}
```

**Response `200`:** Neighborhood graph payload (`entity`, neighbors, edges — encoder-dependent).  
**Response `404`:** `{ "message": "Entity not found" }`

---

### GET `/v1/graph/explore/data/entity/start`

**Query:** `n` (1–100) random seed nodes.

**Response `200`:** Array of entity stubs for visualization bootstrap.

---

### GET `/v1/graph/explore/data/stats`

**Response `200`:** Graph statistics (node/relation counts — schema from Neo4j layer).

---

### GET `/v1/graph/explore/ontology/entities/batch`

Same contract as data entities batch, against the ontology graph. Requires unrestricted datasource access.

---

### GET `/v1/graph/explore/ontology/relations/batch`

Same contract as data relations batch, ontology graph.

---

### POST `/v1/graph/explore/ontology/entity/neighborhood`

Same body as data neighborhood; uses ontology graph.

---

### GET `/v1/graph/explore/ontology/entity/start`

**Query:** `n` (1–100).

---

### GET `/v1/graph/explore/ontology/stats`

Ontology graph statistics.

---

### GET|POST|DELETE `/v1/graph/ontology/agent/{path}`

**Auth:** Bearer JWT — unrestricted datasource access for `GET` **only** when path ends with `/status`; other methods/paths require organization admin. **Service:** RAG server (reverse proxy to `ONTOLOGY_AGENT_RESTAPI_ADDR`, default `http://localhost:8098`).

Streams the ontology agent response (status and headers forwarded). **Errors:** `403` insufficient role; upstream errors pass through as received.

---

## MCP tools configuration (RAG server REST)

Distinct from `/api/rag/tools` (MongoDB team tools). These endpoints configure **MCP search tools** stored in Redis and exposed on the embedded MCP HTTP app at `/mcp` when `ENABLE_MCP=true`.

Reserved tool IDs (cannot be created/deleted via REST; updates return conflict): `search`, `fetch_document`, `list_datasources_and_entity_types`.

### GET `/v1/mcp/tools`

**Auth:** Bearer JWT — `readonly`. **Service:** RAG server.

**Response `200`:** Map or dict of `tool_id` → `MCPToolConfig`.

```json
{
  "infra_search": {
    "tool_id": "infra_search",
    "description": "Search infrastructure docs",
    "parallel_searches": [
      {
        "label": "results",
        "datasource_ids": ["src_web___docs_example_com"],
        "is_graph_entity": null,
        "extra_filters": {},
        "semantic_weight": 0.5
      }
    ],
    "allow_runtime_filters": false,
    "enabled": true,
    "created_at": 1711363200,
    "updated_at": 1711363200
  }
}
```

---

### POST `/v1/mcp/tools`

**Auth:** Bearer JWT — `admin`. **Service:** RAG server.

**Request body:** `MCPToolConfig` (same shape as above; `created_at` / `updated_at` set server-side).

**Response `201`:** Stored config.  
**Errors:** `409` reserved or duplicate `tool_id`.

---

### PUT `/v1/mcp/tools/{tool_id}`

**Auth:** Bearer JWT — `admin`. **Service:** RAG server.

Body `tool_id` must match path. Preserves `created_at`.

**Errors:** `404`, `400` id mismatch, `409` reserved id.

---

### DELETE `/v1/mcp/tools/{tool_id}`

**Auth:** Bearer JWT — `admin`. **Service:** RAG server.

**Response `200`:**

```json
{
  "message": "MCP tool 'infra_search' deleted."
}
```

**Errors:** `404`, `409` reserved id.

---

### GET `/v1/mcp/builtin-config`

**Auth:** Bearer JWT — `readonly`. **Service:** RAG server.

**Response `200`:**

```json
{
  "search_enabled": true,
  "fetch_document_enabled": true,
  "fetch_datasources_enabled": true,
  "graph_explore_ontology_entity_enabled": true,
  "graph_explore_data_entity_enabled": true,
  "graph_fetch_data_entity_details_enabled": true,
  "graph_shortest_path_between_entity_types_enabled": true,
  "graph_raw_query_data_enabled": true,
  "graph_raw_query_ontology_enabled": true
}
```

---

### PUT `/v1/mcp/builtin-config`

**Auth:** Bearer JWT — `admin`. **Service:** RAG server.

**Request body:** Same shape as GET; toggles built-in MCP tools after reload.

**Response `200`:** Updated config JSON.

---

## Health

### GET `/healthz`

**Auth:** None required. **Service:** RAG server.

Returns process health, timestamp, optional error details, and a large `config` snapshot (Milvus, Redis, embeddings model, datasource list, graph settings when enabled).

**Response `200`:**

```json
{
  "status": "healthy",
  "timestamp": 1711363200,
  "details": {},
  "config": {
    "graph_rag_enabled": true,
    "search": {
      "keys": ["document_id", "datasource_id", "title"]
    },
    "vector_db": {
      "milvus": {
        "uri": "http://localhost:19530",
        "collections": ["rag_default"],
        "index_params": {}
      }
    },
    "embeddings": { "model": "text-embedding-3-small" },
    "metadata_storage": { "redis": { "url": "redis://localhost:6379" } },
    "ui_url": "http://localhost:9447",
    "datasources": []
  }
}
```

When dependencies are not initialized, `status` may be `unhealthy` with `details.error` set.

---

## MCP HTTP transport (reference)

When enabled, FastMCP exposes **`/mcp`** on the same server. If `MCP_AUTH_ENABLED=true`, requests must include `Authorization: Bearer <token>`, enforced by middleware. This is the **Model Context Protocol** streamable HTTP surface for agents, not the REST JSON API above.

---

## JWT validation (direct clients)

The RAG server’s `auth` module validates access tokens against configured OIDC providers (`OIDC_ISSUER` / `OIDC_DISCOVERY_URL` + `OIDC_AUDIENCE`, optional second ingestor issuer). Tokens must include a JWKS `kid`; signature algorithms RS/ES families are supported. Human tokens are identity-only: the token `sub` becomes the OpenFGA subject, and AD/OIDC groups or Keycloak realm roles are not consumed by RAG authorization.
