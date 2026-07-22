# Feature Specification: Centralise LLM Routing and Provider Selection

**Feature Branch**: `2026-07-20-centralise-llm-routing`  
**Created**: 2026-07-20  
**Status**: Draft  
**Input**: User description: "Centralise LLM routing and provider selection for all CAIPE agents: move provider choice from per-agent config to one central control point, with agents inheriting it and no agent code changes"

## Overview

Today each CAIPE agent is configured with its own LLM provider (OpenAI, Azure, Bedrock, Anthropic) through per-agent settings. There is no single place to see or change which provider agents use, and no common control point where cross-cutting concerns (cost attribution, budgets, caching, routing policy) could ever be applied.

This feature **centralises LLM routing and provider selection for all agents**. The "which provider" decision moves out of N per-agent configs onto one central control point that every agent inherits — the operator chooses or swaps the upstream provider in one place and every agent follows. No agent source changes; operators not already on this mode perform a one-time configuration migration.

To make one control point work uniformly, every agent addresses a single common endpoint using the OpenAI chat-completions wire protocol, and a central routing layer translates to whichever real upstream the operator selects (including Bedrock and Anthropic native). "OpenAI" names the **wire protocol** every mainstream provider can translate to and from — not a requirement that traffic go to OpenAI. The central routing layer is the *mechanism*, not the goal: its specific form is a plan decision and may be one CAIPE ships or one the operator already runs. The capabilities that build *on* this control point — per-agent budgets, cost attribution, dashboards — are explicitly out of scope and depend on it existing first.

## Clarifications

### Session 2026-07-20

- Q: Does CAIPE ship the routing layer, or is it bring-your-own? → A: CAIPE ships a default routing layer (opt-in / default-off) **and** supports pointing at an operator's existing one (both modes).
- Q: Must the routing layer be highly available in v1? → A: No — a single instance is acceptable for v1; HA (multi-replica) is deferred, and the fail-closed single point of failure is an accepted, documented tradeoff.
- Q: How do agents authenticate to the central endpoint before per-agent keys exist? → A: A single shared credential presented by all agents, plus network restriction on the endpoint; per-agent virtual keys are deferred to the budget epic.
- Q: Is there a latency target for the added routing hop? → A: No hard SLO in v1; the added overhead must be measured and documented, expected negligible relative to LLM call time.
- Q: How are upstream provider errors (5xx, 429, timeout) surfaced through the routing layer? → A: Passed through transparently, preserving status and semantics, so agents see the same error class as a direct call (no masking, no silent retry).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure the LLM provider for every agent in one place (Priority: P1)

An operator points every agent at one central LLM endpoint and chooses the upstream provider there, instead of editing provider settings on each agent. Changing or swapping the provider becomes a single change that all agents inherit.

**Why this priority**: This is the core value — a single source of truth for LLM routing — and the control point every downstream capability (attribution, budgets, routing policy) requires. Without it, provider choice stays smeared across every agent config.

**Independent Test**: Configure the central endpoint, confirm all agents route through it, then change the upstream provider centrally and confirm every agent picks up the change with no per-agent edits.

**Acceptance Scenarios**:

1. **Given** agents driven through the central endpoint, **When** the operator changes the upstream provider centrally, **Then** all agents use the new provider with no per-agent configuration edits.
2. **Given** a newly added agent, **When** it starts, **Then** it inherits central routing by default rather than needing its own provider config.

---

### User Story 2 - Migrate an existing deployment without breaking agents or touching agent code (Priority: P2)

An operator running agents against a direct provider migrates to central routing by changing configuration only. Every agent keeps returning correct results, no agent source changes, and the operator can revert cleanly if needed.

**Why this priority**: Adoption safety. Existing deployments must be able to switch to central routing without a rewrite or an outage, and back out if something is wrong.

**Independent Test**: Take a deployment on a direct OpenAI-compatible provider, migrate it to the central endpoint per the documented steps, confirm every agent still returns correct completions and no agent source changed; then revert and confirm agents return to direct provider calls.

**Acceptance Scenarios**:

1. **Given** a deployment on a direct OpenAI-compatible provider, **When** it is migrated to the central endpoint, **Then** every agent returns correct completions.
2. **Given** the migration, **When** an engineer reviews agent source, **Then** no agent code changed.
3. **Given** the operator wants to revert, **When** they restore prior configuration, **Then** agents return to direct provider calls with no half-configured state.
4. **Given** a rollout in progress, **When** some agents are migrated and others are not, **Then** both migrated and unmigrated agents keep working.

---

### User Story 3 - Uniform behaviour across every agent type (Priority: P2)

Every agent type (GitHub, Jira, ArgoCD, AWS, PagerDuty, Slack, and the rest) routes through the central control point the same way and returns correct results through it — no agent is a special case that bypasses it.

**Why this priority**: A control point that only some agents honour is not a control point; downstream cost/attribution work would leak. Uniformity is what makes the central control point trustworthy.

**Independent Test**: Route each agent type through the central endpoint and confirm each returns correct results and none bypasses it.

**Acceptance Scenarios**:

1. **Given** the central endpoint is configured, **When** each agent type makes an LLM request, **Then** every request goes through the central control point and returns a correct result.

---

