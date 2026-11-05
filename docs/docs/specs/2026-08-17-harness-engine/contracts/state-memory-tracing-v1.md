# State, Memory, and Tracing Contract v1

## Purpose

This contract keeps conversation state, long-term agent memory, and causal telemetry independent from disposable sandbox pods and provider SDKs.

The three concerns are deliberately separate:

| Concern | Scope | Source of truth | Typical lifetime |
|---|---|---|---|
| Thread state | One binding and epoch | Native checkpoint/state store plus committed binding head | Conversation retention |
| Agent memory | Cross-thread user/agent/organization namespace | MemoryBroker store | Independent memory policy |
| Sandbox workspace | One sandbox lease | Pod filesystem or profile PVC | Lease/profile lifetime |
| Traces | One request/run causal graph | Telemetry backend | Observability retention |

## ThreadStateStore

The control plane exposes a binding-scoped facade. Workers never receive database handles or collection names.

```python
class ThreadStateStore(Protocol):
    async def load_head(self, scope: StateScope) -> DurableStateHead | None: ...

    async def write_native_state(
        self,
        scope: StateScope,
        codec: str,
        payload: OpaqueStatePayload,
        idempotency_key: str,
    ) -> PendingStateRef: ...

    async def commit_head(
        self,
        scope: StateScope,
        pending: PendingStateRef,
        expected_durable_revision: int,
        run_id: str,
    ) -> DurableStateHead: ...

    async def mark_uncertain(
        self,
        scope: StateScope,
        run_id: str,
        reason: str,
    ) -> None: ...
```

`StateScope` contains only binding ID, environment, harness, epoch, adapter/codec version, and lease generation. The service derives it from authorized server-side state; a worker cannot broaden it.

### Commit protocol

1. Load the last durable head and revision.
2. Execute or resume the native harness against that head.
3. Write the native checkpoint/snapshot as pending, idempotently.
4. Compare-and-set the binding's durable head and revision.
5. Persist pending interrupt and terminal run metadata in the same logical commit where possible.
6. Only then report durable completion to the public protocol.

If step 3 or 4 fails after client-visible output, mark the run `uncertain_durability`, retain the previous durable head, fence the run, and require explicit idempotency reconciliation. Do not automatically replay model or tool work.

### Thread-state invariants

- Native payloads are opaque and versioned; no cross-harness translation is implied.
- Reads and writes require exact binding, epoch, adapter codec, and current lease generation.
- State size, entry count, and write rate are bounded.
- Duplicate writes with the same idempotency key return the same pending/durable reference.
- Clear creates a new epoch; old state cannot become the new epoch's head.
- Pod-local state is a cache and is never selected during restore.
- Deep Agents preserves current MongoDBSaver thread/checkpoint semantics.

## MemoryBroker

Memory is long-term, cross-thread application state. It is not the transcript, checkpoint, skill catalog, or sandbox filesystem.

```python
class MemoryBroker(Protocol):
    async def get(self, scope: MemoryScope, key: str) -> MemoryRecord | None: ...

    async def search(
        self,
        scope: MemoryScope,
        query: MemoryQuery,
        limit: int,
    ) -> tuple[MemoryRecord, ...]: ...

    async def put(
        self,
        scope: MemoryScope,
        proposal: MemoryProposal,
        expected_revision: int | None,
    ) -> MemoryWriteOutcome: ...

    async def delete(
        self,
        scope: MemoryScope,
        key: str,
        expected_revision: int,
    ) -> MemoryWriteOutcome: ...
```

### Memory scopes

| Scope | Namespace | Default write policy |
|---|---|---|
| `user` | environment + subject + agent | Allowed through configured scan/approval policy |
| `agent` | environment + agent | Read-only unless shared learning is explicitly enabled |
| `organization` | environment + organization + agent/policy set | Read-only; application/admin writes only |

The broker computes the namespace from authenticated context. A model or worker cannot supply another subject or organization.

### Memory kinds

