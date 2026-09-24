# Feature Specification: Remove the cnoe-agent-utils Dependency

**Feature Branch**: `2026-09-24-remove-cnoe-agent-utils`
**Created**: 2026-09-24
**Status**: Draft
**Input**: User description: "Remove the cnoe-agent-utils dependency from CAIPE and replace its LLM factory, tracing, and Bedrock client-resolution surfaces with in-repo equivalents built on first-party LangChain packages, plus an optional OpenAI-compatible gateway provider for broad model coverage."

## Overview

CAIPE currently obtains three distinct capabilities from a single external utility library: construction of chat models from deployment configuration, LLM tracing setup, and resolution of which Bedrock client family a given model id belongs to. Because that library declares pinned versions for the entire provider dependency closure, CAIPE cannot independently choose the versions of the provider integrations it ships. This has already forced the platform to carry dependency overrides to escape a known vulnerability in a transitively pinned package, and to pin an unrelated storage-client version "in lockstep" with the utility library. It also causes every deployed image to carry provider integrations for cloud vendors that the deployment does not use.

This feature replaces those three capabilities with equivalents owned inside the CAIPE repository, so that CAIPE controls its own provider dependency versions, and adds an optional pathway for deployments to reach models CAIPE does not natively integrate.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Maintainer remediates a provider vulnerability without upstream coordination (Priority: P1)

A platform maintainer is notified of a published vulnerability in one of the LLM provider integration packages CAIPE depends on. Today the vulnerable version is pinned by an external utility library, so the maintainer must either wait for that library to cut a release or add a dependency override that fights the declared constraint. After this change, the maintainer raises the affected package's version directly in CAIPE's own dependency declaration and ships.

**Why this priority**: This is the motivating problem. Security remediation latency is currently gated by a third party's release cadence, and the workaround (dependency overrides) is itself fragile and must be re-audited on every upgrade. Delivering only this story already removes the platform's most acute maintenance risk.

**Independent Test**: Can be fully tested by selecting any provider integration package, changing its version in CAIPE's dependency declaration, resolving the dependency lock, and confirming resolution succeeds with no override or exclusion entries required, and that agents still answer a chat turn.

**Acceptance Scenarios**:

1. **Given** a provider integration package with a published advisory, **When** a maintainer raises that package's version in CAIPE's dependency declaration, **Then** the dependency lock resolves successfully without any override, exclusion, or constraint entry that exists solely to escape an external library's pin.
2. **Given** the dependency declarations after this change, **When** a maintainer audits them, **Then** no entry is annotated as needing to be bumped "in lockstep" with an external utility library.
3. **Given** a vulnerability scan of a built platform image, **When** the scan completes, **Then** no finding is attributable to a provider integration version that CAIPE cannot itself change.

---

### User Story 2 - Existing deployments upgrade with no configuration change (Priority: P1)

An operator running CAIPE upgrades to the release containing this change. Their existing LLM configuration — the provider selection, the provider-specific credentials and model identifiers, and any per-agent model choices saved through the admin interface — continues to work with no edits.

**Why this priority**: Equal to P1 because a configuration-breaking change would convert a maintenance improvement into a migration event for every deployment. The internal replacement is only viable if it is invisible from outside.

**Independent Test**: Can be fully tested by capturing a deployment's LLM configuration before the change, upgrading, and confirming every agent answers a chat turn with no configuration edits and no new required settings.

**Acceptance Scenarios**:

1. **Given** a deployment configured for any currently supported provider, **When** the operator upgrades without editing configuration, **Then** agents answer chat turns using the same provider and model as before.
2. **Given** an agent saved with an explicit provider and model through the admin interface, **When** the operator upgrades, **Then** that agent continues to use its saved provider and model without re-selection.
3. **Given** an agent saved with no provider or model, **When** a user starts a conversation with it, **Then** it resolves to the deployment-wide default exactly as it did before the upgrade.
4. **Given** a deployment with an unset or unrecognized provider selection, **When** a user starts a conversation, **Then** they receive the same actionable configuration error message as before, naming where to fix it.

---

### User Story 3 - Cost and latency behaviours are preserved (Priority: P2)

An operator relies on CAIPE's existing efficiency behaviours: prompt caching against the model vendor, reuse of a single shared transport connection across agent runtimes rather than one per runtime, extended request timeouts so long tool calls do not abort, configurable reasoning effort on models that support it, and correct handling of uploaded document attachments. All of these continue to work after the change.

