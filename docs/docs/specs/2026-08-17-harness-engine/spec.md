# Feature Specification: Harness Engine

> **Delivery alignment (2026-10-21):** [Delivery phases](delivery-phases.md) is the canonical release sequence: Phase 1 independent engine/gateway (PR 2401), Phase 2 Deep Agents integration and pluggable builder, Phase 3 external sandbox execution, Phase 4 cross-harness composition. These boundaries are proposed for review; current-path correctness remains a Phase 1 merge gate.

> **Implementation amendment (2026-08-18):** Harness Engine is an independent
> service deployed beside Dynamic Agents. It does not import, replace, or modify
> Dynamic Agents. It owns complete portable agent blueprints, immutable versions,
> session bindings, runs, and canonical events in separate collections. AgentCore
> and Claude Agent SDK are the first contract probes. Migration and compatibility
> remain separate opt-in phases. See [Portable abstractions](portable-abstractions.md).
>
> **Harness Gateway amendment (2026-08-18):** The existing BFF
> `/api/v1/chat/stream/start`, `resume`, `cancel`, and `invoke` routes are the
> channel-neutral Harness Gateway. A BFF-owned `execution_harness_id` marker
> selects Dynamic Agents or the independent Harness Engine. Missing legacy
> markers resolve to Dynamic Agents. The gateway preserves authentication,
> OpenFGA, conversation authorization, and existing AG-UI/custom SSE contracts;
> provider execution and durable sessions never live in the BFF.

**Feature Branch**: `2026-08-17-harness-engine`
**Created**: 2026-08-17
**Status**: Draft
**Input**: User description: "Design a Harness Engine as a replacement for Dynamic Agents with the same functionality and architecture, while supporting additional harnesses such as Claude Agent SDK, Amazon Bedrock AgentCore, Strands Agents, and future providers."

## Overview

Harness Engine first adds an opt-in execution path beside Dynamic Agents. PR 2401 preserves the existing default runtime, configuration ownership, security model, conversation behavior and client protocols. A separately reviewed Phase 2 integrates `DeepAgentsAdapter` by reusing the existing runtime, with parity, migration and rollback gates before cutover.

The current Dynamic Agents behavior is the compatibility baseline. A harness is considered supported only when it passes the same baseline behavior suite or the engine supplies the missing behavior outside the harness. Provider-specific features may be exposed as optional extensions, but they cannot alter existing behavior unless an agent explicitly opts in.

## User Scenarios & Testing *(mandatory)*

The stories describe the full target architecture, not the scope of one PR. Priorities below rank requirements within their selected release; they do not require all P1 stories in PR 2401.

| Story | Delivery scope |
|---|---|
| US1: Deep Agents compatibility/replacement | Phase 2; deployment retirement requires its own parity and cutover evidence |
| US2: Per-agent harness selection | Phase 1 opt-in experimental selection; later certification follows applicable Phase 2–4 gates |
| US3: Consistent chat experience | Phase 1 declared stream capabilities; Phase 2 Deep Agents parity; Phase 4 cross-harness child visibility |
| US4: Add harnesses through contracts | Phase 1 adapter foundation; Phase 2 reusable builder panels; later adapters qualify independently |
| US5: Operations and rollback | Phase 1 current engine controls; Phase 2 adoption/rollback; Phase 3 worker operations |
| US6: Isolated local harness workers | Phase 3 |
| US7: Durable state across workers | Phase 2 native-state preservation and Phase 3 worker recovery; memory extensions are separately scoped |
| US8: Harness-aware builder | Phase 1 truthful capability controls; Phase 2 full descriptor/panel architecture |

### User Story 1 - Replace Dynamic Agents Without Disruption (Priority: P1)

As a platform operator, I want Harness Engine to replace Dynamic Agents in place so that existing agents, conversations, clients, policies, and operational procedures continue to work without coordinated migration.

**Why this priority**: A replacement is unsafe unless the existing production surface remains compatible and rollback remains simple.

**Independent Test**: Deploy Harness Engine with the compatibility harness and the existing data set, then run the current Dynamic Agents contract and end-to-end suites without modifying test clients or stored agent documents.

**Acceptance Scenarios**:

1. **Given** an existing agent document with no harness selection, **When** Harness Engine loads and executes it, **Then** it behaves as it did under Dynamic Agents.
2. **Given** an existing UI, workflow runner, scheduler, Slack client, Webex client, or API consumer, **When** its traffic is routed to Harness Engine, **Then** request paths, status codes, response shapes, stream events, and error behavior remain compatible.
3. **Given** persisted conversation checkpoints, files, attachment references, and interrupt state, **When** the compatibility harness resumes a conversation, **Then** the user can continue without losing history or pending work.
4. **Given** a failed rollout, **When** the operator restores the Dynamic Agents workload, **Then** existing configurations and persisted state remain readable without a reverse data migration.

---

### User Story 2 - Select a Certified Harness Per Agent (Priority: P1)

As an agent builder, I want to choose a supported harness for an agent and see whether its configuration is compatible so that I can use the right execution environment without learning a new chat or administration experience.

**Why this priority**: Per-agent harness choice is the central new capability and must not weaken the baseline contract.

**Independent Test**: Create equivalent agents using the Dynamic Agents-compatible, Claude Agent SDK, Amazon Bedrock AgentCore, and Strands Agents harnesses; validate each configuration and execute the baseline scenario suite through the same client.

**Acceptance Scenarios**:

