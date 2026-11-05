---
sidebar_position: 5
---

# UI API Reference

The CAIPE UI API is a Next.js BFF. It serves browser requests, enforces
UI-facing authz, persists UI data in MongoDB, and proxies selected backend
services.

## Backend Services

| Service | Configuration |
|---|---|
| Dynamic Agents | `DYNAMIC_AGENTS_URL` |
| Harness Engine | `HARNESS_ENGINE_URL`, `HARNESS_ENGINE_INTERNAL_TOKEN` |
| MongoDB | `MONGODB_URI`, `MONGODB_DATABASE` |
| RAG server | `RAG_SERVER_URL` |
| Slack bot admin API | configured bot admin URL/token |
| Webex bot admin API | configured bot admin URL/token |

## Chat Routes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/v1/chat/stream/start` | Start a declared AG-UI app stream, or dispatch through the pinned native/provider Harness Gateway |
| `POST` | `/api/v1/chat/stream/resume` | Resume a declared app stream or native interrupt; unsupported app resume returns 501 and unsupported provider resume returns 409 |
| `POST` | `/api/v1/chat/stream/cancel` | Cancel through the declared app endpoint or the pinned native/provider runtime; unsupported app cancel returns 501 |
| `POST` | `/api/v1/chat/stream/status` | Observe a declared app's turn status; unsupported runtimes return 501 |
| `POST` | `/api/v1/chat/invoke` | Non-streaming native/provider invocation; app-owned assistants require their declared stream endpoints |

All stream operations share one dispatcher after agent-use and conversation-write
authorization. Installed app declarations select the app proxy with the same
authenticated caller and original conversation ID. A claimed app operation,
including its errors and denials, never dispatches to another runtime.

Other start/resume/cancel requests resolve the server-owned runtime conversation
ID and the Harness Gateway's pinned backend. Dynamic Agents configuration is
required only for a native request. Provider execution keeps its detached run
and cursor replay contract; app streams retain their own deadlines and sessions.

Example:

```bash
curl -N -X POST http://localhost:3000/api/v1/chat/stream/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "message": "Check production ArgoCD apps",
    "conversation_id": "conv-123",
    "agent_id": "platform-engineer"
  }'
```

## Health And Config

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | UI process health |
| `GET` | `/api/version` | Build metadata |
| `GET` | `/api/config` | Client-visible UI config |
| `GET` | `/api/admin/platform-config` | Admin-managed runtime defaults |

## Skills

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/skills` | List catalog skills |
| `POST` | `/api/skills` | Create or update a skill |
| `GET` | `/api/skills/install.sh` | Render local install script |
| `POST` | `/api/catalog-api-keys` | Mint catalog API key |

## Dynamic Agent Admin

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/dynamic-agents/available` | List chat-capable agents |
| `GET` | `/api/dynamic-agents/configs` | List agent configs |
| `POST` | `/api/dynamic-agents/configs` | Create agent config |

Route files under `ui/src/app/api` are the implementation source of truth.

### Native app chat activity

`POST /api/v1/chat/stream/status` accepts `{conversation_id, agent_id}` and routes
to an installed app's declared assistant status endpoint. It requires the same
conversation-write and agent-use permissions as stream start. Unsupported
runtimes return 501; app failures never fall back to another runtime.
