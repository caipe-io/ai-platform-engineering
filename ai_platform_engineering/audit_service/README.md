# Audit service

MongoDB serves audit queries. Local disk or S3 stores archive batches.
The BFF uses one audit client (`ui/src/lib/audit/client.ts`) for event submission and cursor queries; it never reads the service's Mongo collections directly. CAS owns its event contract and decision evidence. Other service migrations are separate work (#2884).

```text
CAS ──append──► BFF audit client ◄──queryPage── BFF audit API ◄── Admin UI
                       │
                    POST / GET
                       ▼
                 Audit service ◄──► MongoDB
                       │
                 background archive ──► S3 / local disk
```

- `append(event)` buffers best-effort writes into bounded, single-flight HTTP batches. Failed submissions are logged, not automatically retried; this is not a durable BFF queue.
- `queryPage(filters)` validates the cursor response and throws a typed 400/503 error, never an empty success on failure. The Security audit route exposes unavailable history explicitly; advisory diagnostics choose their fallback at the caller.
- CAS retains individual denials, allow rollups, bulk/list summaries, grant and reconciliation events. Historical and non-CAS payloads remain readable; no new producer migration or provenance mechanism is introduced here.

## Configuration

- Required: `AUDIT_SERVICE_MONGODB_URI` (or `MONGODB_URI`). Database: `AUDIT_SERVICE_MONGODB_DATABASE`, default `caipe`.
- Archive: existing `AUDIT_SERVICE_BACKEND=local|s3` and its existing storage settings.
- `AUDIT_SERVICE_INGEST_MAX_BATCH_SIZE=10000`: maximum events per POST; replaces `AUDIT_SERVICE_QUEUE_MAX_SIZE`.
- `AUDIT_SERVICE_FLUSH_BATCH_SIZE=500` and `AUDIT_SERVICE_FLUSH_INTERVAL_SECONDS=1`: archive worker batching.
- `AUDIT_SERVICE_QUERY_RETENTION_DAYS=0`: no query expiry by default. A positive value expires newly archived/imported records after that many days, not after the event timestamp. Pending archives never receive an expiry. Changing the setting does not rewrite existing expiry dates.
- `AUDIT_SERVICE_READ_MAX_DAYS=31`: maximum span per query, independent of archive/query retention.
- Verbosity filtering is unchanged. A time window such as `48h` selects records; it does not delete them.

Compose inherits the bundled/external MongoDB connection. Include the `caipe-mongodb` profile unless using an external database.
Helm uses the bundled `<release>-mongodb` credentials by default. For an external database or a dedicated audit account, set `audit-service.mongodb.uriSecret.name/key`. An existing `audit-service.existingSecret` may instead supply `MONGODB_URI` through envFrom. Custom bundled service/Secret names require `mongodb.host` and `mongodb.credentialsSecret.name` overrides.

Use TLS and a dedicated database account in production. The account needs read/write access to `audit_event_records` and `audit_archive_progress`, plus permission to create their indexes. It does not need access to BFF session or credential collections. MongoDB backups and capacity monitoring now cover the audit query store too. Use shared S3 for multi-replica archival; local disk requires a persistent shared destination and its own backup policy.