1. **Given** a new or existing agent, **When** a builder selects a harness, **Then** the system reports supported, emulated, unsupported, and unavailable capabilities before the agent is saved or run.
2. **Given** a configuration that requires a capability the selected harness cannot provide or the engine cannot emulate, **When** the builder validates or saves it, **Then** the system rejects it with an actionable explanation and suggests compatible choices.
3. **Given** a valid harness selection, **When** a user starts, resumes, cancels, or restarts a run, **Then** the interaction uses the selected harness and preserves the established client contract.
4. **Given** no explicit harness selection, **When** the agent is saved or run, **Then** the compatibility harness is selected by default.
5. **Given** provider-specific options, **When** they are omitted, **Then** portable agent behavior does not change; when supplied, they are validated and isolated to the selected harness.

---

### User Story 3 - Receive the Same Chat Experience Across Harnesses (Priority: P1)

As an end user, I want chat, tools, files, subagents, and human approvals to behave consistently regardless of the selected harness so that changing harnesses does not require relearning the product.

**Why this priority**: The harness choice is an implementation concern unless it produces a deliberate, disclosed capability difference.

**Independent Test**: Replay a golden set of conversations through every certified harness and compare normalized outputs, lifecycle events, authorization decisions, side effects, and persisted state.

**Acceptance Scenarios**:

1. **Given** an agent that streams text, reasoning, tool calls, tool results, warnings, subagent activity, and completion, **When** it runs on any certified harness, **Then** clients receive correctly ordered custom SSE or AG-UI events with stable identifiers and namespace correlation.
2. **Given** a configured human-input request or tool approval, **When** execution pauses, **Then** the client receives the established interrupt shape and can resume with approve, edit, reject, or structured form input as configured.
3. **Given** MCP and built-in tools with user-scoped credentials, **When** the agent invokes a tool, **Then** allowlists, credential delegation, policy checks, error isolation, retries, and result limits are enforced consistently.
4. **Given** supported image or document attachments, **When** the user sends a multimodal turn, **Then** limits, durable references, provider compatibility checks, and degradation warnings remain consistent.
5. **Given** nested subagents and skills, **When** the parent delegates work, **Then** subagent identity, permissions, tool scope, skill content, streaming attribution, and interrupt/resume behavior are preserved.
6. **Given** a user opens an existing conversation, **When** the chat loads, **Then** a persistent identity header names the selected agent and its execution harness before the user sends a message.
7. **Given** several conversations or selectable agents, **When** the sidebar or new-chat picker renders them, **Then** each agent has a stable, visually distinct fallback color and every harness is identified by both text and color.

---

### User Story 4 - Add a Harness Without Rebuilding the Platform (Priority: P2)

As a platform developer, I want a versioned harness contract and conformance kit so that I can add a new harness without changing public routes, security services, persistence services, or client protocol encoders.

**Why this priority**: The replacement only has lasting value if future harness integrations are bounded and independently testable.

**Independent Test**: Implement a minimal conformance harness against the documented contract and prove that it can be registered, validated, exercised, observed, and removed without modifying shared request routing or client code.

**Acceptance Scenarios**:

1. **Given** a harness implementation, **When** it registers, **Then** it declares identity, version, configuration schema, deployment mode, health, and capability levels in a machine-readable manifest.
2. **Given** raw lifecycle output from a harness, **When** it is adapted, **Then** the engine emits only canonical events to protocol encoders and rejects malformed or out-of-order events.
3. **Given** a harness update, **When** its declared contract version is incompatible with the engine, **Then** readiness fails for that harness without making compatible harnesses unavailable.
4. **Given** a third-party harness failure, **When** a run errors or hangs, **Then** timeouts, cancellation, cleanup, sanitized errors, and metrics follow the common engine policy.

---

### User Story 5 - Operate, Compare, and Roll Back Harnesses (Priority: P2)

As a platform operator, I want harness-aware health, metrics, tracing, capacity controls, and rollout switches so that I can compare providers and safely contain failures.

**Why this priority**: Multiple local and managed execution systems introduce distinct latency, capacity, cost, and failure modes.

**Independent Test**: Run mixed traffic across all configured harnesses, inject provider and dependency failures, and verify dashboards, alerts, isolation, fallback policy, and rollback behavior.

**Acceptance Scenarios**:

1. **Given** mixed harness traffic, **When** operators inspect health and telemetry, **Then** they can distinguish harness, adapter version, execution mode, result, latency, token use, tool use, interrupt state, and capacity without exposing prompts, secrets, or skill bodies.
2. **Given** one unhealthy optional harness, **When** readiness is evaluated, **Then** existing agents on healthy harnesses continue to run and new runs targeting the unhealthy harness fail clearly.
3. **Given** a harness-specific capacity limit, **When** it is exhausted, **Then** only that harness rejects or queues new work according to policy and returns a retryable response.
4. **Given** an operator disables a harness, **When** new runs arrive for agents using it, **Then** the configured fail-closed or explicit fallback policy is applied and recorded; the engine never silently changes harnesses.

---

### User Story 6 - Isolate Each Local Harness Session in Its Own Pod (Priority: P1)

As a platform security operator, I want every local harness conversation to execute in a claim-exclusive sandbox pod so that generated code, SDK processes, files, and failures cannot affect the Harness Engine control plane or another conversation.

**Why this priority**: Harnesses execute model-directed code and tools. Process-level separation inside the API container is not an adequate multi-tenant boundary.

**Independent Test**: Run concurrent conversations for different subjects and harnesses, prove that each resolves to a distinct Sandbox UID and pod, attempt filesystem/process/network/credential escape, evict one pod, and verify isolation plus session recovery.

**Acceptance Scenarios**:

