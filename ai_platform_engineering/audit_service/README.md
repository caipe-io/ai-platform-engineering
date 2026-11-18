# Audit service

Receives audit events at `POST /v1/audit/events`, batches writes to local NDJSON or S3 Parquet, and serves filtered history at `GET /v1/audit/events`.

History scans count every matching event and retain only the newest requested records. S3 listings stream one page at a time, with at most 16 object fetches pending per scan. Parquet decoding uses 512-row batches without additional Arrow worker pools.

| Setting | Default | Helm value | Behavior |
|---------|---------|------------|----------|
| `AUDIT_SERVICE_READ_MAX_CONCURRENT` | `2` | `read.maxConcurrent` | Maximum active scans per process; additional reads return HTTP 503. |
| `AUDIT_SERVICE_READ_TIMEOUT_SECONDS` | `30` | `read.timeoutSeconds` | Scan deadline; expired reads return HTTP 504. |

Client disconnects and deadlines signal cancellation to the storage scan. Cancellation stops new listings, fetches, and record processing. In-flight storage calls finish before the scan releases its concurrency slot. Ingest and readiness remain available under read pressure.

Completed queries return an exact `total`, stable ordering from newest to oldest, and `truncated` when more records match than the response limit. An S3 fetch, body-read, or Parquet-decoding failure fails the request with HTTP 500 and logs the object location and traceback. Failed and timed-out scans do not return partial totals. Failures that arrive after a client disconnects are also logged; expected cancellation is quiet.

## Direct MCP Activity read benchmark

For an authorized internal service, run this read-only probe from a network that can reach it:

```bash
uv run python -m ai_platform_engineering.audit_service.benchmark_reads \
  --base-url http://localhost:8010 --hours 1 24 720
```

- Runs at most three sequential `OK_LOCAL_AGENT_CONTEXT` queries with the statistics card's 10,000-row limit. The 35-second probe deadline lets the default 30-second service deadline report its real status.
- Prints only duration, status, counts and truncation; never event contents, subject identities, response bodies or service origins. Exit 1 means at least one read failed the current five-second dashboard budget or returned incomplete counts.
- An exact row total does not certify statistics computed from a truncated record list. Validate rollup-weighted events and distinct subjects separately.
- A confirmed 1.4.0 failure used an S3 backend with more than 1,000 objects in one daily partition. A one-day query reached the service's 30-second deadline (504), while readiness and ingestion still worked. This sanitized observation is a reproduction, not a benchmark of this checkout.
- The probe is diagnostic. It does not optimize scans, change the timeout, backfill aggregates or establish recovery. Keep the issue open until an indexed/aggregate read path is measured against representative history and exact counts, including legacy data, are verified.
