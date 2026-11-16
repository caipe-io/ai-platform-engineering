# Quickstart: Verify Message Actions

## Prerequisites

- Local UI running (`nvm use`, then the usual dev start from `ui/`).
- A test app with `overlay: "host"`, an agent, and one declared action (see the manifest contract).
- A test endpoint that returns `{ "message": "ok" }` as JSON. Replace host names with `example.test`.

## Manual check

1. Install the test app. The manifest is accepted.
2. Open the assistant popup and finish one answer.
3. **Hidden by default**: no action appears.
4. Call `configure({ version: "1.0", visible: true, messageActions: { "<id>": { visible: true } } })`.
5. **Shown**: the action appears on the finished answer only. Not while streaming, not on your own message.
6. Click it. With a dialog: edit the prefilled text and submit. Without: it calls at once.
7. See pending, then a success toast. The test endpoint received `conversation_id`, `message_id`, `turn_id`, `action_id`, `text`.
8. Make the endpoint return `{ "error": "Nope", "code": "X" }` with 400. The UI shows "Nope".
9. Sign in as a second user. The action stays hidden until the app enables it for that user.

## Negative checks

- Call the route unauthenticated: 401. With a service account token: 403.
- Send an unknown `action_id`: 404. Send an extra `path` key: ignored.
- Use a `message_id` of a user message: refused.

## Automated

```bash
cd ui
npm run lint
npx jest src/lib/agentic-apps src/app/api/v1/chat src/components/agentic-apps src/components/chat
node app-sdk/bin/check-manifest.mjs <manifest.json>
npm run build
```