This deliberately reintroduces a MongoDB query store after the offload discussed in [#1903](https://github.com/caipe-io/ai-platform-engineering/issues/1903). It is not the old synchronous BFF-to-Mongo audit path, but sharing the same MongoDB instance still shares CPU, I/O and storage. A different database name alone is not resource isolation. High-volume deployments should use a separate MongoDB instance through the URI setting, choose an explicit query-retention policy, and load-test before production. S3 remains the long-term archive; no production throughput claim is made by the unit/query-plan tests.

## Query contract

`GET /v1/audit/events?window=48h&type=cas_decision&outcome=deny&limit=30`

- Returns `records`, `limit`, `cursor`, `next_cursor`, `since`, `until`, `as_of`.
- Send `next_cursor` with the **same filters** for the next page; `null` means finished. Save `cursor` to revisit the current page, including page one.
- `since`/`until` (or `from`/`to`) support explicit ranges. `window` defaults to `24h` in the service and `5m` in the BFF.
- Exact filters include type, outcome, tenant, principal/resource reference, decision/correlation ID, component, source, action/capability, reason, agent and tool. Email search remains an escaped case-insensitive substring match.
- Principal/reference, event type/outcome and time queries have dedicated indexes. Other combined filters, especially email substrings, may examine more records; prefer the canonical principal reference for large ranges.
- Sorting is timestamp then immutable event ID, newest first. Indexed reads request at most `limit + 1` records; no offset scan or exact-total count. Queries have a five-second database execution limit.
- A cursor pins the range and an ingestion-time cutoff, excluding subsequently timestamped arrivals (including backfilled old events). This is not a database transaction snapshot: already-in-flight writes, replica clock skew, explicit deletion or configured TTL can still affect results. Keep replica clocks synchronized. Refresh starts a new query.
- Cursors are opaque continuation state, **not credentials**. The BFF still enforces `audit.view` and derives the tenant from the signed-in session on every page.
- Old `page`, `total` and `time_resolution` contracts are removed. Unsupported/repeated parameters fail with 400; storage failures return 503, not an empty successful history.

The browser uses `/api/admin/audit-events` with the same cursor fields and its existing identity enrichment. Its `limit` is capped at 200. Security audit defaults to access decisions; other event types remain selectable. The duplicate RBAC tab and unused `/api/admin/rbac-audit` route are removed. ZIP export follows cursors from one fixed query, includes its bounds in `manifest.json`, and fails visibly above 100,000 records rather than producing a partial export.

## Ingestion and archival

- POST keeps the existing event payload and returns `{accepted: N}`. A 202 means MongoDB acknowledged persistence, not that archival has finished. The obsolete RAM `queued` response field is removed. Supply a stable `audit_event_id` **and timestamp** when retrying; events without these receive generated values.
- Replaying an identical ID/payload is harmless. Reusing an ID for different content returns 409. A batch is not an atomic transaction; retry the same IDs after uncertain or partial failures.
- A MongoDB lease assigns one archive worker across replicas. Its batch membership and completion are durable. Retries write the same deterministic archive object, then mark those records archived. Restarting a worker may wait up to 60 seconds for the lease.
- Archive outages retain a MongoDB backlog; they do not hide records from queries. Monitor `pending_archive_count` and archive health. `/readyz` checks MongoDB and the worker, not S3 availability.
- Producer-side buffers remain best-effort. This does **not** make audit delivery end-to-end lossless, nor does it change authorization decisions when audit delivery fails.
- Keep the service internal. Its HTTP API has no new authentication mechanism; transport and signed provenance remain separate work.

## CAS release migration and coordinated cutover

This upgrade intentionally has no old-query compatibility mode. Deploy the matching audit service and BFF/UI together.

`scripts/cas_migration/migrate_query_store.py` is a one-off step in the CAS release migration. Operators run it explicitly during the release cutover; the audit service never runs it on startup or as a background job.

1. Back up MongoDB and inventory the archive source(s). Protect local files from retention cleanup during migration; S3 lifecycle or another writer must not remove objects being scanned. Preserve all archive data.
2. Run the **new image's migration command** against the existing archive, with MongoDB connection and archive environment settings injected through Secrets. Dry-run reads/validates the archive but does not connect to or modify MongoDB:

   ```bash
   python -m ai_platform_engineering.audit_service.scripts.cas_migration.migrate_query_store \
     --since 2026-10-01T00:00:00Z --until 2026-10-15T00:00:00Z
   ```

3. Repeat with `--apply`. It creates the indexes, copies matching records in bounded batches, preserves IDs and unknown fields, and generates stable source/row-based IDs only for legacy records without IDs. It never writes to S3 or the local source. A rerun skips identical imported records; conflicts/corrupt objects fail visibly. Dry-run counts do not prove that target IDs are conflict-free.
4. Briefly quiesce producers and drain the **old service's in-memory queue** before switching collectors. On every old replica, check `queue_size=0` **and** `accepted_events=flushed_events`; an empty queue alone does not prove the in-flight batch finished. Record any old failed flushes as pre-existing coverage gaps. Run a final overlapping backfill through the cutover boundary. Upgrade the service and BFF/UI as one maintenance operation. Avoid mixed-version query traffic; no archive fallback will conceal a partial migration.
5. Resume producers. Confirm a fresh decision is queryable, paging/filtering/export work, and the archive backlog drains. Record the migration range and final counts. `matched = inserted + already_present` on a successful apply run. Re-run with identical bounds if interrupted; resume is by event ID, not an automatic per-object checkpoint.

The command scans all Parquet and NDJSON/gzip-NDJSON objects under the configured S3 prefix (or NDJSON/gzip-NDJSON files in a local directory) to find records in the requested range; it does not silently omit cross-partition batches. For several sources, run each separately. Legacy generated IDs depend on source location, so do not rename/move source objects between reruns. It cannot recreate already-deleted history or producer-dropped events. The older Mongo `audit_logs`/chat-log collections are not inputs to this archive migration.

Rollback: preserve MongoDB and the archive, quiesce producers, let the new archive backlog reach zero, then roll back the matching service/UI pair. No down-migration or deletion is required. Rolling back while archival is unavailable leaves Mongo-only records invisible to an old archive reader; wait for archival or retain the new reader.

## Tests

Run `uv run pytest ai_platform_engineering/audit_service`. Set `AUDIT_TEST_MONGODB_URI` to exercise the same tests against real MongoDB as well as mongomock. Tests create/drop only randomly named `audit_query_test_*` databases. CI supplies an isolated MongoDB 7 service. Browser fixtures exercise filters, Next/Previous and complete multi-page exports separately.
