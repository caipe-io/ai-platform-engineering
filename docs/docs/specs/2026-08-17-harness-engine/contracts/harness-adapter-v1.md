# Harness Adapter Contract v1

> **Vertical-slice mapping:** The independent implementation uses the smaller
> `descriptor` / `evaluate` / `initial_provider_session_id` / `stream(RunContext)`
> protocol documented in [Portable abstractions](../portable-abstractions.md).
> The lifecycle-rich runtime protocol below is the certification target for
> interrupts, restart, cleanup, and sandbox workers.

## Purpose

This contract isolates provider SDKs from the Harness Engine control plane. Local adapters implement it inside a sandbox worker; provider-managed adapters implement it behind the control-plane remote client. It is intentionally small and async. Concrete Python names may change during implementation, but behavior and ownership are normative.

## Contract versioning

- Contract version is integer `1`.
- An adapter declares all supported versions and one implementation version.
- The engine refuses registration when there is no common contract version.
- Additive optional fields do not require a major contract change.
- Removing a method/event, changing terminal semantics, or broadening adapter authority requires a new contract version.

## HarnessAdapter protocol

```python
class HarnessAdapter(Protocol):
    @property
    def descriptor(self) -> HarnessDescriptor: ...

    async def health(self) -> HarnessHealth: ...

    async def evaluate(
        self,
        config: NormalizedAgentConfig,
        deployment: DeploymentContext,
    ) -> CapabilityReport: ...

    async def create_runtime(
        self,
        context: RuntimeConstructionContext,
    ) -> HarnessRuntime: ...
```

Registration requirements:

- Stable lowercase ID matching `^[a-z][a-z0-9_]{1,63}$`.
- Static allowlisted registry entry.
- JSON schema rejects unknown options by default.
- Descriptor reports execution mode, trust boundary, required dependencies, configuration, capabilities, and certification evidence version.
- Execution mode is `sandbox_pod`, `provider_managed`, or explicitly compatibility-only `in_process`.
- A `sandbox_pod` descriptor references an operator-owned profile ID; it cannot supply a raw Pod spec, image, command, service account, volume, RuntimeClass, or NetworkPolicy.
- Import and descriptor construction perform no provider network call.

## HarnessRuntime protocol

```python
class HarnessRuntime(Protocol):
    @property
    def identity(self) -> RuntimeIdentity: ...

    async def initialize(self) -> RuntimeInitResult: ...

    def stream(self, turn: TurnInput) -> AsyncIterator[CanonicalEvent]: ...

    def resume(self, decision: ResumeDecision) -> AsyncIterator[CanonicalEvent]: ...

    async def pending_interrupt(self) -> PendingInterrupt | None: ...

    async def cancel(self, reason: CancelReason) -> CancelResult: ...

    async def restart(self) -> RestartResult: ...

    async def cleanup(self) -> None: ...
```

Lifecycle requirements:

- `initialize` is idempotent per runtime object or returns the same terminal error.
- Only one mutating `stream`, `resume`, `restart`, or `cleanup` operation runs at a time.
- `stream` and `resume` yield exactly one valid canonical run lifecycle.
- `cancel` is idempotent and safe before, during, or after a run.
- `restart` releases provider clients/processes and recreates them on next use without clearing durable conversation state.
- `cleanup` is idempotent, bounded by a deadline, and releases tool wrappers, connections, credentials, processes, temporary directories, and provider clients.
- Adapter exceptions are classified and sanitized before crossing the boundary.

## Runtime construction context

The adapter receives immutable narrowed values:

```text
RuntimeConstructionContext
├── contract_version
├── agent: NormalizedAgentConfig
├── binding: SessionBindingView
├── model: ModelSelection
├── prompt: RenderedPrompt
├── tools: tuple[PortableTool]
├── skills: SkillManifest
├── files: FileWorkspace
├── interrupt_policy: InterruptPolicy
├── middleware_policy: PortableMiddlewarePolicy
├── limits: RunLimits
├── telemetry: TelemetrySink
├── thread_state: ThreadStateStore
├── memory: MemoryBroker
└── cancellation: CancellationToken
```

It does not receive:

- FastAPI `Request` or response objects;
- SSE encoders;
- MongoDB database/collection handles;
- raw JWT claims or unrestricted bearer tokens;
- credential service clients;
- arbitrary host environment access;
- another adapter's native state.

For `sandbox_pod` execution, these interfaces are serialized through the [Sandbox Worker Protocol v1](./sandbox-worker-v1.md). The worker receives scoped service facades and capabilities, never the control plane's underlying clients or credentials.

## Turn input

```text
TurnInput
├── run_id
├── conversation_id
├── message: text
├── files: tuple[ValidatedInputFile]
├── user: SafeUserContext
├── client_context: mapping
├── trace_context
├── deadline
└── idempotency_key
```

Files contain engine-controlled references/read handles. Inline bytes are supplied only when required and after size/type validation.

## PortableTool