1. **Given** two active local-harness conversations, **When** they execute concurrently, **Then** each is bound to a different claim-exclusive Kubernetes Sandbox and cannot observe the other's processes, filesystem, environment, service account, or network traffic.
2. **Given** a follow-up turn in the same conversation, **When** its sandbox lease is healthy, **Then** it reuses the same stable sandbox identity and workspace until idle TTL, maximum lifetime, clear, or explicit termination.
3. **Given** a sandbox pod is evicted or expires, **When** the user continues the conversation, **Then** Harness Engine creates a new claim, restores durable harness/session state, increments a fencing generation, and rejects events from the stale worker.
4. **Given** a harness invokes an authenticated MCP or built-in tool, **When** the call executes, **Then** the sandbox receives no bearer token or provider secret and the common ToolBroker performs authorization and credential injection outside the sandbox.
5. **Given** a warm pool is enabled, **When** a conversation claims a pre-warmed pod, **Then** the pod becomes exclusive to that binding and is destroyed or verifiably reset before any reassignment.

---

### User Story 7 - Preserve Threads, Memory, and Traces Across Sandboxes (Priority: P1)

As a user and operator, I want conversation state, authorized agent memory, and distributed traces to survive sandbox replacement so that isolated execution does not reduce continuity, learning, recovery, or diagnosability.

**Why this priority**: Disposable pods are safe only when durable state and causal observability live outside them and retain the existing conversation semantics.

**Independent Test**: Persist a thread and user-scoped memory, evict its worker, resume on another worker and control-plane replica, then verify identical thread ownership, correct memory visibility, and one correlated trace across authorization, claim, worker, provider, memory, state, tool, and stream spans.

**Acceptance Scenarios**:

1. **Given** a completed or interrupted turn, **When** its worker is replaced, **Then** a new worker restores the exact harness-native thread checkpoint and pending interrupt without relying on pod-local files.
2. **Given** user-scoped long-term memory created in one conversation, **When** the same authorized user starts another conversation with the agent, **Then** the memory is available while another user cannot discover or modify it.
3. **Given** agent- or organization-scoped shared memory, **When** a worker attempts to change it, **Then** the configured read-only, approval, conflict, provenance, and audit policies are enforced outside the sandbox.
4. **Given** a request that crosses the control plane, worker, provider, ToolBroker, MemoryBroker, state store, and a subagent, **When** operators inspect telemetry, **Then** spans form one causal trace with stable opaque correlation and no prompt, memory body, credential, or PII leakage.
5. **Given** malformed or attacker-supplied trace context, **When** the request is accepted, **Then** Harness Engine sanitizes or replaces it before propagating context internally.

---

### User Story 8 - Create and Edit Agents for a Selected Harness (Priority: P1)

As an agent builder, I want the existing agent-creation wizard to adapt to the selected harness so that I can configure only compatible models and features without losing existing settings or learning a different editor.

**Why this priority**: Per-agent harness selection is usable only when compatibility is explained at the field where the builder can act on it, and existing Deep Agents authoring remains unchanged.

**Independent Test**: Create, edit, and clone agents for every catalog state and first-party harness; switch harnesses with compatible and incompatible drafts; change the catalog during editing; and verify field rendering, navigation, validation, persistence, and active-conversation warnings.

**Acceptance Scenarios**:

1. **Given** a legacy agent with no harness field, **When** a builder opens it, **Then** the existing five-step editor renders with Deep Agents selected at read time and no fields are rewritten merely by opening the page.
2. **Given** a builder selects a harness, **When** the selection is evaluated, **Then** the model list and each existing configuration section show the selected harness's native, emulated, unsupported, or unavailable status from a field-addressable capability report.
3. **Given** a draft has incompatible model, tool, skill, middleware, memory, or harness-option values, **When** the builder switches harnesses, **Then** the editor shows a compatibility diff and retains every value until the builder explicitly accepts individual fixes.
4. **Given** browser-side validation passes, **When** the builder saves, **Then** the BFF revalidates the exact payload against the current catalog and rejects stale or incompatible configuration before MongoDB or OpenFGA is mutated.
5. **Given** an existing agent has active or persisted conversations, **When** its harness changes, **Then** the editor explains that existing conversations remain pinned to their recorded harness, requires explicit confirmation, and offers state transfer only when the server declares a certified transfer path.
6. **Given** an existing agent references an unknown, disabled, or unavailable harness, **When** it is opened, **Then** the UI preserves and displays that harness faithfully, prevents unsafe replacement-by-default, and provides an actionable recovery path.

### Edge Cases

- An existing document is missing the harness field, contains unknown legacy fields, or uses a deprecated model or tool name.
- A selected harness is installed but its external service, credentials, model, region, or required feature is unavailable.
- A harness emits duplicate, missing, late, malformed, oversized, or out-of-order lifecycle events.
- The client disconnects during model output, a tool call, subagent work, or a pending human interrupt.
- Cancellation races with natural completion, interrupt creation, checkpoint persistence, or remote-session termination.
- A runtime is evicted or the service restarts while a conversation has a pending interrupt.
- The same conversation receives concurrent turns or concurrent resume attempts.
- An agent changes harness while it has active or persisted conversations.
- A parent and subagent use different harnesses, models, credential scopes, or persistence modes.
- A remote harness accepts a session identifier with stricter length or character rules than the existing conversation identifier.
- A harness supports text but not a requested attachment type, tool approval mode, middleware behavior, or reasoning stream.
- Tool credentials expire during a long-running or resumed session.
- A provider-native feature would produce data or events that the established protocols cannot represent.
- A warm-pool claim is allocated but the worker does not become ready before the run deadline.
- A stale sandbox worker continues emitting events after its claim was replaced.
- The sandbox controller, CRDs, RuntimeClass, network policy controller, or warm pool is unavailable.
- A sandbox exhausts CPU, memory, ephemeral storage, process count, or maximum lifetime during a turn.
- A worker crashes after client-visible output but before the durable thread commit marker.
- Two threads concurrently update the same user-, agent-, or organization-scoped memory record.
- A memory record contains instructions or data that attempt to broaden the worker's permissions.
- Trace export is slow or unavailable while the run itself remains healthy.
- A provider or external destination receives internal baggage or identifiers that policy forbids exporting.
- The harness catalog, availability, certification, model compatibility, or policy revision changes while the builder is editing or saving.
- A slow validation response for an older draft arrives after a newer harness or field selection.
- A selected model disappears from the harness-filtered catalog or becomes unavailable without changing its identifier.
- A harness switch makes only some selected tools, skills, middleware, subagents, or memory scopes incompatible.
- A builder switches away from a harness after entering unsaved harness-specific options and later switches back.
- An existing agent's harness is unknown to the current deployment, while its configuration still needs to remain inspectable and exportable.
- A clone is created from an agent whose harness is unavailable or whose active-conversation metadata must not be copied.
- A legacy agent has no `execution_harness_id`; Harness Gateway routes it to
  Dynamic Agents without depending on Harness Engine availability.
