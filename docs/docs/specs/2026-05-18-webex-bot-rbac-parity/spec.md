# Feature Specification: Webex Bot RBAC Parity

**Feature Branch**: `ai-platform-engineering-feat-comprehensive-rbac`
**Created**: 2026-05-18
**Status**: Draft
**Input**: User description: "add https://github.com/caipe-io/ai-platform-engineering/pull/1329 and https://github.com/caipe-io/ai-platform-engineering/pull/1038 as webex bot integration and setup with the same RBAC UI capabilities as slack, Webex spaces instead of channels"

## Clarifications

### Session 2026-05-18

- Q: Should the implementation port the old Webex PR code or build fresh from current Slack patterns? -> A: Use PRs #1038 and #1329 as reference material only; build a fresh Webex implementation by mirroring the current Slack code and RBAC surface.
- Q: Should Webex match Slack user-level identity and OBO checks, or only space-level authorization? -> A: Full parity: Webex user linking, OBO token exchange, space-to-team mapping, and space-to-resource ReBAC are all in scope.
- Q: Should this be a generic messaging abstraction or a parallel Webex surface? -> A: Implement a parallel Webex surface with Webex-specific names, collections, OpenFGA types, UI, bot service, Helm, tests, and docs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin Governs Webex Spaces Like Slack Channels (Priority: P1)

As a platform administrator, I need to discover, register, and authorize Webex spaces through CAIPE Admin with the same resource-grant and routing capabilities that Slack channels have, so Webex can be governed without a separate manual policy process.

**Why this priority**: The requested product outcome is Slack RBAC UI parity with Webex spaces replacing Slack channels.

**Independent Test**: Configure one Webex space with a team mapping and agent/resource grants. Verify the Admin UI can list, edit, diagnose, and persist the same categories of grants and routes currently supported for Slack channels.

**Acceptance Scenarios**:

1. **Given** an admin has access to the OpenFGA ReBAC UI, **When** they open the Webex Spaces surface, **Then** they can view and search registered Webex spaces.
2. **Given** a Webex space is mapped to a CAIPE team, **When** an admin grants an agent, tool, or knowledge base to the space, **Then** the corresponding OpenFGA tuple and MongoDB provenance record are written.
3. **Given** a Webex space has route metadata, **When** an admin updates listen mode, priority, or enabled state, **Then** the route metadata is saved and visible in diagnostics.
4. **Given** MongoDB metadata and OpenFGA tuples drift, **When** an admin runs Webex space diagnostics, **Then** the UI reports the drift with Webex-specific labels and remediation guidance.

---

### User Story 2 - Webex User Acts With Enterprise Identity (Priority: P1)

As a Webex user, I need my Webex identity to link to my enterprise identity and be exchanged into an OBO token before bot-initiated agent work starts, so downstream agents and tools authorize actions as me rather than as the bot service account.

**Why this priority**: Bot-to-agent delegation without user identity would violate the RBAC model already required for Slack.

**Independent Test**: Link a Webex user to a Keycloak user, grant that user access to a team and resource, then verify a Webex space request carries the user-scoped OBO token into the agent path.

**Acceptance Scenarios**:

1. **Given** a Webex user is not linked to Keycloak, **When** they invoke the bot in an RBAC-protected space, **Then** the bot denies execution and provides a linking path.
2. **Given** a Webex user is linked and has the required team/resource access, **When** they invoke an authorized agent from an authorized space, **Then** execution proceeds with user-scoped identity.
3. **Given** a Webex user is linked but lacks the required team/resource access, **When** they invoke the bot, **Then** execution is denied before agent work starts.
4. **Given** OBO token exchange fails, **When** the bot handles a request, **Then** execution fails closed and records an auditable reason.

---

### User Story 3 - Operators Deploy Webex Bot With Slack-Like Knobs (Priority: P2)

As a platform operator, I need Webex bot deployment, secrets, Keycloak clients, compose profile, Helm chart, and runtime admin controls to follow the Slack bot pattern, so the new surface can be operated and tested consistently.

**Why this priority**: Webex needs to be installable and supportable without custom one-off deployment steps.

**Independent Test**: Enable the Webex bot in local compose or Helm values, configure required secrets and Keycloak clients, then verify health/runtime admin endpoints and bot authorization checks work.

**Acceptance Scenarios**:

1. **Given** Webex bot values are enabled, **When** Helm templates render, **Then** a non-root Webex bot workload, service account, environment, and secret references are produced.
2. **Given** local compose is configured for Webex bot, **When** the Webex profile starts, **Then** the bot has access to supervisor/dynamic agents, MongoDB, Keycloak, and OpenFGA endpoints.
3. **Given** CAIPE UI is configured with Webex bot admin credentials, **When** an admin triggers runtime status, reload, or sync, **Then** the request reaches the Webex bot admin API and returns a structured result.

---

### User Story 4 - Security Reviewer Audits Webex Parity (Priority: P2)

