# Contract: App Action Endpoint

Host BFF to the app, at the manifest's `path`.

## Request

`POST <path>` with the same identity and auth mode as the app's assistant stream.

```json
{
  "conversation_id": "string",
  "message_id": "string",
  "turn_id": "string",
  "action_id": "string",
  "text": "string"
}
```

- `text` is present only when the user submitted a field value.
- `turn_id` comes from the stored message, not from the browser.
- `Content-Type: application/json`. Body size is bounded by the host.

## Response

- Success: any 2xx with `Content-Type: application/json`. A body such as `{ "message": "Saved" }` is passed through.
- Failure: non-2xx with JSON `{ "error": "<user-safe text>", "code": "<stable code>" }`.
- Redirects are not followed. A non-JSON response is a failure.
- The host aborts the call at about 30 s.

## App obligations

- Re-check the caller on every call. The host's visibility flag is cosmetic.
- Treat `text` as untrusted input.
- Should be safe to call twice for the same message; the host does not dedupe.
- Return `error` text that is safe to show to the user.
