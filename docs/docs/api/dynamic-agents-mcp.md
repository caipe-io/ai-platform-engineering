---
sidebar_position: 6
---

# Dynamic Agents & MCP API

Reference for the **Dynamic Agents & MCP** domain: Next.js UI Backend API routes under `/api/...` (browser → UI server) and the **Dynamic Agents** FastAPI service (`/api/v1/...`), typically reached via `DYNAMIC_AGENTS_URL`.

**Conventions**

- **UI Backend API** responses often use `{ "success": true, "data": ... }` (see `successResponse` / `paginatedResponse` in the UI). Some routes return raw JSON (noted per endpoint).
- **Errors (UI Backend API):** `{ "success": false, "error": "<message>", "code?": "<optional>" }` with an HTTP status.
- **Errors (FastAPI):** `{ "detail": "<message or validation errors>" }`.
- **Pagination (UI Backend API):** query `page` (default `1`), `page_size` (default `20`, max `100`).
- **Pagination (FastAPI lists):** query `page`, `limit` (agents default 20 max 100; MCP servers default 50 max 100).

---

## Agent Management (CRUD, list, search)

### GET `/api/dynamic-agents`

**Auth:** Session (authenticated) | **Service:** UI Backend API

Lists dynamic agent documents from MongoDB (`dynamic_agents`) with visibility rules. Non-admins see enabled agents they own, global agents, or team-shared agents. Admins can list all (optionally filtered).

**Query parameters**

| Name | Description |
|------|-------------|
| `page`, `page_size` | Pagination |
| `enabled_only` | If `true`, only enabled agents (also used when admin filters for subagent pickers) |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "_id": "dynamic-agent-1730000000000",
        "name": "Platform helper",
        "description": "Answers infra questions",
        "system_prompt": "You are a helpful platform engineer...",
        "allowed_tools": { "github-mcp": [] },
        "builtin_tools": { "fetch_url": { "enabled": true, "allowed_domains": "*.example.com" } },
        "model_id": "claude-sonnet-4-20250514",
        "model_provider": "anthropic-claude",
        "visibility": "global",
        "shared_with_teams": [],
        "subagents": [],
        "ui": { "gradient_theme": "ocean" },
        "enabled": true,
        "owner_id": "alice@example.com",
        "is_system": false,
        "config_driven": false,
        "created_at": "2025-01-01T12:00:00.000Z",
        "updated_at": "2025-01-01T12:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "page_size": 20,
    "has_more": false
  }
}
```

**Errors:** `401` unauthenticated; `400` invalid pagination.

---

### POST `/api/dynamic-agents`

**Auth:** Session (**admin**) | **Service:** UI Backend API (MongoDB + OpenFGA)

Creates an agent. The BFF generates `_id` (e.g. `dynamic-agent-<timestamp>`) and owns configuration persistence plus OpenFGA relationship reconciliation.

**Request body:**

```json
{
  "name": "Code reviewer",
  "description": "Reviews pull requests",
  "system_prompt": "You review code for clarity and bugs.",
  "allowed_tools": { "github-mcp": ["list_prs", "get_pr"] },
  "model_id": "claude-sonnet-4-20250514",
  "model_provider": "anthropic-claude",
  "visibility": "team",
  "shared_with_teams": ["team-ops-uuid"],
  "subagents": [
    {
      "agent_id": "dynamic-agent-1729999999999",
      "name": "security-audit",
      "description": "Focuses on security findings"
    }
  ],
  "builtin_tools": { "current_datetime": { "enabled": true } },
  "ui": { "gradient_theme": "sunset" },
  "enabled": true
}
```

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "_id": "dynamic-agent-1730000000001",
    "name": "Code reviewer",
    "owner_id": "admin@example.com",
    "is_system": false,
    "enabled": true
  }
}
```

**Errors:** `403` not admin; `400` subagent visibility mismatch or validation; `409`/other proxied from backend.

---

### PUT `/api/dynamic-agents?id={agent_id}`