- A non-default harness is unavailable; Harness Gateway fails that request and
  never silently runs the same agent through Dynamic Agents.

## Requirements *(mandatory)*

Requirements cover the target architecture. Apply them through the [delivery scope](delivery-phases.md); sandbox, migration and cross-harness requirements are not claims of Phase 1 implementation. Authentication, authorization, retained execution ownership and fail-closed current-path behavior apply in every phase.

### Functional Requirements

#### Compatibility and service boundary

- **FR-001**: Harness Engine MUST preserve all existing Dynamic Agents client-facing route paths, methods, authentication requirements, authorization decisions, request fields, response fields, status codes, retry headers, and error categories.
- **FR-002**: Harness Engine MUST preserve the existing custom SSE and AG-UI wire contracts, including run lifecycle, text, reasoning, tool, warning, namespace, subagent, interrupt, error, and completion semantics.
- **FR-003**: Harness Engine MUST remain a runtime reader for agent and MCP configuration; existing administrative writes and ownership rules MUST remain with the current gateway layer.
- **FR-004**: Existing agent, MCP server, skill, conversation, checkpoint, file, attachment, authorization, and audit data MUST remain readable in place.
- **FR-005**: An agent document without a harness selection MUST resolve to the Dynamic Agents-compatible harness with no persisted backfill required.
- **FR-006**: The initial replacement MUST retain the existing service address, deployment topology, health probes, metrics exposure, and configuration aliases, while allowing a later naming transition that does not require client changes.
- **FR-007**: The Dynamic Agents-compatible harness MUST pass all existing Dynamic Agents unit, integration, contract, security, and end-to-end tests without weakening assertions.

#### Harness selection and certification

- **FR-008**: Harness Engine MUST support per-agent selection of the Dynamic Agents-compatible runtime, Claude Agent SDK, Amazon Bedrock AgentCore, and Strands Agents.
- **FR-009**: Harness Engine MUST maintain a machine-readable catalog containing each harness's stable identifier, display name, adapter version, contract version, execution mode, configuration schema, availability, health, and capability declaration.
- **FR-010**: Harness capability levels MUST distinguish at least `native`, `emulated`, `unsupported`, and `unavailable`.
- **FR-011**: A harness MUST NOT be marked `certified` until it passes the common conformance suite for every required baseline capability.
- **FR-012**: The system MUST validate harness selection and harness-specific configuration during create, update, request override, startup diagnostics, and runtime initialization.
- **FR-013**: Unsupported required behavior MUST fail before execution with a field-specific, actionable error; it MUST NOT be silently ignored or downgraded.
- **FR-014**: Harness-specific options MUST be namespaced, versioned, bounded in size, excluded from unsafe request overrides by default, and ignored by other harnesses.
- **FR-015**: Changing an agent's harness MUST invalidate affected cached runtimes and MUST require an explicit policy for existing conversations: continue on the recorded harness, start a new conversation, or perform a certified state transfer.

#### Portable execution baseline

- **FR-016**: Every certified harness MUST support streaming and non-streaming invocation, accumulated text output, optional reasoning output, stable run and tool-call identifiers, graceful cancellation, restart, and sanitized error reporting.
- **FR-017**: Every certified harness MUST support conversation continuity, durable checkpoints where configured, interrupt inspection, clear/reset, and restart recovery consistent with existing retention and namespace rules.
- **FR-018**: Every certified harness MUST support structured human input and per-tool approval with the configured approve, edit, and reject decisions, including multiple pending approvals and nested subagent interruptions.
- **FR-019**: Every certified harness MUST support existing MCP server transports, tool allowlists, namespacing, schema sanitation, credential-source resolution, caller-token forwarding, gateway routing, transient retry classification, partial availability, and bounded tool results.
- **FR-020**: Every certified harness MUST support all currently enabled built-in tools, including workflow delegation, with their existing security limits and caller identity behavior.
- **FR-021**: Every certified harness MUST support existing skills, scan gates, missing-skill warnings, system-prompt templates, client context, user context, and prompt-content scrubbing.
- **FR-022**: Every certified harness MUST support configured subagents, cycle prevention, distinct tool scopes, mixed-harness delegation, streaming attribution, and independent authorization.
- **FR-023**: Every certified harness MUST support existing middleware outcomes. A harness may implement an outcome natively or the engine may emulate it, but configuration order and observable policy results MUST remain consistent.
- **FR-024**: Every certified harness MUST support images and documents accepted by its selected model, enforce existing attachment limits, store durable attachment references, rehydrate content safely, and warn when content is skipped.
- **FR-025**: Harness-native tools, memory, files, or features MUST NOT bypass common authorization, credential, audit, retention, network, approval, or observability policy.

#### Canonical lifecycle and isolation

