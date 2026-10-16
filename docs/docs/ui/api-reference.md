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
| MongoDB | `MONGODB_URI`, `MONGODB_DATABASE` |
| RAG server | `RAG_SERVER_URL` |
| Slack bot admin API | configured bot admin URL/token |
| Webex bot admin API | configured bot admin URL/token |

## Chat Routes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/v1/chat/stream/start` | Start an agent SSE stream; Webex can route to an installed app assistant with a declared AG-UI stream path |
| `POST` | `/api/v1/chat/stream/resume` | Resume a HITL/interrupted stream |
| `POST` | `/api/v1/chat/stream/cancel` | Cancel an active stream |
| `POST` | `/api/v1/chat/invoke` | Non-streaming Dynamic Agents invocation |

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
