# Quickstart: Verify Message Actions

## Prerequisites

- Run the demo app: [`ui/examples/external-apps/actions-demo`](../../../../ui/examples/external-apps/actions-demo/README.md).
- It starts a host, a test app with a **Flag answer** dialog action and a **Mark answer** action, and a script that checks the browser flow.

## Manual check

1. Install the test app. The manifest is accepted.
2. Open the assistant popup and finish one answer.
3. **Hidden by default**: with both boxes unticked on the demo page, no action appears.
4. The demo page calls `configure` on load. Tick a box to show that action.
5. **Shown**: the action appears on the finished answer only. Not while streaming, not on your own message.
6. Click it. With a dialog: edit the prefilled text and submit. Without: it calls at once.
7. See pending, then a success toast. The test endpoint received `conversation_id`, `message_id`, `turn_id`, `action_id`, `text`.
8. Type `fail` in the Flag dialog. The app returns 422 and the dialog shows "Demo failure". The demo README lists the other error words.
9. Sign in as a second user. The action stays hidden until the app enables it for that user.

## Negative checks

- Call the route unauthenticated: 401. With a service account token: 403. The demo's dev bypass turns these off, so rely on the unit tests for them.
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