- **FR-026**: Harness Engine MUST define one versioned canonical lifecycle contract between harness adapters and client protocol encoders.
- **FR-027**: The canonical lifecycle MUST represent run start and finish, text and reasoning deltas, tool start/arguments/result/error, warnings, subagent or namespace context, human interrupts, usage, provider metadata, cancellation, and run errors.
- **FR-028**: Harness adapters MUST translate provider output into canonical events; client protocol encoders MUST NOT consume provider-native event objects.
- **FR-029**: The engine MUST validate canonical event ordering, identifiers, payload size, and terminal-state rules before encoding output.
- **FR-030**: Conversation and remote-session identifiers MUST be deterministically mapped without exposing user identity, must satisfy provider constraints, and must never collide across users, agents, harnesses, or environments.
- **FR-031**: Runtime cache, concurrency, session, cleanup, and capacity accounting MUST be isolated by harness, agent, conversation, and caller where required by the provider.
- **FR-032**: Harness selection, fallback, and state transfer MUST be explicit and auditable. Automatic fallback is disabled by default and MUST never occur after a run has produced side effects.

#### Security and operations

- **FR-033**: Existing bearer validation, delegated workflow authorization, agent-use authorization, OpenFGA enforcement, signed agent context, audit logging, and fail-closed behavior MUST apply before any harness is invoked.
- **FR-034**: Secrets and caller credentials MUST be supplied only at execution time, scoped to the requesting principal and target, redacted from configuration and telemetry, and released during cleanup.
- **FR-035**: Local, subprocess, container, and managed-remote harnesses MUST declare their trust boundary and receive only the minimum filesystem, network, environment, identity, and tool access required for the run.
- **FR-036**: Harness health MUST be reported independently; failure of an optional harness MUST not make healthy harnesses unavailable.
- **FR-037**: Metrics, logs, and traces MUST include low-cardinality harness identity, adapter version, execution mode, operation, outcome, and latency while preserving current trace and conversation correlation.
- **FR-038**: The engine MUST retain existing TTL cleanup, bounded capacity, least-recently-used eviction, active-run protection, retry guidance, and shutdown cleanup, extended with per-harness limits.
- **FR-039**: Operators MUST be able to enable, disable, and set the certification state of each harness without rebuilding clients or rewriting agent documents.
- **FR-040**: The system MUST publish a compatibility report that traces every current Dynamic Agents behavior to common engine behavior, adapter behavior, a conformance test, and rollout status.

#### Sandbox execution plane

- **FR-041**: Deep Agents, Claude Agent SDK, and Strands runtimes MUST execute in Kubernetes Agent Sandbox pods for production; `in_process` execution MAY remain only as an explicitly enabled migration and rollback mode.
- **FR-042**: Harness Engine MUST act as the trusted control plane and MUST create only `SandboxClaim` resources from operator-owned, allowlisted `SandboxTemplate` or `SandboxWarmPool` profiles; agent or request configuration MUST NOT select arbitrary images, commands, RuntimeClasses, service accounts, volumes, or network policy.
- **FR-043**: The default sandbox scope MUST be one exclusive lease per harness session binding and conversation epoch. No sandbox MAY serve concurrent bindings, callers, or tenants.
- **FR-044**: The control plane MUST persist the Sandbox claim name, UID, stable endpoint, profile, lease generation, and lifecycle state with the session binding and MUST fence stale workers after replacement.
- **FR-045**: The sandbox worker MUST communicate through a versioned internal protocol that accepts normalized run/resume/cancel requests and emits canonical events; it MUST NOT expose public client routes or provider-native events.
- **FR-046**: Raw user bearer tokens, exchanged MCP credentials, cloud credentials, database credentials, Kubernetes API credentials, and unrestricted secrets MUST NOT be mounted or injected into sandbox pods. Authenticated tools MUST execute through the external ToolBroker or a credential-injecting proxy that does not reveal secrets to the worker.
- **FR-047**: Every sandbox profile MUST enforce non-root execution, read-only root filesystem where compatible, dropped Linux capabilities, seccomp, bounded CPU/memory/ephemeral storage/processes, no host namespaces or host mounts, a dedicated isolation RuntimeClass, and default-deny ingress/egress with explicit destinations.
- **FR-048**: Sandbox lifecycle MUST support claim, readiness, reuse within the same binding, idle hibernation or deletion, maximum lifetime, clear, cancellation, shutdown, eviction recovery, and orphan reconciliation without losing durable conversation state or accepting stale events.
- **FR-049**: Warm pools MAY reduce startup latency, but allocation MUST remain exclusive and a released pod MUST NOT be reassigned unless an automated reset-and-isolation conformance test proves removal of prior files, processes, credentials, network state, and memory-backed data. Destroy-on-release is the default.
- **FR-050**: Provider-managed remote harnesses such as AgentCore MUST declare `provider_managed` isolation and MUST NOT create a redundant Kubernetes sandbox unless required for local brokering; their provider boundary MUST pass equivalent security and session conformance.

#### Thread persistence, agent memory, and tracing

