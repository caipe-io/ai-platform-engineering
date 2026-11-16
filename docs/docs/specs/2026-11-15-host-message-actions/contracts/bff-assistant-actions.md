# Contract: `POST /api/v1/chat/assistant-actions`

Browser to host BFF.

## Request

```json
{
  "conversation_id": "string",
  "agent_id": "string",
  "message_id": "string",
  "action_id": "string",
  "input": { "text": "string" }
}
```

- `input` and `input.text` are optional.
- Same-origin session auth or bearer token, as the stream routes.
- Any other key, including a path, is ignored or rejected. The client never picks the destination.

## Order of checks

```text
1. authenticate (401)
2. reject service account / missing interactive identity (403)
3. validate body shape and size (400 / 413)
4. agent-use permission (403)
5. conversation write access (403 / 404)
6. agent_id == conversation agent, app installed and enabled (409 / 503)
7. action_id declared by that app (404)
8. client is web UI conversation (403)
9. message_id is a stored assistant message in the conversation (404 / 409)
10. text length <= declared maxLength; required field not empty (400)
11. call app, write audit event, map result
```

## Responses

| Status | Body | When |
|---|---|---|
| 200 | `{ "success": true, "data": <app JSON> }` | App returned 2xx JSON |
| 400 | `{ "success": false, "error": "…" }` | Bad body, text rules |
| 401 | `{ "error": "…" }` | Not authenticated |
| 403 | `{ "error": "…" }` | Service account, no access, wrong client |
| 404 | `{ "error": "…" }` | Unknown action or message, or non-owner |
| 409 | `{ "error": "…" }` | Agent mismatch, message is not an assistant message |
| 413 | `{ "error": "…" }` | Body over limit |
| 502 | `{ "error": "…", "code": "ASSISTANT_ACTION_BAD_RESPONSE" }` | Non-JSON, redirect |
| 504 | `{ "error": "…", "code": "ASSISTANT_ACTION_TIMEOUT" }` | About 30 s |
| app 4xx (not 401) | `{ "success": false, "error": "<app text>", "code": "<app code>" }`, same status | App returned a JSON error. `error` is cut at 300 chars. `code` must match `[A-Za-z0-9_.-]{1,64}`, else `ASSISTANT_ACTION_FAILED`. |
| app 401 or 5xx | same body, status 502 | Never shown as an expired host session |
| host refused the app call | 403 `ASSISTANT_ACTION_FORBIDDEN`, or 502 `ASSISTANT_ACTION_UNAVAILABLE` | The proxy's own reason stays server-side |

## Audit

- One event per call that reaches step 11, including failures.
- Event type `auth` (kept at every audit verbosity level), action `assistant.message_action`.
- Fields: app id, action id, conversation id, hashed caller subject, outcome, reason code.
- Never the text.
