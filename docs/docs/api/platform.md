---
sidebar_position: 8
---

# Platform API

Swagger-style reference for platform concerns: health and readiness across services, build/version metadata, runtime frontend configuration, user settings, debug introspection, feedback, changelog, skill templates, and workflow run history.

Paths under `/api/*` are served by the **Next.js UI Backend API** (CAIPE UI). RAG and Dynamic Agents paths are on their respective service base URLs (e.g. `https://<rag-host>`, `https://<dynamic-agents-host>`).

---

## Health & Readiness (all services)

### GET `/api/health`

**Auth:** None · **Service:** UI Backend API

Liveness probe for the CAIPE UI. Returns a fixed service identifier and current timestamp.

**Response `200`:**

```json
{
  "status": "ok",
  "service": "caipe-ui",
  "timestamp": "2026-03-25T12:00:00.000Z"
}
```

### GET `/healthz`

**Auth:** None (typically internal / mesh) · **Service:** RAG Server

Aggregated health for the RAG FastAPI app: dependency initialization, optional graph-RAG config, Milvus/Redis/embeddings metadata. `status` is `healthy` or `unhealthy`; `details` may include an error when subsystems are not initialized.

**Response `200`:**

```json
{
  "status": "healthy",
  "timestamp": 1742904000,
  "details": {},
  "config": {
    "graph_rag_enabled": false,
    "search": {
      "keys": ["kb_id", "owner_id"]
    },
    "vector_db": {
      "milvus": {
        "uri": "http://milvus:19530",
        "collections": ["documents"],
        "index_params": {
          "dense": {},
          "sparse": {}
        }
      }
    },
    "embeddings": {
      "model": "text-embedding-3-small"
    },
    "metadata_storage": {
      "redis": {
        "url": "redis://redis:6379/0"
      }
    },
    "ui_url": "http://localhost:3000",
    "datasources": []
  }
}
```

When `graph_rag_enabled` is true and graph DBs are connected, `config` may also include a `graph_db` object (data/ontology graph URIs, entity types, etc.).

### GET `/healthz`

**Auth:** None (typically internal / mesh) · **Service:** Dynamic Agents

Process health and MongoDB connectivity summary for the Dynamic Agents service.

**Response `200`:**

```json
{
  "status": "healthy",
  "timestamp": 1742904000,
  "details": {},
  "config": {
    "mongodb_database": "caipe",
    "collections": {
      "dynamic_agents": "dynamic_agents",
      "mcp_servers": "mcp_servers"
    },
    "agent_runtime_ttl_seconds": 3600
  }
}
```

If MongoDB is not connected, `status` is `unhealthy` and `details` may include `"mongodb": "Not connected"`.

### GET `/readyz`

**Auth:** None (typically internal / mesh) · **Service:** Dynamic Agents

Readiness: whether MongoDB client is connected. (HTTP status remains `200`; inspect `ready`.)

**Response `200`:**

```json
{
  "ready": true
}
```

```json
{
  "ready": false,
  "error": "MongoDB not connected"
}
```

### GET `/`

**Auth:** None · **Service:** Dynamic Agents

Service banner and link to OpenAPI docs.

**Response `200`:**

```json
{
  "service": "dynamic-agents",
  "version": "0.1.0",
  "docs": "/docs"
}
```

---

## Version & Build Info

### GET `/api/version`

**Auth:** None · **Service:** UI Backend API

Reads `public/version.json` when present (e.g. Docker build); falls back to dev defaults. Adds `packageVersion` from `package.json` when available. Route is forced dynamic.

**Response `200`:**

```json
{
  "version": "1.2.3",
  "gitCommit": "abc1234",
  "buildDate": "2026-03-20T10:00:00.000Z",
  "packageVersion": "1.2.3"
}
```

**Response `500`:** On unexpected read/parse errors, may return `version` / `gitCommit` of `"unknown"` and an `error` message string.

---

## Frontend Configuration

### GET `/api/config`

**Auth:** None · **Service:** UI Backend API

Returns all `process.env` entries whose keys start with `NEXT_PUBLIC_` (runtime values as seen by the server). Same conceptual data as injected `window.__RUNTIME_ENV__`. Cached `60s` (`Cache-Control: public, max-age=60`).

**Response `200`:**

