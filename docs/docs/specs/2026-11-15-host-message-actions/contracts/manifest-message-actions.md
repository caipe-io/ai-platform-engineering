# Contract: Manifest `messageActions`

Location: `ui.assistant.hostOptions.messageActions`. Not allowed when `ui.assistant.overlay` is `"app"`.

## Example

```json
{
  "ui": {
    "assistant": {
      "agentId": "example-agent",
      "overlay": "host",
      "streamPath": "/api/assistant/stream",
      "hostOptions": {
        "version": "1.0",
        "requireConfiguration": true,
        "messageActions": [
          {
            "id": "flag-answer",
            "label": "Flag answer",
            "icon": "flag",
            "path": "/api/assistant/actions/flag",
            "dialog": {
              "title": "Flag this answer",
              "description": "Edit the text to give a corrected answer.",
              "submitLabel": "Submit",
              "field": { "label": "Corrected answer", "prefill": "message", "optional": true, "maxLength": 60000 }
            }
          }
        ]
      }
    }
  }
}
```

## Validation (rejects with an error)

| Rule | Reject when |
|---|---|
| Key allowlist | Any key not listed in the data model |
| Count | More than 4 actions |
| Ids | Not `identifier()`-valid, or duplicate |
| Label | Empty or over 24 chars |
| Icon | Not in the host list |
| Path | Fails the `streamPath` rules: safe path, starts with `/api/`, app runtime declared, allowed `POST` policy covers it |
| Dialog | Missing a required field, or `prefill` not `message`/`empty` |
| `maxLength` | Not an integer in 1..60000 |
| Host support | Older host: unknown key rejected |

## Notes

- Declarative only. No code, markup or URLs in any field.
- Labels and dialog text are rendered as plain text.