**Auth:** Session (**admin**) | **Service:** UI Backend API (MongoDB + OpenFGA)

Partial update. Query param `id` is required.

**Request body (example):**

```json
{
  "description": "Updated description",
  "enabled": false
}
```

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "_id": "dynamic-agent-1730000000000",
    "name": "Platform helper",
    "enabled": false,
    "updated_at": "2025-01-02T10:00:00.000Z"
  }
}
```

**Errors:** `400` missing `id`; `403` not admin; `403` config-driven agent; `404` not found.

---

### DELETE `/api/dynamic-agents?id={agent_id}`

**Auth:** Session (**admin**) | **Service:** UI Backend API (MongoDB + OpenFGA)

**Response `200`:**

```json
{
  "success": true,
  "data": { "deleted": "dynamic-agent-1730000000000" }
}
```

**Errors:** `400` missing `id`; `403` not admin; `400` system agent; `403` config-driven agent; `404` not found.

---

### GET `/api/dynamic-agents/agents/{id}`

**Auth:** Session (authenticated) | **Service:** UI Backend API (MongoDB)

Single agent by `_id`. Non-admins must have access (owner, global, or team) and the agent must be enabled. Admins can read disabled agents. `404` if missing or no access (no existence leak).

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "_id": "dynamic-agent-1730000000000",
    "name": "Platform helper",
    "system_prompt": "...",
    "allowed_tools": {},
    "model_id": "claude-sonnet-4-20250514",
    "model_provider": "anthropic-claude",
    "visibility": "global",
    "subagents": [],
    "enabled": true,
    "owner_id": "alice@example.com",
    "is_system": false,
    "created_at": "2025-01-01T12:00:00.000Z",
    "updated_at": "2025-01-01T12:00:00.000Z"
  }
}
```

**Errors:** `400`/`404` as above; `401` unauthenticated.

---

### GET `/api/dynamic-agents/available`

**Auth:** Session (authenticated) | **Service:** UI Backend API (MongoDB)

Agents the user may **chat with**: enabled, and global, team (membership or ownership), or private (owner).

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "_id": "dynamic-agent-1730000000000",
      "name": "Platform helper",
      "visibility": "global",
      "enabled": true
    }
  ]
}
```

---

### GET `/api/dynamic-agents/available-subagents?id={agent_id}`

**Auth:** Session (**admin**) | **Service:** UI Backend API (MongoDB)

Candidates for subagent configuration (excludes self and cycle ancestors).

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "agents": [
      {
        "id": "dynamic-agent-1729999999999",
        "name": "Security bot",
        "description": "Security-focused agent",
        "visibility": "global"
      }
    ]
  }
}
```

**Errors:** `400` missing `id`; `403` not admin; `404` parent agent not found.

---

### GET `/api/dynamic-agents/teams`

**Auth:** Session (authenticated) | **Service:** UI Backend API (MongoDB)

