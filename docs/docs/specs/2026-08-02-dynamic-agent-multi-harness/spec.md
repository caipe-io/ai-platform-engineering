---
sidebar_position: 2
sidebar_label: Specification
title: "Dynamic Agent Multi-Harness Support"
---

# Feature Specification: Dynamic Agent Multi-Harness Support

**Feature Branch**: `prebuild/feat/dynamic-agent-multi-harness`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "Support multiple harnesses for Dynamic Agents, including LangChain DeepAgents, Claude Agent SDK, and Amazon Bedrock AgentCore as optional per-agent choices."

## Overview

Dynamic Agents currently execute through one agentic harness. This feature lets an
administrator select a supported harness for each agent while preserving the current
DeepAgents behavior as the default.

The initial harness choices are:

- **DeepAgents** — existing default behavior.
- **Claude Agent SDK** — self-hosted agent loop using Anthropic's supported SDK contract.
- **Amazon Bedrock AgentCore Harness** — AWS-managed agent loop running on AgentCore Runtime.

Harness selection and execution placement are separate concepts. A harness determines
how an agent plans, calls tools, manages short-term context, and reports progress. An
execution provider determines where the agent is hosted and how its lifecycle is
managed.

The platform presents a consistent Dynamic Agents experience across supported choices:

- Agent configuration and access control
- Conversation start, follow-up, resume, and cancellation
- MCP tool access using the caller's delegated identity
- Streaming text, tool, subagent, approval, usage, completion, and error events
- AgentOps status, traces, usage, and diagnostics

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Select a Harness Per Agent (Priority: P1)

As a platform administrator, I want to choose a supported harness for each Dynamic
Agent so that teams can use the execution behavior appropriate for their workload
without changing the rest of the CAIPE deployment.

**Why this priority**: Per-agent selection is the core capability. Without it, adding
another SDK only creates a deployment-wide fork and does not satisfy multi-harness
support.

**Independent Test**: Create one agent for each enabled harness, start a conversation
with each agent, and verify that the selected harness executes while the same Dynamic
Agents entry points and access controls remain in effect.

**Acceptance Scenarios**:

1. **Given** an existing agent without an explicit harness selection, **When** it is loaded after the feature is enabled, **Then** it continues to use DeepAgents with no required migration.
2. **Given** multiple harnesses are enabled, **When** an administrator creates or edits an agent, **Then** the administrator can select one supported harness for that agent.
3. **Given** an agent has a valid harness selection, **When** a user starts a conversation, **Then** only that harness executes the agent run.
4. **Given** an agent configuration names an unknown, disabled, or unavailable harness, **When** the configuration is saved or invoked, **Then** the system rejects it with an actionable error and does not silently substitute another harness.
5. **Given** a deployment contains agents using different harnesses, **When** those agents are invoked concurrently, **Then** each agent continues to use its own configured harness.

---

### User Story 2 - Run Claude Agent SDK Agents (Priority: P1)

As a CAIPE operator, I want Claude Agent SDK to be a supported Dynamic Agent harness
so that teams can use Claude's agent loop, tools, sessions, hooks, and subagents in the
general-purpose agent platform.

**Why this priority**: Claude Agent SDK exercises option construction, MCP integration,
hooks, session handling, streaming, and subagent reporting. It validates the common
contract before a remote managed runtime is introduced.

**Independent Test**: Configure a Claude Agent SDK agent with a system prompt, allowed
MCP tools, and a resumable conversation. Verify text streaming, tool activity, session
continuity, usage reporting, and cancellation through the standard Dynamic Agents API.

**Acceptance Scenarios**:

