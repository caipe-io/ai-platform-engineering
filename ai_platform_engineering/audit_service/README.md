# Audit service

Receives audit events at `POST /v1/audit/events`, batches writes to local NDJSON or S3 Parquet, and serves filtered history at `GET /v1/audit/events`.

History scans count every matching event and retain only the newest requested records. S3 listings stream one page at a time, with at most 16 object fetches pending per scan. Parquet decoding uses 512-row batches without additional Arrow worker pools.

| Setting | Default | Helm value | Behavior |
|---------|---------|------------|----------|
| `AUDIT_SERVICE_READ_MAX_CONCURRENT` | `2` | `read.maxConcurrent` | Maximum active scans per process; additional reads return HTTP 503. |
| `AUDIT_SERVICE_READ_TIMEOUT_SECONDS` | `30` | `read.timeoutSeconds` | Scan deadline; expired reads return HTTP 504. |

Client disconnects and deadlines signal cancellation to the storage scan. Cancellation stops new listings, fetches, and record processing. In-flight storage calls finish before the scan releases its concurrency slot. Ingest and readiness remain available under read pressure.

Completed queries return an exact `total`, stable ordering from newest to oldest, and `truncated` when more records match than the response limit. Timed-out scans return an error rather than partial totals.