**Why this priority**: P2 because these behaviours are already in production and were each added deliberately to solve a measured problem. Silently losing them would show up as a cost or reliability regression rather than an outage, which makes it easy to ship and hard to diagnose. They are separable from P1/P2 above and testable on their own.

**Independent Test**: Can be fully tested by running a conversation with a multi-turn prompt, an uploaded document, and a long-running tool call against each supported provider, then comparing token-usage reporting, memory footprint per runtime, and request outcomes against the pre-change baseline.

**Acceptance Scenarios**:

1. **Given** a deployment whose provider and model support prompt caching, **When** a conversation exceeds one turn, **Then** cache-read token usage is reported for later turns at the same rate as before the change.
2. **Given** transport sharing is enabled, **When** multiple agent runtimes are active, **Then** the per-runtime memory footprint matches the pre-change baseline rather than growing by one full transport client per runtime.
3. **Given** a tool call that runs longer than the provider's default read timeout, **When** the model waits on it, **Then** the request completes rather than aborting on timeout.
4. **Given** a model that advertises configurable reasoning effort, **When** an agent is configured with a reasoning effort, **Then** that setting reaches the provider; **and given** a model that does not, **Then** the provider default is used and the substitution is logged.
5. **Given** a conversation with an uploaded text-family document, **When** the model receives it, **Then** the document is accepted and its content is available to the model on every supported provider.

---

### User Story 4 - Operator reaches a model CAIPE does not natively integrate (Priority: P2)

An operator needs a model from a vendor CAIPE has no built-in integration for, or wants all model traffic to flow through a central gateway their organization already operates for spend attribution, rate limiting, and key custody. They point CAIPE at that gateway's OpenAI-compatible endpoint and select it as the provider.

**Why this priority**: P2 because it converts "CAIPE supports N providers" into "CAIPE supports anything reachable through a gateway" at low cost, and it satisfies the breadth requirement without expanding the in-process dependency surface. It is additive and can ship after the replacement lands.

**Independent Test**: Can be fully tested by standing up any OpenAI-compatible gateway, configuring CAIPE to use it, and confirming an agent completes a conversation involving tool calls and streaming through it.

**Acceptance Scenarios**:

1. **Given** a reachable OpenAI-compatible gateway endpoint and credential, **When** an operator selects the gateway provider and names a model the gateway exposes, **Then** agents complete conversations through it.
2. **Given** a conversation through the gateway provider, **When** the agent needs a tool, **Then** tool calls and streamed responses work as they do for a native provider.
3. **Given** a gateway that is unreachable or rejects the credential, **When** a user starts a conversation, **Then** they receive an actionable error naming the endpoint and the failure, not an unhandled exception.
4. **Given** the gateway provider is not configured, **When** the platform starts, **Then** no gateway-related dependency, credential, or setting is required.

---

### User Story 5 - Release engineer ships only the integrations a deployment uses (Priority: P3)

A release engineer builds a platform image for a deployment that uses exactly one cloud provider. The image contains the integration for that provider and not the integrations for the others.

**Why this priority**: P3 because it is an efficiency and attack-surface improvement rather than a correctness or security-remediation requirement. It depends on P1 being done and is the natural payoff of owning the dependency declaration.

**Independent Test**: Can be fully tested by building an image with a single-provider dependency selection, listing its installed packages, and confirming the unused provider integrations are absent while agents still serve traffic on the selected provider.

**Acceptance Scenarios**:

1. **Given** a build that selects a subset of providers, **When** the image is built, **Then** integrations for unselected providers are absent from it.
2. **Given** such an image, **When** it starts and serves a conversation on a selected provider, **Then** it behaves identically to the all-provider image.
3. **Given** such an image, **When** an operator configures a provider whose integration was not installed, **Then** startup or first use fails with a message naming the missing provider and how to obtain an image that includes it.

---

### Edge Cases

