# Implementation Plan: Harness Engine

> **Delivery alignment (2026-10-21):** [Delivery phases](delivery-phases.md) defines the common sequence used by this plan, the discussion and PR: independent engine/gateway, separate Deep Agents integration, external sandbox execution, then cross-harness composition. Older task workstreams are technical backlog, not competing release phases.

> **Independent track (2026-08-18):** The current implementation follows the
> standalone control-plane slice in [Portable abstractions](portable-abstractions.md).
> Tasks that name `ai_platform_engineering/dynamic_agents/` remain future
> replacement work and are intentionally untouched.

**Branch**: `2026-08-17-harness-engine` | **Date**: 2026-08-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `docs/docs/specs/2026-08-17-harness-engine/spec.md`

## Summary

Build Harness Engine as an independent service and adopt it beside Dynamic Agents. The first delivery phase supports opt-in AgentCore and Claude SDK execution, with operator-owned profiles and explicit experimental capabilities. No source file, route, database schema, stream, or execution behavior in `ai_platform_engineering/dynamic_agents/` changes.

The Next.js BFF remains horizontally stateless. Its existing chat endpoints now
form the **Harness Gateway**: they resolve the BFF-owned
`execution_harness_id`, preserve Dynamic Agents as the legacy/default target,
and route opted-in agents to detached Harness Engine runs. The gateway converts
canonical events to the existing AG-UI or custom SSE wire format. Harness Engine
owns the provider task, AgentCore `runtimeSessionId`, run status, and sequenced
event log, so a browser or BFF disconnect cannot cancel execution. Later
harnesses use the same independent adapter/run contract; replacement of Dynamic
Agents remains a separate opt-in phase.

Common platform policy remains outside adapters: authentication and OpenFGA checks stay in the BFF; operator-owned runtime allowlists, session ownership, persistence, event ordering, and provider credentials stay in Harness Engine. Adapters own provider invocation and native stream translation only.

## Technical Context

**Language/Version**: Python 3.13 for the runtime; TypeScript/Next.js 16 and React 19 for additive builder UI fields
**Primary Dependencies**: Independent FastAPI/Pydantic service, boto3 AgentCore client, PyMongo, and the existing Next.js BFF/authz libraries
**Storage**: Independent `harness_agents`, `harness_agent_versions`,
`harness_sessions`, `harness_runs`, and `harness_events` MongoDB collections;
each adapter owns its native checkpoint/session representation
**Testing**: pytest/pytest-asyncio disconnect/replay E2E and adapter tests; BFF Jest route tests; existing Dynamic Agents tests remain unchanged
**Target Platform**: Independent Linux control-plane container calling the managed AgentCore Runtime plane; local memory repository is test/development only
**Project Type**: New backend service plus additive Next.js BFF routes and agent-editor overlay
**Performance Goals**: Compatibility control-plane overhead within 10% excluding declared sandbox startup; canonical translation under 25 ms p95 per event batch; warm worker readiness under 5 seconds p95 and cold readiness under 30 seconds p95; no more than 20% control-plane memory growth
**Phase 1 constraints**: Zero Dynamic Agents runtime changes; fail closed before provider invocation; no arbitrary AgentCore ARN or execution role from browser/agent data; no user bearer propagation into experimental provider calls; no BFF affinity; no automatic fallback after side effects. Phase 2 separately specifies governed caller delegation for existing tool behavior.
**Scale/Scope**: Opt-in AgentCore and Claude SDK; horizontally scaled BFF and Harness Engine readers over a shared Mongo event log; Deep Agents integration and sandbox workers follow the staged delivery gates

## Constitution Check

*Historical Spec Kit research/design checklist, not delivery-phase approval. Current merge and certification gates are recorded in [Delivery phases](delivery-phases.md).*