1. **Given** a valid Claude Agent SDK agent configuration, **When** a user sends a message, **Then** the SDK runs with only the configured tools, model, instructions, and skills.
2. **Given** the Claude agent calls an MCP tool, **When** the tool request is issued, **Then** it carries the authorized caller context required by CAIPE's downstream policy enforcement.
3. **Given** the SDK emits text, tool, usage, session, or subagent activity, **When** Dynamic Agents streams the run, **Then** each activity is represented through the platform's common event vocabulary.
4. **Given** a user sends a follow-up message, **When** the native Claude session remains available, **Then** the conversation resumes with its prior context.
5. **Given** the native Claude session is missing or cannot be resumed, **When** the user sends a normal follow-up, **Then** the system applies the documented recovery policy and clearly reports whether it recovered with a new session or requires user action.
6. **Given** a Claude built-in tool can access files or execute commands, **When** the tool is considered for execution, **Then** workspace isolation and CAIPE authorization policy are enforced before the operation is allowed.

---

### User Story 3 - Run an Agent with AgentCore Harness (Priority: P2)

As an AWS platform administrator, I want to run selected Dynamic Agents through
AgentCore Harness so that those agents can use AWS-managed isolation, scaling,
sessions, memory options, identity, and observability.

**Why this priority**: AgentCore provides the requested managed execution option, but
it depends on the common harness contract and introduces asynchronous cloud-resource
lifecycle management.

**Independent Test**: Create an AgentCore-backed agent, wait for it to become ready,
invoke it through Dynamic Agents, continue the conversation, inspect its operational
status, and delete it without using the AWS console.

**Acceptance Scenarios**:

1. **Given** valid AWS settings and an AgentCore-compatible agent configuration, **When** an administrator creates the agent, **Then** the platform provisions or reconciles its required managed resources and exposes lifecycle status.
2. **Given** the managed agent is ready, **When** an authorized user sends a message, **Then** the request is invoked in the correct AgentCore session and its response is streamed through the standard Dynamic Agents surface.
3. **Given** the managed resource is still being created, updated, deleted, or has failed, **When** a user attempts an incompatible operation, **Then** the platform returns the current state and an actionable retry or remediation message.
4. **Given** a conversation continues after its AgentCore execution environment is recycled, **When** the same conversation is invoked again, **Then** durable context follows the configured memory policy rather than relying on an expired execution environment.
5. **Given** an administrator deletes an AgentCore-backed Dynamic Agent, **When** deletion completes, **Then** CAIPE and managed-resource state are reconciled and no new invocations are accepted.

---

### User Story 4 - Receive a Consistent Streaming Experience (Priority: P2)

As a user or client integrator, I want the same observable run lifecycle regardless of
the selected harness so that the CAIPE UI, Slack, Webex, and API clients do not require
harness-specific implementations.

**Why this priority**: A harness-specific wire format would spread SDK coupling into
every client and make each new harness a full-stack rewrite.

**Independent Test**: Run the common streaming conformance suite against each harness
and verify that supported lifecycle events have the same meaning, ordering guarantees,
terminal behavior, and protocol encoding.

**Acceptance Scenarios**:

1. **Given** any supported harness produces response text, **When** it is streamed, **Then** clients receive ordered text deltas and one unambiguous terminal outcome.
2. **Given** a harness executes a tool, **When** tool activity is streamed, **Then** clients receive correlated start and result events without seeing native SDK message objects.
3. **Given** a harness reports subagent activity, approvals, usage, warnings, or errors, **When** the capability is supported, **Then** clients receive the corresponding common event.
4. **Given** a harness does not support a requested interaction, **When** the configuration is saved or invoked, **Then** the system returns a capability error instead of silently omitting the behavior.
5. **Given** a client disconnects during a run, **When** execution is cancelled or allowed to continue according to policy, **Then** the resulting state is observable and a later request does not create an ambiguous duplicate run.

---

### User Story 5 - Configure and Operate Harnesses Safely (Priority: P2)

As a platform operator, I want capability validation, security controls, health status,
and harness-specific diagnostics so that I can operate mixed-harness deployments
without weakening CAIPE's existing authorization boundary.

**Why this priority**: The harnesses have different tools, session stores, hooks,
identity models, and lifecycle behavior. Safe operation requires these differences to
be explicit.

**Independent Test**: Exercise a matrix of supported and unsupported options, denied
MCP calls, missing credentials, native runtime failures, and version mismatches; verify
fail-closed behavior, redacted diagnostics, and audit records.

