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

## Notifications

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/notifications` | Current user's inbox, paged, with unread count |
| `PATCH` | `/api/notifications/{id}` | Mark one notification read |
| `POST` | `/api/notifications/read-all` | Mark all notifications read |
| `GET` | `/api/settings/notification-preferences` | Effective event preferences for the current user |
| `PATCH` | `/api/settings/notification-preferences` | Set or clear category and event overrides |

`PATCH` accepts `{ "categories": {...}, "events": {...} }`. Each value is `true`, `false`, or `null`. `null` removes the override. An event then uses its category setting, if present, followed by its catalog default. Unknown keys are rejected with `400`. Concurrent edits are merged safely. If the settings keep changing under the request, it returns `409`.

## Internal Service Routes

These routes are for other CAIPE services, not browsers. They are not part of the user-facing API.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/internal/notifications/events` | `Authorization: Bearer $NOTIFICATIONS_INTERNAL_TOKEN` | Publish one notification event |

Responses:

| Status | Meaning |
|---|---|
| `202` | Accepted. Body: `{ recipients, skipped, rejected, results: { delivered, queued, disabled, invalid, failed } }`. `skipped` counts recipients with no matching user. `rejected` counts recipients whose subject and email name different users. |
| `400` | Envelope invalid. Nothing was published. |
| `401` | Missing or wrong token |
| `503` | Token not configured, or delivery failed. Safe to retry. |

Example:

```bash
curl -X POST http://caipe-ui:3000/api/internal/notifications/events \
  -H "Authorization: Bearer $NOTIFICATIONS_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "evt-example-1",
    "type": "ingestion.completed",
    "version": 1,
    "occurred_at": "2026-10-14T10:00:00Z",
    "resource": { "type": "datasource", "id": "example-source" },
    "attempt_id": "job-example-1",
    "recipient_subject": "example-subject",
    "recipient_email": "test-user@example.com",
    "data": { "status": "completed", "title": "Ingestion finished", "summary": "Example source finished indexing.", "href": "/knowledge-bases" }
  }'
```

Envelope fields are documented in `ui/src/lib/notifications/envelope.ts`. The event catalog is in `ui/src/lib/notifications/taxonomy.ts`.

Route files under `ui/src/app/api` are the implementation source of truth.

### Native app chat activity

`POST /api/v1/chat/stream/status` accepts `{conversation_id, agent_id}` and routes
to an installed app's declared assistant status endpoint. It requires the same
conversation-write and agent-use permissions as stream start. Unsupported
runtimes return 501; app failures never fall back to another runtime.

### App notification registration and user delivery

| Endpoint | Caller | Purpose |
|---|---|---|
| `POST /api/notifications/registrations` | Bound app service account with `host.notifications` | Register the app's notification types |
| `POST /api/notifications` | Same app service account | Queue a registered notification type for named users |
| `GET/PATCH /api/notifications/subscriptions` | Current user | Read or update global, source, or event choices; pause/resume and quiet hours |
| `POST/DELETE /api/notifications/push-subscriptions` | Current user | Add or remove an owned browser subscription |
| `POST /api/notifications/push-receipts` | Current user | Record browser display for an owned, unexpired web-push delivery |
| `GET /api/notifications/channels` | Current user | Read channel availability without exposing provider identifiers |
| `POST /api/notifications/test` | Current user | Queue a test for an enabled channel; limited to three per minute |
| `GET /api/notifications/deliveries` | Current user | Read the last 50 delivery statuses |
| `POST /api/notifications/deliveries/:id/retry` | Delivery owner | Retry an unexpired failed delivery |

Subscription patches accept `sourceId` and `eventType` (default `*`), plus
`enabled`, `pausedUntil` (ISO timestamp or `null`), `channels`, and `quietHours`.
Channel names are `in_app`, `web_push`, `webex`, and `slack`. Quiet hours use
`enabled`, `start` and `end` (`HH:mm`), and an IANA `timeZone`.
A source/event override cannot enable an external channel disabled globally.