| Principle | Design response | Status |
|---|---|---|
| Worse is Better | Add the independent opt-in engine first; reuse the existing runtime in a separate compatibility phase, then add isolated execution and composition. | Design intent |
| YAGNI | Implement only the four requested adapters, one minimal internal worker protocol, static profiles, and Agent Sandbox claims. No marketplace, arbitrary plugin loader, or automatic cost router. | PASS |
| Rule of Three | A common adapter contract is justified by four concrete harnesses. Provider-specific configuration remains duplicated inside adapters until a third identical pattern appears. | PASS |
| Composition over Inheritance | Use small runtime, adapter, tool, session, and event protocols composed by a registry; no adapter inheritance tree. | PASS |
| Specs as Source of Truth | Specification, research, data model, contracts, migration plan, architecture, and quickstart are defined before code. | PASS |
| CI Gates | Preserve the existing suite unchanged and add contract, conformance, integration, security, Helm, and performance gates. | PASS |
| Security by Default | Keep authorization and secrets in the control plane; use claim-exclusive pods, allowlisted profiles, hardened RuntimeClasses, default-deny networking, scoped capabilities, redaction, and fail-closed validation. | PASS |

### Architecture decision amendment

`.specify/ARCHITECTURE.md` continues to describe the existing LangGraph-based Dynamic Agents system. Harness Engine is a separate execution plane for opt-in agents. No claim is made that all existing agents already execute through Harness Engine.

### Supply-chain gate

Before enabling an adapter, record its exact locked version, license/terms, transitive dependency diff, vulnerability scan, release cadence, runtime artifacts, network behavior, and credential requirements. A failed review leaves the adapter installed as unavailable or excludes it from the image; it does not weaken the common contract.

## Architecture

```mermaid
flowchart TB
    C["Web UI / CLI / Slack / Webex"] --> HG["Harness Gateway\nexisting BFF chat routes"]
    HG -->|"missing/default marker"| DA["Dynamic Agents"]
    HG -->|"non-default marker\ninternal token + subject"| HE["Independent Harness Engine"]
    HG -->|"app-defined assistant"| APP["App-owned stream"]
    HE --> CFG["Immutable execution versions"]
    HE --> RUNS["Mongo sessions + runs + ordered event log"]
    HE --> CLAUDE["Claude SDK adapter"]
    HE --> AC["AgentCore adapter"]
    AC --> AWS["Operator-allowlisted AgentCore Runtime"]
    C -. "reconnect run_id + cursor" .-> HG
```

### Target ownership boundary

The table includes future shared services from delivery Phases 2–4. Phase 1 retains BFF/CAS policy enforcement and the unchanged Dynamic Agents default; protocol declarations alone do not claim those services are implemented.

| Common engine owns | Harness adapter owns |
|---|---|
| Public routes and errors | Provider client/process construction |
| Authentication, authorization, audit | Native option translation |
| Agent/MCP configuration reads | Model and agent-loop invocation |
| Config override allowlist | Native stream parsing |
| Prompt and context rendering | Native session create/resume/delete calls |
| Skills scan/load policy | Provider resource cleanup |
| Attachment validation/storage | Provider health diagnostics |
| Tool discovery, credentials, execution policy | Provider-specific usage metadata |
| Subagent delegation broker | Capability evidence for native behavior |
| Session binding and retention policy | Opaque adapter state codec/reference |
| Canonical event validation and wire encoders | Canonical event production |
| Cache, capacity, cancellation policy | Best-effort native cancellation |
| Metrics/tracing labels and redaction | Provider spans linked to the common trace |
| Sandbox claim, profile, lease generation, worker auth, and fencing | Harness SDK execution and provider-native translation inside its worker image |
| Kubernetes RBAC and NetworkPolicy ownership | No Kubernetes API or raw credential access |

## Project Structure

### Documentation (this feature)

