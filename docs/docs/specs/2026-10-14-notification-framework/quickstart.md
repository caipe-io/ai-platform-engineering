# Quickstart: try event notifications locally

## Turn it on

- Set one shared token in `.env`: `NOTIFICATIONS_INTERNAL_TOKEN=<random value>`.
- Restart the stack. Services read the same variable.
- Without the token, producers send nothing and the internal endpoint answers `503`.

## See it work in the UI

- Open **Settings → Notifications**. Use **Send test** on any event. It appears in the bell.
- Turn an event or a category off, then send a test. It is skipped.
- Use the **Notify me about ...** toggle on the Workflows, Knowledge Bases (Data Sources), Agents and Autonomous pages. It changes the same setting.

## Send an event from a service

```bash
curl -X POST http://localhost:3000/api/internal/notifications/events \\
  -H "Authorization: Bearer $NOTIFICATIONS_INTERNAL_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"id":"evt-1","type":"agent.failed","version":1,"occurred_at":"2026-10-14T10:00:00Z",
       "resource":{"type":"autonomous_task","id":"example"},"attempt_id":"run-1",
       "data":{"status":"failed","title":"Agent task failed","summary":"Example task failed."},
       "recipients":[{"email":"you@example.com"}]}'
```

The recipient must be a user who has signed in at least once.

## Use NATS JetStream

- Start a server: `docker compose --profile nats up -d nats`.
- Set `NOTIFICATIONS_TRANSPORT=jetstream` and `NATS_URL=nats://nats:4222`. Restart `caipe-ui`.

## Run the tests

- UI: `cd ui && npm run lint && npm test && npm run build`. Run `TZ=UTC npm test` to avoid a known timezone failure in `admin-stats`.
- Database: `NOTIFICATIONS_MONGO_TEST=1 MONGODB_URI=... npx jest notifications-mongo`.
- JetStream: `NATS_INTEGRATION_URL=nats://localhost:4222 npx jest notifications-jetstream`.
- Python: `uv run pytest` in `utils`, `autonomous_agents`, `dynamic_agents`, `knowledge_bases/rag/common` and `knowledge_bases/rag/server`.