As a security reviewer, I need Webex authorization docs, RBAC file maps, tests, and audit events to line up with Slack behavior, so Webex does not become a weaker entry point.

**Why this priority**: Webex is another external messaging surface and must preserve deny-by-default behavior, traceability, and least privilege.

**Independent Test**: Run automated Webex RBAC tests and inspect docs/file maps to confirm every Webex auth-relevant file and enforcement point is documented.

**Acceptance Scenarios**:

1. **Given** a Webex request is denied, **When** audit logs are inspected, **Then** the denial includes a non-PII user/resource identifier, Webex surface type, space reference, and reason code.
2. **Given** docs are built, **When** an operator opens the RBAC architecture, workflows, file map, or usage docs, **Then** Webex bot authorization is documented alongside Slack.
3. **Given** RBAC validation runs, **When** Webex auth files are present, **Then** canonical docs and tests include Webex entries.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST add a Webex bot integration package that handles Webex space messages and dispatches to the existing CAIPE agent path only after authorization succeeds.
- **FR-002**: The Webex bot MUST ignore bot/self events and malformed events without starting agent work.
- **FR-003**: The Webex bot MUST resolve each Webex sender to a Keycloak user through a `webex_user_id` mapping before protected execution.
- **FR-004**: The system MUST provide a Webex identity linking flow equivalent to Slack's linking flow, using single-use nonces that expire after 10 minutes.
- **FR-005**: The Webex bot MUST obtain or validate an OBO token scoped to the linked user and active team before dispatching to downstream agents.
- **FR-006**: The system MUST model Webex spaces as first-class OpenFGA subjects/resources, using Webex-specific types such as `webex_workspace` and `webex_space`.
- **FR-007**: The system MUST use Webex-specific subject identifiers in the form `<workspace-alias>--<space-id>` and MUST NOT reuse Slack channel identifiers or OpenFGA types.
- **FR-008**: The system MUST support Webex space-to-team mappings equivalent to Slack channel-to-team mappings.
- **FR-009**: The system MUST support Webex space grants for agents, tools, and knowledge bases through CAIPE UI BFF APIs and OpenFGA tuples.
- **FR-010**: The system MUST support Webex space route metadata equivalent to Slack channel agent routes, including enabled state, listen mode, and priority.
- **FR-011**: The CAIPE Admin UI MUST expose a Webex Spaces RBAC panel beside the Slack Channels RBAC panel.
- **FR-012**: The CAIPE Admin UI MUST label Webex concepts as spaces, not channels, in Webex-specific views, APIs, docs, and diagnostics.
- **FR-013**: The system MUST provide Webex diagnostics for missing mappings, missing OpenFGA tuples, disabled routes, stale MongoDB records, and runtime admin connectivity.
- **FR-014**: The Webex bot MUST fail closed for missing identity links, missing team mappings, missing resource grants, failed OBO exchange, OpenFGA outages, or route-deny outcomes.
- **FR-015**: The Webex bot and BFF MUST produce structured audit events for allow/deny/runtime-admin outcomes without logging raw tokens or secrets.
- **FR-016**: The system MUST add Webex bot deployment support through Helm, docker-compose, example secret wiring, environment documentation, and CI.
- **FR-017**: The system MUST add Keycloak setup for Webex bot service credentials, admin API audience, token exchange, and the `webex_user_id` user attribute pattern.
- **FR-018**: Automated tests MUST cover Webex bot identity, OBO, space ReBAC, UI BFF routes, OpenFGA tuple builders/model changes, Helm values, and denial behavior.
- **FR-019**: Canonical RBAC docs under `docs/docs/security/rbac/` MUST be updated in the same change to include Webex bot architecture, workflows, usage, and file map entries.
- **FR-020**: PRs #1038 and #1329 MUST be treated as reference inputs only; implementation MUST align with current Slack RBAC patterns in this branch.
- **FR-021**: Webex bot replies MUST identify the selected Dynamic Agent and explain how to continue in the same Webex thread; when enabled, bounded prior thread context MUST be fetched through Webex `parentId` and sent only after identity, team, route, and ReBAC authorization succeed.

### Key Entities *(include if feature involves data)*

- **Webex Workspace**: A deployment-level alias used to group Webex spaces in OpenFGA and configuration. This mirrors Slack's workspace alias behavior.
- **Webex Space**: A Webex room/space that can be mapped to a CAIPE team and granted access to agents, tools, and knowledge bases.
- **Webex User Link**: The relationship between a Webex person ID and a Keycloak user, represented by the `webex_user_id` attribute and nonce-backed linking flow.
- **Space-Team Mapping**: A MongoDB record that binds one Webex space to a CAIPE team for runtime team context.
- **Space Grant**: The OpenFGA-backed authorization record that permits a Webex space to invoke or access a protected platform resource.
- **Space Route**: Dispatch metadata that controls which agents a Webex space can route to and how the bot should listen.
- **Webex Bot Admin API**: The internal API used by CAIPE UI to check Webex bot status, reload runtime state, and sync configured routes.
- **Authorization Decision**: The allow, deny, or unavailable result produced before a Webex bot request reaches agent execution.