```text
docs/docs/specs/2026-08-17-harness-engine/
├── spec.md
├── plan.md
├── research.md
├── architecture.md
├── agent-creation-ui.md
├── compatibility-matrix.md
├── data-model.md
├── quickstart.md
├── mongodb-migration.md
├── tasks.md
├── contracts/
│   ├── rest-api-v1.md
│   ├── harness-adapter-v1.md
│   ├── canonical-events-v1.md
│   ├── state-memory-tracing-v1.md
│   └── sandbox-worker-v1.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
ai_platform_engineering/dynamic_agents/
├── src/dynamic_agents/
│   ├── main.py                         # preserved compatibility service
│   ├── models.py                       # additive harness selection models
│   ├── routes/
│   │   ├── chat.py                     # existing routes; coordinator only
│   │   ├── conversations.py            # provider-neutral interrupt/clear
│   │   └── harnesses.py                # additive catalog/validation routes
│   └── services/
│       ├── runtime_cache.py             # cache of HarnessRuntime protocol
│       ├── runtime_coordinator.py       # common run lifecycle
│       ├── tool_broker.py               # portable tool surface and policy
│       ├── delegation_broker.py         # mixed-harness subagents
│       ├── session_store.py             # session binding repository
│       ├── thread_state_store.py        # scoped native state and durable heads
│       ├── memory_broker.py             # governed cross-thread memory
│       ├── telemetry.py                 # W3C propagation, spans, redaction
│       ├── sandbox_manager.py            # claims, readiness, fencing, reconciliation
│       ├── sandbox_profiles.py           # static template/pool policy
│       ├── worker_client.py              # internal streaming protocol client
│       ├── stream_encoders/             # consume canonical events only
│       └── harnesses/
│           ├── contract.py              # protocols and data types
│           ├── registry.py              # explicit allowlisted registry
│           ├── capability.py            # validation/certification
│           ├── deepagents_adapter.py    # wraps current AgentRuntime behavior
│           ├── deepagents_events.py     # LangGraph -> canonical translation
│           ├── claude_sdk_adapter.py
│           ├── strands_adapter.py
│           └── agentcore_adapter.py
├── worker/                               # minimal common worker host
│   ├── protocol.py
│   ├── server.py
│   └── adapters/                         # built into separate signed images
└── tests/
    ├── conformance/                     # parametrized adapter contract suite
    ├── contract/                        # REST and canonical event contracts
    ├── integration/                     # mixed-harness/failure scenarios
    └── test_*.py                        # existing suite remains unchanged

ui/src/
├── types/dynamic-agent.ts                # HarnessConfig, MemoryPolicy, UI reports
├── hooks/
│   ├── use-agent-draft.ts                # revisioned common + parked option state
│   ├── use-harness-catalog.ts            # catalog/model loading and race guards
│   └── use-harness-validation.ts         # debounced field-addressable validation
├── components/dynamic-agents/
│   ├── DynamicAgentEditor.tsx            # stable five-step composition
│   ├── HarnessSelector.tsx               # selector cards and catalog states
│   ├── HarnessCompatibilityDialog.tsx    # switch diff and explicit fixes
│   ├── CompatibilitySummary.tsx          # unified blockers and review
│   └── harness-options/                  # first-party typed option panels
└── app/api/dynamic-agents/
    ├── route.ts                          # allowlisted create/update + revalidation
    ├── models/route.ts                   # harness-filtered model proxy
    └── harnesses/                        # BFF catalog and validation proxies

charts/ai-platform-engineering/charts/dynamic-agents/
├── values.yaml                          # adapter/profile/controller config
└── templates/                           # control plane, RBAC, policies, profiles/pools
```

**Structure Decision**: Phase 1 creates `ai_platform_engineering/harness_engine/` as a separate package, image, API, persistence boundary and test suite. Extend the existing BFF chat routes with Harness Gateway and add `/api/harness-engine/*` controls. Preserve `ai_platform_engineering/dynamic_agents/`; Phase 2 integration is separately specified and reversible.

### Implemented vertical-slice structure

```text
ai_platform_engineering/harness_engine/
├── build/Dockerfile
├── pyproject.toml
├── src/harness_engine/
│   ├── adapters/agentcore.py
│   ├── coordinator.py
│   ├── main.py
│   ├── models.py
│   └── repository.py
└── tests/
    ├── test_agentcore_adapter.py
    └── test_disconnect_replay_e2e.py

ui/src/
├── app/api/harness-engine/             # catalog, overlay, run, replay, SSE
├── app/api/v1/chat/                    # Harness Gateway compatibility routes
├── components/chat/AgentHarnessBadge.tsx
├── lib/agent-presentation.ts           # labels + deterministic agent colors
├── lib/chat-agent-metadata.ts          # use-authorized identity + tab title
├── lib/harness-gateway.ts              # routing + canonical wire encoders
├── lib/harness-engine-proxy.ts         # internal-credential proxy
├── lib/harness-engine-session-client.ts
└── types/harness-engine.ts
```