Teams where the current user is a member (`members.user_id`); used for agent sharing UI.

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "name": "Platform Engineering",
      "description": "Core platform team"
    }
  ]
}
```

---

## Agent Chat & Streaming (start stream, resume, restart)

### POST `/api/dynamic-agents/chat/start-stream`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `POST /api/v1/chat/start-stream`

Starts SSE (`text/event-stream`). Proxies the backend stream end-to-end.

**Request body:**

```json
{
  "message": "List open PRs in repo X",
  "conversation_id": "conv-uuid-thread-id",
  "agent_id": "dynamic-agent-1730000000000"
}
```

Optional on backend (not validated by UI Backend API JSON schema): `trace_id` for Langfuse.

**Response `200`:** `Content-Type: text/event-stream` — events such as `content`, `tool_start`, `tool_end`, `input_required`, `error`, `done` (see FastAPI section).

**Errors:** `401` unauthenticated; `400` missing fields; `403` dynamic agents disabled; `500` URL not configured; `502` no body; `503` backend unreachable; backend status on proxy failure.

---

### POST `/api/dynamic-agents/chat/resume-stream`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `POST /api/v1/chat/resume-stream`

Resumes after HITL `input_required`. `form_data` is a **JSON string** (form values or dismissal text).

**Request body:**

```json
{
  "conversation_id": "conv-uuid-thread-id",
  "agent_id": "dynamic-agent-1730000000000",
  "form_data": "{\"field_a\":\"value\"}"
}
```

**Response `200`:** SSE stream (same family of events as start-stream).

**Errors:** Same pattern as start-stream; `400` if `form_data` omitted.

---

### POST `/api/dynamic-agents/chat/restart-runtime`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `POST /api/v1/chat/restart-runtime`

Invalidates cached runtime for `(agent_id, session_id)` so MCP connections refresh on next message.

**Request body:**

```json
{
  "agent_id": "dynamic-agent-1730000000000",
  "session_id": "conv-uuid-thread-id"
}
```

**Response `200`:** Pass-through from backend, e.g.:

```json
{
  "success": true,
  "invalidated": true,
  "agent_id": "dynamic-agent-1730000000000",
  "session_id": "conv-uuid-thread-id"
}
```

**Errors:** `401`, `400`, `403`, `404`, `503`, `500` as implemented in proxy/backend.

---

## Agent Conversations (list, messages, todos, files, clear)

### GET `/api/dynamic-agents/conversations`

**Auth:** Session (**admin**) | **Service:** UI Backend API (MongoDB)

Lists conversations that have a non-empty `agent_id` (dynamic agent threads). Empty paginated result if MongoDB or dynamic agents feature is off.

**Query parameters**

| Name | Description |
|------|-------------|
| `page`, `page_size` | Pagination |
| `search` | Case-insensitive regex on `_id`, `title`, `owner_id` |
| `agent_id` | Filter by dynamic agent id |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "conv-uuid",
        "title": "Chat with Platform helper",
        "owner_id": "alice@example.com",
        "agent_id": "dynamic-agent-1730000000000",
        "created_at": "2025-01-01T12:00:00.000Z",
        "updated_at": "2025-01-02T09:00:00.000Z",
        "checkpoint_count": 14,
        "is_archived": false,
        "deleted_at": null
      }
    ],
    "total": 1,
    "page": 1,
    "page_size": 20,
    "has_more": false
  }
}
```

**Errors:** `403` not admin.

---

### GET `/api/dynamic-agents/conversations/{id}/messages?agent_id={agent_id}`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `GET /api/v1/conversations/{id}/messages`

**Query:** `agent_id` **required**.

**Response `200`:** Raw JSON from backend (not wrapped in UI Backend API `success/data`), e.g.:

```json
{
  "conversation_id": "conv-uuid",
  "agent_id": "dynamic-agent-1730000000000",
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "Hello",
      "timestamp": "2025-01-01T12:00:00Z"
    },
    {
      "id": "msg-2",
      "role": "assistant",
      "content": "Hi! How can I help?",
      "timestamp": null
    }
  ],
  "has_pending_interrupt": false,
  "interrupt_data": null
}
```

**Errors:** `400` missing `agent_id` or `id`; `403` feature disabled; `500` URL missing; upstream `403`/`404`/etc.

---

### GET `/api/dynamic-agents/conversations/{id}/todos?agent_id={agent_id}`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `GET /api/v1/conversations/{id}/todos`

**Response `200`:**

```json
{
  "conversation_id": "conv-uuid",
  "agent_id": "dynamic-agent-1730000000000",
  "todos": [
    { "content": "Verify cluster health", "status": "in_progress" }
  ]
}
```

---

### GET `/api/dynamic-agents/conversations/{id}/files/list?agent_id={agent_id}`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `GET /api/v1/conversations/{id}/files/list`

**Response `200`:**

```json
{
  "conversation_id": "conv-uuid",
  "agent_id": "dynamic-agent-1730000000000",
  "files": ["/notes/plan.md", "/scratch/output.txt"]
}
```