### Edge Cases

- **Non-OpenAI-native upstream**: providers whose native protocol is not OpenAI-compatible (e.g. Bedrock or Anthropic native) are reached through the central routing layer via translation (FR-008); operators on these providers can adopt without waiting for a separate feature.
- **Endpoint unreachable or misconfigured**: agents must fail with a clear error, never silently fall back to a different provider or an unrouted direct call.
- **Upstream provider error (routing layer up)**: when the real provider returns a 5xx, rate-limit (429), or timeout, the routing layer passes it through transparently — preserving status and semantics — so the agent sees the same error class as a direct call.
- **Mixed mode during migration**: a partially-migrated fleet (some agents on central routing, some direct) must keep functioning throughout the rollout.
- **New agent added after adoption**: inherits central routing by default rather than reintroducing per-agent provider config.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow every agent to be driven through the OpenAI chat-completions wire protocol pointed at a single, centrally-configured endpoint.
- **FR-002**: The upstream provider and endpoint selection MUST be configurable in one central place and inherited by all agents (single source of truth), not duplicated per agent.
- **FR-003**: Adopting central routing MUST NOT require changes to agent source code.
- **FR-004**: A newly added agent MUST inherit central routing by default.
- **FR-005**: Central routing MUST be opt-in and reversible — reverting configuration returns agents to their prior direct-provider behaviour with no half-configured state.
- **FR-006**: All agent types MUST route through the central control point uniformly and return correct results through it, with none bypassing it.
- **FR-007**: When the configured endpoint is unreachable or misconfigured, agents MUST fail with a clear error that identifies the routing layer as the failure point (not a raw or generic error), and MUST NOT silently use a different provider or an unrouted call.
- **FR-008**: For upstream providers that are not natively OpenAI-compatible (e.g. Bedrock or Anthropic native protocols), the system MUST translate between the OpenAI wire protocol the agents speak and the provider's native protocol, so that operators on any supported upstream can adopt central routing immediately and receive correct completions.
- **FR-009**: Documentation MUST cover the migration steps and the consequence for operators currently using non-OpenAI providers.
- **FR-010**: CAIPE MUST ship a default routing layer that a fresh install can enable (opt-in / default-off) so the feature works out of the box, AND MUST support pointing at an operator's existing routing layer (bring-your-own) as a first-class alternative.
- **FR-011**: The central endpoint MUST require a credential — a single shared credential presented by all agents in v1 — and MUST be network-restricted so the upstream provider key it fronts is never reachable unauthenticated. Per-agent credentials replace the shared one in the downstream budget epic; the shared credential MUST be stored and injected through the existing secret strategies, never in plaintext.
- **FR-012**: When the upstream provider returns an error (e.g. 5xx, rate-limit/429, timeout) while the routing layer is healthy, the routing layer MUST pass the error through transparently, preserving its status and semantics, so agents observe the same error class as a direct provider call — no masking and no silent retry.

### Key Entities *(include if feature involves data)*

- **Agent**: a CAIPE agent that consumes LLM capacity; the unit routed through the central control point.
- **Central LLM routing config**: the single, inherited configuration naming the central endpoint and the upstream provider choice.
- **Central endpoint**: the one OpenAI-compatible endpoint all agents address.
- **Upstream provider**: the real model provider ultimately serving requests, selected centrally rather than per agent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Changing the upstream provider for all agents requires exactly one configuration change, down from one change per agent.
- **SC-002**: 100% of agent types return correct completions through the central endpoint.
- **SC-003**: Migrating a deployment to central routing requires zero agent source changes.
- **SC-004**: Reverting central routing restores prior behaviour with no residual configuration, verified by an automated test.
- **SC-005**: A misconfigured endpoint never results in an agent silently using a different provider (zero silent-fallback events).
- **SC-006**: A reviewer can perform the migration from the documentation alone.
- **SC-007**: Operators on every supported upstream — OpenAI, Azure, Bedrock, and Anthropic (including the non-OpenAI-native ones) — can adopt central routing and their agents return correct completions.
- **SC-008**: The latency added by the routing hop is measured and documented; there is no hard SLO in v1, but the figure is available for operators to assess.

## Assumptions

- "OpenAI" denotes the neutral wire protocol every mainstream provider and proxy can translate to and from; it does not imply traffic goes to OpenAI.
- Delivering translation for non-OpenAI-native upstreams (Bedrock, Anthropic native) implies a translating component sits behind the endpoint; whether that is a bundled proxy, an existing in-stack component, or a third-party gateway is a plan-phase decision, not a spec one.
- The value of this feature is the single-source-of-truth control point plus universal upstream support; the cost/attribution capabilities it unlocks are downstream.
- v1 runs the routing layer as a single instance; because routing fails closed (FR-007), that instance is a single point of failure for all agent LLM traffic. This is an accepted, documented tradeoff for v1, with high availability deferred (see Out of Scope).

## Out of Scope (downstream, depends on this control point)

- Per-agent cost attribution, budgets, spend enforcement, dashboards, and alerting (separate epic).
- Per-agent virtual keys and their provisioning.
- High availability / multi-replica of the routing layer (v1 is single-instance; deferred).
- Central caching or multi-backend routing behind the central control point.