The technical implementation backlog, story checkpoints, file targets and release gates are defined in [tasks.md](./tasks.md), generated through Spec Kit task planning. [Delivery phases](delivery-phases.md) owns release order; task workstream numbers are stable backlog references.

### Harness Gateway vertical slice

- `dynamic_agents.execution_harness_id` is routing metadata owned by the BFF;
  absent values preserve the legacy Dynamic Agents path.
- Web UI, Slack, and Webex keep calling `/api/v1/chat/*`; no provider SDK or
  harness-specific logic is added to those clients.
- Non-default `start` creates a detached run and streams a translation of the
  durable canonical event log. Client disconnect closes only the subscription.
- Non-default `invoke` waits on the durable event log and accumulates the same
  JSON response shape.
- Non-default `cancel` addresses the active run by caller, agent, and
  conversation while preserving its session binding.
- Human-input resume and file attachments remain capability-gated for the
  initial AgentCore/Claude adapters; the gateway returns an explicit `409`
  instead of silently switching harnesses.
- Chat renders a persistent agent/harness identity header. Sidebar history and
  new-chat choices reuse the same accessible harness badges and deterministic
  per-agent fallback themes; explicit author-selected themes still win. The
  active browser tab includes the friendly agent name, with metadata falling
  back to the `agent#use`-authorized available-agent catalog when the richer
  detail route is unavailable to a chat-only caller.

## Key Technical Decisions

### 1. Versioned, provider-neutral adapter protocol

`HarnessAdapter` is a factory and capability provider. It creates a conversation-scoped `HarnessRuntime` with these required operations:

- `initialize()`
- `stream(turn) -> AsyncIterator[CanonicalEvent]`
- `resume(decision) -> AsyncIterator[CanonicalEvent]`
- `pending_interrupt()`
- `cancel()`
- `restart()`
- `cleanup()`
- `health()`

Adapters receive immutable normalized inputs and service interfaces. They do not receive FastAPI requests, SSE encoders, Mongo collections, bearer headers, or unrestricted environment access.

### 2. Canonical events before wire encoding

Replace the current LangGraph-specific encoder input with a canonical event union. The state-machine validator enforces:

- one `run.started` before output;
- balanced text/reasoning/tool spans;
- stable run, message, tool, and interrupt IDs;
- valid subagent namespace transitions;
- one terminal `run.finished`, `run.interrupted`, `run.cancelled`, or `run.error`;
- bounded tool results and provider metadata;
- no post-terminal events.

Custom SSE and AG-UI encoders retain their current bytes-on-the-wire behavior for compatibility inputs.

### 3. Common tool and delegation brokers

The common `ToolBroker` resolves MCP and built-in tools, validates schemas, obtains per-request credentials, enforces tool allowlists and approval policy, executes calls, and bounds results. Adapters receive provider-specific wrappers over these portable tool handles.

All configured subagents use a common `DelegationBroker` exposed as the established task/delegation tool. This enables parent and child agents to use different harnesses while retaining independent authorization, credentials, capacity, canonical namespaces, interrupts, and traces. Provider-native subagents remain an optional extension until they can meet the same mixed-harness contract.

### 4. Explicit capability negotiation

Each adapter publishes `native`, `emulated`, `unsupported`, or `unavailable` for required capabilities. Validation computes the agent's requirements from its model, tools, built-ins, skills, middleware, files, subagents, interrupt policy, backend, and request override. Saving and running fail before invocation if any required capability is unsupported or unavailable.

`certified` is derived from conformance evidence, never self-declared. `experimental` adapters are visible only when explicitly enabled and cannot be chosen for production agents by default.

### 5. Session binding, not universal state translation

Persist a binding from `(environment, caller subject, agent, conversation)` to harness, adapter version, provider session, epoch, checkpoint strategy, and pending interrupt. The binding prevents a configuration edit from silently moving an active conversation between harnesses.

- Deep Agents continues to use existing LangGraph Mongo checkpoints.
- Claude Agent SDK uses its external `SessionStore` backed by Mongo and an isolated temporary config directory.
- Strands uses a custom Mongo-backed session repository.
- AgentCore stores the remote harness/session identity and durable engine metadata; clear increments the epoch and starts a fresh remote session.

State stays in its native codec. Cross-harness transfer is an explicit future contract, not JSON coercion of private SDK state.

