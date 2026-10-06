# Data Model: Configurable Audit Log Storage Backend

## AuditBackend (Python)

**File**: `ai_platform_engineering/utils/audit_backend.py`

```
AuditBackend (Protocol)
  write(event: Dict[str, Any]) -> None
    Fire-and-forget. Must never raise; catches and logs all errors internally.

get_audit_backend() -> AuditBackend
  Returns the process-wide singleton. Reads AUDIT_LOG_BACKEND on first call.
```

## AuditBackend (TypeScript)

**File**: `ui/src/lib/audit/backend.ts`

```
AuditBackend (interface)
  write(event: Record<string, unknown>): void
    Fire-and-forget. Must never throw; catches and logs all errors internally.

getAuditBackend(): AuditBackend
  Returns the module-level singleton. Reads AUDIT_LOG_BACKEND on first call.
```

---

## Event shape (unchanged)

All backends receive the same unified audit event dict. No new fields are added by this feature.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | ISO-8601 string / Date | Yes | Event timestamp (UTC) |
| `type` | string | Yes | `auth`, `tool_action`, `agent_delegation`, `openfga_rebac`, `cas_decision`, `cas_grant` |
| `tenant_id` | string | Yes | Tenant identifier |
| `subject_hash` | string | Yes | `sha256:<hex>` hashed subject |
| `action` | string | Yes | Human-readable action identifier |
| `outcome` | string | Yes | `allow`, `deny`, `success`, `error` |
| `correlation_id` | string | Yes | Request/trace correlation id |
| `source` | string | Yes | Originating service layer |
| `user_email` | string | No | Plaintext email (admin display) |
| `agent_name` | string | No | Agent name (tool events) |
| `tool_name` | string | No | Tool name (tool events) |
| `duration_ms` | float | No | Execution duration in ms |
| `reason_code` | string | No | Machine-readable outcome reason |
| `context_id` | string | No | Conversation/session id |
| `component` | string | No | Component identifier |
| `resource_ref` | string | No | Resource reference |
| `pdp` | string | No | Policy decision point |
| `trace_id` | string | No | OpenTelemetry trace id |
| `span_id` | string | No | OpenTelemetry span id |
| `count` | int | No | Decisions summarized by an aggregated allow row; absent means one. Sum this rather than counting rows |
| `window_start` / `window_end` | ISO-8601 string | No | Time span an aggregated allow row covers |

---

## Storage representations

### Local disk

```
<AUDIT_LOG_LOCAL_PATH>/
└── YYYY/
    └── MM/
        └── DD/
            └── <event_type>-<YYYYMMDD>-<uuid>.ndjson
```

Each `.ndjson` file contains one JSON object per line. File is opened in append mode; multiple events from the same process/day/type share a file. File name components:
- `<event_type>` — `auth`, `tool_action`, `agent_delegation`, etc.
- `<YYYYMMDD>` — event date in UTC
- `<uuid>` — process-unique identifier generated at backend init (keeps files per-process)

### S3

```
<AUDIT_LOG_S3_PREFIX>/
└── YYYY/
    └── MM/
        └── DD/
            └── <event_type>-<YYYYMMDDTHHMMSSZ>-<uuid>.ndjson.gz
```

Each S3 object is a single gzip-compressed NDJSON file containing one event. Object key components:
- `<event_type>` — same as local
- `<YYYYMMDDTHHMMSSZ>` — event timestamp (UTC, compact ISO-8601)
- `<uuid>` — random UUID4 to avoid key collisions under concurrent writers

### MongoDB (unchanged)

No structural changes. Existing `audit_events` and `authorization_decision_records` collections are read-only artifacts once a non-MongoDB backend is active.

---

## Backend state transitions

```
Process start
    │
    ▼
Read AUDIT_LOG_BACKEND
    │
    ├── "mongodb" (or unset) ──► MongoBackend (existing behaviour)
    ├── "local"              ──► LocalBackend (new)
    ├── "s3"                 ──► S3Backend (new)
    └── <other>              ──► ValueError / Error (fail-fast at startup)
```