**Acceptance Scenarios**:

1. **Given** an agent uses features unsupported by its selected harness, **When** it is saved, **Then** the UI and API identify every incompatible feature before execution.
2. **Given** a caller is not authorized to use an agent or tool, **When** the selected harness attempts execution, **Then** work is denied before the protected operation and no fallback identity is substituted.
3. **Given** a harness credential or remote runtime is unavailable, **When** a run is attempted, **Then** the failure is classified, redacted, traceable, and does not expose secrets.
4. **Given** an operator views AgentOps, **When** agents use different harnesses, **Then** the operator can identify the harness, execution provider, native binding, lifecycle state, latency, token usage, cost when available, and failure category.
5. **Given** a harness adapter is upgraded, **When** compatibility tests fail, **Then** the release is blocked before incompatible agent configurations reach production.

### Edge Cases

- An administrator changes the harness while conversations are active. Existing native
  session bindings must not be interpreted by the new harness; the platform must require
  a new session or an explicit supported migration.
- A native session identifier exists but its transcript, managed memory, or execution
  environment has expired.
- A stream ends without a native terminal event, emits a terminal event twice, or fails
  after reporting completion.
- A tool start has no result because the run is interrupted, cancelled, or the provider
  loses connectivity.
- A harness supports a tool name but not the same input, output, permission, or approval
  semantics as another harness.
- The selected model or authentication method is incompatible with the selected harness.
- AgentCore creates a new immutable version while older conversations are still using a
  previous version.
- Managed-resource creation succeeds in AWS but CAIPE loses the response, or CAIPE state
  is saved while AWS provisioning fails.
- The Claude SDK process exits, stalls, or produces an SDK message type unknown to the
  installed adapter version.
- A caller cancels a run at the same time that the harness completes it.
- A parent agent references a subagent that uses another harness. Cross-harness subagent
  execution is not assumed unless explicitly supported by a separate routing contract.
