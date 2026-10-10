---
description: "Follow-up issues for Centralise LLM Routing, Quotas and Budgets"
---

# Tasks: Centralise LLM Routing, Quotas and Budgets

This PR is the spec/ADR only. Each item below becomes one issue under Epic #2537 once the spec is approved. Every PR stays under 500 changed lines.

Task IDs use `T001` for phase 0 and `T101`, `T201`, etc. for phases 1–5. Separate blocks cover required validation (`T6xx`), optional work (`T7xx`) and housekeeping (`T8xx`).

## Phase 0
- [ ] **T001 Spike S1**: Keycloak 26.3 per-agent client-scope token exchange (claims, autonomous delegation per #2890, scale). Outcome: [K2](./research.md#identity-option-legend) or [C1](./research.md#identity-option-legend).

## Phase 1: identity preparation and agent data plane

Depends on #1753 (JWT-only identity in dynamic agents) and S1. Complete identity preparation before enabling routing.

- [ ] **T101** Configure the Keycloak exchanger client, backfill scopes for existing agents, and sync scopes on agent create, owner-team change (before save) and delete ([K2](./research.md#identity-option-legend) only).
- [ ] **T102** Provision `LLM_GATEWAY_DEFAULT_TEAM` in CAIPE at startup and use it for agents without an owning team.
- [ ] **T103** If S1 selects [C1](./research.md#identity-option-legend), configure signing key management and gateway trust; resolve agent and team claims from CAIPE data.
- [ ] **T104** Document operator provisioning of required gateway principals and per-agent keys before phase 3, including preparation for existing agents and later agent or team changes. Gateways may instead create principals from verified JWTs.
- [ ] **T105** Provision the [AI-assist system identity](./data-model.md#ai-assist-system-identity), permissions and gateway credentials before enabling `/assistant/suggest` routing. Verify that an authorized user can request a suggestion before saving any agent; attribution identifies the user, AI-assist system agent and its owning team (user attribution is unverified in key mode); denied system-agent or model access prevents the gateway call; missing identity preparation fails closed.
- [ ] **T106** Switch, provider override and auth hook inside `build_chat_model`, so paths 1–3 (runtime, middleware, `/suggest`) cannot bypass them.
- [ ] **T107** Gateway token acquisition and cache in dynamic agents, keyed by (user, agent, owner team); autonomous runs as the task owner.
- [ ] **T108** Key auth mode (`LLM_GATEWAY_AUTH=key`) reading per-agent keys from the credentials store.
- [ ] **T109** `llm_model#can_read` check once per turn, through the CAS access API (#2889) with audit (agent action `use` already maps to OpenFGA relation `agent#can_use`).
- [ ] **T110** Gate phase 1 on successful first calls for existing, new and ownerless agents; verify attribution after owner-team changes and fail-closed behavior when identity preparation is missing.

- [ ] **T111** Verify the global switch on paths 1–3: with a configured, reachable gateway and routing disabled, direct-provider calls succeed and zero inference requests reach the gateway. With routing enabled, a gateway outage fails closed without direct-provider fallback.

## Phase 2: errors and telemetry
- [ ] **T201** `LLMQuotaExceeded` mapping (④) with declarative gateway-limit rules and operator configuration for adapter `none` (no default). Test confirmed gateway limits, forwarded provider quota errors containing "budget"/"quota", ambiguous 402/429 responses and missing rules; only confirmed gateway limits receive budget-specific classification and advice.
- [ ] **T202** OTel GenAI metrics labelled with user, agent, team and caller kind.

## Phase 3: control plane
- [ ] **T301** `LlmGatewayAdapter` interface + `none` adapter.
- [ ] **T302** LiteLLM adapter (reference: `ai_platform_engineering/mcp/litellm/`).
- [ ] **T303** AgentGateway adapter.
- [ ] **T304** Kong adapter.
- [ ] **T305** AgentRouter adapter (optional): models listed; limits through Kubernetes CRDs or `none`; usage from Prometheus.
- [ ] **T306** `llm_models` gateway sync.
- [ ] **T307** Automate gateway principal provisioning through `ensure_principal` where supported, including the default team and first-use onboarding; replace phase 1 manual preparation for these gateways.
- [ ] **T308** Admin UI: limits per user, agent and team; live usage.

## Phase 4: RAG
- [ ] **T401** Embeddings through the gateway (same model id only).
- [ ] **T402** Ontology agent through `llm_wrapper` + the gateway.

- [ ] **T403** Extend the global-switch tests to embeddings and the ontology agent: disabled mode succeeds through direct providers with zero gateway inference requests; enabled mode fails closed on gateway outage.

## Phase 5: end-user UX
- [ ] **T501** Remaining-budget display (UI) where the adapter supports it.
- [ ] **T502** Quota-increase requests (`llm_quota_requests`) + admin approval.
- [ ] **T503** Actionable budget messages in Slack and Webex.

## Required validation
- [ ] **T601** Build and run the [gateway conformance suite](./contracts/routing-backend-contract.md) against at least two different gateways. Record each gateway's version, configured authentication mode and results. Passing all applicable checks for every in-scope path on both gateways is required for implementation completion (SC-007), not for merging this spec/ADR.

## Optional
- [ ] **T701** Gateways with ext_authz ask the BFF CAS adapter (#2909) for the model decision and verified identity headers.

## Housekeeping
- [ ] **T801** Document `setup-caipe.sh --litellm` as a dev/demo example gateway against these contracts.
- [ ] **T802** Fix `docs/docs/security/rbac/index.md`: the `tenant` claim row has no implementation.
