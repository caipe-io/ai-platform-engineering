# Research: Harness Engine

> **2026-08-18 implementation update:** The original replacement decision below
> remains future migration research. The approved current slice is the
> independent service described in [Portable abstractions](portable-abstractions.md),
> and no Dynamic Agents source is changed.

**Date**: 2026-08-17
**Scope**: Dynamic Agents compatibility surface, multi-harness architecture, and first-party adapter feasibility

## Decision 1: Use an in-place strangler migration

**Decision**: Evolve `ai_platform_engineering/dynamic_agents` into Harness Engine while preserving the package, routes, service address, chart, image alias, MongoDB collections, and rollback path. Wrap the current runtime as the first adapter before moving behavior.

**Rationale**:

- The current service has a broad, tested surface: authentication/authorization, chat start/resume/invoke/cancel/restart, two stream protocols, MCP credentials and retries, tools, skills, attachments, subagents, interrupts, checkpoints, files, cache limits, and observability.
- A parallel rewrite would make “exact same functionality” dependent on manual comparison.
- Keeping the old workload able to read the same data makes rollback a routing operation.

**Alternatives considered**:

- **New service and package copied from Dynamic Agents**: rejected because two implementations would drift immediately.
- **Rename everything first**: rejected because it adds deployment/client churn before the execution abstraction proves itself.
- **Big-bang refactor of `AgentRuntime`**: rejected because it removes the working oracle before canonical contracts exist.

## Decision 2: Define one canonical lifecycle before adding adapters

**Decision**: Adapters yield a versioned discriminated union of canonical events. Custom SSE and AG-UI encoders consume only canonical events.

**Rationale**:

- Current encoders parse LangGraph tuple/chunk objects, which makes LangGraph an implicit public dependency.
- Claude Agent SDK, Strands, and AgentCore use different stream types and terminal states.
- A validated state machine makes ordering, identity, payload bounds, interrupt semantics, and protocol compatibility independently testable.

**Alternatives considered**:

- **Translate every provider directly to both wire protocols**: rejected because four adapters times two protocols creates eight mappings and inconsistent fixes.
- **Make adapters synthesize LangGraph chunks**: rejected because it preserves the wrong dependency and relies on private LangGraph shapes.
- **Adopt AG-UI as the internal model**: rejected because the legacy custom stream and internal usage/session events need semantics not safely inferred from AG-UI frames.

## Decision 3: Keep security and tools outside harness adapters

**Decision**: A common ToolBroker resolves and executes MCP/built-in tools and a DelegationBroker executes subagents. Adapters receive narrowed callable handles or provider-specific wrappers.

**Rationale**:

- Existing caller-token forwarding, provider connection exchange, AgentGateway routing, signed agent context, OpenFGA checks, SSRF protection, approvals, retries, schema sanitation, and result truncation are security behavior, not framework behavior.
- Mixed-harness subagents require a common parent/child authorization and event namespace.
- Remote harnesses must not receive broad credentials or bypass established audit controls.

**Alternatives considered**:

- **Give each harness direct MCP configuration**: rejected for the baseline because provider-native credential and policy behavior differs.
- **Use provider-native subagents for all delegation**: rejected because it cannot guarantee mixed-harness routing or common child authorization.
- **Duplicate tool wrappers per adapter**: rejected because security behavior would diverge.

## Decision 4: Use capabilities plus certification, not optimistic fallback

**Decision**: Each adapter declares `native`, `emulated`, `unsupported`, or `unavailable` for a fixed baseline. An adapter becomes `certified` only after the common conformance suite proves all required behavior.

**Rationale**:

- Product names alone do not imply equivalent model, session, HITL, filesystem, middleware, or cancellation behavior.
- Early, actionable validation is safer than silently dropping agent configuration.
- The same adapter may be healthy but incompatible with a particular model or feature set.

**Alternatives considered**:

- **Boolean supported flag**: rejected because it conflates installation, health, native support, and engine emulation.
- **Best-effort execution**: rejected because it violates exact-functionality and fail-closed requirements.
- **Automatic fallback to Deep Agents**: rejected because a second run can duplicate external side effects and change model behavior.