- A deployment disables a harness while persisted agents still reference it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support selecting one harness per Dynamic Agent.
- **FR-002**: The initial supported harness identifiers MUST include DeepAgents, Claude Agent SDK, and AgentCore Harness.
- **FR-003**: Existing agent configurations without a harness selection MUST continue to use DeepAgents.
- **FR-004**: The system MUST distinguish the agent harness from the execution provider and MUST validate their compatibility as a pair.
- **FR-005**: A single CAIPE deployment MUST be able to run agents configured with different enabled harnesses.
- **FR-006**: The system MUST reject unknown, disabled, unavailable, or incompatible harness configurations without silently substituting a fallback harness.
- **FR-007**: The system MUST expose the capabilities and configuration constraints of each enabled harness to both the administration API and UI.
- **FR-008**: The system MUST validate model, tool, skill, subagent, approval, session, memory, and execution-provider requirements against the selected harness before accepting the configuration.
- **FR-009**: The system MUST provide a common run-event vocabulary for text, tool activity, subagent activity, approvals or user input, usage, session changes, warnings, completion, cancellation, and failure.
- **FR-010**: Native harness messages MUST be translated into common run events before custom SSE, AG-UI, A2A, or other client protocol encoding.
- **FR-011**: Common events MUST preserve correlation identifiers, ordering information, agent identity, native diagnostic metadata when safe, and exactly one terminal outcome.
- **FR-012**: The existing Dynamic Agents client protocols MUST remain usable without requiring clients to understand native DeepAgents, Claude SDK, or AgentCore event types.
- **FR-013**: The system MUST support start, follow-up, resume, cancellation, and status operations where the selected harness advertises those capabilities.
- **FR-014**: When a requested operation is not supported by the selected harness, the system MUST return a stable, actionable capability error.
- **FR-015**: CAIPE MUST remain the canonical owner of agent configuration, conversation identity, authorization decisions, and normalized audit history.
- **FR-016**: The system MUST persist a harness binding that associates a CAIPE conversation with the selected harness, execution provider, native session identifier, and compatible agent version.
- **FR-017**: Native short-term context MUST follow the selected harness's session policy; durable conversation or memory behavior MUST be explicitly configured and observable.
- **FR-018**: The system MUST prevent a native session binding created by one harness from being resumed by a different harness.
- **FR-019**: All harnesses MUST enforce authenticated agent access before execution and MUST preserve the caller identity required for downstream MCP authorization.
- **FR-020**: Harness-level permissions, hooks, sandboxes, or managed identity controls MUST supplement rather than replace CAIPE's boundary and downstream authorization checks.
- **FR-021**: The system MUST fail closed when caller identity, required credentials, authorization, or secure tool-routing context is unavailable.
- **FR-022**: Credentials and native provider secrets MUST be referenced through approved credential mechanisms and MUST NOT be stored in reusable agent definitions, events, traces, or logs.
- **FR-023**: Claude Agent SDK support MUST cover option validation, MCP tools, allowed built-in tools, workspace isolation, streaming, usage, session continuity, subagent activity, cancellation, and errors.
- **FR-024**: Claude Agent SDK support MUST remain independent of application-specific persistence, ingestion, workspace-layout, and event contracts.
- **FR-025**: AgentCore support MUST expose asynchronous create, update, ready, failed, and delete lifecycle states.
- **FR-026**: AgentCore invocation MUST bind each CAIPE conversation to the appropriate managed session and agent version.
- **FR-027**: AgentCore durable context MUST not rely solely on an ephemeral runtime session.
- **FR-028**: Operators MUST be able to identify the harness and execution provider for every configured agent and active run.
- **FR-029**: Operators MUST receive comparable health, latency, usage, cost when available, lifecycle, and error telemetry across harnesses.
- **FR-030**: Harness-specific diagnostic metadata MUST be retained only when it is safe, bounded, and redacted.
- **FR-031**: The system MUST provide contract tests that run the same core scenarios against every enabled harness.
- **FR-032**: The DeepAgents adapter MUST pass the contract suite before DeepAgents-specific runtime coupling is removed from shared request and streaming paths.
- **FR-033**: The Claude adapter MUST include compatibility tests for the supported Claude Agent SDK version and every native message type mapped by the adapter.
- **FR-034**: AgentCore reconciliation MUST be idempotent so retries cannot create uncontrolled duplicate managed resources.
- **FR-035**: Harness selection MUST be preserved by configuration import, export, seed configuration, and read APIs.
- **FR-036**: The platform MUST document enabled harnesses, execution providers, required credentials, supported capabilities, operational limits, and recovery behavior.

### Key Entities

- **Harness Definition**: A registered harness type, version, availability state,
  configuration constraints, and capability declaration.
- **Execution Provider Definition**: A registered hosting target and its supported
  lifecycle, identity, networking, streaming, and compatibility characteristics.
- **Agent Harness Selection**: The harness and execution-provider choice attached to a
  Dynamic Agent configuration.
- **Harness Capability Set**: The operations and features a harness supports, including
  tools, skills, subagents, streaming, approvals, cancellation, sessions, and memory.
- **Harness Binding**: The association between a CAIPE agent or conversation and its
  native harness resource, session, and compatible version.
- **Common Run Event**: A harness-neutral representation of observable agent activity.
- **Managed Resource State**: The desired and observed lifecycle state of an external
  execution resource such as AgentCore.
- **Execution Context**: The authenticated caller, agent, conversation, authorization,
  trace, credential references, and client context supplied to a run.

### Assumptions

- DeepAgents remains the default during this feature's rollout.
- Claude Agent SDK is the first additional harness because it exercises a second local
  SDK contract before the platform adds remote managed-resource lifecycle complexity.
- AgentCore in this specification means AgentCore Harness when selecting the managed
  orchestration loop; AgentCore Runtime is modeled as an execution provider.
- CAIPE continues to own the user-facing Dynamic Agents API and protocol encoders.
- Native harnesses may provide different feature sets. Product parity means explicit
  capability reporting and consistent semantics for supported features, not pretending
  unsupported features exist.
- Existing RBAC, OpenFGA, OBO, Agent Gateway, MCP, audit, and secret-management policies
  remain authoritative.

