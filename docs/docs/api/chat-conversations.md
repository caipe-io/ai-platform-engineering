---
sidebar_position: 4
---

# Chat & Conversations API

Next.js App Router UI Backend API routes under `/api/chat/*`. All endpoints use **NextAuth session cookies** (or equivalent session) unless noted. Successful JSON bodies wrap payloads in `{ "success": true, "data": ... }`. Paginated list endpoints use `data.items`, `data.total`, `data.page`, `data.page_size`, and `data.has_more`. Errors return `{ "success": false, "error": "...", "code": "..." }` when `code` is set.

Base path: **`/api/chat`**

---

## Conversations

### GET `/api/chat/conversations`

**Auth:** Session (authenticated) | **Since:** v1.0

Lists conversations the user can access: owned by them, shared by email, shared via teams they belong to, or marked public. Excludes soft-deleted rows (`deleted_at` unset or null). Sorted by `is_pinned` desc, then `updated_at` desc.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default `1`, must be ≥ 1) |
| `page_size` | integer | No | Page size (default `20`, max `100`) |
| `archived` | string | No | When `true`, only archived conversations (`is_archived: true`). Otherwise only non-archived. |
| `pinned` | string | No | When `true`, only pinned conversations (`is_pinned: true`) |

**Request Body:**

_Not applicable_

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "title": "Platform deploy checklist",
        "owner_id": "alice@example.com",
        "agent_id": "platform-engineer",
        "created_at": "2026-03-20T14:22:00.000Z",
        "updated_at": "2026-03-25T09:15:00.000Z",
        "metadata": {
          "agent_version": "0.1.0",
          "model_used": "gpt-4o",
          "total_messages": 12
        },
        "sharing": {
          "is_public": false,
          "shared_with": ["bob@example.com"],
          "shared_with_teams": [],
          "share_link_enabled": false
        },
        "tags": ["infra", "deploy"],
        "is_archived": false,
        "is_pinned": true
      }
    ],
    "total": 42,
    "page": 1,
    "page_size": 20,
    "has_more": true
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid `page` / `page_size` |
| 503 | `MONGODB_NOT_CONFIGURED` | MongoDB not configured |

---

### POST `/api/chat/conversations`

**Auth:** NextAuth session or service bearer token + dynamic-agent `can_use`. | **Since:** v1.0

Creates a conversation for a specific dynamic agent. Server sets `owner_id` from the session, timestamps, default `metadata`, `sharing`, `is_archived`, and `is_pinned`. Optional client `id` (UUID) is accepted so client and server share the same `_id`.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

```json
{
  "title": "New chat",
  "id": "optional-client-uuid-v4",
  "tags": ["support"],
  "agent_id": "platform-engineer"
}
```

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "title": "New chat",
    "owner_id": "alice@example.com",
    "agent_id": "platform-engineer",
    "created_at": "2026-03-25T10:00:00.000Z",
    "updated_at": "2026-03-25T10:00:00.000Z",
    "metadata": {
      "agent_version": "0.1.0",
      "model_used": "gpt-4o",
      "total_messages": 0
    },
    "sharing": {
      "is_public": false,
      "shared_with": [],
      "shared_with_teams": [],
      "share_link_enabled": false
    },
    "tags": ["support"],
    "is_archived": false,
    "is_pinned": false
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | `VALIDATION_ERROR` | Missing required field `title` |
| 503 | `MONGODB_NOT_CONFIGURED` | MongoDB not configured |

---

### GET `/api/chat/conversations/[id]`

**Auth:** Session (authenticated) | **Since:** v1.0

Returns one conversation if the user is owner, share recipient (email/team/public rules), has a `sharing_access` grant, or has admin audit read access. Response includes `access_level`.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