- `semantic`: facts and preferences.
- `episodic_reference`: authorized summary/reference to prior thread state; never an automatic raw transcript copy.
- `procedural`: learned procedure. Operator-owned skills remain a separate, normally read-only source.

### Memory-write pipeline

1. Authorize scope, operation, agent, and caller.
2. Validate key, kind, content type, size, and retention.
3. Scan and classify content as untrusted model-produced context.
4. Redact prohibited secrets and reject permission/tool/network instructions that attempt to broaden authority.
5. Require human approval where the scope/path policy says so.
6. Compare expected revision; reject conflict or invoke a declared consolidation policy.
7. Persist content plus provenance, source revisions, content hash, writer, approval, and audit record.

Search applies authorization and namespace filters before lexical/vector ranking. Results are bounded and retain provenance. Memory cannot grant a tool, credential, model, sandbox profile, or network destination.

## Distributed tracing

Harness Engine uses OpenTelemetry with W3C Trace Context across trusted internal boundaries.

### Propagation

- Validate incoming `traceparent`; ignore or replace malformed/untrusted context according to ingress policy.
- Generate child spans for control-plane and worker operations.
- Propagate context to the sandbox worker, ToolBroker, MemoryBroker, ThreadStateStore, subagents, and trusted internal services.
- Suppress internal context to untrusted external/provider endpoints unless explicitly configured.
- Treat trace context only as correlation, never authentication or authorization.

### Required span topology

```text
harness.request
├── authn
├── authz.agent
├── session.binding
├── sandbox.claim_or_reuse
│   └── sandbox.worker.bind
├── harness.run
│   ├── provider.invoke
│   ├── thread_state.load
│   ├── thread_state.write
│   ├── thread_state.commit
│   ├── memory.read / memory.write
│   ├── tool.invoke
│   └── subagent.run
└── stream.validate_and_encode
```

Provider-managed harnesses may return a remote trace reference. Link it to `harness.run` only when the provider integration supports safe, tenant-correct correlation.

### Attribute and baggage policy

Allowed low-cardinality attributes include:

- harness and adapter ID/version;
- execution mode and sandbox profile;
- operation, outcome, error category, capability level;
- model/provider name where existing policy allows it;
- opaque/hmac binding, run, agent, and sandbox identifiers;
- lease generation, retry count, event/tool/memory counts, sizes, and durations.

Forbidden attributes, events, resource labels, and baggage include:

- bearer tokens, credentials, API keys, cookies, or authorization headers;
- raw subject, email, names, or other PII;
- prompts, message text, reasoning content, memory bodies, tool arguments/results, file bodies, and protected skill content;
- provider stderr, native checkpoints, environment variables, or Kubernetes object bodies.

Baggage is empty by default. Any allowed baggage key is schema-defined, bounded, opaque, and stripped before untrusted external calls.

### Export and failure behavior

- Workers export only to the in-cluster OpenTelemetry Collector or a control-plane telemetry facade.
- Common processors scrub before export and apply head/tail sampling according to deployment policy.
- Audit/security decisions and durability outcomes remain durable even when traces are unsampled or dropped.
- Queues, batches, retry duration, and memory are bounded independently in workers and the control plane.
- Collector outage may drop telemetry and raise a health signal; it does not change authorization, persistence, memory, cleanup, or run outcomes.

## Conformance

Certification requires:

1. completed and interrupted thread restore after worker/control-plane failure;
2. exact durable-head selection and rejection of pending/stale state;
3. idempotent duplicate state writes and explicit ambiguous-crash behavior;
4. zero cross-binding, epoch, adapter, or lease-generation state access;
5. user/agent/organization memory isolation and default policies;
6. revision-conflict and consolidation provenance tests;
7. memory injection, scope escalation, retention, approval, and deletion tests;
8. one causal trace across control plane, worker, state, memory, tools, subagents, and encoding;
9. malformed external context and forbidden-baggage rejection;
10. telemetry leak canaries and bounded collector-outage tests.