```python
class PortableTool(Protocol):
    @property
    def descriptor(self) -> ToolDescriptor: ...

    async def invoke(
        self,
        arguments: Mapping[str, Any],
        call_context: ToolCallContext,
    ) -> ToolOutcome: ...
```

Rules:

- Adapter tool names preserve the stable common tool ID through a reversible provider-safe mapping.
- The adapter cannot replace the input schema or widen allowed arguments.
- All calls flow through the handle; the adapter cannot receive the underlying credential.
- A `ToolOutcome` is success, bounded failure, or pending canonical interrupt.
- Retrying a tool is controlled by common policy and idempotency metadata, not provider guesswork.
- Delegation is a PortableTool supplied by DelegationBroker.

## Session state contract

Adapters choose one declared strategy:

- `langgraph`: existing checkpoint collection and thread semantics;
- `adapter_store`: opaque native state through `ThreadStateStore`;
- `remote_managed`: provider state plus durable binding/reference;
- `ephemeral`: explicitly no multi-turn history.

Every certified non-ephemeral interactive adapter implements:

- create native session;
- resume after service restart on another replica;
- delete/reset native state or create a new epoch;
- restore pending interrupts;
- report durability failure;
- enforce binding ownership and version.
- commit and restore the exact durable native state head through the common state facade.

Provider-native state is opaque. The adapter may store bytes or JSON-safe records through scoped keys but cannot list or read another binding.

Thread state, long-term memory, and tracing follow the separate [State, Memory, and Tracing Contract v1](./state-memory-tracing-v1.md). Provider-native memory cannot bypass the common MemoryBroker for certified portable behavior.

## Interrupt contract

Adapters normalize native pauses to:

- `form_input` with validated field definitions; or
- `tool_approval` with one or more tool calls and allowed decisions.

`ResumeDecision` includes binding ID, interrupt ID, revision, idempotency key, and one of:

- form values;
- dismiss;
- per-tool approve;
- per-tool reject;
- per-tool edit with revalidated arguments.

The adapter must not resume a different native pause, reuse a consumed decision, or broaden allowed decisions.

## Capabilities

Required capability keys for v1:

```text
stream.text
stream.reasoning
stream.usage
invoke.non_streaming
session.multi_turn
session.cross_replica_resume
session.clear
thread.durable_commit
thread.eviction_restore
interrupt.form_input
interrupt.tool_approval
interrupt.multi_tool
tool.mcp
tool.builtin
tool.caller_credentials
tool.partial_availability
tool.cancellation
input.images
input.documents
skills
subagents
subagents.mixed_harness
middleware.portable
memory.semantic
memory.episodic_reference
memory.procedural
memory.user_scope
memory.shared_policy
observability.metrics
observability.tracing
observability.trace_propagation
observability.redaction
runtime.cancel
runtime.restart
runtime.bounded_cleanup
runtime.sandbox_isolation
runtime.lease_fencing
runtime.eviction_recovery
```

Each capability reports:

- level: `native`, `emulated`, `unsupported`, `unavailable`;
- constraints in machine-readable form;
- human explanation;
- conformance evidence identifier when certified.

## Error contract

Adapter errors map to one category:

| Category | Retryable | Examples |
|---|---:|---|
| `configuration` | no | invalid options, incompatible model |
| `authentication` | usually no | missing/expired provider credentials |
| `authorization` | no | provider/IAM denial |
| `capacity` | yes | concurrency quota or local capacity |
| `throttled` | yes | provider rate limit |
| `unavailable` | yes | provider, sandbox worker, or SDK subprocess unavailable |
| `timeout` | policy | initialization/turn/tool deadline |
| `protocol` | no | malformed or invalid event order |
| `persistence` | policy | native state could not save/load |
| `cancelled` | no | caller or shutdown cancellation |
| `internal` | no | unexpected adapter defect |

Errors include safe public message, internal diagnostic, provider code if non-sensitive, retry interval, and whether output or side effects may have occurred. Only the safe projection reaches clients.

## Health contract

Health checks are bounded and side-effect free:

- dependency installed/version compatible;
- required deployment configuration present;
- provider reachability/identity when enabled;
- session/tool storage reachable when required;
- capacity active/limit/pending;
- last successful check and sanitized reason.

An optional adapter's failure does not fail global readiness. The default `deepagents` adapter and common Mongo/tool dependencies retain current readiness semantics.

## Conformance suite

Every adapter runs the same fixtures for:

1. initialization and cleanup idempotency;
2. text/reasoning/usage streaming and terminal ordering;
3. tool success, error, approval, edit, rejection, and multiple calls;
4. MCP partial failure and caller credential isolation;
5. session restart, cross-replica resume, clear, and expired state;
6. form input and duplicate/conflicting resume;
7. cancellation at every lifecycle boundary;
8. file modalities and limits;
9. skills and missing/blocked skill behavior;
10. subagents, mixed harnesses, namespaces, cycles, and nested interrupts;
11. provider faults, malformed events, timeouts, and sanitized errors;
12. metrics/traces/redaction and resource leak checks.

Certification is version-specific. Changing adapter or provider SDK versions invalidates evidence until the suite passes again.