### Assumptions

- Webex spaces are the Webex analogue to Slack channels for RBAC and UI purposes.
- Webex person IDs are stable enough to store as Keycloak user attributes, equivalent to Slack user IDs.
- A Webex workspace alias is configured by deployment and is preferred over raw Webex org identifiers for OpenFGA subject IDs.
- OpenFGA is the authoritative source for resource grants; MongoDB stores mappings, metadata, provenance, diagnostics, and UI state.
- The existing Slack implementation is the reference for desired behavior, but Webex uses separate names and storage to avoid platform leakage.
- Existing Webex agent and RAG ingestor code are separate integrations and are not the Webex bot runtime requested by this feature.
- JIT user creation can follow Slack patterns only where already supported by the platform; this spec requires identity linking and OBO parity, not a new cross-platform JIT design.

### Out Of Scope

- Refactoring Slack and Webex into a generic messaging-surface abstraction in the initial implementation.
- Importing the old PR code directly into this branch.
- Changing the existing Slack channel RBAC semantics except where small shared helpers are extracted without behavior changes.
- Adding Microsoft Teams or other messaging clients.
- Replacing OpenFGA with a different policy engine.

## Proposed Design

### Architecture

Add a dedicated Webex bot surface parallel to Slack. The runtime lives under `ai_platform_engineering/integrations/webex_bot/` and follows the Slack bot's shape: message ingestion, identity enrichment, Webex user linking, OBO token exchange, space-to-team resolution, OpenFGA checks, route resolution, optional auto-assignment, and a small internal admin API.

The authorization model mirrors Slack with Webex names: `webex_workspace` and `webex_space` in OpenFGA, subject IDs like `WEBEX--<spaceId>`, `webex_user_id` as the Keycloak user attribute, and Webex-specific MongoDB collections for space grants, routes, metrics, nonces, and mappings.

### Data Flow

1. Webex sends a space event to the Webex bot runtime.
2. The bot validates the event, ignores self/bot messages, and extracts the space ID and Webex sender ID.
3. The bot resolves the sender to a Keycloak user through `webex_user_id`; unlinked users receive a linking path and execution stops.
4. The bot resolves the space to a CAIPE team; unmapped spaces deny by default unless an explicit approved auto-assign mode is configured.
5. The bot obtains an OBO token scoped to the linked user and active team.
6. The bot checks space-level OpenFGA grants and user-level/team-level access before dispatch.
7. The bot resolves enabled Webex space routes and, when thread context is enabled, fetches bounded prior Webex messages for the same `parentId`.
8. The bot forwards the current request plus bounded thread context to the existing CAIPE agent path with user context.
9. Allow/deny outcomes are logged with Webex-specific audit fields and surfaced through diagnostics. Threaded replies include the selected `agent_id` and follow-up instructions.

### Admin UI

CAIPE UI exposes Webex BFF routes under `/api/admin/webex/spaces/...`, including list/search, resources, routes, access-check, diagnostics, defaults, runtime status, runtime reload, runtime sync, and Webex user-link administration. The OpenFGA ReBAC admin experience gains a Webex Spaces panel parallel to Slack Channels. Team details gain Webex space binding management where Slack channel binding exists today.

### Deployment

Deployment adds a `webex-bot` Helm subchart, docker-compose profile/service, CI workflow, example secrets, environment variables, and Keycloak setup. The chart follows container hardening expectations already used for service charts: non-root runtime, explicit env/secret references, and no hardcoded credentials.

### Error Handling

The Webex path denies by default. Missing identity, expired nonce, failed OBO exchange, unmapped space, missing grant, disabled route, OpenFGA outage, and bot admin authentication failure all produce structured error categories. User-facing Webex messages remain concise and do not expose internal policy details. Operator diagnostics provide specific reason codes.

### Testing

Focused tests cover bot parsing, identity linking, OBO exchange, space-team resolution, space grants, route resolution, BFF route behavior, OpenFGA model/tuple helpers, Helm rendering, and docs/file-map validation. RBAC matrix coverage includes allowed and denied Webex space scenarios, plus identity-link and grant-missing failures.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Admins can perform Webex space grant, route, diagnostic, and runtime admin workflows through CAIPE UI with parity to Slack channel workflows.
- **SC-002**: 100% of Webex bot execution attempts without a linked Webex user are denied before agent work starts.
- **SC-003**: 100% of Webex bot execution attempts from unmapped or unauthorized spaces are denied before agent work starts.
- **SC-004**: 100% of authorized Webex bot execution attempts include user-scoped identity/OBO context before reaching downstream agents.
- **SC-005**: Automated tests cover allowed, denied, unlinked, unmapped, OpenFGA unavailable, and route-disabled Webex cases.
- **SC-006**: Helm and compose provide documented Webex bot deployment paths without hardcoded secrets.
- **SC-007**: Canonical RBAC docs identify every Webex auth-relevant file and enforcement point added by this feature.
