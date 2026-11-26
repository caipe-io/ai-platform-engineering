# RAG MongoDB persistence and migration

MongoDB owns RAG metadata, jobs/errors, MCP settings, ontology statistics,
ingestion commands, and preview responses. Milvus and Neo4j retain their
existing responsibilities. Runtime RAG images do not require Redis.

## Configuration

- `MONGODB_URI`: existing application MongoDB or Amazon DocumentDB URI.
- `MONGODB_DATABASE`: application database, default `caipe`.
- `MONGODB_TLS_CA_FILE`: optional trusted CA bundle path.
- `RAG_WRITES_PAUSED=true`: maintenance gate for HTTP mutations, scheduled
  reloads/cleanup, command claims, and ontology scheduling. Restart processes
  when changing this environment variable.
- Helm: `global.rag.mongodb.existingSecret`, `uriKey` (default `MONGODB_URI`),
  `database`, optional `caConfigMap` and `caKey` (default `global-bundle.pem`).
  The CA mounts at `/etc/rag-mongodb-ca/ca.pem`. The URI must use that path if
  it includes `tlsCAFile`; use `readPreference=primary` and `retryWrites=false`
  with DocumentDB. Coordination explicitly uses primary reads.
- Helm maintenance gate: `global.rag.writesPaused=true` applies to all three
  RAG consumers. URI credentials stay in the existing Secret.
- Compose reuses `caipe-mongodb`; include the `caipe-mongodb` profile or supply
  an external URI. No Slack/Webex services are required for first install.

Collections use the `rag_` prefix. Jobs use indexed native fields and atomic
counters; errors and ontology examples occupy separate documents. Metadata and
ontology facades preserve their public interfaces and legacy identifiers.
Every ingestion path acquires a renewable datasource lease. Worker callbacks
carry its token through API calls; stale workers cannot replace current metadata or job
state. Long server requests also renew their claims. Vector batch mutations
check ownership after embeddings; graph writes check immediately before the
external call. MongoDB and the external stores have no shared transaction, so
a mutation already in flight can finish after a lease is lost. Explicit retry
reconciles partial ingestion; automatic replay is disabled.
Expired claimed commands fail their jobs and require explicit retry. Unclaimed
commands remain queued across restarts. Preview results expire after five
minutes; reads enforce expiration before asynchronous TTL cleanup.

## Prepare the operator environment

Use a virtual environment with `common[migration]` installed. The Redis client
is a migration extra, never a runtime requirement. Run the tool with the same
MongoDB URI/database and CA settings as the deployment:

```bash
.venv/bin/python -m common.migrations.redis_to_mongo dry-run \
  --redis-url "$LEGACY_RAG_REDIS_URL"
```

The tool reads only RAG-owned legacy key patterns. It rejects unsupported
record types and active `in_progress` jobs. Snapshot files contain sensitive
application metadata and are written with mode `0600`; store them alongside
protected database backups. Do not commit snapshots.

## Staged cutover

1. Inventory **all** writers: RAG server, every structured and document
   ingestor replica, ontology agent, scheduled ingestion, and cleanup jobs.
   Block new mutations; stop schedules and new command claims. Drain active
   work. Explicitly terminate abandoned legacy jobs through the existing API
   before taking the final snapshot; do not replay partially completed work.
2. Back up legacy Redis externally, including its persistence files. Keep
   this backup outside the future evicting cache and verify it is readable.
3. Upgrade to the new chart with **`rag-redis.enabled=true`** and
   `global.rag.writesPaused=true`, pointing the new services at the target
   MongoDB database. Keep old producers stopped. The paused ingestors may fail
   their initial heartbeat until the maintenance gate is removed; restart them
   after verification. Do not enable normal traffic during this stage.
4. Verify `helm get manifest` for this retained release contains
   `helm.sh/resource-policy: keep` on the legacy Redis PVC. A live PVC patch
   alone is insufficient: Helm must record the retention annotation in an
   installed release **before** a later upgrade disables the dependency.
5. Freeze legacy Redis writes and take the final logical snapshot. Use a pause
   duration longer than snapshot/import/verification; renew it if necessary.
   A pause is additional protection, not a replacement for stopping producers.

```bash
.venv/bin/python -m common.migrations.redis_to_mongo snapshot \
  --redis-url "$LEGACY_RAG_REDIS_URL" --freeze-seconds 1800 \
  --snapshot /protected-backups/rag-state.json
.venv/bin/python -m common.migrations.redis_to_mongo import \
  --snapshot /protected-backups/rag-state.json
.venv/bin/python -m common.migrations.redis_to_mongo verify \
  --snapshot /protected-backups/rag-state.json
```

6. Import requires an empty RAG destination or an unfinished import of the
   identical snapshot. A stored digest permits idempotent recovery; verified
   or runtime-activated destinations reject reimport. Existing UI ingestion
   configuration is outside the migrated collections. Verification compares
   logical values, job membership, numeric heuristic sums, ordered error/example
   lists, pending command payloads, and absolute expiration times. Legacy queues
   without logical ingestor IDs are normalized to their addressed queues.
   Stop on any verification difference; investigate before allowing writes.
7. Remove the maintenance gate and restart the server, ingestors, and ontology
   agent. Confirm datasource ownership, jobs, preview, periodic/manual reload,
   and ontology behavior. Retain the original Redis backup and PVC through
   production acceptance. A later deployment may disable legacy Redis only
   after confirming the retained release manifest and backup. Provision
   `caipe-redis` separately; do not enable eviction on the migration backup.

## Rollback after MongoDB accepts writes

Restoring the original Redis snapshot loses changes made after cutover. Pause
all MongoDB producers again, drain/terminate active work, and reverse-export
**current** MongoDB state into a newly provisioned empty legacy Redis database
with persistence enabled and eviction disabled:

```bash
.venv/bin/python -m common.migrations.redis_to_mongo reverse-export \
  --redis-url "$ISOLATED_ROLLBACK_REDIS_URL" \
  --snapshot /protected-backups/rag-current-state.json
```

The tool refuses a nonempty target or active ingestion commands/jobs. Drain or
let pending preview commands expire before exporting a queue with mixed
deadlines, because a legacy Redis list cannot represent per-command TTLs. Verify
the reverse-export using a fresh logical Redis snapshot and compare it with
`rag-current-state.json`, then point the legacy images at that isolated target.
Only resume writers after verification. Preserve both backups independently.

## Validation

- `RAG_TEST_MONGODB_URI` enables isolated real-database tests for claims,
  counter concurrency, recovery, TTL visibility, and migration round trips.
- Run these tests against both MongoDB and the target DocumentDB version.
- Record cold/restart recovery, command queue delay, database errors, and
  failed/expired worker leases during the deployment soak.
