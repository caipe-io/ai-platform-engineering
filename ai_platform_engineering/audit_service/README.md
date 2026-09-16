# Audit service

Receives audit events at `POST /v1/audit/events`, batches writes to local NDJSON
or S3 Parquet, and serves filtered history at `GET /v1/audit/events`.

## Query memory

- Queries count every matching event but retain only the newest `limit` records.
  `total`, newest-first ordering, and `truncated` remain exact for readable files.
- S3 queries read at most 16 objects concurrently per query, with bounded
  submission. A slow object cannot accumulate decoded results for the entire range.
- Parquet decoding uses 512-row batches; S3 bodies are closed after reading.
- `AUDIT_SERVICE_READ_CONCURRENCY` defaults to **2** simultaneous history scans
  per process. Additional reads wait without blocking ingest or health endpoints.
  A cancelled request holds its slot until the background scan finishes.
- `AUDIT_SERVICE_READ_MAX_LIMIT` (default **10000**) limits retained results;
  `AUDIT_SERVICE_READ_MAX_DAYS` (default **31**) limits the scan range.

These are record/concurrency bounds, not a fixed byte ceiling: individual event
and object sizes still matter. Increasing container memory does not replace
bounded queries. Accepted ingest events remain queued in memory until flushed;
monitor queue depth, flush failures, and container restarts separately.

## Validation

Run the audit-service tests with `uv run pytest ai_platform_engineering/audit_service`.
The query-memory regression checks a 6,000-event scan with 4 KiB payloads, exact
counts/order, bounded S3 prefetch, and concurrent reads with ingest still available.