## Decision 5: Bind conversations to a harness and retain native state codecs

**Decision**: Persist a harness session binding and adapter-owned opaque state reference. Do not translate private checkpoint formats between harnesses.

**Rationale**:

- LangGraph checkpoints, Claude transcripts, Strands session snapshots, and AgentCore managed sessions have different semantics.
- A conversation must not move because an agent configuration changed after the conversation started.
- New epochs provide safe clear/reset without pretending remote history was mutated.

**Alternatives considered**:

- **One universal transcript as the only state**: rejected because tool-loop state, pending interrupts, compaction, subagent state, and provider IDs are not recoverable from visible messages alone.
- **Store adapter state in the existing LangGraph collection**: rejected because it couples unrelated codecs and makes old Dynamic Agents rollback riskier.
- **Always start a new conversation after restart**: rejected because it breaks current persistence behavior.

## Decision 6: Claude Agent SDK runs in a sandbox worker with engine-governed storage

**Finding**: The Python SDK supports async iteration, continuous clients, interrupts, hooks, custom tools, MCP, sessions, subagents, skills, and OpenTelemetry. Its `SessionStore` can mirror transcripts to an external backend and resume them on another host. The official documentation notes that mirror writes are best-effort and that SDK file checkpointing conflicts with an external session store.

**Decision**:

- Use the Python `ClaudeSDKClient`/query primitives through an adapter; accept only Claude-compatible models.
- Run the SDK and its subprocess inside the Claude worker image with a pod-local temporary `CLAUDE_CONFIG_DIR` per session.
- Provide a Mongo-backed `SessionStore` through the binding-scoped state facade; the worker receives no MongoDB client.
- Disable SDK file checkpointing; expose Harness Engine's existing GridFS/file APIs instead.
- Treat `mirror_error` as a durability fault: emit a sanitized error/warning, mark the binding degraded, and prevent certification until restart/resume and store-failure tests meet the baseline.
- Wrap ToolBroker handles in a worker-local SDK MCP server; translate permissions and `AskUserQuestion` to canonical interrupts.
- Link SDK OpenTelemetry to the existing trace while retaining common redaction.

**Sources**:

- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python)
- [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [MCP integration](https://code.claude.com/docs/en/agent-sdk/mcp)
- [Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability)

**Alternatives considered**:

- **Use Claude Client SDK and implement the loop**: rejected because the request is specifically to support the Agent SDK harness.
- **Reuse host `~/.claude` state**: rejected because it risks cross-user leakage and cannot support multi-replica recovery.
- **Allow Claude built-in filesystem/shell without common policy**: rejected for the portable baseline.

## Decision 7: Strands runs in a sandbox worker using hooks and a custom session repository

**Finding**: Strands provides async streaming events, strongly typed lifecycle/tool hooks, MCP clients, session management with custom repositories, multi-agent events, and resumable interrupts. Session managers are documented as not thread-safe, so per-binding serialization is required.

**Decision**:

- Use `stream_async` and hooks to produce canonical lifecycle events and metrics.
- Implement the Strands session repository over the binding-scoped state facade backed by MongoDB, with a control-plane lock per binding.
- Wrap ToolBroker handles as Strands tools/MCP providers.
- Use Strands interrupts for provider-native pauses, normalized into the common interrupt record.
- Use DelegationBroker for configured CAIPE subagents; leave Strands-native graphs/swarms as provider extensions until separately certified.

**Sources**:

- [Strands streaming events](https://strandsagents.com/docs/user-guide/concepts/streaming/)
- [Async iterator streaming](https://strandsagents.com/docs/user-guide/concepts/streaming/async-iterators/)
- [Hooks](https://strandsagents.com/docs/user-guide/concepts/agents/hooks/)
- [Session management](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/)
- [MCP tools](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/)
- [Interrupts](https://strandsagents.com/docs/user-guide/concepts/interrupts/)

**Alternatives considered**:

- **Use only Strands callback handlers**: rejected because async iterators integrate more cleanly with FastAPI streaming and cancellation.
- **Use local file sessions**: rejected for multi-replica production and because the project already relies on MongoDB.

## Decision 8: Integrate managed AgentCore Harness, not “AgentCore” as an ambiguous framework

**Finding**: AgentCore Runtime is a hosting environment for user-supplied agent code; managed AgentCore Harness is a configuration-driven agent loop running on Runtime and powered by Strands. Harness supports stateful isolated sessions, streaming events, multiple model providers, remote MCP/Gateway tools, skills, memory, filesystem, observability, versions, and endpoints. Inline functions return tool calls to the client and are explicitly suitable for human approvals and custom integrations.

**Decision**:

- Define `agentcore` as the managed Harness adapter for this feature.
- Store harness ARN, endpoint/qualifier, region, immutable version, provider session ID, and epoch in the session binding.
- Use deterministic opaque IDs that satisfy AgentCore session rules; never send raw email or user names.
- Use inline functions for the portable baseline so tool execution, caller credentials, approval, audit, and results return through ToolBroker.
- Add direct AgentCore Gateway/MCP as an optional capability only after policy and credential equivalence is proven.
- Treat cold starts, remote timeouts, IAM denial, throttling, maximum lifetime, and stopped sessions as adapter-classified errors.

**Sources**:

- [AgentCore Harness overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html)
- [Harness get started and stream events](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-get-started.html)
- [Harness tools and inline functions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html)
- [Harness versus Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-vs-runtime.html)
- [Runtime session isolation and lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)

**Alternatives considered**:

- **Host the existing service on AgentCore Runtime and call that an adapter**: rejected because hosting location does not provide another harness.
- **Let AgentCore execute all remote MCP tools directly**: deferred because it would bypass the common per-caller tool policy until equivalent controls are demonstrated.
- **Map one CAIPE conversation directly to a user-supplied session string**: rejected due to provider constraints and identity disclosure.

## Decision 9: Split the trusted control plane from a sandboxed execution plane

**Finding**: Deep Agents documents two patterns. “Agent in sandbox” puts the entire agent loop in the isolated environment and requires an HTTP or WebSocket communication layer; “sandbox as tool” leaves the agent loop on the host and remotely executes only filesystem/shell operations. The latter keeps keys and agent state outside the sandbox, but it does not isolate the harness SDK, model-directed loop, parser, subprocesses, or provider dependencies.

**Decision**: Use the **agent-in-sandbox** pattern for local harnesses. The existing FastAPI service becomes the trusted Harness Engine control plane. Deep Agents, Claude Agent SDK, and Strands run in claim-exclusive Kubernetes Agent Sandbox pods and communicate through a versioned worker protocol. Managed AgentCore remains `provider_managed` and does not receive a redundant pod.

**Rationale**:

- The requested boundary is the whole harness runtime, not only shell execution.
- A compromised or defective SDK/parser cannot reach the API process, Mongo client, Kubernetes client, or another runtime.
- Provider dependencies can use adapter-specific images without creating incompatible Python locks in the control-plane image.
- Public routes, authorization, persistence, canonical events, and client streams remain unchanged.

**Sources**:

- [Deep Agents sandbox patterns](https://docs.langchain.com/oss/python/deepagents/sandboxes)
- [Kubernetes Agent Sandbox overview](https://agent-sandbox.sigs.k8s.io/docs/)
- [Agent Sandbox coding-agent architecture](https://agent-sandbox.sigs.k8s.io/docs/use-cases/coding-agents/)

**Alternatives considered**:

- **Sandbox only `execute()` and filesystem tools**: rejected as the primary boundary because the harness still runs beside the API, credentials, and database clients.
- **One long-lived Deployment per adapter**: rejected because replicas would still multiplex tenants and conversation files/processes.
- **One pod per turn**: rejected as the default because repeated cold starts and workspace hydration break interactive continuity; it remains an optional high-isolation profile.
- **Keep every adapter in the API image**: retained only as an explicitly enabled migration/rollback mode, never the production target.

## Decision 10: Use one exclusive SandboxClaim per conversation epoch

**Finding**: Deep Agents recommends thread-scoped sandboxes by default: the first turn creates a sandbox, follow-up turns reuse it, and TTL removes it after inactivity. Agent Sandbox provides a stateful singleton `Sandbox` with stable identity, optional persistent storage, hibernation/resume, scheduled deletion, operator-owned `SandboxTemplate`s, user-facing `SandboxClaim`s, and `SandboxWarmPool`s.

**Decision**:

- Scope one sandbox lease to one Harness Engine session binding and epoch.
- Reuse the sandbox for follow-up turns while the lease is healthy.
- Persist claim name/UID, Sandbox UID, endpoint, profile, generation, readiness, and expiry in `harness_sessions`.
- On clear, max lifetime, eviction, or unrecoverable worker failure, claim a new sandbox, increment the lease generation, rehydrate durable harness state, and fence the old worker.
- Use `SandboxTemplate`/`SandboxWarmPool` references from an operator-owned profile; never build arbitrary Pod specs from agent documents.

**Sources**:

- [Deep Agents lifecycle and thread scoping](https://docs.langchain.com/oss/python/deepagents/sandboxes)
- [Agent Sandbox CRDs and lifecycle](https://agent-sandbox.sigs.k8s.io/docs/)
- [Agent Sandbox warm-pool workflow](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/warmpool-quickstart/)

**Alternatives considered**:

- **Assistant-scoped/shared sandbox**: rejected because conversations and callers could observe shared files and processes.
- **Direct Pod creation from Harness Engine**: rejected because it broadens RBAC and duplicates stable identity, claim, warm-pool, persistence, and lifecycle controllers.
- **Unconditional persistent volume per conversation**: rejected as the baseline; provider/session state stays in Mongo/GridFS and PVCs are profile-specific for workloads that truly need POSIX persistence.

## Decision 11: Keep credentials and governed tools outside the sandbox

**Finding**: Deep Agents explicitly recommends never placing secrets in a sandbox. Its preferred pattern is to keep authenticated tools outside the sandbox; a credential-injecting network proxy is the other option. It also warns that sandboxing alone does not prevent prompt/context injection or network exfiltration.

**Decision**:

- Do not mount raw user, MCP, MongoDB, cloud, or Kubernetes credentials into worker pods.
- The worker receives short-lived, audience-bound run and tool-broker capability tokens containing only binding, generation, run, tool, and expiry claims.
- Tool invocations call the trusted ToolBroker, which re-authorizes the tool and injects credentials outside the sandbox.
- Network policy allows only DNS, the control-plane worker endpoint/ToolBroker, the selected model endpoint or an egress proxy, and explicitly approved artifact endpoints.
- Sandboxes receive no Kubernetes service-account token and no direct MongoDB/OpenFGA/credential-service route.

**Sources**:

- [Deep Agents sandbox security and secret handling](https://docs.langchain.com/oss/python/deepagents/sandboxes)
- [Composing Agent Sandbox with NetworkPolicy](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/composing-sandbox-nw-policies/)

**Alternatives considered**:

- **Inject provider and tool API keys as environment variables**: rejected because model-directed code can read and exfiltrate them.
- **Give each worker a Kubernetes service account**: rejected; only the control plane needs permission to create and inspect claims.
- **Permit unrestricted internet egress**: rejected because pod isolation does not stop data exfiltration.

## Decision 12: Use hardened, adapter-specific worker images and warm claims

**Decision**:

- Publish immutable, signed worker images per harness adapter on a minimal common worker base.
- Map each harness/workload class to a static sandbox profile containing template/pool, image digest, RuntimeClass, resources, storage, egress class, idle TTL, maximum lifetime, and readiness deadline.
- Prefer Kata Containers for the highest-risk multi-tenant profiles and allow gVisor where its compatibility/performance trade-off is certified.
- Warm pools pre-start pods, but a claimed pod becomes exclusive. Destroy-on-release is the default; reuse requires a separately proven reset controller.

**Rationale**:

- Agent Sandbox deliberately decouples its CRD API from gVisor, Kata, and other OCI runtimes.
- Adapter-specific images isolate dependency graphs and let certification bind an adapter version to an exact image digest.
- Warm pools reduce interactive latency without returning to process multiplexing.

**Sources**:

- [Agent Sandbox isolation and runtime flexibility](https://agent-sandbox.sigs.k8s.io/)
- [Agent Sandbox warm-pool quickstart](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/warmpool-quickstart/)
- [Agent Sandbox gVisor guidance](https://agent-sandbox.sigs.k8s.io/docs/use-cases/gvisor-isolation/)
- [Agent Sandbox Kata Containers guidance](https://agent-sandbox.sigs.k8s.io/docs/use-cases/kata-containers-isolation/)

**Alternatives considered**:

- **One universal image with every SDK**: rejected because it expands the supply chain and couples adapter upgrades.
- **Runtime package installation**: rejected because it defeats image signing, reproducibility, and readiness budgets.
- **Return released pods directly to the pool**: rejected by default because process/file/memory residue is difficult to prove absent.

## Decision 13: Preserve names and use additive storage for rollback

**Decision**: Keep `DYNAMIC_AGENTS_URL`, `/api/dynamic-agents`, `dynamic_agents`, the chart name, service DNS, and existing collections during this feature. Add optional harness/memory policy fields plus additive session-binding, adapter-state, and long-term-memory collections without rewriting legacy data.

**Rationale**:

- Client and deployment renames add no harness capability.
- Existing Dynamic Agents models ignore unknown additive fields.
- No backfill means rollback does not require reverse migration.

**Alternatives considered**:

- **Immediate rename to `/api/harness-engine` and `HARNESS_ENGINE_URL`**: rejected as a breaking change.
- **Duplicate every route under a new prefix**: deferred; aliases can be added later if a product rename is approved.

## Decision 14: Treat thread persistence as external short-term state

**Finding**: LangGraph separates thread-scoped checkpointers from cross-thread stores. Checkpointers preserve graph state for conversation continuity, human-in-the-loop, recovery, and fault tolerance; stores hold application-defined long-term memory. Deep Agents likewise describes short-term memory as checkpointed state scoped to one thread.

The current non-ephemeral Dynamic Agents runtime already uses `MongoDBSaver` for conversation checkpoints and a GridFS-backed store for large files. These are migration assets, not pod-local state, and remain the Deep Agents compatibility oracle.

**Decision**:

- Keep each harness's native thread codec, but access it through a binding-scoped `ThreadStateStore` facade.
- Preserve the existing MongoDBSaver collections and thread IDs for the Deep Agents compatibility worker.
- Persist native checkpoint head, run idempotency, pending interrupt, adapter codec/version, and a durable-commit revision in `harness_sessions` or adapter state.
- Do not acknowledge a turn as durably complete until the final native state reference and binding revision commit.
- If client-visible output precedes a failed commit, return `uncertain_durability`, fence the run, retain the last durable head, and never automatically replay possible side effects.

**Sources**:

- [LangGraph persistence: checkpointers versus stores](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Deep Agents memory and short-term thread state](https://docs.langchain.com/oss/python/deepagents/memory)

**Alternatives considered**:

- **Use pod-local files as thread state**: rejected because eviction and hibernation would lose acknowledged work.
- **Translate every harness into LangGraph checkpoints**: rejected because private execution state and interrupt semantics are not portable.
- **Replay automatically after an ambiguous crash**: rejected because tools or remote calls may already have produced side effects.

## Decision 15: Add a policy-governed MemoryBroker for cross-thread memory

**Finding**: Deep Agents distinguishes long-term memory from thread state and supports agent-, user-, and organization-scoped memory. Its guidance defaults sensitive writable memory toward user isolation, recommends read-only shared policies, warns that shared writable memory is a prompt-injection surface, and notes that concurrent file writes can conflict.

**Decision**:

- Define long-term memory independently from thread checkpoints, chat transcripts, sandbox workspace, and operator-owned skills.
- Support semantic facts/preferences, episodic references to authorized prior threads, and procedural learned memory.
- Default writable learned memory to `(environment, subject, agent)` scope.
- Require explicit policy for agent-shared memory and make organization memory read-only by default.
- Route reads/writes through MemoryBroker authorization, provenance, scan/redaction, revision compare-and-set, retention, approval, and audit.
- Materialize memory into a worker only as a bounded lease-local cache; the durable source stays outside the sandbox.

**Sources**:

- [Deep Agents long-term and scoped memory](https://docs.langchain.com/oss/python/deepagents/memory)
- [LangGraph stores for cross-thread memory](https://docs.langchain.com/oss/python/langgraph/persistence)

**Alternatives considered**:

- **Treat the entire conversation history as agent memory**: rejected because retention, authorization, relevance, and user expectations differ.
- **Let each provider own memory directly**: rejected for the portable baseline because scopes, deletion, audit, and authorization would diverge.
- **Last-write-wins shared memory**: rejected because concurrent conversations could silently discard learned state.

## Decision 16: Propagate sanitized W3C traces across every boundary

**Finding**: OpenTelemetry context propagation correlates traces, logs, and metrics across process and network boundaries. Its default propagator uses W3C Trace Context. OpenTelemetry also warns against trusting arbitrary external trace headers or placing credentials, PII, or sensitive values in baggage.

Dynamic Agents already forwards `traceparent` to authorization services and has an OpenTelemetry skill-content scrubber. The ingress middleware currently stores the request header directly, so Harness Engine must add validation/re-rooting before propagating it to workers and brokers.

**Decision**:

- Validate or replace incoming client trace context, then propagate W3C `traceparent` across the coordinator, sandbox worker, brokers, state/memory stores, subagents, and trusted provider integrations.
- Allowlist only opaque low-cardinality baggage such as harness ID/version, binding/run digest, sandbox profile, and lease generation.
- Create spans for authorization, session binding, claim/readiness, worker lifecycle, model/provider, checkpoint commit, memory read/write, tools, subagents, canonical validation, and protocol encoding.
- Export worker telemetry only to an in-cluster OpenTelemetry Collector or control-plane facade. Apply common scrubbing, sampling, and bounded outage buffering before external export.
- Suppress internal context on untrusted provider/tool destinations unless an explicit policy permits it.

**Sources**:

- [OpenTelemetry context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)

**Alternatives considered**:

- **Generate unrelated worker traces**: rejected because claim, provider, tool, memory, and persistence latency could not be reconstructed causally.
- **Put user/conversation data in baggage**: rejected because baggage crosses services and can be logged or forwarded.
- **Let each SDK export directly**: rejected because provider-native exporters could bypass common redaction and destination policy.

## Open implementation risks (resolved by gates, not design questions)

- SDK versions may have transitive dependency conflicts with the current Python 3.13 lock. Resolution: lock and scan each adapter independently before enablement; use a worker boundary only if the lock cannot be resolved safely.
- Claude external session mirroring can degrade on store failure. Resolution: detect `mirror_error`, test recovery, and withhold certification if the durability baseline is not met.
- AgentCore inline-function round trips may increase tool latency and have service quotas. Resolution: benchmark and set explicit per-adapter capacity/timeouts before certification.
- Exact middleware outcomes may not map natively. Resolution: implement outcomes in common pre/post policies where safe; otherwise report `unsupported` and do not certify the adapter.
- Cancellation cannot undo an already-started external side effect in any harness. Resolution: match existing best-effort semantics, stop further event acceptance, audit the race, and never automatically retry/fallback.
- Agent Sandbox CRDs and APIs may evolve. Resolution: pin controller/CRD/client versions, validate them at startup, and certify upgrades against the worker and lifecycle conformance suites.
- Warm-pool readiness depends on cluster capacity. Resolution: separate warm and cold readiness SLOs, cap pending claims, and classify exhaustion as retryable capacity without falling back to in-process execution.
- Final checkpoint persistence can fail after partial output. Resolution: separate stream completion from durable completion, expose uncertain durability, retain idempotency metadata, and forbid automatic replay after possible side effects.
- Cross-thread memory can amplify prompt injection or leak between users. Resolution: user scope by default, shared read-only policy, content scanning, explicit provenance, approval for sensitive writes, and authorization before retrieval.
- Telemetry can leak content or overload runtimes during collector failure. Resolution: attribute allowlists, common scrubbers, bounded queues, tail sampling, and a protected in-cluster collector endpoint.