- An operator names a model identifier that the selected provider does not recognize — the error must name both the provider and the model, not surface a raw vendor error.
- An operator selects a provider but omits a required credential or endpoint — the error must name the specific missing setting.
- A model identifier maps ambiguously across the Bedrock client families used for prompt-caching selection and attachment shaping — resolution must be deterministic and must have a defined default for unrecognized identifiers.
- Tracing is enabled but the trace collector is unreachable or misconfigured — agents must continue serving conversations; tracing degrades without taking traffic down.
- Tracing is disabled entirely — no trace-related credential may be required and no trace-related error may be logged per request.
- Two components both attempt to install prompt-caching behaviour for the same model — the platform must not end up with duplicate conflicting behaviour that fails at agent construction time.
- An operator upgrades, hits a problem, and needs to roll back — the previous release must still work against unchanged configuration.
- Per-agent model selections were saved by an earlier release — they must remain readable and usable, not require re-saving.

## Requirements *(mandatory)*

### Functional Requirements

**Dependency ownership**

- **FR-001**: The platform MUST NOT depend, directly or transitively, on the external agent-utility library for chat model construction, tracing setup, or model-family resolution.
- **FR-002**: The platform MUST declare the version of every LLM provider integration it ships in its own dependency declarations, changeable without coordination with any external utility library.
- **FR-003**: The platform MUST NOT require any dependency override, exclusion, or constraint entry whose sole purpose is escaping an external utility library's pinned version.
- **FR-004**: The platform MUST allow a build to install only a selected subset of provider integrations, and MUST fail with a message naming the missing provider when a provider is configured whose integration is absent.

**Configuration compatibility**

- **FR-005**: The platform MUST continue to accept the existing provider selection setting and the existing provider-specific credential, endpoint, and model-identifier settings, with unchanged names and meanings.
- **FR-006**: The platform MUST continue to accept the existing provider identifier strings used by the admin interface and by stored per-agent configuration, with unchanged spelling.
- **FR-007**: The platform MUST preserve the existing resolution order in which an agent's own provider and model take precedence over deployment-wide defaults, and a deployment-wide default takes precedence over nothing.
- **FR-008**: The platform MUST report configuration failures as actionable messages that name the provider, the model where known, and the setting to correct — not as unhandled errors.

**Capability preservation**

- **FR-009**: The platform MUST continue to supply agents with model objects that the existing agent framework and its middleware accept without adaptation.
- **FR-010**: The platform MUST continue to apply vendor-native prompt caching for every model family that previously received it, and MUST NOT install two conflicting caching behaviours for the same model.
- **FR-011**: The platform MUST continue to support sharing one transport client across agent runtimes when transport sharing is enabled, for every provider that previously supported it.
- **FR-012**: The platform MUST continue to apply extended request and connection timeouts for providers that previously received them.
- **FR-013**: The platform MUST continue to pass a configured reasoning effort to models that advertise support for it, and MUST log a substitution when a configured effort is dropped because the model does not support it.
- **FR-014**: The platform MUST continue to resolve a model identifier to the client family that governs prompt-caching selection and attachment block shaping, with deterministic behaviour and a defined default for unrecognized identifiers.
- **FR-015**: The platform MUST continue to shape uploaded document attachments correctly for each client family, preserving the existing distinction between families that require text sources and those that accept inline encoded sources.

**Tracing**

- **FR-016**: The platform MUST continue to emit LLM traces to the existing trace destination, carrying at least the trace attributes it carried before the change.
- **FR-017**: The platform MUST continue to honour the existing tracing configuration settings with unchanged names and meanings.
- **FR-018**: The platform MUST serve conversations normally when tracing is disabled or the trace destination is unreachable, and MUST NOT require any trace-related credential when tracing is disabled.
- **FR-019**: The platform MUST preserve the existing behaviour that removes sensitive skill content from emitted traces.
- **FR-020**: The platform MUST keep its own log output separate from third-party log configuration, preserving the existing isolation.

**Gateway provider**

- **FR-021**: The platform MUST offer a provider option that reaches any OpenAI-compatible endpoint, configured by endpoint, credential, and model identifier.
- **FR-022**: The gateway provider MUST support tool calling and streamed responses at parity with native providers.
- **FR-023**: The gateway provider MUST be optional: when unconfigured it MUST impose no required dependency, credential, or setting, and MUST NOT appear as a configuration error.
- **FR-024**: The platform MUST NOT add a broad multi-provider routing library to the dependency set of any agent-serving process in order to satisfy FR-021.

**Scope and sequencing**

- **FR-025**: The change MUST be delivered so that the dynamic-agents component is fully migrated and shippable before the ontology and autonomous-agents components are migrated.
- **FR-026**: Until every component is migrated, the platform MUST remain deployable and MUST NOT require two conflicting versions of any shared provider integration.

