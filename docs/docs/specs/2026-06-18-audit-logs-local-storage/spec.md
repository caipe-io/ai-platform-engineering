# Feature Specification: Configurable Audit Log Storage Backend

**Feature Branch**: `2026-06-18-audit-logs-local-storage`
**Created**: 2026-06-18
**Status**: Draft
**Issue**: [#1903](https://github.com/caipe-io/ai-platform-engineering/issues/1903)

## Summary

Move audit log persistence out of MongoDB/DocumentDB and into a configurable storage backend. Two backends are required: local-disk (for dev/CI) and S3-compatible object storage (for production). MongoDB must no longer be used as the long-term audit log store.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Local-disk audit log storage (Priority: P1)

A developer running the platform locally or in CI sets a single environment variable to direct all audit events to a local directory instead of MongoDB. No MongoDB connection is required. The audit log files accumulate on disk in a structured, readable format.

**Why this priority**: Unblocks local development immediately and eliminates the database contention that causes UI hangs in the dev environment.

**Independent Test**: Start the stack without a MongoDB URI. Set `AUDIT_LOG_BACKEND=local` and `AUDIT_LOG_LOCAL_PATH=/tmp/audit`. Trigger a tool action and an auth decision. Confirm that log files appear under the path. No MongoDB connection error should appear.

**Acceptance Scenarios**:

1. **Given** `AUDIT_LOG_BACKEND=local` and a writable `AUDIT_LOG_LOCAL_PATH`, **When** an audit event is emitted from the Python backend, **Then** the event is appended to a file under the local path within 1 second and no write is made to MongoDB.
2. **Given** `AUDIT_LOG_BACKEND=local`, **When** an auth decision is recorded from the Next.js backend, **Then** the event is written to the local path; no MongoDB call is made.
3. **Given** the local path does not exist, **When** the first audit event is emitted, **Then** the directory is created automatically and the write succeeds.
4. **Given** `AUDIT_LOG_BACKEND=local` and the path is not writable, **When** an audit event is emitted, **Then** the error is logged to stdout and the application continues without crashing.

---

### User Story 2 — S3-compatible audit log storage (Priority: P2)

An operator deploying the platform to a shared or production environment sets configuration pointing to an S3 bucket. All audit events flow to that bucket in compressed files. The primary database is not involved in audit writes.

**Why this priority**: Required for production deployments to meet cost and performance goals; keeps the primary database focused on operational state.

**Independent Test**: Configure `AUDIT_LOG_BACKEND=s3` with a valid bucket and credentials. Trigger multiple audit events. Confirm objects appear in the bucket. Confirm no audit writes reach MongoDB.

**Acceptance Scenarios**:

1. **Given** `AUDIT_LOG_BACKEND=s3` with valid bucket credentials, **When** audit events accumulate, **Then** they are batched and written to S3 as compressed files (Parquet or NDJSON+gzip) within a configurable flush interval.
2. **Given** S3 credentials are invalid, **When** the backend attempts to flush, **Then** the error is surfaced in logs, the events are not silently dropped, and the application continues running.
3. **Given** a bucket lifecycle policy is configured externally, **When** objects age past the threshold, **Then** the storage backend's file structure is compatible with standard lifecycle/tiering (path prefix `audit/YYYY/MM/DD/`).
4. **Given** `AUDIT_LOG_BACKEND=s3`, **When** the S3 endpoint is temporarily unreachable, **Then** in-flight events are buffered in memory (up to a configurable limit) and retried; once the endpoint recovers, buffered events are flushed.

---

### User Story 3 — MongoDB fallback / migration path (Priority: P3)

During transition, operators who have not yet set a new backend variable continue to use MongoDB as before (no breaking change). A migration guide describes how to drain MongoDB audit collections once the new backend is live.

**Why this priority**: Prevents breakage for existing deployments while giving operators a clear cut-over path.

**Independent Test**: Leave `AUDIT_LOG_BACKEND` unset. Confirm all audit events still reach MongoDB. Set the variable to `local`. Confirm no audit events reach MongoDB.

**Acceptance Scenarios**:

1. **Given** `AUDIT_LOG_BACKEND` is unset, **When** an audit event is emitted, **Then** it is written to MongoDB as today (no regression).
2. **Given** `AUDIT_LOG_BACKEND=local` or `s3`, **When** an audit event is emitted, **Then** MongoDB audit collections (`audit_events`, `authorization_decision_records`) receive no new writes.
3. **Given** the operator sets `AUDIT_LOG_BACKEND=local`, **When** they later query the audit UI, **Then** the UI either reads from the new backend or shows a clear notice that audit data is now stored externally.

---

### Edge Cases

- What happens when the local disk fills up? — Write fails with a logged error; application does not crash.
- What happens if two processes write to the same local path concurrently? — Files are named with process/timestamp/UUID to avoid collision; append-only writes per file.
- What happens when S3 upload fails mid-batch? — Partial upload is not committed; the batch is retried with exponential back-off.
- What happens when `AUDIT_LOG_BACKEND` is set to an unrecognised value? — Application fails fast at startup with a clear configuration error.
- What happens to existing MongoDB audit data after migration? — Out of scope for this feature; the migration guide covers manual export/delete.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support a `AUDIT_LOG_BACKEND` environment variable that accepts `mongodb` (default), `local`, and `s3` as values.
- **FR-002**: When `AUDIT_LOG_BACKEND=local`, system MUST write all audit events to the directory specified by `AUDIT_LOG_LOCAL_PATH` (default `./audit-logs`).
- **FR-003**: When `AUDIT_LOG_BACKEND=s3`, system MUST write all audit events to the bucket and prefix specified by `AUDIT_LOG_S3_BUCKET`, `AUDIT_LOG_S3_PREFIX`, and `AUDIT_LOG_S3_REGION`.
- **FR-004**: Both the Python backend and the Next.js BFF MUST route their audit writes through the selected backend.
- **FR-005**: The storage backend selection MUST be made once at startup; individual audit call-sites MUST NOT contain per-backend branching logic.
- **FR-006**: Local-disk files MUST be structured as `<AUDIT_LOG_LOCAL_PATH>/YYYY/MM/DD/<event-type>-<timestamp>-<uuid>.ndjson` (one JSON event per line).
- **FR-007**: S3 objects MUST use the key prefix `<AUDIT_LOG_S3_PREFIX>/YYYY/MM/DD/<event-type>-<timestamp>-<uuid>.ndjson.gz`.
- **FR-008**: Audit writes MUST remain fire-and-forget (non-blocking to the request path); backend failures MUST be logged but MUST NOT propagate exceptions to callers.
- **FR-009**: When `AUDIT_LOG_BACKEND` is unset or `mongodb`, system MUST behave exactly as today (no regression).
- **FR-010**: System MUST log a startup message identifying the active audit backend and its configuration (bucket name or local path, but never credentials).

### Key Entities

- **AuditBackend**: The pluggable interface both Python and TypeScript implementations satisfy. Operations: `write(event)` (async, fire-and-forget).
- **AuditEvent**: The existing unified event shape (unchanged): `ts`, `type`, `tenant_id`, `subject_hash`, `action`, `outcome`, `correlation_id`, `source`, plus type-specific fields.
- **LocalBackend**: Writes NDJSON files to the local filesystem, organised by date and event type.
- **S3Backend**: Buffers events in memory and flushes to S3 as gzip-compressed NDJSON on a configurable interval or when the buffer reaches a size threshold.
- **MongoBackend**: Existing behaviour, unchanged; active when `AUDIT_LOG_BACKEND=mongodb` or unset.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Dev environment UI no longer experiences hangs attributable to audit log writes after switching to `local` backend.
- **SC-002**: Audit event writes add no more than 5 ms to the p99 request latency in the hot path (fire-and-forget guarantee).
- **SC-003**: Switching backend requires changing at most 3 environment variables and restarting the service; no code changes.
- **SC-004**: 100% of audit events emitted during a test run appear in the configured backend (zero silent drops under normal operating conditions).
- **SC-005**: The MongoDB `audit_events` and `authorization_decision_records` collections receive zero new documents when a non-MongoDB backend is active.

---

## Assumptions

- S3-compatible storage (AWS S3, MinIO, GCS S3-interop) is available in production; exact SDK is an implementation detail.
- Parquet is noted in the issue but NDJSON+gzip is simpler and sufficient; Parquet can be a follow-on if analytics queries are needed.
- The audit UI (read path) continues to read from MongoDB for existing data; migrating the read path is out of scope for this issue.
- Per-process buffering for S3 is acceptable; cross-process deduplication is not required.
- Credential management for S3 follows the existing platform pattern (environment variables or workload identity); this feature does not add a secrets UI.

---

## Out of Scope

- Migrating historical MongoDB audit data to the new backend.
- A UI for browsing local-disk or S3 audit files.
- Encryption at rest beyond what S3 or the filesystem natively provides.
- Audit log streaming/tailing from the new backends.