---

### GET `/api/dynamic-agents/conversations/{id}/files/content?agent_id={agent_id}&path={path}`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `GET /api/v1/conversations/{id}/files/content`

**Query:** `agent_id`, `path` (file path in agent virtual FS) **required**.

**Response `200`:**

```json
{
  "conversation_id": "conv-uuid",
  "path": "/notes/plan.md",
  "content": "# Plan\n\nStep one..."
}
```

---

### DELETE `/api/dynamic-agents/conversations/{id}/files/content?agent_id={agent_id}&path={path}`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `DELETE` same backend path

**Response `200`:**

```json
{
  "success": true,
  "data": { "deleted": "/notes/plan.md" }
}
```

---

### POST `/api/dynamic-agents/conversations/{id}/clear`

**Auth:** Session (authenticated); **backend enforces admin** | **Service:** UI Backend API → `POST /api/v1/conversations/{id}/clear`

Clears LangGraph checkpoint rows for the thread; keeps conversation metadata. Non-admin sessions receive **`403`** from the Dynamic Agents service.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "conversation_id": "conv-uuid",
    "checkpoints_deleted": 12,
    "writes_deleted": 48
  }
}
```

**Errors:** `404` conversation not found; `403` access denied / not admin; `503` DB.

---

## MCP Server Management (CRUD, probe)

### GET `/api/mcp-servers`

**Auth:** Session (**admin**) | **Service:** UI Backend API (MongoDB)

**Response `200`:** Paginated `mcp_servers` documents (same envelope as dynamic-agents list).

**Errors:** `403` not admin.

---

### POST `/api/mcp-servers`

**Auth:** Session (**admin**) | **Service:** UI Backend API → `POST /api/v1/mcp-servers`

**Request body:**

```json
{
  "id": "github-mcp",
  "name": "GitHub MCP",
  "description": "GitHub tools",
  "transport": "sse",
  "endpoint": "http://localhost:3333/sse",
  "enabled": true
}
```

Stdio example fields: `command`, `args`, `env`.

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "_id": "github-mcp",
    "name": "GitHub MCP",
    "transport": "sse",
    "endpoint": "http://localhost:3333/sse",
    "enabled": true,
    "config_driven": false,
    "created_at": "2025-01-01T12:00:00.000Z",
    "updated_at": "2025-01-01T12:00:00.000Z"
  }
}
```

**Errors:** `409` duplicate id (backend); `400` transport validation.

---

### PUT `/api/mcp-servers?id={server_id}`

**Auth:** Session (**admin**) | **Service:** UI Backend API → `PATCH /api/v1/mcp-servers/{id}`

**Request body (partial):**

```json
{ "enabled": false, "description": "Disabled for maintenance" }
```

**Errors:** `403` config-driven server; `404` not found.

---

### DELETE `/api/mcp-servers?id={server_id}`

**Auth:** Session (**admin**) | **Service:** UI Backend API → `DELETE /api/v1/mcp-servers/{id}`

**Response `200`:**

```json
{
  "success": true,
  "data": { "deleted": "github-mcp" }
}
```

---

### POST `/api/mcp-servers/probe?id={server_id}`

**Auth:** Session (**admin**) | **Service:** UI Backend API → `POST /api/v1/mcp-servers/{id}/probe`