_Not applicable_

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Shared design review",
    "owner_id": "bob@example.com",
    "created_at": "2026-03-18T11:00:00.000Z",
    "updated_at": "2026-03-24T16:30:00.000Z",
    "metadata": {
      "agent_version": "0.1.0",
      "model_used": "gpt-4o",
      "total_messages": 5
    },
    "sharing": {
      "is_public": false,
      "shared_with": ["alice@example.com"],
      "shared_with_teams": [],
      "share_link_enabled": false
    },
    "tags": [],
    "is_archived": false,
    "is_pinned": false,
    "access_level": "shared"
  }
}
```

`access_level` is one of: `owner`, `shared`, `shared_readonly`, `admin_audit`.

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid conversation ID (not UUID) |
| 403 | `FORBIDDEN` | No access to conversation |
| 404 | `NOT_FOUND` | Conversation not found |
| 503 | `MONGODB_NOT_CONFIGURED` | MongoDB not configured |

---

### PUT `/api/chat/conversations/[id]`

**Auth:** Session (authenticated) | **Since:** v1.0

Updates conversation fields. **Owner only.**

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

```json
{
  "title": "Renamed chat",
  "tags": ["infra", "urgent"],
  "is_archived": false,
  "is_pinned": true
}
```

All fields optional; only provided fields are updated. `updated_at` is set server-side.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Renamed chat",
    "owner_id": "alice@example.com",
    "created_at": "2026-03-20T14:22:00.000Z",
    "updated_at": "2026-03-25T10:05:00.000Z",
    "metadata": {
      "agent_version": "0.1.0",
      "model_used": "gpt-4o",
      "total_messages": 12
    },
    "sharing": {
      "is_public": false,
      "shared_with": [],
      "shared_with_teams": [],
      "share_link_enabled": false
    },
    "tags": ["infra", "urgent"],
    "is_archived": false,
    "is_pinned": true
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid conversation ID |
| 403 | `FORBIDDEN` | Not the owner |
| 404 | — | Conversation not found |
| 503 | `MONGODB_NOT_CONFIGURED` | MongoDB not configured |

---

### DELETE `/api/chat/conversations/[id]`

**Auth:** Session (authenticated) | **Since:** v1.0

Soft-deletes by default (`deleted_at` set, `is_archived: true`). With `permanent=true`, permanently deletes the conversation and its associated platform records through the same lifecycle as retention cleanup. **Owner only.**

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `permanent` | string | No | `true` = permanent delete (conversation + messages) |

**Request Body:**

_Not applicable_

**Response `200` (soft delete):**

```json
{
  "success": true,
  "data": {
    "deleted": true,
    "permanent": false
  }
}
```

**Response `200` (permanent delete):**

```json
{
  "success": true,
  "data": {
    "deleted": true,
    "permanent": true
  }
}
```

**Response `202` (permanent cleanup accepted):**

If another replica already holds the cleanup claim, or bounded file/relationship
cleanup needs another pass, deletion continues in the background:

```json
{
  "success": true,
  "data": {
    "deleted": false,
    "permanent": true,
    "pending": true
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid conversation ID |
| 403 | `FORBIDDEN` | Not the owner |
| 404 | — | Conversation not found |
| 409 | `CONVERSATION_CHANGED` | The conversation was restored or changed before the deletion claim; reload before retrying |
| 503 | `MONGODB_NOT_CONFIGURED` | MongoDB not configured |

---

### GET `/api/chat/shared`

**Auth:** Session (authenticated) | **Since:** v1.0

Paginated list of conversations **not** owned by the caller but shared with them (direct email, team membership, or `is_public`), sorted by `updated_at` descending.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default `1` |
| `page_size` | integer | No | Default `20`, max `100` |

**Request Body:**

_Not applicable_

**Response `200`:**

Same shape as GET `/api/chat/conversations` (paginated `items` of `Conversation` documents).

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid pagination |

---

## Messages

### GET `/api/chat/conversations/[id]/messages`

**Auth:** Session (authenticated) | **Since:** v1.0

Paginated messages for a conversation, oldest first (`created_at` ascending). Requires conversation access (same rules as GET conversation).

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default `1` |
| `page_size` | integer | No | Default `20`, max `100` |

**Request Body:**

_Not applicable_

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "_id": "674a1b2c3d4e5f6789abcdef",
        "message_id": "msg-uuid-client-0001",
        "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "owner_id": "alice@example.com",
        "role": "user",
        "content": "Summarize the last incident.",
        "sender_email": "alice@example.com",
        "sender_name": "Alice",
        "created_at": "2026-03-25T10:01:00.000Z",
        "updated_at": "2026-03-25T10:01:00.000Z",
        "metadata": {
          "turn_id": "turn-1711360860000",
          "model": "gpt-4o",
          "is_final": true
        }
      },
      {
        "_id": "674a1b2c3d4e5f6789abcdf0",
        "message_id": "msg-uuid-client-0002",
        "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "owner_id": "alice@example.com",
        "role": "assistant",
        "content": "Here is a concise summary…",
        "created_at": "2026-03-25T10:01:05.000Z",
        "updated_at": "2026-03-25T10:01:08.000Z",
        "metadata": {
          "turn_id": "turn-1711360865000",
          "agent_name": "Platform Engineer",
          "is_final": true
        },
        "stream_events": [],
        "artifacts": []
      }
    ],
    "total": 2,
    "page": 1,
    "page_size": 20,
    "has_more": false
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid conversation ID |
| 403 | `FORBIDDEN` | No access |
| 404 | `NOT_FOUND` | Conversation not found |

