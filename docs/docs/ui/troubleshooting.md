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

The UI initializes indexes once per process:

- Definitions for one collection are sent in a single `createIndexes` command.
- At most eight collections initialize concurrently per process, including recovery.
  Account for all UI replicas and other consumers when sizing database connections.
- Conflicts with builds in other replicas are retried up to six attempts, with at
  most 17 seconds of backoff per command. Other errors do not receive this retry.
- A rejected batch falls back to sequential, idempotent requests for every index
  in that collection. This retains duplicate-key cleanup and index-option conflict
  handling without skipping unrelated definitions. Each fallback request has its
  own bounded conflict retries.

Batching avoids repeated background-build waits on OSS DocumentDB while retaining
one active index-creation command per collection in each process. It does not
change index names, keys, uniqueness or TTL options. Existing-index startup remains
idempotent; no database engine is detected or special-cased.

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