Verifies server exists in MongoDB, `enabled`, then probes via Dynamic Agents service.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "server_id": "github-mcp",
    "success": true,
    "tools": [
      {
        "name": "list_prs",
        "namespaced_name": "github-mcp_list_prs",
        "description": "List pull requests"
      }
    ]
  }
}
```

On probe failure (connection, etc.) the UI Backend API still returns `200` with `success: false` inside `data`:

```json
{
  "success": true,
  "data": {
    "server_id": "github-mcp",
    "success": false,
    "error": "Connection refused",
    "tools": []
  }
}
```

**Errors:** `400` disabled server; `404` server not found; `503` dynamic agents unreachable.

---

## Agent Configurations (system agent configs, seed)

MongoDB collection `agent_configs` (Agent Skills / quick-start templates). Requires MongoDB.

### GET `/api/agent-configs`

**Auth:** Session (authenticated) | **Service:** UI Backend API

- No query: returns **raw array** of visible configs (system, owned, global, team-shared)—**not** `{ success, data }`.
- `?id={configId}`: returns **raw single object**.

**Response `200` (list):**

```json
[
  {
    "id": "agent-config-1730000000-abc123",
    "name": "My workflow",
    "category": "DevOps",
    "description": "Custom skill",
    "tasks": [
      {
        "display_text": "Step 1",
        "llm_prompt": "Do X with ${REPO}",
        "subagent": "github"
      }
    ],
    "owner_id": "alice@example.com",
    "is_system": false,
    "visibility": "private",
    "created_at": "2025-01-01T12:00:00.000Z",
    "updated_at": "2025-01-01T12:00:00.000Z"
  }
]
```

**Errors:** `503` MongoDB not configured; `404` unknown id.

---

### POST `/api/agent-configs`

**Auth:** Session (authenticated) | **Service:** UI Backend API

**Request body:**

```json
{
  "name": "Onboard service",
  "category": "DevOps",
  "description": "Steps to onboard",
  "tasks": [
    {
      "display_text": "Create repo",
      "llm_prompt": "Create a repository named {{name}}",
      "subagent": "github"
    }
  ],
  "visibility": "team",
  "shared_with_teams": ["507f1f77bcf86cd799439011"]
}
```

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "agent-config-1730000000-xyz789",
    "message": "Agent config created successfully"
  }
}
```

**Errors:** `400` validation; `503` no MongoDB.

---

### PUT `/api/agent-configs?id={id}`

**Auth:** Session (authenticated; system configs **admin only**) | **Service:** UI Backend API

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "agent-config-1730000000-xyz789",
    "message": "Agent config updated successfully"
  }
}
```

**Errors:** `403` permission; `404` not found.

---

### DELETE `/api/agent-configs?id={id}`

**Auth:** Session (authenticated) | **Service:** UI Backend API

System/built-in configs cannot be deleted (`403`).

---

### GET `/api/agent-configs/seed`

**Auth:** None required | **Service:** UI Backend API

**Response `200`:**

```json
{
  "needsSeeding": true,
  "existingCount": 2,
  "templateCount": 5,
  "message": "3 templates need to be seeded"
}
```

If MongoDB is not configured, `needsSeeding` is `false` and a message explains in-memory templates.

---

### POST `/api/agent-configs/seed`

**Auth:** Optional (attempts session; seeding runs even if unauthenticated for initial setup) | **Service:** UI Backend API

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "message": "Successfully seeded 3 templates (0 removed)",
    "seeded": 3,
    "skipped": 2,
    "removed": 0
  }
}
```

**Errors:** `503` MongoDB not configured.

---

## Tools & Models

### GET `/api/dynamic-agents/builtin-tools`

**Auth:** None | **Service:** UI Backend API → `GET /api/v1/builtin-tools`

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "fetch_url",
      "name": "Fetch URL",
      "description": "HTTP fetch with domain controls",
      "enabled_by_default": false,
      "config_fields": [
        {
          "name": "allowed_domains",
          "type": "string",
          "label": "Allowed domains",
          "description": "Comma-separated patterns",
          "default": "*",
          "required": false
        }
      ]
    }
  ]
}
```

**Errors:** `500` URL not configured / backend error.

---

### GET `/api/dynamic-agents/models`

**Auth:** Session (authenticated) | **Service:** UI Backend API → `GET /api/v1/llm-models`

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "model_id": "claude-sonnet-4-20250514",
      "name": "Claude Sonnet 4",
      "provider": "anthropic-claude",
      "description": "Balanced coding and reasoning"
    }
  ]
}
```