---

### POST `/api/chat/conversations/[id]/messages`

**Auth:** NextAuth session + conversation write access. | **Since:** v1.0

Upserts a message by `(message_id, conversation_id)`. If the row exists, content/metadata/events are updated and `200` is returned; on first insert, `201` and `metadata.total_messages` on the conversation may increment. **Blocked** for `access_level` `admin_audit` or `shared_readonly` (`403`). For `role: "user"`, sender fields default from the session if omitted.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

```json
{
  "message_id": "msg-uuid-client-0002",
  "role": "assistant",
  "content": "Updated streaming content…",
  "sender_email": "alice@example.com",
  "sender_name": "Alice",
  "metadata": {
    "turn_id": "turn-1711360865000",
    "model": "gpt-4o",
    "tokens_used": 1200,
    "latency_ms": 840,
    "agent_name": "Platform Engineer",
    "is_final": false,
    "timeline_segments": []
  },
  "stream_events": [],
  "artifacts": []
}
```

Required: `role`, `content`. Optional: `message_id`, sender fields, `metadata`, `stream_events`, `artifacts`.

**Response `201` (new message):**

```json
{
  "success": true,
  "data": {
    "_id": "674a1b2c3d4e5f6789abcdf0",
    "message_id": "msg-uuid-client-0002",
    "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "owner_id": "alice@example.com",
    "role": "assistant",
    "content": "Updated streaming content…",
    "created_at": "2026-03-25T10:01:05.000Z",
    "updated_at": "2026-03-25T10:01:08.000Z",
    "metadata": {
      "turn_id": "turn-1711360865000",
      "model": "gpt-4o",
      "tokens_used": 1200,
      "latency_ms": 840,
      "agent_name": "Platform Engineer",
      "is_final": false
    }
  }
}
```

**Response `200` (updated existing):**

Same `success` / `data` shape with updated fields.

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid conversation ID or `VALIDATION_ERROR` (missing `role` / `content`) |
| 403 | `FORBIDDEN` | Read-only access |
| 404 | `NOT_FOUND` | Conversation not found |

---

### PUT `/api/chat/messages/[id]`

**Auth:** Session (authenticated) | **Since:** v1.0

Updates a message by MongoDB `_id` (24-hex ObjectId) **or** client `message_id` (UUID). At least one updatable field should be provided; empty body returns the existing message unchanged.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | MongoDB `_id` or `message_id` UUID |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

```json
{
  "feedback": {
    "rating": "positive",
    "comment": "Helpful summary"
  },
  "content": "Final assistant text after stream",
  "metadata": {
    "is_final": true,
    "is_interrupted": false,
    "task_id": "task-abc-123"
  },
  "stream_events": []
}
```

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "_id": "674a1b2c3d4e5f6789abcdf0",
    "message_id": "msg-uuid-client-0002",
    "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "role": "assistant",
    "content": "Final assistant text after stream",
    "created_at": "2026-03-25T10:01:05.000Z",
    "updated_at": "2026-03-25T10:02:00.000Z",
    "metadata": {
      "turn_id": "turn-1711360865000",
      "is_final": true,
      "is_interrupted": false,
      "task_id": "task-abc-123"
    },
    "feedback": {
      "rating": "positive",
      "comment": "Helpful summary",
      "submitted_at": "2026-03-25T10:02:00.000Z",
      "submitted_by": "alice@example.com"
    }
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 404 | — | Message not found |

---

## Sharing

### GET `/api/chat/conversations/[id]/share`

**Auth:** Session (authenticated) | **Since:** v1.0

Returns the conversation `sharing` object and active `sharing_access` rows (not revoked). **Owner only.**

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