```json
{
  "NEXT_PUBLIC_SSO_ENABLED": "true",
  "NEXT_PUBLIC_APP_NAME": "CAIPE"
}
```

---

## Application Settings (user preferences, notifications, defaults)

All settings routes require an authenticated NextAuth session (`401` if missing; when SSO is disabled, other routes may use an anonymous dev user—settings use `withAuth` and expect a real session email).

MongoDB collection: `user_settings`, keyed by `user_id` (user email). GET creates a document with defaults if none exists.

### GET `/api/settings`

**Auth:** Session required · **Service:** UI Backend API

Returns the full `UserSettings` document for the current user.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "user_id": "user@example.com",
    "preferences": {
      "theme": "dark",
      "gradient_theme": "default",
      "font_family": "inter",
      "font_size": "medium",
      "sidebar_collapsed": false,
      "context_panel_visible": true,
      "debug_mode": false,
      "code_theme": "onedark",
      "memory_enabled": "true",
      "debug_mode_enabled": "false",
      "show_thinking_enabled": "true",
      "auto_scroll_enabled": "true",
      "show_timestamps_enabled": "false"
    },
    "notifications": {
      "email_enabled": true,
      "in_app_enabled": true,
      "conversation_shared": true,
      "weekly_summary": false
    },
    "defaults": {
      "default_model": "gpt-4o",
      "default_agent_mode": "auto",
      "auto_title_conversations": true
    },
    "updated_at": "2026-03-25T12:00:00.000Z",
    "_id": "67e2b3c4d5e6f7890abcdef1"
  }
}
```

### PUT `/api/settings`

**Auth:** Session required · **Service:** UI Backend API

Partial update via nested objects. Any of `preferences`, `notifications`, `defaults` may be supplied; only provided keys are merged with `$set` on dotted paths.

**Request body (example):**

```json
{
  "preferences": {
    "theme": "nord"
  },
  "notifications": {
    "weekly_summary": true
  }
}
```

**Response `200`:** Same `{ "success": true, "data": { ... } }` shape as GET, reflecting the updated document.

### PATCH `/api/settings/preferences`

**Auth:** Session required · **Service:** UI Backend API

Body is a flat object of preference keys to values (merged into `preferences.*`).

**Request body (example):**

```json
{
  "theme": "light",
  "sidebar_collapsed": true
}
```

**Response `200`:** `{ "success": true, "data": { ...full user_settings... } }`

### PATCH `/api/settings/notifications`

**Auth:** Session required · **Service:** UI Backend API

Flat keys merged into `notifications.*`.

**Request body (example):**

```json
{
  "email_enabled": false,
  "in_app_enabled": true
}
```

**Response `200`:** `{ "success": true, "data": { ... } }`

### PATCH `/api/settings/defaults`

**Auth:** Session required · **Service:** UI Backend API

Flat keys merged into `defaults.*`.

**Request body (example):**

```json
{
  "default_model": "claude-3-5-sonnet-20241022",
  "auto_title_conversations": false
}
```

**Response `200`:** `{ "success": true, "data": { ... } }`

---

## Debug Endpoints (auth status, session)

Intended for operators and local debugging. Do not expose publicly in production without controls.

### GET `/api/debug/auth-status`

**Auth:** None (session optional) · **Service:** UI Backend API

If there is no session, returns minimal config. If authenticated, returns session-derived role, OIDC group checks, optional MongoDB `metadata.role`, and computed admin flags.

**Response `200` (unauthenticated):**

```json
{
  "authenticated": false,
  "message": "No session found",
  "config": {
    "ssoEnabled": true
  }
}
```

**Response `200` (authenticated):**

```json
{
  "authenticated": true,
  "session": {
    "email": "user@example.com",
    "name": "Jane User",
    "role": "admin",
    "isAuthorized": true
  },
  "config": {
    "requiredGroup": "caipe-users",
    "requiredAdminGroup": "caipe-admins",
    "ssoEnabled": true
  },
  "checks": {
    "hasRequiredGroup": true,
    "hasAdminGroup": true,
    "sessionRole": "admin",
    "mongoRole": null,
    "finalIsAdmin": true
  }
}
```

### GET `/api/debug/session`

**Auth:** None (session optional) · **Service:** UI Backend API

Lightweight session dump plus selected env vars related to OIDC/SSO.

**Response `200`:**

```json
{
  "authenticated": true,
  "user": {
    "name": "Jane User",
    "email": "user@example.com",
    "image": "https://example.com/avatar.png"
  },
  "role": "user",
  "isAuthorized": true,
  "env": {
    "ssoEnabled": "true",
    "requiredGroup": "caipe-users",
    "requiredAdminGroup": "caipe-admins",
    "requiredAdminViewGroup": "caipe-admin-viewers"
  }
}
```

---

## User Feedback

### POST `/api/feedback`

**Auth:** Optional session (user email used for attribution when present) · **Service:** UI Backend API

Submits thumbs up/down style feedback to Langfuse when `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_HOST` are set; otherwise logs and returns success with `langfuseEnabled: false`.

**Request body:**

| Field | Required | Description |
|--------|----------|-------------|
| `feedbackType` | Yes | `"like"` or `"dislike"` |
| `conversationId` / `traceId` / `messageId` | At least one | Trace grouping for Langfuse scores |
| `reason`, `additionalFeedback` | No | Combined into Langfuse comment |

**Response `200`:**

```json
{
  "success": true,
  "message": "Feedback submitted successfully",
  "langfuseEnabled": true
}
```

**Response `400` / `500`:** `{ "success": false, "message": "..." }`

### GET `/api/feedback`

**Auth:** None · **Service:** UI Backend API

Reports whether Langfuse is configured (does not leak secrets).

**Response `200`:**

```json
{
  "enabled": true,
  "host": "cloud.langfuse.com"
}
```

---

## Changelog

### GET `/api/changelog`

**Auth:** None · **Service:** UI Backend API

Fetches `CHANGELOG.md` from the upstream GitHub raw URL, with local file fallbacks. Parses `## x.y.z (YYYY-MM-DD)` releases and subsection bullets; filters out `rc` / `alpha` / `beta` versions.