- **FR-051**: Harness Engine MUST distinguish thread persistence (short-term, conversation-scoped state) from agent memory (long-term, cross-thread state) and from disposable sandbox workspace; these stores MUST NOT share an implicit namespace or lifecycle.
- **FR-052**: Every certified interactive harness MUST persist its native thread state, checkpoint head, pending interrupt, run idempotency state, and durable-commit status outside the sandbox through a binding-scoped state contract.
- **FR-053**: A successful terminal turn MUST NOT be acknowledged as durable until its checkpoint/state reference and binding revision are committed. If output was streamed before a failed commit, the engine MUST report an explicit uncertain-durability error and MUST NOT automatically replay side effects.
- **FR-054**: Thread restore MUST work after worker eviction, hibernation, maximum lifetime, control-plane restart, cache eviction, and cross-replica continuation while enforcing binding owner, agent, harness, epoch, adapter version, and lease generation.
- **FR-055**: Harness Engine MUST provide a provider-neutral MemoryBroker for long-term semantic, episodic-reference, and procedural memory with explicit `user`, `agent`, and `organization` scopes; user scope MUST be the default for writable learned memory.
- **FR-056**: Memory reads and writes MUST enforce authorization, namespace isolation, provenance, retention, size/content limits, revision-based concurrency, audit, and configured read-only or human-approval policy. Shared organization memory MUST be read-only by default.
- **FR-057**: Provider-native memory and sandbox files MUST NOT bypass MemoryBroker policy. Pods MUST treat local memory materializations as caches and MUST NOT be the source of truth.
- **FR-058**: Harness Engine MUST propagate a single distributed trace across public request handling, authorization, session lookup, sandbox claim/bind, worker execution, model/provider calls, checkpoint commits, memory operations, ToolBroker calls, subagents, canonical validation, and stream encoding using W3C Trace Context internally.
- **FR-059**: Incoming external trace context MUST be validated and sanitized or replaced. Trace baggage MUST use an explicit low-cardinality allowlist and MUST NOT contain user identity, prompts, message content, memory content, tool arguments/results, credentials, provider secrets, or protected skill content.
- **FR-060**: Worker telemetry MUST flow through an in-cluster collector or control-plane telemetry facade with redaction, sampling, resource attribution, and bounded buffering. Trace-export failure MUST NOT expose data, block cleanup, or silently change run outcomes.

#### Agent creation and editing experience

- **FR-061**: The existing agent editor MUST retain the stable `basic`, `instructions`, `tools`, `skills`, and `advanced` step identifiers, URLs, browser navigation, and default Deep Agents behavior.
- **FR-062**: The Basic Info step MUST present harness selection before model selection and MUST obtain display, certification, availability, execution placement, capability, and sanitized diagnostic data from the harness catalog.
- **FR-063**: Model choices MUST be filtered by the selected harness and deployment policy. A stored or selected incompatible model MUST remain visible with a blocking issue until the builder explicitly replaces it.
- **FR-064**: Every common editor field and section MUST derive its enabled, warning, or blocking state from a field-addressable capability report with `native`, `emulated`, `unsupported`, or `unavailable` level; feature components MUST NOT independently infer compatibility from harness identifiers.
- **FR-065**: Switching harnesses MUST produce a compatibility diff before destructive draft changes. The UI MUST NOT silently delete, reset, hide-and-submit, or persist incompatible values, and any safe automated fix MUST be listed individually and explicitly confirmed.
- **FR-066**: The browser MAY retain unsaved harness-specific options per harness during one editing session, but MUST submit and persist only the selected harness's options. Common configuration MUST remain one shared draft.
- **FR-067**: Harness-specific configuration MUST use first-party typed panels backed by the catalog's bounded JSON Schema. The UI MUST NOT render server-provided executable content or expose images, commands, modules, environment variables, secret inputs, raw provider resources, or Kubernetes infrastructure controls.
- **FR-068**: The Advanced step MUST expose portable long-term memory policy controls and read-only thread-persistence and observability summaries. Agent authors MUST NOT configure checkpoint namespaces, sandbox claims, telemetry secrets, protected-content capture, or security/audit span suppression.
- **FR-069**: Client validation MUST be advisory. Before create or update, the BFF MUST validate the exact allowlisted payload against the current catalog, reject unknown/unsafe fields, and complete validation before mutating MongoDB or OpenFGA.
- **FR-070**: A validation report MUST include a fingerprint or revision that covers the validated draft and relevant catalog/policy state. A save with stale validation MUST fail with `409` and return a fresh field-addressable report.
- **FR-071**: Asynchronous catalog, model, and validation responses MUST be correlated to the current harness and draft revision so that stale responses cannot overwrite newer selections or clear their errors.
- **FR-072**: Editing a persisted harness with existing conversations MUST disclose and confirm the conversation policy: existing bindings remain pinned, new conversations use the new harness, and transfer is unavailable unless a certified path is returned by validation.
- **FR-073**: Unknown, disabled, misconfigured, unhealthy, experimental, and blocked harness states MUST remain distinguishable and accessible. An existing stored value MUST never be silently coerced to the default harness.
- **FR-074**: Save blockers MUST be summarized once, mapped to stable wizard steps and field paths, focus the first actionable control, and be announced accessibly without relying on color alone.

#### Chat identity experience

- **FR-075**: Chat MUST show a persistent agent identity header containing the selected agent name, avatar, and human-readable execution-harness label. Legacy or absent harness metadata MUST display as LangChain Deep Agents.
- **FR-076**: Conversation history and agent-selection surfaces MUST reuse the same harness labels and agent avatar colors. Agents without an explicit theme MUST receive a deterministic theme derived from their stable id; explicit themes MUST continue to take precedence.
- **FR-077**: Harness and agent identity MUST remain understandable without color through visible text, accessible labels, and tooltips. Live, input-required, and unread states MUST remain visually separate from agent identity.
- **FR-078**: The browser tab title for an active agent conversation MUST include the selected agent's friendly name. Chat identity metadata MUST be resolvable for callers with `agent#use` even when a richer management/detail endpoint is unavailable to them.

#### Provider resource lifecycle

