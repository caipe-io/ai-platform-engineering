---
description: "Follow-up issues for Centralise LLM Routing, Quotas and Budgets"
---

# Tasks: Centralise LLM Routing, Quotas and Budgets

This PR is the spec/ADR only. Each task becomes an issue under Epic #2537 after approval. Keep implementation PRs under 500 changed lines; an issue may require multiple PRs.

- IDs group work by phase; explicit prerequisites and acceptance gates define execution order.
- Deliver LiteLLM OSS key mode first, then AgentGateway and AgentRouter JWT mode. Kong is optional.
- JWT remains the configuration default; LiteLLM OSS explicitly selects key mode. Never fall back to keys after JWT authentication fails.
- Independent work may proceed in parallel. Keep routing disabled until the selected mode passes its acceptance gate.
- Final acceptance uses `T6xx`, optional extensions `T7xx`, and documentation `T8xx`.

## Phase 0: design and spike

- [x] **T001Spike S1** (#2938, done 2026-10-14; outcome K2; autonomous chained exchange moved to T118): Keycloak 26.3 per-agent client-scope token exchange (claims, autonomous delegation per #2890, scale). Outcome: [K2](./research.md#identity-option-legend) or [C1](./research.md#identity-option-legend).

## Phase 1: identity preparation and agent data plane

### Shared prerequisites

Token exchange does not gate key-mode delivery. Prepare identities for the selected auth mode before enabling routing.

- [ ] **T101** Build the reusable [gateway conformance suite](./contracts/routing-backend-contract.md), initially covering key-mode checks. Record gateway versions, auth modes and applicable checks; extend it for JWT and additional paths as they land.
- [ ] **T102** `LlmGatewayAdapter` interface + `none` adapter. Verify empty capabilities hide management controls while configuration/admin-created model entries remain usable. Operator-managed principals, keys and limits must work without a named adapter.
- [ ] **T103** Provision `LLM_GATEWAY_DEFAULT_TEAM` in CAIPE at startup and use it for agents without an owning team.
- [ ] **T104** Document operator provisioning of required gateway principals and per-agent keys before phase 3, including preparation for existing agents and later agent or team changes. Gateways may instead create principals from verified JWTs.

### Milestone 1: LiteLLM OSS key mode

Depends on the shared prerequisites; JWT setup is not required.

- [ ] **T105** Switch, provider override and auth hook inside `build_chat_model`, so paths 1–3 (runtime, middleware, `/suggest`) cannot bypass them.
- [ ] **T106** Key auth mode (`LLM_GATEWAY_AUTH=key`) reading per-agent keys from the credentials store. Until JWT implementation is complete, selecting JWT with routing enabled must fail closed with a clear unsupported-mode error.
- [ ] **T107** `llm_model#can_read` check once per turn, through the CAS decision API dynamic agents already calls, with audit; move to `/api/access` with #2889 (agent action `use` already maps to OpenFGA relation `agent#can_use`).
- [ ] **T108** Provision the [AI-assist system identity](./data-model.md#ai-assist-system-identity), permissions and gateway credentials before enabling `/assistant/suggest` routing. Verify that an authorized user can request a suggestion before saving any agent; attribution identifies the user, AI-assist system agent and its owning team (user attribution is unverified in key mode); denied system-agent or model access prevents the gateway call; missing identity preparation fails closed.
- [ ] **T109** Implement recoverable ownership transfers for K2, C1 and key auth as applicable: block new calls while unresolved, verify credential bindings against committed ownership before use or caching, and invalidate previous-owner cached credentials on completion.

### Deployment safeguards

Complete these before key-mode acceptance; reuse them for JWT rollout.

- [ ] **T110** Wire Helm `global.llmGateway` through a shared helper into Dynamic Agents and BFF templates (FR-020).
  - Render strings and exactly one explicit switch per container, overriding imported ConfigMaps/Secrets. Omitted global configuration or `enabled` resolves to false.
  - Inherit omitted local switches, accept matching values, and reject conflicts in either direction. Other explicit subchart settings retain precedence.
  - Derive credential injection from the same resolved switch. Keep adapter selection and management credentials BFF-only.
- [ ] **T111** Implement credential isolation, mode transitions and secret rotation (FR-006).
  - Exclude direct-provider credentials from enabled environments and mounts, and exclude ambient identities that can invoke models. Split mixed secrets or project individual keys.
  - Restore provider references when disabled; each transition changes the pod template. Wait for readiness and termination of old pods.
  - Use checksums for chart-managed Secrets; document synchronization followed by explicit rolling restart for external Secrets.
- [ ] **T112** Configure Compose and the separate Harness Engine Deep Agents host.
  - Add commented settings to `.env.example`, including `LLM_GATEWAY_BASE_URL`. Preserve the default first-install path.
  - Propagate one deployment-wide switch, reject conflicting service settings, select mode-specific credentials, and recreate Compose containers. Do not pass provider keys wholesale to enabled containers.
  - Cover the separate Harness image and supported manifests: routing settings, mode-specific credentials, provider/ambient-identity isolation and rolling restarts. Shared Python code alone does not configure this host.
- [ ] **T113** Startup warning for configured experimental Harness Engine runtimes when the switch is on (FR-023); docs list which runtimes are budgeted.

### Key-mode acceptance

Depends on T101–T113. Run against LiteLLM OSS with operator-provisioned keys and adapter `none`.

- [ ] **T114** Validate rendered deployment configuration.
  - Use `helm template` to cover default-disabled and enabled settings, inherited/matching switches, rejection of both conflict directions, other overrides and BFF-only management settings.
  - Verify one explicit switch wins over imported Secrets, including a Secret after a ConfigMap in `envFrom`. Test omitted global configuration and omitted `enabled` with an imported true switch: routing remains disabled and provider references remain present. External Secrets need not be readable at render time.
  - Check equivalent switch propagation and conflict rejection in Compose and supported Harness manifests.
- [ ] **T115** Validate credential isolation and both deployment-mode transitions on paths 1–3, including both Dynamic Agents and the separate Harness host for paths 1–2.
  - Confirm provider credentials and model-invoking ambient identities are absent when enabled. Disabling restores credentials and replaces pods; direct calls succeed only after credential loading and readiness.
  - With a reachable gateway and routing disabled, direct calls succeed with zero gateway inference requests. Enabled gateway outages fail closed without provider fallback.
  - Test secret rotation, including external synchronization and explicit restart, missing secrets, rollout failures and other overrides. Do not report success until old pods terminate. Verify equivalent Compose recreation.
- [ ] **T116** Validate identity readiness with successful first calls for existing, new and ownerless agents, a successful AI-assist suggestion before saving an agent (T108), and fail-closed behavior when identity preparation is missing. Run the success checks after T103, T104 and T108 preparation is complete for the selected auth mode. Validate ownership transfers across applicable auth modes:
  - Successful transfers charge the committed owner and invalidate previous-owner cached credentials.
  - Failure between ownership and credential-binding writes, and recovery after process interruption, leave no persistent billing mismatch.
  - Concurrent new calls, including calls with cached credentials, are rejected while a transfer is unresolved; mismatched credentials are neither used nor cached.
  - Calls admitted before the transfer may complete against the previous team's budget.
- [ ] **T117** Complete the LiteLLM OSS milestone after T114–T116 and all applicable key-mode conformance checks for paths 1–3 pass. Record version, agent/team attribution, best-effort user attribution, limit rejection and fail-closed results.

### Milestone 2: JWT implementation

Follows T117. S1 selected K2; token minting uses the validated bearer, never `X-User-Context`, so this work is not gated on #1753.

- [ ] **T118** Configure the exchange-only `caipe-dynamic-agents` Keycloak client (no admin roles), user-token audiences and shared `llm-gateway` audience scope. Validate chained exchange of a scheduler-minted owner token and production database/cache behavior; size `cache-embedded-realms-max-count` ([S1 results](./research.md#s1-results)).
- [ ] **T119** Backfill per-agent Keycloak scopes and synchronize create/delete lifecycle. Extend T109 ownership-transfer safeguards to JWT bindings. Prepare default-team and AI-assist identities for JWT mode.
- [ ] **T120** Gateway token acquisition and cache in dynamic agents, keyed by (user, agent, owner team); request exactly one agent scope and verify the returned `agent_id`/`team_id`; autonomous runs as the task owner. Refresh before expiry where possible; test that tokens are never sent at or after `exp`, and refresh failure after expiry fails closed even if the gateway permits leeway.
- [ ] **T121** Only if K2 fails the remaining validation and [C1](./research.md#identity-option-legend) is selected, configure signing key management and gateway trust; resolve agent and team claims from CAIPE data. Complete this before enabling C1 routing and repeat the applicable validation gates.

### JWT acceptance

Depends on T118–T120, or the explicitly selected C1 alternative in T121. C1 is conditional, not a mandatory follow-on to K2.

- [ ] **T122** Extend T101 with JWT signature, issuer, audience, claim-binding and expiry checks. Record gateway expiry leeway (0–60 seconds) and test boundaries with controlled clocks; verify the runtime never sends expired tokens.
- [ ] **T123** After T122, validate AgentGateway: repeat T114–T116 for JWT and pass all applicable conformance checks for paths 1–3, including autonomous owner attribution. Record version, configuration and results before rollout.
- [ ] **T124** After T122, validate AgentRouter against the same JWT acceptance criteria as T123. Record supported capabilities and enforce fail-closed limit-store behavior. Both gateways are required for the JWT milestone.

## Phase 2: errors and telemetry

Depends on phase 1; key-mode coverage may begin after T117, with JWT coverage added after T123–T124.

- [ ] **T201** Preserve error status and existing classification (④) through the runtime. Test gateway limit rejections, forwarded provider 429/5xx responses and ambiguous 402/429 responses, including messages containing "budget" or "quota". Verify no inferred origin, scope, reset time or budget-increase advice, and no direct-provider fallback. Adapter `none` requires no error-recognition configuration.
- [ ] **T202** Metrics (FR-009): extend `da_llm_*` with team, caller kind and outcome; add failed-request, gateway-connection-failure and token-cache counters. No user label.
- [ ] **T203** Structured logs (FR-021) for gateway calls, rejected requests, fail-closed and token-mint failures; test that no token, key or prompt is logged.
- [ ] **T204** Traces (FR-022): gateway-call and token-acquisition spans; `traceparent` carries the gateway-call span. Measure the added hop for SC-006.

## Phase 3: gateway management

Depends on phase 1. Reuse the adapter interface and `none` behavior from T102.

### Required adapters

- [ ] **T301** LiteLLM OSS adapter (reference: `ai_platform_engineering/mcp/litellm/`).
- [ ] **T302** AgentGateway adapter.
- [ ] **T303** AgentRouter adapter: models listed; limits through Kubernetes CRDs; usage from Prometheus. Advertise only implemented capabilities; unsupported budget features remain unavailable.

### Provisioning and management UI

- [ ] **T304** Implement gateway model sync gated by `models.list`, persisting catalogue entries in `llm_models`. Verify that `none` hides sync while configuration/admin-created entries remain usable for gateway inference.
- [ ] **T305** Automate gateway principal provisioning through `ensure_principal` where supported, including the default team and first-use onboarding; replace phase 1 manual preparation for these gateways.
- [ ] **T306** Admin UI: limits per user, agent and team; live usage.
  - Verify that cached responses cannot cross users, agents, teams, operations, reporting windows or gateway configurations, including identical IDs across principal types. Verify that a caller whose access has been revoked is denied even when the requested data is cached, and that cache entries expire.

## Phase 4: RAG and ontology

Depends on phases 1–2. Complete identity design and provisioning before activating either path.

### Identity preparation and integration

- [ ] **T401** Embeddings through the gateway (same model id only); render `global.llmGateway` into the RAG charts. Define and provision the effective principal, billing identity and credential acquisition for query and background-ingestion calls before activation; do not assume an interactive user token is always available.
- [ ] **T402** Integrate ontology gateway identity and credentials, reusing its existing `build_chat_model` call. Complete the identity design and provisioning before enabling its gateway settings:
  - Define the effective principal for background ontology evaluation and the stable agent/team billing binding, including who authorizes the work. Record how this satisfies FR-004 and SC-002; if a service principal is needed instead of a user/owner token, resolve that contract explicitly before implementation.
  - Provision the required identity, permissions and gateway principals; implement JWT acquisition/refresh or per-agent key retrieval for the selected auth mode. Reuse shared acquisition helpers where applicable; chart settings alone do not provide a caller identity.
  - Pass verified identity context to the model client and verify gateway attribution. Missing identity or denied access must prevent inference.

### Acceptance

- [ ] **T403** Extend T114–T115 credential-isolation and deployment-transition tests to embeddings and the ontology agent: disabled mode succeeds through direct providers with zero gateway inference requests; enabled mode fails closed on gateway outage. Validate provisioned identity and user/agent/team attribution according to the selected auth mode, credential refresh or key retrieval, and failure before inference when identity preparation is missing or access is denied.

## Phase 5: end-user experience

Depends on phase 3 capabilities.

- [ ] **T501** Remaining-budget display (UI) where the adapter supports it.
- [ ] **T502** Quota-increase requests (`llm_quota_requests`) + admin approval.
- [ ] **T503** Preserve runtime failure reporting in Slack and Webex without inferred budget scope, reset time or budget-increase advice.

## Final acceptance

- [ ] **T601** After phases 1–5, run the suite built in T101 and extended in T122 across all in-scope paths. Validate the [gateway conformance suite](./contracts/routing-backend-contract.md) against LiteLLM OSS (key mode), AgentGateway (JWT) and AgentRouter (JWT). Record each gateway's version, configured authentication mode, JWT expiry leeway (0–60 seconds where applicable) and results; test the expiry boundary with controlled clocks. Passing all applicable checks for every in-scope path on all three required gateways is required for implementation completion (SC-007), not for merging this spec/ADR.

## Optional extensions

- [ ] **T701** Gateways with ext_authz ask the BFF CAS adapter (#2909) for the model decision and verified identity headers.
- [ ] **T702** Kong AI Gateway adapter and applicable conformance checks; confirm deployment plugin and licence requirements.

## Documentation

- [ ] **T801** Document `setup-caipe.sh --litellm` as a dev/demo example gateway against these contracts.
- [ ] **T802** Fix `docs/docs/security/rbac/index.md`: the `tenant` claim row has no implementation.
