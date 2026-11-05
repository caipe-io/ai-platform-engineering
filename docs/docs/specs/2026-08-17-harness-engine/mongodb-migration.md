# MongoDB Migration: Harness Engine

## Summary

This is an additive, backward-compatible migration.

- No existing document requires a backfill.
- Existing Dynamic Agents data is not rewritten.
- Existing checkpoint and file collections retain their names and formats.
- A new `harness_sessions` collection stores provider-neutral bindings.
- A new `harness_memories` collection stores policy-governed long-term memory metadata and bounded content/object references.
- Adapter-specific state collections are created only when their adapter is enabled.

## Required changes

### Existing `dynamic_agents` collection

Optional new subdocument:

```yaml
harness:
  id: deepagents
  contract_version: 1
  conversation_policy: pin
  options: {}
memory:
  enabled: false
  read_scopes: [user]
  write_scope: user
  write_policy: disabled
```

Migration operation: **no-op**. Absence of `harness` resolves to the `deepagents` compatibility adapter. Absence of `memory` preserves current behavior and does not enable new cross-thread learned memory.

No collection validation rule is made stricter during rollout because old Dynamic Agents and mixed-version BFF pods must continue writing legacy documents. Validation occurs in application schemas and the Harness Engine validation endpoint.

### New `harness_sessions` collection

Create lazily/idempotently on startup or through the existing schema migration framework.

Indexes:

```javascript
db.harness_sessions.createIndex(
  {
    environment_id: 1,
    owner_subject: 1,
    agent_id: 1,
    conversation_id: 1,
    epoch: 1
  },
  { unique: true, name: "uniq_harness_binding_v1" }
)

db.harness_sessions.createIndex(
  {
    harness_id: 1,
    "provider_resource_ref.kind": 1,
    provider_session_id: 1
  },
  {
    unique: true,
    sparse: true,
    name: "uniq_provider_session_v1"
  }
)

db.harness_sessions.createIndex(
  { conversation_id: 1, agent_id: 1, status: 1 },
  { name: "conversation_interrupt_lookup_v1" }
)

db.harness_sessions.createIndex(
  { harness_id: 1, status: 1, last_activity_at: 1 },
  { name: "harness_operations_v1" }
)

db.harness_sessions.createIndex(
  {
    "state_ref.durability_status": 1,
    "state_ref.committed_at": 1
  },
  { name: "thread_durability_reconciliation_v1" }
)

db.harness_sessions.createIndex(
  { "provider_resource_ref.claim_uid": 1 },
  {
    unique: true,
    sparse: true,
    name: "uniq_active_sandbox_claim_v1"
  }
)

db.harness_sessions.createIndex(
  { "provider_resource_ref.sandbox_uid": 1 },
  {
    unique: true,
    sparse: true,
    name: "uniq_active_sandbox_uid_v1"
  }
)

db.harness_sessions.createIndex(
  { expires_at: 1 },
  { expireAfterSeconds: 0, name: "harness_session_ttl_v1" }
)
```

The migration implementation must use PyMongo index declarations rather than an unchecked shell script. Index definitions are shown here as precise target state.

### New `harness_memories` collection

Create lazily/idempotently only when long-term memory is enabled.

Indexes:

```javascript
db.harness_memories.createIndex(
  {
    environment_id: 1,
    scope: 1,
    namespace_key: 1,
    agent_id: 1,
    kind: 1,
    memory_key: 1
  },
  { unique: true, name: "uniq_memory_key_v1" }
)

db.harness_memories.createIndex(
  {
    environment_id: 1,
    scope: 1,
    namespace_key: 1,
    agent_id: 1,
    updated_at: -1
  },
  { name: "memory_authorized_list_v1" }
)

db.harness_memories.createIndex(
  {
    "provenance.source_binding_id": 1,
    "provenance.source_run_id": 1
  },
  { name: "memory_provenance_v1" }
)

db.harness_memories.createIndex(
  { expires_at: 1 },
  { expireAfterSeconds: 0, name: "memory_ttl_v1" }
)
```

Namespace keys are environment-keyed digests. Raw subject/email/organization identities are not used as memory keys, filenames, vector-index metadata, or trace attributes. If lexical/vector search is added, authorization-compatible namespace filters are mandatory and applied before ranking.

### Adapter state

Preferred initial names:

- `harness_session_entries` for ordered opaque Claude SessionStore entries and summary records;
- `harness_session_snapshots` for Strands repository records when one shared collection remains simpler than separate collections.

The implementation may use adapter-specific collections after benchmark evidence, but names and indexes must be documented before code merges.

Minimum indexes:

- unique ordered entry identity per binding/session/provider entry UUID;
- binding/session sequence lookup;
- binding/type/latest snapshot lookup;
- TTL on `expires_at`;
- no unindexed scan by raw transcript body.

## No-change collections

Do not rename, rewrite, backfill, or repurpose:

- existing LangGraph checkpoint collection;
- existing LangGraph checkpoint-writes collection;
- `conversations`;
- `dynamic_agents` records without explicit user edits;
- `mcp_servers`;
- skill collections;
- GridFS buckets/files/chunks;
- attachment local/S3 objects;
- audit collections.

## Data movement and backfill

### Agent configuration

No backfill. Read-time behavior:

```text
missing harness -> deepagents / contract v1 / pin / empty options
```