### 6. Sandbox workers for local harnesses

Register only first-party, code-reviewed harnesses and map each local harness to an operator-owned sandbox profile. Harness Engine creates a `SandboxClaim`, waits for a worker with a compatible protocol/image digest, persists the lease generation, and invokes it through a cluster-private streaming endpoint. Agent config cannot choose images, commands, volumes, service accounts, RuntimeClasses, or egress.

The worker hosts exactly one binding at a time and emits canonical events. A short-lived capability authenticates binding, run, tool set, audience, expiry, and lease generation. ToolBroker rejects calls from stale generations. Provider SDK types, processes, temporary config, and workspace remain inside the pod; MongoDB, Kubernetes, OpenFGA, credential exchange, audit, and client encoders remain outside.

Use adapter-specific signed images. Keep `in_process` only behind an explicit migration/local-development flag so Docker Compose and rollback can continue while Kubernetes sandbox conformance is established.

### 7. Agent Sandbox lifecycle and hardening

- Claim from an allowlisted `SandboxTemplate` or `SandboxWarmPool`; do not create Pods directly.
- Default to one conversation-epoch lease, same-sandbox follow-up turns, idle hibernation/deletion, maximum lifetime, and destroy-on-release.
- Fence before replacement, reconcile orphan claims, and rehydrate from Mongo/GridFS/provider-native durable state.
- Run without a service-account token, root, host namespaces, hostPath, privileges, or runtime sockets.
- Use Kata for high-risk profiles and gVisor where certified; set seccomp, dropped capabilities, read-only root, PID/resource/ephemeral-storage limits.
- Default-deny ingress and egress. Permit only control-plane worker traffic, ToolBroker, DNS, the selected model/proxy, and approved artifacts.
- Warm-pool reuse is forbidden until a reset conformance suite proves no residual files, processes, memory-backed state, credentials, or network identity.

### 8. Separate thread state, long-term memory, and traces

Thread persistence uses native adapter codecs behind a binding-scoped `ThreadStateStore`. Deep Agents retains the existing MongoDBSaver collections. Each binding records the last durable head, commit revision, run/idempotency digest, interrupt revision, and durability status. Public durable completion follows the head commit; ambiguous post-output failures become `uncertain_durability` and are never auto-replayed.

Long-term agent memory uses a common MemoryBroker, separate from checkpoints, transcripts, pod files, and operator skills. Writable memory defaults to user+agent scope. Agent-shared memory needs explicit policy; organization memory is read-only by default. Every write is authorized, scanned, revisioned, provenance-bearing, retained independently, audited, and optionally approved.

Tracing uses sanitized W3C Trace Context across the control plane, worker, model/provider, ThreadStateStore, MemoryBroker, ToolBroker, subagents, and encoders. Baggage is empty by default and never carries identity or content. Worker OTLP goes only to the in-cluster collector/control-plane facade, where common redaction and sampling apply. Telemetry outage is bounded and does not alter run results.

## Adapter Mapping

| Adapter | Execution | Session strategy | Tool strategy | HITL strategy | Initial status |
|---|---|---|---|---|---|
| `deepagents` | Exclusive sandbox pod | Existing LangGraph Mongo/in-memory checkpointers; pod workspace | Worker-side LangChain wrappers calling ToolBroker | Existing LangGraph interrupts | Compatibility oracle; sandbox certify first |
| `claude_agent_sdk` | Exclusive sandbox pod + SDK subprocess | Mongo-backed SDK `SessionStore`; pod-local `CLAUDE_CONFIG_DIR` | Worker SDK MCP facade calling ToolBroker | Permission callback and user-input messages mapped to canonical interrupts | Experimental until sandbox + adapter conformance pass |
| `strands` | Exclusive sandbox pod | Custom Mongo `SessionRepository` through scoped state API | Worker Strands wrappers calling ToolBroker | Strands interrupts and hooks mapped to canonical interrupts | Experimental until sandbox + adapter conformance pass |
| `agentcore` | Managed remote harness | Durable binding to harness ARN/endpoint/session/epoch | Inline functions routed back through ToolBroker; governed MCP only after equivalent policy proof | Inline-function tool-use pause/resume mapped to canonical interrupts | Experimental, opt-in, AWS-configured |

