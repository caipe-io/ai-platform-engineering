# Querying security audit history

The audit service uses MongoDB for interactive reads and local disk or S3 for archival.
Authorization policy and audit delivery are separate: an unavailable audit store does not change CAS's allow/deny result.

```mermaid
flowchart LR
    subgraph BFF
      C[CAS · decision owner] -->|append event| Q[One audit client]
      B[Audit API · audit.view + tenant] -->|queryPage| Q
    end
    C <-->|Permission checks| F[OpenFGA]
    Q -->|POST events / GET page| A
    subgraph AUDIT[Audit service · separate process]
      A[Ingest + query API]
      W[Archive worker]
    end
    A -->|Persist before acknowledging| M[(MongoDB)]
    U[Admin · Security audit] --> B
    A -->|Indexed page| M
    M -. Durable archive backlog .-> W
    W --> S[(S3 / local archive)]
```

- One **Security audit** view replaces the overlapping Access decisions/RBAC views. It starts with CAS decisions; policy changes, authentication and other event types remain available through filters.
- Each request returns one bounded page. The BFF no longer downloads earlier pages or scans S3 for every click.
- BFF audit reads and writes use `ui/src/lib/audit/client.ts`, not separate backend/reader factories or route-local event fetches. CAS builds its typed decision, grant and reconciliation events; transport preserves them.
- Next/Previous retain the query's time range and ingestion cutoff. Refresh starts a new query. ZIP export follows the same cursor contract.
- A `48h` filter is a viewing window, not retention. MongoDB records expire seven days after archival/import by default; unarchived events never expire. Set query retention to `0` to disable expiry.
- S3 archive retention is independent, with no CAIPE-managed expiry by default; existing bucket lifecycle rules still apply. MongoDB expiry never deletes the archive copy. S3-only history needs an explicit backfill, not an automatic query fallback.
- An empty result is not proof that an operation never happened. Producer delivery remains best-effort; read outages are shown explicitly.
- Component provenance and signed caller context are **not** added by this change.
- The diagram focuses on CAS. Remaining service adoption and retirement of their independent decision writers are tracked under #2884; this is not a claim that all authorization is already centralized.
- MongoDB capacity is a rollout trade-off, not a free performance guarantee. Producers remain buffered, but sharing the app's MongoDB still shares database resources; high-volume deployments can use a separate instance. Validate load before production.

## Upgrade requirement

Deploy the audit service and BFF/UI together. The offset/page/total API is intentionally replaced, not maintained alongside the new one.

Existing history needs a one-off, idempotent archive-to-Mongo backfill as part of the CAS release migration. It lives under `audit_service/scripts/cas_migration/`, defaults to dry-run and is never run automatically by the service. It never changes source archives. Drain the old collector before cutover and verify the final overlapping migration before resuming traffic. No CAS grant or identity migration is involved.

See the [audit-service README](https://github.com/caipe-io/ai-platform-engineering/blob/main/ai_platform_engineering/audit_service/README.md) for API fields, MongoDB/Helm settings, migration commands, recovery behavior and rollback.
