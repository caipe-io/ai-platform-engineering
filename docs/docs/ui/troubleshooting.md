---
sidebar_position: 6
---

# Troubleshooting

## Quick Checks

```bash
curl http://localhost:3000/api/health
curl http://localhost:8100/health
docker ps | grep caipe
```

## Chat Fails To Start

Check the UI can reach Dynamic Agents:

```bash
echo "$DYNAMIC_AGENTS_URL"
curl "$DYNAMIC_AGENTS_URL/health"
```

In Docker Compose, use the service URL from inside the UI container:

```bash
DYNAMIC_AGENTS_URL=http://caipe-dynamic-agents:8001
```

## Conversations Do Not Persist

Check MongoDB configuration:

```bash
echo "$MONGODB_URI"
echo "$MONGODB_DATABASE"
```

The UI and Dynamic Agents should point at the same database.

## Index Initialization Conflicts

The UI initializes indexes once per process. Builds on the same collection run
sequentially; different collections initialize concurrently. Conflicts with index
builds in other replicas are retried up to six attempts, with at most 17 seconds
of backoff per index. Other errors are not retried.

Exhausted retries and permanent failures are logged, and initialization continues
with the remaining indexes. Check UI logs for failed index creation; once the
cause is resolved, restart the UI process to repeat initialization.

## Auth Redirects Fail

Verify:

```bash
echo "$NEXTAUTH_URL"
echo "$NEXTAUTH_SECRET"
```

`NEXTAUTH_URL` must match the browser-facing UI URL.

## Dynamic Agent Not Available

Open the Admin Dashboard and verify at least one dynamic agent is enabled. New
chats require a valid `agent_id`.