## Implementation Phases

These are the same delivery phases published in [Discussion 2405](https://github.com/orgs/caipe-io/discussions/2405). [Delivery phases](delivery-phases.md) is the canonical scope and gate reference. This sequence supersedes the earlier replacement-first ordering.

### Phase 1 — Independent engine and gateway (PR 2401)

- Retain Dynamic Agents as the default; add opt-in AgentCore and Claude SDK adapters without refactoring its Python runtime.
- Deliver current gateway/session/run/replay contracts and preserve app-owned streams.
- Keep unsupported capabilities explicit and provider settings truthful in the builder.
- Resolve retained-owner routing, optional-engine coupling, current-path UI issues and required CI/review gates.

**Exit:** Approved Phase 1 scope and current-path correctness/compatibility evidence. No claim of Deep Agents integration, sandbox isolation or cross-harness delegation.

### Phase 2 — Deep Agents integration and pluggable builder

- Extract and reuse the existing runtime behind `DeepAgentsAdapter`; preserve its graph, tools, middleware, skills and native subagents.
- Add typed events, completed/paused/cancelled outcomes, authorized resume, attachments and caller-scoped credential handling.
- Preserve checkpoint/file identities and scheduled/workflow behavior; migrate bindings gradually with one execution authority and a reconciled rollback path.
- Render supported editor features through bounded schemas and a trusted reusable panel registry.
- Keep service retirement separate until remaining management and operational APIs have replacements.

**Exit:** Native behavior, CAS/credential isolation, lifecycle, migration and UI conformance pass. See [interface and migration sketches](deep-agents-integration-pending.md).

### Phase 3 — External sandbox execution

- Keep `SandboxManager` in the engine container; call a pluggable external backend such as Kubernetes Agent Sandbox.
- Acquire operator-approved claims and conversation-scoped worker leases; keep AgentCore provider-managed.
- Move full local harness loops to workers through the worker protocol, governed model/tool/state interfaces and generation fencing.
- Validate external durable state, reuse/restore, cancellation, cleanup, credentials and runtime/network isolation before production certification.

**Exit:** Each advertised sandbox profile passes worker lifecycle, recovery and isolation gates. Tool-only sandboxing is labeled as a narrower mode.

### Phase 4 — Cross-harness agent composition

- Add `DelegationBroker` to admit child agents through their adapters under the effective caller's authorization.
- Preserve parent/child identity, session/workspace boundaries, output, approvals and coordinated cancellation.
- Enforce compatible capabilities, target permissions, cycle/depth/concurrency controls and budgets.
- Enable reusable delegation UI only for qualified adapter/deployment combinations.

**Exit:** Cross-harness delegation and child-run visibility pass authorization, lifecycle and isolation conformance. Existing Deep Agents native subagents remain available through Phase 2 parity.

Additional harnesses, long-term memory, process-failure takeover and ACP are separately scoped extensions. Capability declarations and certification follow demonstrated implementations, not roadmap position.

## Testing Strategy

| Gate | Required evidence |
|---|---|
| Existing behavior | Entire current Dynamic Agents test suite passes unchanged against `deepagents` adapter |
| REST contract | Snapshot/OpenAPI and black-box tests for every existing and additive route |
| Event contract | State-machine/property tests plus byte-for-byte golden custom SSE and AG-UI frames |
| Adapter conformance | Parametrized suite for initialize, stream, invoke, resume, cancel, restart, cleanup, errors, usage, sessions, tools, files, and subagents |
| Security | Authorization before worker/remote invocation, per-user credential isolation, pod escape and credential-canary tests, default-deny egress, redaction, malformed event defense, remote session collision tests |
| Persistence | Restart/eviction/resume, pending interrupts, clear, TTL, rollback readability, adapter version changes |
| Agent memory | User/agent/organization scopes, authorization-before-search, conflicts, provenance, approval, injection, retention, deletion, cross-thread behavior |
| Tracing | W3C parentage across all boundaries, opaque correlation, forbidden baggage/attributes, provider suppression, sampling, collector outage bounds |
| Agent builder | Legacy/default Deep Agents regression; create/edit/clone for every harness and catalog state; field capability projection; filtered models; switch diff; parked options; active-conversation policy; unknown harness preservation; keyboard/screen-reader/error-focus behavior |
| UI/BFF consistency | Out-of-order catalog/model/validation responses, exact-payload fingerprint, catalog revision change before save, allowlist rejection, and proof that invalid validation performs no MongoDB/OpenFGA mutation |
| Fault isolation | Provider unavailable, claim/controller failure, pod eviction/OOM/lifetime, stale worker, slow/hung stream, malformed output, tool failure, client disconnect, cancellation races |
| Performance | Current-vs-compatibility p50/p95/p99 latency, warm/cold claim readiness, control-plane memory, event translation/transit overhead, mixed-harness and pool capacity |
| Deployment | Docker Compose compatibility smoke; Helm/CRD/RBAC/NetworkPolicy/Profile render tests; gVisor/Kata readiness; rolling upgrade and rollback rehearsal |

## Database Migrations

**Deliverable**: [mongodb-migration.md](./mongodb-migration.md)

- Add optional `harness` subdocument to `dynamic_agents`; no backfill because absence resolves to `deepagents`.
- Add `harness_sessions` for provider session bindings, canonical pending interrupts, Sandbox leases, and durable thread heads.
- Add `harness_memories` for scoped memory metadata/revisions/provenance, reusing existing GridFS/object storage for large content.
- Create unique ownership/binding and TTL query indexes idempotently.
- Do not alter or rewrite existing LangGraph checkpoint, GridFS, attachment, conversation, skill, or audit data.
- Rollback leaves additive fields and the new collection in place; Dynamic Agents ignores them.

## Rollout Gates

- No implementation phase begins with unresolved spec markers.
- No adapter is called supported before certification.
- No adapter receives production traffic before dependency/security review.
- No protocol cutover occurs before byte-compatible golden tests pass.
- No service rename or legacy object deletion occurs in this feature.
- No automatic fallback is enabled by default.
- No production local harness runs in-process after sandbox certification.
- No sandbox profile accepts an agent-selected image, command, identity, volume, RuntimeClass, or egress rule.
- No warm-pool sandbox is reassigned after release unless reset conformance is separately proven.
- No harness is certified without crash-safe thread restore, governed cross-thread memory, and end-to-end trace/redaction evidence.
- Production cutover requires a successful rollback rehearsal and a soak period meeting SC-005 through SC-008.

## Complexity Tracking

| Complexity | Why needed | Simpler alternative rejected because |
|---|---|---|
| Provider-neutral canonical event layer | Four harnesses emit incompatible lifecycle objects while two stable client protocols must remain unchanged. | Teaching each wire encoder every provider multiplies coupling and makes compatibility untestable. |
| Additive session-binding collection | Remote and SDK-native session identifiers/codecs must survive restarts and remain bound to the originating harness. | Storing provider IDs only in memory breaks resume; coercing private state into LangGraph checkpoints is unsafe. |
| Common ToolBroker and DelegationBroker | Security, caller credentials, approvals, and mixed-harness subagents must remain identical across local and remote harnesses. | Letting each provider invoke tools directly creates four policy implementations and bypass risks. |
| Claim-exclusive sandbox execution plane | The requested boundary must isolate each local harness loop, SDK, workspace, and generated process from the control plane and other conversations. | Sandboxing only shell tools leaves the model-directed harness and SDK inside the trusted API container. |
| Worker protocol and lease fencing | Pods are disposable and can emit late events or tool calls after eviction/replacement. | Direct public routing to pods would bypass canonical validation, stable APIs, authorization, and stale-worker rejection. |
| Separate state and memory contracts | Conversation continuity and cross-thread learning have different ownership, authorization, codecs, deletion, and retention. | Treating checkpoints, transcripts, memory, and pod files as one store causes leaks and makes eviction unsafe. |
| Distributed trace propagation | A run crosses API, policy, Kubernetes, worker, provider, state, memory, tools, and subagents. | Unrelated per-process traces cannot explain latency, persistence ambiguity, or authorization/tool causality. |

## Post-Design Constitution Re-check

PASS. The design adds abstractions only where four concrete adapters and the requested pod boundary require them, preserves the existing implementation as the first compatibility worker, keeps adapters and sandbox profiles statically registered, documents the architecture change, defines test gates, and centralizes credentials and security outside provider execution.