- **FR-079**: An AgentCore operator profile configured for `per_agent` provisioning MUST create exactly one managed Amazon Bedrock AgentCore Harness for each CAIPE agent selecting that profile.
- **FR-080**: Provider resource IDs, ARNs, execution-role ARNs, regions, credentials, and lifecycle state MUST remain server-owned. The browser and portable `AgentBlueprint` MUST select only a sanitized operator profile ID.
- **FR-081**: Provider creation MUST complete before the Harness Engine agent version becomes runnable. A failed create MUST fail the save, while optimistic-write conflicts and failed CAIPE creation MUST compensate any newly created provider resource.
- **FR-082**: Deleting a non-default CAIPE agent MUST delete its agent-owned provider resource before removing agent metadata. Provider deletion failure MUST fail closed so that the resource remains discoverable and retryable.
- **FR-083**: Existing `shared` AgentCore profiles MUST remain supported for migration and rollback. Harness Engine MUST never delete a shared operator-owned target.
- **FR-084**: AgentCore provisioning credentials MUST be workload credentials with least-privilege control-plane actions and `iam:PassRole` limited to the configured execution role; user credentials MUST never be forwarded.
- **FR-085**: Updating provider-relevant CAIPE agent configuration MUST update the existing agent-owned Harness in place, wait for `READY`, and persist a private configuration fingerprint; it MUST NOT create a second Harness.

### Non-Functional Requirements

- **NFR-001**: The compatibility harness MUST add no more than 10% p95 latency to first response or total turn duration compared with the current Dynamic Agents runtime under the same workload.
- **NFR-002**: Worker-side canonical translation plus control-plane validation and encoding MUST add no more than 25 milliseconds p95 per emitted event batch, excluding network transit and provider latency.
- **NFR-003**: A harness adapter failure MUST be contained to its affected runs and MUST not corrupt shared configuration, checkpoints, files, or other cached runtimes.
- **NFR-004**: New engine and adapter code MUST achieve at least 80% line coverage, with 100% coverage of public contract states and security decisions.
- **NFR-005**: The system MUST support the current configured runtime-cache capacity and mixed-harness traffic without increasing baseline memory consumption by more than 20% when only the compatibility harness is enabled.
- **NFR-006**: Public and canonical contracts MUST be versioned with documented compatibility rules and deprecation periods.
- **NFR-007**: Logs, traces, events, and API errors MUST not reveal bearer tokens, exchanged credentials, secret values, raw protected skill content, or unbounded tool output.
- **NFR-008**: A warm sandbox claim MUST reach worker readiness within 5 seconds p95 and a cold claim within 30 seconds p95 under the certified cluster profile; time outside these budgets MUST return a retryable capacity or unavailable error.
- **NFR-009**: Sandbox termination or claim replacement MUST fence the old worker within 2 seconds of the control plane committing a new lease generation.
- **NFR-010**: Sandbox isolation tests MUST demonstrate zero cross-binding filesystem, process, environment, identity, network, event, and persisted-state access across at least 1,000 concurrent bindings.
- **NFR-011**: A turn reported as durably complete MUST have zero acknowledged thread-state loss after worker or control-plane failure; incomplete durability MUST be explicitly observable and recoverable without automatic side-effect replay.
- **NFR-012**: Memory concurrency tests MUST produce zero silent lost updates; conflicting writes MUST be rejected or merged by a declared, tested policy.
- **NFR-013**: Trace propagation and instrumentation MUST add no more than 5% p95 turn latency under the compatibility workload, excluding external collector outage buffering.
- **NFR-014**: Trace, log, and metric export MUST remain bounded during collector outage and MUST shed telemetry according to policy without exhausting worker or control-plane memory.
- **NFR-015**: Harness-dependent editor controls MUST remain keyboard operable and screen-reader labeled at all supported viewport sizes, including selector cards, capability badges, compatibility dialogs, disabled reasons, and error navigation.
- **NFR-016**: The editor MUST remain usable while optional catalog or validation dependencies are unavailable: stored data remains inspectable, unsaved draft data remains recoverable, and save fails closed with a retryable explanation.
- **NFR-017**: Chat identity labels and harness badges MUST remain readable at the supported collapsed sidebar and narrow chat widths without hiding the conversation title or status.

### Key Entities

- **Agent Configuration**: The existing agent definition plus an optional harness selection and validated harness-specific options. Absence of the selection means compatibility mode.
- **Harness Descriptor**: Immutable identity, adapter and contract versions, execution mode, configuration schema, availability, health, certification state, and capability declarations for one harness.
- **Harness Capability**: A named behavior with a level (`native`, `emulated`, `unsupported`, or `unavailable`), constraints, and evidence from conformance tests.
- **Harness Runtime**: A conversation-scoped execution instance created by an adapter and managed by the common runtime pool.
- **Run Context**: The authorized, immutable inputs for one turn: agent, conversation, caller, trace, client context, tools, skills, files, policy, and resolved configuration.
- **Canonical Event**: A validated provider-neutral lifecycle event consumed by custom SSE and AG-UI encoders.
- **Session Binding**: The mapping among conversation, caller, agent, harness, provider session, checkpoint namespace, and lifecycle state.
- **Sandbox Profile**: An operator-owned mapping from harness and workload class to an allowlisted SandboxTemplate or warm pool, worker image, RuntimeClass, resources, storage, network policy, and lifecycle limits.
- **Sandbox Lease**: The claim-exclusive binding from one conversation epoch to a Sandbox UID, endpoint, profile, fencing generation, readiness state, and expiry.
- **Thread State**: Harness-native, conversation-scoped checkpoints and run/interrupt metadata required to continue one binding safely across processes, pods, and replicas.
- **Agent Memory Record**: Long-term cross-thread content or reference with scope, owner namespace, kind, provenance, revision, permissions, retention, and audit metadata.
- **Trace Context**: Sanitized W3C correlation propagated through trusted internal boundaries using opaque, non-sensitive identifiers and an allowlisted sampling policy.
- **Compatibility Report**: The traceability record linking existing Dynamic Agents behaviors to requirements, adapter capabilities, tests, and certification results.
- **Agent Editor Draft**: Non-persisted browser state containing common agent fields, the selected harness, per-harness parked options, a monotonically increasing draft revision, and the latest matching validation result.
- **Field Capability Report**: A sanitized validation projection that maps a stable field path and wizard step to capability level, constraints, warnings, blockers, and explicitly permitted fixes.

