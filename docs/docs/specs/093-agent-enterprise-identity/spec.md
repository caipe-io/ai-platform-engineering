# Feature Specification: Policy Engines and Enterprise Authorization Architecture for Agentic AI

**Feature Branch**: `093-policy-engine-comparison` (spec folder: `093-agent-enterprise-identity`)  
**Created**: 2026-03-17  
**Status**: Draft  
**Input**: User description: "Policy Engine comparison for Agentic AI, OBO, Impersonation, Slack/Webex Bots to CAIPE Workflows"

**Scope (expanded)**: Policy engine comparison (Cedar, CEL, Casbin, OPA/Rego, AgentGateway, IBAC, OpenFGA); current codebase baseline (ASP/Global Tool Authorization); enterprise identity federation and OBO (Keycloak, token exchange, connector management); AgentGateway + Keycloak + 3LO + **Slack and Webex** bots + external authz; Slack/Webex bot authorization and I/O guardrails; architecture evolution. See [README.md](./README.md) for full research index.

**Single source of architecture truth**: [architecture.md](./architecture.md) — one unified diagram and narrative for Slack + Webex entry, Keycloak, AgentGateway, external authz, and CAIPE.

## Research & comparison baseline

- **Comparison document**: The analysis document [Policy Engine Comparison for Agentic AI, OBO & Impersonation Workflows](./policy-engine-comparison.md) is the primary deliverable. It covers Cedar, CEL, Casbin, and OPA/Rego with executive summary, detailed analysis, Keycloak integration patterns, implementation checklists, and recommendations. The spec's research sources and additional candidates (AgentGateway, IBAC, OpenFGA, current ASP baseline) extend this document.
- **AgentGateway (agentgateway.dev)**: Use agentgateway.dev and official AgentGateway documentation as a primary research source to compare how the policy engine works with tools — including tool authorization, tool-level RBAC, tool federation, and MCP/A2A protocol integration. The comparison must articulate how AgentGateway enforces policy at the tool-call boundary and how that contrasts with standalone engines.
- **Current codebase baseline**: Include the existing CAIPE **Global Tool Authorization Policy** in the comparison. This is the Answer Set Programming (ASP) policy governing tool access for system workflows, exposed in the admin UI (Global Tool Authorization Policy / Policy tab) and persisted in the `policies` collection (MongoDB). The comparison MUST evaluate candidate engines against this baseline — i.e. how each candidate could express and enforce equivalent tool-access rules for system workflows, and what migration or replacement would imply.
- **[IBAC](https://ibac.dev/) (Intent-Based Access Control)**: Include as a research and comparison reference. IBAC secures agentic AI by deriving per-request permissions from the user's explicit intent (parsed into fine-grained authorization tuples), enforcing them deterministically at every tool invocation, and blocking unauthorized actions regardless of prompt injection. It is built on OpenFGA; the pattern is "write FGA tuples after intent parsing, check before every tool call" (~9ms per check). The comparison MUST describe how IBAC's intent-based approach and tool-call boundary checks relate to (or differ from) the evaluated policy engines and CAIPE's ASP baseline.
- **[OpenFGA](https://openfga.dev/)**: Include as a comparison candidate or related system. OpenFGA is an open-source, relationship-based access control (ReBAC) solution inspired by Google Zanzibar; CNCF incubating project. It supports fine-grained authorization with a readable modeling language and fast checks. The comparison MUST evaluate OpenFGA (and the IBAC pattern that builds on it) against the other policy engines — e.g. ReBAC vs ABAC vs policy-language expressiveness, latency, and fit for agent tool-call authorization.
- **Research: AgentGateway + Keycloak + Enterprise Auth + 3LO + Slackbot + External Authz**: A dedicated research document with Mermaid diagrams describes how [AgentGateway.dev](https://agentgateway.dev/), Keycloak, enterprise authentication, third-party OAuth (3LO, e.g. Slack), a Slack bot, and an external authorization server/service work together. See [research-agentgateway-keycloak-slack-external-authz.md](./research-agentgateway-keycloak-slack-external-authz.md) for architecture, sequence, token-flow, deployment, and integration-pattern diagrams.
- **Research from [PR #975](https://github.com/caipe-io/ai-platform-engineering/pull/975)**: The following architecture docs are pulled into this spec's research for a single reference set: [Enterprise Identity Federation](./research-enterprise-identity-federation.md) (Keycloak, OBO, token exchange, connector management), [Slack Bot Authorization](./research-slack-bot-authorization.md) (scope validation gates, pre-authorization binding), [Slack I/O Guardrails](./research-slack-io-guardrails.md) (input/output guardrails for Slack), [Architecture Evolution](./research-architecture-evolution.md) (CAIPE roadmap). See [README.md](./README.md) for the full research index.

## Clarifications

### Session 2026-03-18

- Q: Add agentgateway.dev to research and compare how the policy engine works with tools; include Global Tool Authorization Policy and ASP policy governing tool access for system workflows from the current codebase for comparison. → A: Incorporated. Research & comparison baseline section added; agentgateway.dev called out as primary research source for tool-level policy; current CAIPE Global Tool Authorization Policy (ASP) added as baseline. FR-014 and Key Entity for Global Tool Authorization Policy (current) added.
- Q: Include https://ibac.dev/ and https://openfga.dev/ in the spec. → A: Incorporated. IBAC (Intent-Based Access Control, built on OpenFGA) and OpenFGA (ReBAC/Zanzibar-style) added to Research & comparison baseline; FR-015 and Key Entities for IBAC and OpenFGA added; In Scope updated.
- Q: Create research on how AgentGateway.dev + Keycloak + Enterprise Auth + 3LO + Slackbot + External Authorization Server/Service could work with Mermaid diagrams. → A: Created [research-agentgateway-keycloak-slack-external-authz.md](./research-agentgateway-keycloak-slack-external-authz.md) with architecture, sequence, token-flow, deployment, and integration-pattern diagrams; referenced in Research & comparison baseline.
- Q: In the research note, add a scenario how identity brokering and OBO/token exchange workflow would work with user pre-authorization of GitHub or Atlassian. → A: Added §9 to research doc: pre-authorization flow (user links GitHub/Atlassian via OAuth, Keycloak stores brokered identity + tokens); runtime flow (OBO JWT for AgentGateway, backend supplies brokered GitHub/Atlassian tokens to agent so API calls run in user context); summary table.
- Q: Rename this spec appropriately given the expanded scope of this task. → A: Renamed to "Policy Engines and Enterprise Authorization Architecture for Agentic AI". Added Scope (expanded) line in spec header; updated README title and description.
- Q: Create a unified architecture and include Webex bot; one architecture diagram as single source of truth. → A: Created [architecture.md](./architecture.md) as the single source of architecture truth. It contains one canonical Mermaid diagram covering Slack and Webex as entry points, Keycloak, AgentGateway, External Authz, and CAIPE; flow summary table; optional vs required components; references to all related research.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Platform Engineer Evaluates Policy Engines for Agent Authorization (Priority: P1)

As a platform engineer responsible for the CAIPE multi-agent platform, I need a structured comparison of policy engines and agent-native gateways (Cedar, CEL, Casbin, OPA/Rego, AgentGateway) so that I can select the best-fit engine for enforcing authorization boundaries on agentic AI workflows that use Keycloak identity federation with OAuth 2.0 Token Exchange and on-behalf-of (OBO) flows.

**Why this priority**: Selecting the wrong policy engine affects every downstream authorization decision across the platform. This is the foundational decision that gates all agent tool-call boundaries, impersonation controls, and multi-tenant isolation.

**Independent Test**: Can be validated by presenting the comparison matrix to a platform engineering team and confirming they can make a confident selection decision with clear trade-off understanding.

**Acceptance Scenarios**:

1. **Given** five candidates (Cedar, CEL, Casbin, OPA/Rego, AgentGateway), **When** a platform engineer reviews the comparison, **Then** each is evaluated against consistent criteria including agent tool-call boundaries, OBO/impersonation support, Keycloak integration, determinism, latency, self-hosted deployment, readability, and formal verification.
2. **Given** the comparison matrix, **When** a platform engineer needs to decide, **Then** a clear recommendation is provided per use-case archetype (deterministic agent boundaries, lightweight embedding, simple RBAC, complex infrastructure-wide policies, agent-native gateway with built-in routing and policy).

---

### User Story 2 - Security Architect Validates OBO and Impersonation Controls (Priority: P1)

As a security architect, I need to understand how each policy engine handles OAuth 2.0 Token Exchange (OBO) and service account impersonation so that I can verify the platform enforces the principle of least privilege when agents act on behalf of users.

**Why this priority**: OBO/impersonation is a critical security boundary. If the policy engine cannot enforce actor delegation constraints, agents could escalate privileges or access resources beyond what the delegating user authorized.

**Independent Test**: Can be tested by reviewing each engine's OBO integration pattern with Keycloak and confirming the policy examples correctly enforce actor, scope, and resource constraints.

**Acceptance Scenarios**:

1. **Given** a Keycloak-issued JWT with `sub`, `act`, `scope`, and `roles` claims from an OAuth 2.0 Token Exchange flow, **When** the comparison describes each engine's handling, **Then** concrete policy examples demonstrate how each engine validates the actor, the principal acting on behalf, and the authorized scope.
2. **Given** an impersonation scenario where a service account acts on behalf of a user, **When** the policy engine evaluates the request, **Then** the comparison shows whether each engine can enforce that (a) the principal is authorized to act on behalf of the actor, and (b) the actor has permission for the requested action.

---

### User Story 3 - Integration Engineer Maps Keycloak Federation Patterns (Priority: P2)

As an integration engineer, I need to understand the Keycloak integration patterns for each policy engine so that I can design the identity federation flow from Keycloak JWT issuance through agent gateway validation to policy evaluation and decision caching.

**Why this priority**: Keycloak is the identity provider for CAIPE. The integration pattern determines the deployment architecture, latency profile, and operational complexity of the authorization system.

**Independent Test**: Can be tested by reviewing the integration architecture diagrams for each engine and confirming they correctly map the flow from Keycloak JWT to policy decision.

**Acceptance Scenarios**:

1. **Given** Keycloak issues JWTs with custom claims (actor, scope, roles, org), **When** the comparison describes each engine's integration pattern, **Then** it shows the complete flow: JWT issuance, gateway validation, claim extraction, policy evaluation, and decision caching.
2. **Given** four distinct integration patterns (JWT Claims → Policy Engine, Keycloak Role Manager → Casbin, OAuth 2.0 Token Exchange → Policy Engine, Agent Gateway with built-in CEL policy evaluation), **When** an engineer reviews the comparison, **Then** each pattern is mapped to the engines that support it with concrete examples.

---

### User Story 4 - DevOps Engineer Assesses Deployment and Operational Characteristics (Priority: P2)

As a DevOps engineer, I need to understand the deployment models, latency profiles, self-hosting requirements, and operational overhead of each policy engine so that I can plan infrastructure and SLA commitments.

**Why this priority**: Deployment model affects latency, availability, and operational cost. An engine requiring an external daemon has different failure modes than an embedded library.

**Independent Test**: Can be tested by reviewing the deployment checklist for each engine and confirming it covers all infrastructure requirements.

**Acceptance Scenarios**:

1. **Given** each candidate's deployment model (daemon, embedded library, managed service, agent-native proxy), **When** a DevOps engineer reviews the comparison, **Then** latency ranges, resource requirements, and operational dependencies are clearly documented.
2. **Given** a self-hosted requirement, **When** the comparison describes deployment options, **Then** each candidate's open-source deployment path is documented with specific components (Cedar Agent + OPAL, OPA daemon, embedded library, AgentGateway proxy).

---

### User Story 5 - Bot/Automation Architect Evaluates Slack/Webex Bot Authorization (Priority: P3)

As an architect building Slack and Webex bot integrations for CAIPE, I need to understand how each policy engine handles bot-initiated workflows where a bot acts as an intermediary between a user command and agent execution, ensuring the bot cannot exceed the user's authorization scope.

**Why this priority**: Bots introduce an additional delegation layer. A user issues a command in Slack/Webex, the bot translates it to an agent request, and the agent executes tools. Each hop must preserve the user's authorization boundary.

**Independent Test**: Can be tested by tracing a sample Slack bot command through the authorization flow and confirming the policy engine enforces user-scoped permissions at each hop.

**Acceptance Scenarios**:

1. **Given** a user issues a command via a Slack/Webex bot, **When** the bot forwards the request to CAIPE agents, **Then** the comparison shows how each engine can enforce that the bot's service account acts within the user's authorization scope (not the bot's own elevated permissions).
2. **Given** a multi-hop delegation (user → bot → agent → tool), **When** the policy engine evaluates the request, **Then** the comparison identifies which engines support transitive delegation chain validation versus flat role-based checks only.

---

### User Story 6 - Platform Architect Evaluates Integrated Gateway vs Standalone Engine (Priority: P2)

As a platform architect, I need to understand the trade-offs between adopting AgentGateway (an integrated agent-native proxy with built-in Cedar + CEL policy enforcement, MCP/A2A gateways, LLM routing, and OpenTelemetry observability) versus composing a standalone policy engine (Cedar, CEL, Casbin, or OPA/Rego) behind a custom-built agent gateway, so that I can make an informed build-vs-adopt architectural decision.

**Why this priority**: This is a fundamental architectural fork. An integrated gateway reduces operational complexity and provides native MCP/A2A protocol support, but may constrain customization. A standalone engine offers maximum flexibility but requires building and maintaining the gateway, routing, and observability layers independently.

**Independent Test**: Can be tested by mapping both approaches against CAIPE's deployment topology (Kubernetes, self-hosted) and confirming the comparison articulates the operational cost, feature coverage, and extensibility trade-offs.

**Acceptance Scenarios**:

1. **Given** AgentGateway bundles Cedar + CEL policy enforcement with MCP tool federation, A2A agent discovery, JWT/OAuth authentication (Keycloak), and OpenTelemetry, **When** the comparison evaluates it against standalone engines, **Then** it quantifies what is gained (reduced integration effort, native protocol support, unified observability) and what is lost (flexibility to swap engines, policy language lock-in, dependency on a single project).
2. **Given** AgentGateway is a Linux Foundation project with contributions from Cisco, Microsoft, Apple, AWS, and others, **When** the comparison assesses project maturity and community, **Then** it evaluates governance model, release cadence, and long-term viability alongside the standalone engines.

---

### Edge Cases

- What happens when a Keycloak-issued JWT has expired claims but the policy engine has a cached positive decision?
- How does each engine handle conflicting policies (e.g., one policy permits and another denies the same action)?
- What happens when the OBO actor's permissions change mid-session (role revocation while a cached token is still valid)?
- How does each engine handle missing or malformed JWT claims (e.g., no `act` claim in a non-OBO request)?
- What happens when a bot service account is compromised — can the policy engine limit blast radius to only the permissions of the users who authorized the bot?
- How does AgentGateway handle policy evaluation when it federates multiple MCP servers behind a single endpoint — are policies scoped per upstream MCP server or applied globally?
- What happens when AgentGateway's built-in Cedar and CEL engines produce conflicting decisions for the same request (e.g., Cedar permits but a CEL traffic policy denies)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The comparison MUST evaluate each candidate (Cedar, CEL, Casbin, OPA/Rego, AgentGateway) against a consistent set of criteria covering agent tool-call boundaries, OBO/impersonation support, JWT claim inspection, determinism, latency, deployment model, readability, formal verification, MCP/A2A protocol support, and observability.
- **FR-002**: The comparison MUST provide concrete policy examples for each engine demonstrating how OBO (on-behalf-of) authorization is expressed, including principal, actor, action, resource, and scope constraints.
- **FR-003**: The comparison MUST document the Keycloak integration pattern for each engine, showing the flow from JWT issuance through policy evaluation to authorization decision.
- **FR-004**: The comparison MUST include a summary comparison matrix that allows side-by-side evaluation across all criteria.
- **FR-005**: The comparison MUST provide a recommendation per use-case archetype (deterministic agent boundaries, lightweight embedding, simple RBAC, complex infrastructure-wide policies, agent-native gateway with integrated routing/policy/observability) with justification.
- **FR-006**: The comparison MUST address the default-deny posture, formal verification capabilities, and audit/logging support of each engine.
- **FR-007**: The comparison MUST describe the multi-hop delegation scenario (user → bot → agent → tool) and identify which engines can enforce authorization at each hop.
- **FR-008**: The comparison MUST include an implementation checklist for each engine tailored to the CAIPE platform with Keycloak identity federation.
- **FR-009**: The comparison MUST document the migration path from the current state (Keycloak + identity federation) to each candidate engine.
- **FR-010**: The comparison MUST assess each candidate's handling of multi-tenant isolation for agentic workflows.
- **FR-011**: The comparison MUST evaluate AgentGateway as a distinct architectural option — an agent-native proxy that bundles policy enforcement (Cedar + CEL), MCP/A2A protocol gateways, LLM routing, and OpenTelemetry observability — and contrast this integrated approach against composing standalone policy engines with a custom gateway.
- **FR-012**: The comparison MUST assess each candidate's native support for MCP (Model Context Protocol) and A2A (Agent-to-Agent) protocol-level authorization, including tool federation, tool-level RBAC, and agent discovery governance.
- **FR-013**: The comparison MUST evaluate built-in observability capabilities (OpenTelemetry tracing, metrics, audit logging) for each candidate, distinguishing between native support and external integration requirements.
- **FR-014**: The comparison MUST research and document how AgentGateway (agentgateway.dev) implements policy enforcement for tools (tool authorization, tool-level RBAC, MCP tool federation) and compare that with other candidates; and MUST include the current CAIPE implementation — the Global Tool Authorization Policy implemented via Answer Set Programming (ASP) governing tool access for system workflows (admin Policy tab, `policies` collection) — as a baseline for comparison so that each candidate is evaluated against how the existing ASP-based implementation governs tool access.
- **FR-015**: The comparison MUST include [IBAC](https://ibac.dev/) (Intent-Based Access Control) and [OpenFGA](https://openfga.dev/) as research and comparison references: describe how IBAC's intent-parsing + FGA-tuple pattern (built on OpenFGA) enforces tool-call authorization and resists prompt injection; evaluate OpenFGA as a ReBAC/Zanzibar-style authorization engine and compare it (and the IBAC pattern) against the other policy engines for agent tool-call boundaries, latency, and fit with CAIPE workflows.

### Key Entities

- **Policy Engine**: A software component that evaluates authorization decisions based on policies, identity context, and resource attributes. Key attributes: language/syntax, evaluation model, latency profile, deployment model, formal verification capability.
- **Agent**: An autonomous AI component in the CAIPE platform that invokes tools and MCP servers on behalf of users. Key attributes: service account identity, delegated permissions, tool access scope.
- **Keycloak JWT**: An identity token issued by Keycloak containing claims (sub, act, scope, roles, org) used to convey user identity and delegated authority. Key relationship: consumed by the Agent Gateway and passed as context to the Policy Engine.
- **OBO Token**: A token obtained via OAuth 2.0 Token Exchange that allows a service account (agent) to act on behalf of a user, carrying both the principal and actor identities.
- **Bot Service Account**: An identity representing a Slack/Webex bot that acts as an intermediary between user commands and CAIPE agent execution. Key constraint: must not exceed the delegating user's authorization scope.
- **AgentGateway**: An open-source, Rust-based agent-native proxy (Linux Foundation project) that serves as a unified data plane for agentic AI. Unlike standalone policy engines, AgentGateway integrates policy enforcement (Cedar for fine-grained RBAC, CEL for access policies), MCP/A2A protocol gateways, LLM routing, JWT/OAuth authentication (with native Keycloak support), and OpenTelemetry observability into a single deployment. Key distinction: it is an architectural alternative where the gateway itself is the policy enforcement point rather than a separate engine wired behind a custom proxy. Contributing companies include Solo.io, Microsoft, Apple, AWS, Cisco, Salesforce, and others. Research source: agentgateway.dev.
- **Global Tool Authorization Policy (current)**: The existing CAIPE policy exposed in the admin UI as "Global Tool Authorization Policy" and described as an Answer Set Programming (ASP) policy governing tool access for system workflows. It is stored in the `policies` collection (MongoDB) and edited via the Policy tab. It defines which tools are allowed for system workflows. Key relationship: baseline for comparing candidate policy engines' ability to express and enforce equivalent tool-access rules; the comparison must evaluate how each candidate could replace or interoperate with this ASP-based implementation.
- **IBAC (Intent-Based Access Control)**: A pattern and reference implementation ([ibac.dev](https://ibac.dev/)) for securing agentic AI through fine-grained authorization. User intent is parsed into FGA (fine-grained authorization) tuples; tuples are written to the authorization store and checked before every tool call. No custom interpreter or dual-LLM architecture; ~9ms auth latency via OpenFGA. Key relationship: compare intent-based, tool-call-boundary enforcement against other policy engines and CAIPE's ASP baseline; relevant for prompt-injection resistance and dynamic scope.
- **OpenFGA**: Open-source, relationship-based access control (ReBAC) solution ([openfga.dev](https://openfga.dev/)), inspired by Google Zanzibar; CNCF incubating project. Provides a modeling language and fast authorization checks. IBAC is built on OpenFGA. Key relationship: compare as an authorization engine option (ReBAC vs ABAC vs policy languages) for agent tool-call authorization and as the underlying engine for the IBAC pattern.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A platform engineering team can select a policy engine within one decision-making session (under 2 hours) using the comparison as the sole reference document. The comparison is captured in [policy-engine-comparison.md](./policy-engine-comparison.md) (Cedar, CEL, Casbin, OPA/Rego), extended by research on AgentGateway, IBAC, OpenFGA, and the current ASP baseline.
- **SC-002**: The comparison covers 100% of the evaluation criteria listed in FR-001 for all five candidates.
- **SC-003**: Security reviewers confirm that the OBO/impersonation policy examples for each engine correctly enforce actor delegation constraints without privilege escalation.
- **SC-004**: The integration patterns are validated against a Keycloak test instance, confirming JWT claims flow correctly through each engine's evaluation pipeline.
- **SC-005**: The comparison identifies at least one engine that meets all CAIPE requirements: sub-millisecond latency, deterministic boundaries, OBO support, self-hosted deployment, and formal verification.
- **SC-006**: The multi-hop delegation scenario (user → bot → agent → tool) is traceable end-to-end in at least two of the five candidates.
- **SC-007**: The comparison clearly articulates the trade-off between adopting an integrated agent-native gateway (AgentGateway) versus composing a standalone policy engine with a custom gateway, enabling teams to make an informed build-vs-adopt decision.

## Assumptions

- Keycloak is the identity provider for CAIPE and issues JWTs with custom claims including `act` (actor for OBO), `scope`, `roles`, and `org`.
- The CAIPE platform uses OAuth 2.0 Token Exchange (RFC 8693) for on-behalf-of flows.
- Agents interact with external tools via MCP servers, and each tool call is a discrete authorization decision point.
- Self-hosted deployment is a requirement; managed-only services (without open-source alternatives) are not acceptable as the sole option.
- Slack and Webex bots use service accounts that authenticate via Keycloak and delegate user context through the OBO flow.
- Latency budget for authorization decisions is under 5ms for the critical path (agent → tool call).
- AgentGateway (agentgateway.dev) is evaluated as an integrated agent-native proxy option rather than a standalone policy engine — it bundles Cedar and CEL policy enforcement with MCP/A2A protocol support, making it a distinct architectural choice.
- Cisco is a contributing company to the AgentGateway project, which may influence adoption considerations.

## Scope

### In Scope

- Comparative evaluation of Cedar, CEL, Casbin, OPA/Rego, and AgentGateway for agentic AI authorization
- Research using agentgateway.dev and comparison of how each option (including AgentGateway) enforces policy for tools; inclusion of the current codebase Global Tool Authorization Policy (ASP) for system workflows as a comparison baseline
- Inclusion of [IBAC](https://ibac.dev/) (Intent-Based Access Control) and [OpenFGA](https://openfga.dev/) as research and comparison references (intent-based tool authorization, ReBAC engine)
- OBO and impersonation flow support with Keycloak identity federation
- Slack/Webex bot authorization patterns as a delegation layer
- Deployment models and operational characteristics for self-hosted environments
- Security analysis: default-deny, formal verification, audit logging
- Implementation checklists and migration paths for CAIPE
- **Documentation site and contributor workflow** (merged from former `095-enterprise-identity-federation-docs`): publish enterprise identity architecture to `docs/docs/architecture/`, and keep `CLAUDE.md` and root `.cursorrules` aligned with git worktrees and `prebuild/<type>/<description>` branch naming (see dedicated section below)

### Out of Scope

- Implementation of the selected policy engine or gateway (covered in a subsequent spec)
- Keycloak configuration changes (covered by the identity federation spec)
- Performance benchmarking with production workloads (covered in implementation phase)
- Policy engine customization or plugin development
- AgentGateway's LLM routing and inference gateway capabilities (evaluated only as they relate to policy enforcement and observability, not as an LLM proxy selection criterion)
- Non-authorization concerns beyond what AgentGateway bundles natively (standalone rate limiting, standalone network policy)

## Dependencies

- **Keycloak Identity Federation**: The comparison assumes Keycloak is configured with OAuth 2.0 Token Exchange and custom claim mappers. See the enterprise identity federation spec.
- **CAIPE Agent Architecture**: The comparison references agent-to-tool-call patterns defined in the multi-agent system architecture.
- **Slack/Webex Bot Integration**: The bot delegation scenario depends on the bot service account configuration in Keycloak.
- **AgentGateway Project**: The comparison references AgentGateway (agentgateway.dev), a Linux Foundation project. Evaluation depends on publicly available documentation, feature set as of March 2026, and compatibility with Keycloak OAuth providers.
- **IBAC & OpenFGA**: The comparison references [IBAC](https://ibac.dev/) (Intent-Based Access Control for agentic AI, built on OpenFGA) and [OpenFGA](https://openfga.dev/) (ReBAC/Zanzibar-style authorization). Evaluation uses publicly available documentation, research paper (2026), and reference implementation.

## Documentation site and contributor workflow (merged from former `095-enterprise-identity-federation-docs`)

This section folds the former standalone spec **`095-enterprise-identity-federation-docs`** into **093** so architecture publication and contributor git workflow live in one place alongside policy and identity research.

### Overview

Ship the Enterprise Identity Federation and user-impersonation architecture narrative on the CAIPE docs site, and keep developer-facing rules aligned with **git worktrees** and **`prebuild/<type>/<description>`** branch naming (no bare `git checkout -b` for feature work).

### Motivation

- The [enterprise identity federation architecture page](../../architecture/enterprise-identity-federation.md) belongs with other architecture docs (gateway, MAS).
- Contributors and automation should see one consistent story in `CLAUDE.md` and `.cursorrules` (sibling worktrees under the cnoe directory, `prebuild/<type>/...` branches).

### Scope (documentation and rules only)

**In scope**

- `docs/docs/architecture/enterprise-identity-federation.md` (and related architecture pages this effort touches, e.g. evolution / Slack docs when promoted from research).
- Root **`CLAUDE.md`**: worktree commands, branch naming, optional local `uv` / worktree setup notes.
- Root **`.cursorrules`**: Development Workflow section with the same worktree and branch conventions.

**Out of scope**

- Changing the technical content of the identity federation architecture narrative except where normal doc maintenance applies.
- Docusaurus sidebar wiring when docs are auto-discovered.
- Implementing federation in product code (separate engineering work).

### Components affected

| Area | Role |
|------|------|
| `docs/docs/architecture/` | Published architecture markdown |
| `CLAUDE.md` | Claude / contributor git workflow |
| `.cursorrules` (repo root) | Cursor / AI assistant and human developer defaults |

### Acceptance criteria

- [ ] `docs/docs/architecture/enterprise-identity-federation.md` is present and consistent with the research baseline in this folder.
- [ ] `CLAUDE.md` documents `prebuild/<type>/<description>` naming and git worktree usage.
- [ ] `.cursorrules` Development Workflow uses matching branch names and worktree examples.
- [ ] PR passes CI (docs build, lint).

### Implementation plan

**Phase 1 — Documentation**

- [ ] Ensure architecture pages under `docs/docs/architecture/` reflect the intended narratives (including federation, bots, evolution where applicable).

**Phase 2 — Contributor rules**

- [ ] Update `CLAUDE.md` git workflow section.
- [ ] Update `.cursorrules` branch naming and worktree examples.

### Testing strategy

- Manual: open architecture pages in the docs site preview.
- Manual: skim `CLAUDE.md` and `.cursorrules` for consistent `prebuild/<type>/...` and worktree paths.

### Rollout

Merge via normal PR to default branch; docs publish through existing Docusaurus CI.

### Related

- Research index: [README.md](./README.md)
- ADR: none required for doc and rules-only updates.
- Feature branch example: `prebuild/docs/enterprise-identity-federation`