---

## Dynamic Agents Backend API (FastAPI direct endpoints)

Base URL: service root (e.g. `http://localhost:8100`). JSON unless streaming.

Auth: Bearer JWT from identity provider (same token the UI forwards); admin vs user enforced per route.

### GET `/healthz`

**Auth:** None | **Service:** Dynamic Agents

**Response `200`:**

```json
{
  "status": "healthy",
  "timestamp": 1730000000,
  "details": {},
  "config": {
    "mongodb_database": "caipe",
    "collections": {
      "dynamic_agents": "dynamic_agents",
      "mcp_servers": "mcp_servers"
    },
    "agent_runtime_ttl_seconds": 300
  }
}
```

---

### GET `/readyz`

**Auth:** None

**Response `200`:** `{ "ready": true }` or `{ "ready": false, "error": "MongoDB not connected" }`.

---

### GET `/`

Service banner.

**Response `200`:**

```json
{
  "service": "dynamic-agents",
  "version": "0.1.0",
  "docs": "/docs"
}
```

---

### Agents configuration

Dynamic Agents no longer exposes `/api/v1/agents` CRUD routes. The Web UI BFF owns agent
configuration writes through `/api/dynamic-agents` and persists agent metadata directly,
including OpenFGA relationship reconciliation. The Dynamic Agents service remains the
runtime reader for chat, conversation, file, MCP, built-in tool, assistant, and middleware
routes.

---

### Chat (`/api/v1/chat`)

**POST `/api/v1/chat/start-stream`**

**Request body:**

```json
{
  "message": "Hello",
  "conversation_id": "thread-id",
  "agent_id": "dynamic-agent-1730000000000",
  "trace_id": "optional-langfuse-id"
}
```

**Response:** SSE (`text/event-stream`).

**POST `/api/v1/chat/resume-stream`**

**Request body:**

```json
{
  "conversation_id": "thread-id",
  "agent_id": "dynamic-agent-1730000000000",
  "form_data": "{}",
  "trace_id": null
}
```

**Response:** SSE.

**POST `/api/v1/chat/invoke`** — non-streaming; returns:

```json
{
  "success": true,
  "content": "Full assistant text...",
  "tool_calls": [],
  "agent_id": "dynamic-agent-1730000000000",
  "conversation_id": "thread-id",
  "trace_id": null
}
```

**POST `/api/v1/chat/restart-runtime`**

**Request body:** `{ "agent_id", "session_id" }` — response matches UI Backend API example above.

---

### Conversations (`/api/v1/conversations`)

| Method | Path | Query | Notes |
|--------|------|-------|--------|
| GET | `/{conversation_id}/messages` | `agent_id` | `ConversationMessagesResponse` |
| GET | `/{conversation_id}/todos` | `agent_id` | Todos from checkpoint |
| GET | `/{conversation_id}/files/list` | `agent_id` | Path list |
| GET | `/{conversation_id}/files/content` | `agent_id`, `path` | File body |
| DELETE | `/{conversation_id}/files/content` | `agent_id`, `path` | `ApiResponse` |
| POST | `/{conversation_id}/metadata` | `agent_id` | Upsert sidebar metadata |
| POST | `/{conversation_id}/clear` | — | **Admin** — clear checkpoints |

**POST metadata response:**

```json
{
  "success": true,
  "conversation_id": "conv-uuid",
  "created": true
}
```

---

### MCP servers (`/api/v1/mcp-servers`)

Admin-only list/create/get/patch/delete; probe returns `MCPServerProbeResult` (`server_id`, `success`, `tools?`, `error?`).

---

### Builtin tools & LLM models

- **GET `/api/v1/builtin-tools`** — `{ "success": true, "data": { "tools": [ ... ] } }` (no auth).
- **GET `/api/v1/llm-models`** — `ApiResponse` with `data` as array of model descriptors.

---

OpenAPI / interactive docs are available at **`/docs`** on the Dynamic Agents service when it is running.