## Assumptions

- “Same architecture” means the existing external topology, route boundary, gateway/runtime ownership split, security controls, persistence systems, streaming protocols, and operational model remain stable. The internal execution plane may move from the API container to claim-exclusive sandbox pods without changing clients.
- “Supported harness” means a certified adapter that meets the complete portable baseline. An installed adapter with known gaps is visible as experimental or unavailable, not represented as fully supported.
- The current Deep Agents/LangGraph behavior becomes the default compatibility harness and migration oracle.
- Existing UI and database names may remain during the compatibility window; user-facing renaming can occur separately after traffic has migrated.
- Provider-native enhancements are opt-in extensions and are not required for existing Dynamic Agents configurations.
- State transfer between unlike harnesses is not assumed safe. Existing conversations stay bound to their originating harness unless a pairwise transfer is explicitly certified.
- Existing LangGraph Mongo checkpoints remain the Deep Agents thread-persistence oracle; the common state contract does not translate their private graph state.
- Long-term agent memory is opt-in and policy-governed. Conversation transcripts are not automatically promoted into cross-thread memory.
- AgentCore refers to the managed Amazon Bedrock AgentCore Harness integration. A custom agent hosted on AgentCore Runtime can be added later through the same remote-adapter contract.

## Out of Scope

- Replacing the UI/BFF as the owner of agent and MCP configuration writes.
- Wholesale redesign of the chat UI, workflow system, scheduler, OpenFGA model, credential service, AgentGateway, MCP servers, skill catalog, or audit service. Additive agent/harness identity affordances are in scope.
- Automatically translating arbitrary provider-native memory, checkpoints, plugins, middleware, or filesystem state between harnesses.
- Silent routing based on cost, model availability, or quality scores.
- Allowing untrusted runtime code to load dynamically into the main service process.
- Guaranteeing byte-for-byte identical model prose across different models or harnesses; compatibility applies to behavior, policy, lifecycle, and contracts.
- Removing the Dynamic Agents deployment or legacy names before the compatibility and rollback gates pass.
- Building a general-purpose user-configurable container platform, accepting arbitrary sandbox images, or exposing Kubernetes resources directly to end users.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of existing Dynamic Agents contract and end-to-end tests pass unchanged against Harness Engine using the compatibility harness.
- **SC-002**: 100% of existing agent documents without a harness field load, validate, and execute without a data backfill.
- **SC-003**: Each harness advertised as certified passes 100% of the required cross-harness conformance scenarios for streaming, tools, sessions, human interaction, subagents, files, security, cancellation, and recovery.
- **SC-004**: Existing UI, workflow, scheduler, Slack, Webex, and API clients require zero request or response contract changes for the initial replacement rollout.
- **SC-005**: In a mixed-harness fault test, failures in one adapter cause zero failed runs on healthy adapters and zero cross-conversation state leaks.
- **SC-006**: Compatibility-mode p95 first-response and total-turn latency remain within 10% of the Dynamic Agents baseline at the same load.
- **SC-007**: Operators can identify the selected harness, version, health, latency, usage, and outcome for at least 99.9% of runs without inspecting sensitive content.
- **SC-008**: A rollback to Dynamic Agents completes within 10 minutes and requires no reverse database migration or client reconfiguration.
- **SC-009**: A reference harness adapter can be added and pass the conformance kit without changing public routes, protocol encoders, authorization services, or persistence services.
- **SC-010**: Security tests demonstrate zero credential leakage and zero cross-user, cross-agent, cross-conversation, or cross-harness state access across at least 1,000 concurrent isolation scenarios.
- **SC-011**: Every concurrent local-harness binding has a distinct Sandbox UID and pod UID, and stale workers produce zero accepted events after lease replacement.
- **SC-012**: Killing or evicting a sandbox pod during text, tool, and interrupt states does not corrupt another binding; the affected conversation either resumes from durable state or returns an explicit retryable error.
- **SC-013**: Production sandbox pods contain zero raw user, MCP, database, cloud, or Kubernetes credentials in environment variables, mounted files, process arguments, and captured crash artifacts.
- **SC-014**: Completed and interrupted conversations resume correctly after at least 1,000 randomized worker/control-plane failure points with zero acknowledged thread-state loss and zero cross-binding restore.
- **SC-015**: User-, agent-, and organization-scoped memory tests demonstrate zero unauthorized reads/writes and zero silent lost updates across at least 1,000 concurrent memory operations.
- **SC-016**: At least 99.9% of sampled runs produce a causally connected trace from public request through terminal stream encoding, including worker, persistence, memory, tool, and subagent spans when exercised.
- **SC-017**: Automated telemetry leak tests find zero prompts, message bodies, memory bodies, credentials, raw tool payloads, protected skills, email addresses, or bearer subjects in exported span attributes, events, baggage, and resource labels.
- **SC-018**: 100% of existing agent-editor component and end-to-end tests pass with a legacy document or explicit `deepagents` selection, without changing the five stable step identifiers.
- **SC-019**: The create, edit, and clone UI conformance suite passes for every first-party harness and every catalog state, including model filtering, field-level capabilities, unavailable stored harnesses, active conversations, and authoritative save validation.
- **SC-020**: Harness-switch tests observe zero silent loss or persistence of incompatible draft fields across common configuration and parked per-harness options.
- **SC-021**: Race tests observe zero cases where an out-of-order catalog, model, or validation response changes the selected harness, replaces a newer validation report, or enables an invalid save.