**Response `200`:**

```json
{
  "releases": [
    {
      "version": "1.2.0",
      "date": "2026-03-01",
      "sections": [
        {
          "type": "Features",
          "items": [
            {
              "text": "**ui**: Add workflow history panel",
              "scope": "ui"
            }
          ]
        }
      ]
    }
  ],
  "scopes": ["ui", "rag"]
}
```

**Response `502` / `500`:** `{ "error": "Failed to fetch changelog", "releases": [], "scopes": [] }`

---

## Skills catalog & API keys (UI Backend API)

### GET `/api/skills`

**Auth:** Session **or** `Authorization: Bearer` (validated via `getAuthFromBearerOrSession`).

Merged skills catalog: prefers proxy to Python `GET {BACKEND_SKILLS_URL}/skills` when configured; otherwise aggregates filesystem templates, MongoDB `agent_skills`, and enabled `skill_hubs`.

**Query parameters:** `q`, `source` (`default` \| `agent_skills` \| `hub`), `tags` (comma-separated), `include_content`, `page`, `page_size`, `visibility`.

**Response `200`:** `{ "skills": [...], "meta": { "total", "page?", "page_size?", "has_more?", "sources_loaded", "unavailable_sources" } }`

**Errors:** `401` unauthorized; `503` `{ "error": "skills_unavailable", "message": "..." }` on aggregation failure.

---

### POST `/api/skills/token`

**Auth:** Session (`withAuth`).

Mints an HS256 JWT for programmatic catalog reads (`scope: skills:read`, `role: user`).

**Body (optional):** `{ "expires_in_days": 30 | 60 | 90 }` (default 90, max 90).

**Response `200`:** `{ "token", "token_type": "Bearer", "expires_in", "scope": "skills:read" }`

---

### GET `/api/catalog-api-keys`

**Auth:** Session.

Proxies to Python `GET /catalog-api-keys`. `503` with `{ "error": "backend_not_configured", "keys": [] }` if no backend URL.

---

### POST `/api/catalog-api-keys`

**Auth:** Session.

Proxies key minting to Python `POST /catalog-api-keys`.

---

### DELETE `/api/catalog-api-keys/[keyId]`

**Auth:** Session.

Proxies `DELETE /catalog-api-keys/{keyId}` on the Python backend.

---

## Skill hubs (UI Backend API)

### GET `/api/skill-hubs`

**Auth:** Session + **`requireAdmin`**. Returns `{ "hubs": [...] }` (MongoDB). Empty hubs if MongoDB off.

