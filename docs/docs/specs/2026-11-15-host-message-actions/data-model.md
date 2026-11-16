# Data Model: App-Declared Message Actions

No persisted data is added. All entities are manifest data, in-memory state, or request payloads.

## MessageActionDeclaration (manifest)

| Field | Type | Rule |
|---|---|---|
| `id` | string | `identifier()` rule; unique within the app |
| `label` | string | 1-24 chars |
| `icon` | enum | Host-defined list |
| `path` | string | App-relative; same path rules as `streamPath` |
| `dialog` | `ActionDialog` | Optional |

- Max 4 per app.
- Unknown keys rejected.

## ActionDialog (manifest)

| Field | Type | Rule |
|---|---|---|
| `title` | string | Required, bounded text |
| `description` | string | Optional, bounded text |
| `submitLabel` | string | Required, bounded text |
| `field.label` | string | Required, bounded text |
| `field.prefill` | `"message"` or `"empty"` | Required |
| `field.optional` | boolean | Required |
| `field.maxLength` | integer | 1 to 60000 |

## ActionEnablement (runtime, per user)

- Shape: `messageActions?: Record<actionId, { visible: boolean }>` inside `AssistantConfiguration`.
- Keys must match declared ids; unknown keys fail validation.
- Default for every declared action: hidden.
- Cleared on unmount and account change.
- Not an authorization grant.

## ActionRequest (browser to BFF)

| Field | Type | Rule |
|---|---|---|
| `conversation_id` | string | Required |
| `agent_id` | string | Required; must equal the conversation's agent |
| `message_id` | string | Required; must be a stored assistant message |
| `action_id` | string | Required; must be declared |
| `input.text` | string | Optional; at most the declared `maxLength` |

- No path, app id or `turn_id` accepted from the client.

## ActionCall (BFF to app)

- Body: `{ conversation_id, message_id, turn_id, action_id, text? }`.
- `turn_id` comes from the stored message.

## ActionResult

- Success: JSON object, any 2xx.
- Failure: `{ error, code }`.

## State: one action on one message in the UI

```text
hidden ──(enabled + finished assistant message)──> idle
idle ──(click, no dialog)──> pending
idle ──(click, dialog)──> dialog-open ──(submit)──> pending ──> success | error
dialog-open ──(cancel)──> idle
success | error ──> idle
```

- `pending` blocks resubmission.