### Key Entities

- **Provider selection**: The operator-facing name for an LLM vendor pathway (for example the Bedrock, OpenAI, Azure OpenAI, Anthropic, Gemini, Vertex AI, and Groq options, plus the new gateway option). Spelling is a compatibility surface because it is stored in agent records and shown in the admin interface.
- **Model identifier**: The vendor's name for a specific model, supplied per agent or per deployment. Determines reasoning-effort support and, for Bedrock, the client family.
- **Client family**: The classification of a Bedrock model identifier that governs which prompt-caching behaviour applies and how document attachments must be shaped. Has a small closed set of values and a default.
- **Agent model configuration**: The provider, model, and reasoning-effort choices stored per agent, possibly empty, in which case deployment defaults apply.
- **Trace context**: The identifiers and attributes attached to an LLM call for correlation at the trace destination.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A maintainer can raise any provider integration's version and ship it without adding or editing a dependency override — verified by removing every existing override that exists to escape an external pin and confirming the dependency lock still resolves.
- **SC-002**: Zero vulnerability-scan findings on a built platform image are attributable to a provider integration version the platform cannot change on its own.
- **SC-003**: 100% of supported provider configurations serve a successful conversation after upgrade with zero configuration edits.
- **SC-004**: Zero configuration settings are renamed, removed, or newly required for existing deployments; the count of newly required settings for an unchanged deployment is zero.
- **SC-005**: Per-turn token usage, including cache-read tokens, is within 5% of the pre-change baseline for the same conversation on the same provider and model.
- **SC-006**: Per-runtime memory footprint with transport sharing enabled is within 10% of the pre-change baseline.
- **SC-007**: A conversation involving tool calls and streamed output completes successfully through an OpenAI-compatible gateway that the platform has no native integration for.
- **SC-008**: A single-provider build produces an image that contains no integration for any unselected provider and is smaller than the all-provider image.
- **SC-009**: Every conversation that produced a trace before the change produces a trace with the same attributes after it, and a deployment with tracing disabled logs zero trace-related errors across a full conversation.
- **SC-010**: Every misconfiguration in the edge-case list produces an actionable message naming the setting to correct, with zero unhandled errors reaching the user.
- **SC-011**: The dynamic-agents component ships migrated in a release where the remaining components are not yet migrated, with the platform deployable in that state.

## Assumptions

- **A-001**: The platform's existing agent framework remains the basis for agent execution; this feature replaces how model objects are constructed, not how agents are built or run. A change of agent framework is out of scope.
- **A-002**: The set of natively supported providers stays as it is today. Breadth beyond that set is served by the gateway provider (FR-021) rather than by adding native integrations.
- **A-003**: "OpenAI-compatible gateway" is intentionally unnamed so operators can use whichever gateway they already run. Several mature open-source gateways expose this interface; selecting or shipping one is a deployment decision, not part of this feature.
- **A-004**: Keeping broad multi-provider routing out of agent-serving processes (FR-024) is deliberate. Such routing libraries sit on the critical path of every model call and have a history of both wide transitive dependency footprints and at least one confirmed package-registry compromise; running that capability out of process as a gateway confines the blast radius and is the reason FR-021 and FR-024 are paired.
- **A-005**: The trace destination and the tracing configuration surface stay as they are today; this feature changes which code configures tracing, not where traces go.
- **A-006**: The Bedrock client-family classification in use today is correct and is being preserved rather than redesigned. Any behaviour change there would be a separate feature.
- **A-007**: Provider credentials continue to be supplied by the existing credential mechanism; this feature does not change credential storage or custody.
- **A-008**: Storage and object-store clients used for non-LLM purposes remain in the dependency set on their own merit; only their coupling to the external utility library's pinned version is removed.

## Out of Scope

- Replacing or changing the agent execution framework or its middleware stack.
- Adding native integrations for providers not supported today.
- Selecting, packaging, operating, or shipping a gateway on the platform's behalf.
- Changing the trace destination, the trace schema, or the observability stack.
- Redesigning the Bedrock client-family classification rules.
- Changing how provider credentials are stored or brokered.
- Migrating any component other than dynamic-agents, ontology, and autonomous-agents.
- Changes to the admin interface beyond whatever is required to keep existing provider selection working and to expose the gateway option.