_Not applicable_

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "sharing": {
      "is_public": false,
      "shared_with": ["bob@example.com"],
      "shared_with_teams": ["674a1b2c3d4e5f6789abcd01"],
      "team_permissions": {
        "674a1b2c3d4e5f6789abcd01": "view"
      },
      "share_link_enabled": false
    },
    "access_list": [
      {
        "_id": "674a1b2c3d4e5f6789abcd02",
        "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "granted_by": "alice@example.com",
        "granted_to": "bob@example.com",
        "permission": "comment",
        "granted_at": "2026-03-22T08:00:00.000Z"
      }
    ]
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid conversation ID |
| 403 | `FORBIDDEN` | Not the owner |
| 404 | — | Conversation not found |

---

### POST `/api/chat/conversations/[id]/share`

**Auth:** Session (authenticated) | **Since:** v1.0

Applies sharing updates. At least one of `user_emails`, `team_ids`, or `is_public` must be provided. **`permission` is required** when sharing with users or teams. Validates emails and team ObjectIds. **Owner only.**

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

```json
{
  "user_emails": ["bob@example.com"],
  "team_ids": ["674a1b2c3d4e5f6789abcd01"],
  "permission": "comment",
  "is_public": false,
  "public_permission": "view",
  "enable_link": true,
  "link_expires": "2026-04-01T00:00:00.000Z"
}
```

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Design review",
    "owner_id": "alice@example.com",
    "sharing": {
      "is_public": false,
      "public_permission": "view",
      "shared_with": ["bob@example.com"],
      "shared_with_teams": ["674a1b2c3d4e5f6789abcd01"],
      "team_permissions": {
        "674a1b2c3d4e5f6789abcd01": "comment"
      },
      "share_link_enabled": true,
      "share_link_expires": "2026-04-01T00:00:00.000Z"
    },
    "tags": [],
    "is_archived": false,
    "is_pinned": false,
    "created_at": "2026-03-18T11:00:00.000Z",
    "updated_at": "2026-03-25T10:10:00.000Z",
    "metadata": {
      "agent_version": "0.1.0",
      "model_used": "gpt-4o",
      "total_messages": 5
    }
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid ID, validation (no share action, missing `permission`, bad email, invalid team id, team not found) |
| 403 | `FORBIDDEN` | Not the owner |
| 404 | — | Conversation or team not found |

---

### PATCH `/api/chat/conversations/[id]/share`

**Auth:** Session (authenticated) | **Since:** v1.0

Updates permission for a **user** (`email`) and/or **team** (`team_id`). `permission` must be `view` or `comment`. **Owner only.**

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

```json
{
  "email": "bob@example.com",
  "team_id": "674a1b2c3d4e5f6789abcd01",
  "permission": "view"
}
```

Provide `email` and/or `team_id` (at least one required alongside `permission`).

**Response `200`:**

Full updated `Conversation` document under `data` (same general shape as POST share response).

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid `permission`, missing `email`/`team_id`, invalid conversation ID |
| 403 | `FORBIDDEN` | Not the owner |
| 404 | — | Conversation not found |

---

## Conversation actions

### GET `/api/chat/conversations/trash`

**Auth:** Session (authenticated) | **Since:** v1.0

Lists **soft-deleted** conversations visible to the current user. Paginated. Listing Trash does not trigger deletion.

MongoDB-backed UI servers enforce the **seven-day** soft-delete retention policy at startup and once a minute, in bounded batches of up to 100 conversations across all owners. The cutoff uses `deleted_at`, not an ordinary `is_archived` toggle. Atomic per-conversation claims coordinate replicas and compete with Restore. Associated platform data and authorization relationships are cleaned before the conversation is removed; partial failures remain eligible for retry after backoff. Production builds and browser-only installations do not run cleanup.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default `1` |
| `page_size` | integer | No | Default `20`, max `100` |

**Request Body:**

_Not applicable_

**Response `200`:**

Paginated `Conversation` items (may include `deleted_at`).

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid pagination |
| 503 | `MONGODB_NOT_CONFIGURED` | MongoDB not configured |

---

### POST `/api/chat/conversations/[id]/archive`

**Auth:** Session (authenticated) | **Since:** v1.0

Toggles `is_archived` for the conversation. **Owner only.**

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

_Not applicable_

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Old sprint notes",
    "owner_id": "alice@example.com",
    "is_archived": true,
    "is_pinned": false,
    "updated_at": "2026-03-25T10:20:00.000Z"
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid conversation ID |
| 403 | `FORBIDDEN` | Not the owner |
| 404 | — | Conversation not found |

---

### POST `/api/chat/conversations/[id]/pin`

**Auth:** Session (authenticated) | **Since:** v1.0