---

### POST `/api/skill-hubs`

**Auth:** Session + **`requireAdmin`**.

**Body:** `type` (`github` \| `gitlab`), `location` (`owner/repo` or URL). Optional fields per implementation.

---

### PATCH `/api/skill-hubs/[id]`

**Auth:** Session + **`requireAdmin`**. Update `enabled`, `location`, `credentials_ref`.

---

### DELETE `/api/skill-hubs/[id]`

**Auth:** Session + **`requireAdmin`**.

---

### POST `/api/skill-hubs/crawl`

**Auth:** Session + **`requireAdmin`**.

Preview crawl for a repo; proxies to Python when `BACKEND_SKILLS_URL` is set.

---

## Skill Templates

### GET `/api/skill-templates`

**Auth:** None · **Service:** UI Backend API

Loads built-in skill templates from `SKILLS_DIR`, or chart `data/skills`, or `ui/data/skills`. Supports folder-per-skill (`<id>/SKILL.md`, `metadata.json`) or flat ConfigMap names (`<id>--SKILL.md`). Results cached 30 seconds.

**Response `200`:** JSON array of templates.

```json
[
  {
    "id": "review-pr",
    "name": "review-pr",
    "description": "Review a pull request with structured feedback",
    "title": "PR Review",
    "category": "Development",
    "icon": "GitBranch",
    "tags": ["github", "review"],
    "content": "---\nname: review-pr\ndescription: ...\n---\n\n# Skill\n..."
  }
]
```

---

## Workflow Runs

Stored in MongoDB (`workflow_runs`). All methods require MongoDB; otherwise `503` with message about workflow history. All methods require session auth.

Query params for GET: `id` (single run), `workflow_id`, `status`, `limit` (default 100). Mutations use query param `id` for PUT/DELETE.

### POST `/api/workflow-runs`

**Auth:** Session required · **Service:** UI Backend API

Creates a run with generated `id`, `status: "running"`, and `owner_id` set to the user email.

**Request body:**

```json
{
  "workflow_id": "support-triage-v2",
  "workflow_name": "Support triage",
  "workflow_category": "support",
  "input_parameters": { "tone": "friendly" },
  "input_prompt": "Create an agent that...",
  "metadata": {
    "model": "gpt-4o",
    "tags": ["demo"]
  }
}
```

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "run-1742904000000-x7k2m9p1q",
    "message": "Workflow run created successfully"
  }
}
```

### GET `/api/workflow-runs`

**Auth:** Session required · **Service:** UI Backend API

Without `id`: returns an array of runs for the current owner (not wrapped in `{ success, data }`).

**Response `200` (list):**

```json
[
  {
    "id": "run-1742904000000-x7k2m9p1q",
    "workflow_id": "support-triage-v2",
    "workflow_name": "Support triage",
    "status": "completed",
    "started_at": "2026-03-25T12:00:00.000Z",
    "completed_at": "2026-03-25T12:05:00.000Z",
    "owner_id": "user@example.com",
    "created_at": "2026-03-25T12:00:00.000Z"
  }
]
```

With `?id=<runId>`: returns a single `WorkflowRun` object (same shape as one list element, plus optional fields such as `execution_artifacts`, `result_summary`, etc.).

### PUT `/api/workflow-runs?id=<runId>`

**Auth:** Session required · **Service:** UI Backend API

Owner-only update. Body must include at least one field from `UpdateWorkflowRunInput` (e.g. `status`, `completed_at`, `duration_ms`, `result_summary`, `error_message`, step counts, `execution_artifacts`).

**Request body (example):**

```json
{
  "status": "completed",
  "completed_at": "2026-03-25T12:05:00.000Z",
  "duration_ms": 300000,
  "result_summary": "Agent configuration saved."
}
```

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "run-1742904000000-x7k2m9p1q",
    "message": "Workflow run updated successfully"
  }
}
```

### DELETE `/api/workflow-runs?id=<runId>`

**Auth:** Session required · **Service:** UI Backend API

Owner-only delete.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "run-1742904000000-x7k2m9p1q",
    "message": "Workflow run deleted successfully"
  }
}
```

**Error shape (typical):** `{ "success": false, "error": "...", "code": "..." }` with `401`, `403`, `404`, or `503` as appropriate.