### Non-Functional Requirements

- **NFR-001 — Backward compatibility**: Existing DeepAgents configurations and supported client protocols MUST pass their current regression suites without migration.
- **NFR-002 — Isolation**: A run MUST NOT read another user, conversation, workspace, native session, or managed execution environment unless an explicit authorized sharing feature permits it.
- **NFR-003 — Reliability**: Common event translation MUST tolerate duplicate, delayed, partial, and unknown native events without producing duplicate terminal outcomes or corrupting conversation state.
- **NFR-004 — Performance**: Harness-neutral dispatch and event normalization SHOULD add no more than 100 ms p95 server-side overhead to a run, excluding harness startup, model latency, network transit, and managed-resource provisioning.
- **NFR-005 — Scalability**: Local and remote harnesses MUST respect deployment concurrency and backpressure limits without allowing one harness to exhaust capacity reserved for all others.
- **NFR-006 — Security**: External SDKs, CLIs, container artifacts, and cloud permissions MUST receive supply-chain and least-privilege review before release.
- **NFR-007 — Observability**: Every run MUST be traceable from CAIPE request and conversation identifiers to its harness, execution provider, native session, and terminal outcome.
- **NFR-008 — Operability**: Harness availability and managed lifecycle failures MUST be visible without requiring direct container, database, or cloud-console access for routine diagnosis.

## Out of Scope

- Replacing DeepAgents as the default harness in the initial release.
- Automatically converting native prompts, checkpoints, transcripts, or memory between
  harnesses.
- Guaranteeing identical reasoning, tool selection, token usage, or model output across
  harnesses.
- Supporting every possible combination of harness and execution provider.
- Direct cross-harness subagent composition inside one native agent loop.
- Replacing A2A as the protocol for independently deployed agent-to-agent communication.
- Adding application-specific ingestion, snapshot, or content-persistence behavior to
  the generic harness contract.
- Adding Google ADK or standalone Strands adapters in the first delivery; the common
  contract must leave room for them as follow-up work.
- Supporting Anthropic consumer-account login or consumer rate limits for CAIPE users.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of existing Dynamic Agent configurations without a harness field continue to execute through DeepAgents and pass the existing regression suite.
- **SC-002**: Administrators can configure and successfully invoke at least one DeepAgents, Claude Agent SDK, and AgentCore Harness agent in the same deployment.
- **SC-003**: The common conformance suite passes every mandatory supported scenario for all three initial harnesses.
- **SC-004**: 100% of unknown, disabled, or incompatible harness configurations are rejected before agent execution with a stable error category.
- **SC-005**: 100% of tested native text, tool, subagent, approval, usage, session, completion, cancellation, and error messages are either mapped to documented common events or explicitly classified as safe ignored diagnostics.
- **SC-006**: Every completed, failed, interrupted, or cancelled test run produces exactly one common terminal outcome.
- **SC-007**: 100% of tested MCP calls preserve the authorized caller identity through the selected harness and fail closed when that identity is absent.
- **SC-008**: No credential values appear in persisted agent definitions, normalized events, audit records, application logs, or exported traces during security tests.
- **SC-009**: A Claude conversation survives a supported service restart using the configured session persistence policy, or returns the documented recovery outcome when its native session is unavailable.
- **SC-010**: AgentCore create, update, retry, invoke, and delete reconciliation tests produce no duplicate managed resources.
- **SC-011**: Operators can trace every test run from CAIPE conversation ID to harness type, execution provider, native binding, usage data when reported, and terminal result.
- **SC-012**: Harness-neutral dispatch and event normalization remain within the 100 ms p95 overhead budget under the representative integration workload.

## Dependencies and Related Work

- [Issue #2079 — Multiple Agentic Harness SDK Integration](https://github.com/cnoe-io/ai-platform-engineering/issues/2079)
- [Issue #2109 — Amazon Bedrock AgentCore Integration](https://github.com/cnoe-io/ai-platform-engineering/issues/2109)
- [Research and architectural decisions](./research.md)