Toggles `is_pinned`. **Owner only.**

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

_Not applicable_

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Pinned incident",
    "owner_id": "alice@example.com",
    "is_pinned": true,
    "is_archived": false,
    "updated_at": "2026-03-25T10:21:00.000Z"
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid conversation ID |
| 403 | `FORBIDDEN` | Not the owner |
| 404 | — | Conversation not found |

---

### POST `/api/chat/conversations/[id]/restore`

**Auth:** Session (authenticated) | **Since:** v1.0

Clears `deleted_at` and sets `is_archived: false` for a soft-deleted conversation. **Owner only.** The update is conditional on the conversation still being soft-deleted and not yet claimed for permanent deletion. A restore that wins the claim race preserves the conversation; once cleanup has claimed it, Restore returns `409 CONVERSATION_PURGING`.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string (UUID) | Yes | Conversation `_id` |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

_Not applicable_

**Response `200`:**

Full restored `Conversation` under `data`.

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid ID, or conversation not in archive (`deleted_at` unset) |
| 403 | `FORBIDDEN` | Not the owner |
| 404 | — | Conversation not found |
| 409 | `CONVERSATION_PURGING` | Permanent deletion has started; the conversation cannot be restored |
| 409 | `CONVERSATION_CHANGED` | The archived state changed concurrently; reload before retrying |

---

## Search

### GET `/api/chat/search`

**Auth:** Session (authenticated) | **Since:** v1.0

Searches conversations where the user is **owner** or in `sharing.shared_with` (does not include team/public-only scope in the query). Optional case-insensitive regex on `title` and `tags`; optional `tags` filter (comma-separated, must match a tag in the array). Sorted by `updated_at` descending.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | No | Search string (title/tags) |
| `tags` | string | No | Comma-separated tags (exact match in `tags` array) |
| `page` | integer | No | Default `1` |
| `page_size` | integer | No | Default `20`, max `100` |

**Request Body:**

_Not applicable_

**Response `200`:**

Paginated list of matching `Conversation` documents (same envelope as other list endpoints).

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid pagination |

---

## Bookmarks

### GET `/api/chat/bookmarks`

**Auth:** Session (authenticated) | **Since:** v1.0

Paginated bookmarks for the current user (`user_id` = session email), newest first.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Default `1` |
| `page_size` | integer | No | Default `20`, max `100` |

**Request Body:**

_Not applicable_

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "_id": "674a1b2c3d4e5f6789abcd99",
        "user_id": "alice@example.com",
        "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "message_id": "msg-uuid-client-0002",
        "note": "Key decision on rollback",
        "created_at": "2026-03-24T12:00:00.000Z"
      }
    ],
    "total": 3,
    "page": 1,
    "page_size": 20,
    "has_more": false
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | — | Invalid pagination |

---

### POST `/api/chat/bookmarks`

**Auth:** Session (authenticated) | **Since:** v1.0

Creates a bookmark for a conversation (optional `message_id` and `note`).

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | — |

**Request Body:**

```json
{
  "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "message_id": "msg-uuid-client-0002",
  "note": "Bookmark this answer"
}
```

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "_id": "674a1b2c3d4e5f6789abcdaa",
    "user_id": "alice@example.com",
    "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "message_id": "msg-uuid-client-0002",
    "note": "Bookmark this answer",
    "created_at": "2026-03-25T10:30:00.000Z"
  }
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | No valid session |
| 400 | `VALIDATION_ERROR` / validation | Missing `conversation_id` or invalid UUID |

---

## Type reference (summary)

| Shape | Fields (high level) |
|-------|---------------------|
| **Conversation** | `_id` (UUID string), `title`, `owner_id`, `agent_id?`, `created_at`, `updated_at`, `metadata`, `sharing`, `tags`, `is_archived`, `is_pinned`, `deleted_at?` |
| **Message** | `_id?` (ObjectId), `message_id?`, `conversation_id`, `owner_id?`, `role`, `content`, `sender_*?`, `created_at`, `updated_at`, `metadata`, `artifacts?`, `stream_events?`, `feedback?` |
| **SharingAccess** | `conversation_id`, `granted_by`, `granted_to`, `permission`, `granted_at`, `accessed_at?`, `revoked_at?` |
| **ConversationBookmark** | `user_id`, `conversation_id`, `message_id?`, `note?`, `created_at` |

Date fields serialize as ISO 8601 strings in JSON responses.