Writing an existing agent through the updated editor may persist the explicit default, but bulk mutation is not required.

### Existing conversations

No pre-created binding backfill. On first Harness Engine access:

1. Authorize the caller and load the conversation/agent.
2. Detect existing LangGraph checkpoint state.
3. Atomically upsert a `deepagents` binding with epoch `0` and the existing conversation/thread ID.
4. If a concurrent request created the same binding, read and use it.
5. If a conflicting non-Deep-Agents binding exists, reject with `409`; never overwrite it.

This lazy adoption makes migration proportional to active conversations and keeps rollback simple.

### Attachments and files

No movement. Bindings reference existing namespaces and attachment references. Adapter views are materialized at run time.

## Idempotency and safety

- Create indexes by stable name and equivalent key/options checks.
- Treat existing equivalent indexes as success.
- Refuse startup migration only for a conflicting uniqueness condition; report duplicate keys without deleting data.
- Binding lazy-upsert uses `$setOnInsert` and the unique compound index.
- Sandbox claim adoption/replacement uses a binding `revision` compare-and-set and commits an incremented `lease_generation` before accepting worker traffic.
- Claim and Sandbox UIDs, not names alone, are used for ownership and reconciliation.
- State entry writes use provider UUID/idempotency key plus ordered sequence.
- Native thread state is written pending before a compare-and-set advances the binding's `state_ref.durable_head` and `durable_revision`.
- A failed head commit leaves the previous durable head authoritative and marks the run for uncertain-durability reconciliation.
- Memory writes compare the expected `revision`; conflicts are not overwritten silently.
- No migration reads or logs transcript bodies, prompts, skills, tool results, or secrets.

## Duplicate handling

Before enabling unique indexes in an environment that has pre-release test data:

1. Query duplicate binding tuples and provider session IDs.
2. Stop enablement if duplicates exist.
3. Export affected metadata-only records for human review.
4. Do not auto-delete or merge native state.
5. Resolve by selecting the valid binding, incrementing an epoch, or starting a new conversation.

Production migration should have no duplicates because the collection is new.

## Retention

- `expires_at: null` or absent means no Mongo TTL expiry.
- When configured, binding expiry must not be shorter than conversation/checkpoint retention.
- Adapter entries inherit the binding expiry.
- Remote providers may have independent retention; engine deletion is best effort and audited.
- Sandbox claims are operational resources, not durable session storage. Their TTL/hibernation may be shorter than Mongo retention because a replacement worker rehydrates from durable state.
- Memory retention is scope-specific and independent from thread/checkpoint retention. Conversation clear does not implicitly remove cross-thread memory.
- Memory content/object deletion follows the existing GridFS/object-store deletion audit and garbage-collection policy.
- TTL deletion does not replace explicit clear because provider cleanup and file deletion require coordinated actions.

## Deployment sequence

1. Deploy code capable of reading missing harness fields and creating indexes, with only `deepagents` enabled.
2. Verify index creation and lazy binding for existing conversations.
3. Run compatibility and rollback tests.
4. Install pinned Agent Sandbox CRDs/controller, templates, policies, RuntimeClasses, and empty warm pools.
5. Enable the Deep Agents sandbox profile for shadow traffic, then new-conversation canaries.
6. Enable experimental adapters for isolated test agents.
7. Enable long-term memory only after scope, provenance, conflict, retention, deletion, and injection tests pass.
8. Enable certified adapters only after their state, memory, trace, sandbox lifecycle, and retention are verified.

Mixed old/new pods remain safe because:

- old pods ignore `harness` and new collections;
- new pods default missing fields to `deepagents`;
- only new pods write session bindings;
- existing LangGraph checkpoint format is unchanged.

The reconciler periodically compares active Mongo bindings with Kubernetes claims:

- missing claim or UID mismatch: fence the generation and mark `replacing`;
- ready unowned claim: delete and audit as an orphan;
- claim owned by a closed/expired binding: delete it;
- worker image/protocol mismatch: mark `failed`, delete the claim, and never send inputs;
- stale worker events: reject without mutating state.
- pending/uncertain thread heads: preserve the previous committed head and surface reconciliation state;
- memory records with invalid namespace/provenance schema: quarantine from retrieval and require review rather than broadening access.

## Rollback

Rollback application/deployment only:

1. Route the existing service alias to the previous Dynamic Agents image.
2. Do not drop new fields or collections.
3. Dynamic Agents resumes existing Deep Agents conversations from unchanged checkpoints.
4. Agents explicitly configured for another harness must be disabled or reverted to a known compatible configuration before routing them to the old service.
5. Conversations originating on another harness are not translated; users start a new Deep Agents conversation if required.

No reverse database migration is required.

## Cleanup after rollback window

Dropping `harness_sessions`, `harness_memories`, adapter state collections, old service aliases, or legacy checkpoint data is explicitly outside this feature. A later cleanup spec must prove retention expiration, export/audit needs, derived-memory provenance, and rollback retirement before any destructive change.

## Environment notes

| Environment | Rule |
|---|---|
| Local/test | Collections and indexes may be created at startup; use short TTLs only in isolated databases. |
| Staging | Run lazy-adoption, restart/resume, duplicate, and rollback rehearsals with production-like indexes. |
| Production | Snapshot/backup before rollout; create indexes with monitored impact; enable only compatibility adapter first; no destructive cleanup. |
