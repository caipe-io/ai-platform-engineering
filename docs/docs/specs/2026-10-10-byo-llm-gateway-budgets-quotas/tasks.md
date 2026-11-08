---
description: "Follow-up issues for Centralise LLM Routing, Quotas and Budgets"
---

# Tasks: Centralise LLM Routing, Quotas and Budgets

This PR is the spec/ADR only. Each item below becomes one issue under Epic #2537 once the spec is approved. Every PR stays under 500 changed lines.

- Task IDs use `T001` for phase 0 and `T101`, `T201`, etc. for phases 1–5.
- Phase-one IDs follow the JWT delivery order, followed by key mode and the conditional signer fallback.
- Independent implementation work may proceed in parallel; validation gates require completed prerequisites.
- Separate blocks cover required validation (`T6xx`), optional work (`T7xx`) and housekeeping (`T8xx`).

## Phase 0
- [x] **T001 Spike S1** (#2938, done 2026-10-14; outcome K2; autonomous chained exchange moved to T102): Keycloak 26.3 per-agent client-scope token exchange (claims, autonomous delegation per #2890, scale). Outcome: [K2](./research.md#identity-option-legend) or [C1](./research.md#identity-option-legend).

## Phase 1: identity preparation and agent data plane

Depends on S1. Complete identity preparation before enabling routing.

- **JWT first** (LiteLLM Enterprise, AgentGateway): complete the setup and implementation tasks below, then pass both JWT validation tasks before rollout. Keep routing disabled until identity preparation is complete.
- **Key mode next** (LiteLLM OSS): implement per-agent keys, complete identity preparation for key auth, and repeat the switch, first-call and ownership-transfer checks.
- Operators follow T104 to register required principals and set budgets in the gateway until phase 3.
- C1 is conditional fallback work, not a required step after K2.
- Not gated on #1753: the gateway token is minted only from the bearer that dynamic agents already validate, never from `X-User-Context`.

- [ ] **T101** Switch, provider override and auth hook inside `build_chat_model`, so paths 1–3 (runtime, middleware, `/suggest`) cannot bypass them.
- [ ] **T102** Create the exchange-only `caipe-dynamic-agents` Keycloak client (no admin roles), add it to user-token audiences, add the shared `llm-gateway` scope (audience mapper), test a chained exchange of a scheduler-minted owner token, size `cache-embedded-realms-max-count`, backfill scopes for existing agents, and sync scopes on agent create and delete ([K2](./research.md#identity-option-legend) only; see [S1 results](./research.md#s1-results)). Implement recoverable ownership transfers for K2, C1 and key auth as applicable: block new calls while unresolved, verify credential bindings against committed ownership before use or caching, and invalidate previous-owner cached credentials on completion.
- [ ] **T103** Provision `LLM_GATEWAY_DEFAULT_TEAM` in CAIPE at startup and use it for agents without an owning team.
- [ ] **T104** Document operator provisioning of required gateway principals and per-agent keys before phase 3, including preparation for existing agents and later agent or team changes. Gateways may instead create principals from verified JWTs.
- [ ] **T105** Provision the [AI-assist system identity](./data-model.md#ai-assist-system-identity), permissions and gateway credentials before enabling `/assistant/suggest` routing. Verify that an authorized user can request a suggestion before saving any agent; attribution identifies the user, AI-assist system agent and its owning team (user attribution is unverified in key mode); denied system-agent or model access prevents the gateway call; missing identity preparation fails closed.
- [ ] **T106** Gateway token acquisition and cache in dynamic agents, keyed by (user, agent, owner team); request exactly one agent scope and verify the returned `agent_id`/`team_id`; autonomous runs as the task owner. Refresh before expiry where possible; test that tokens are never sent at or after `exp`, and refresh failure after expiry fails closed even if the gateway permits leeway.
- [ ] **T107** `llm_model#can_read` check once per turn, through the CAS decision API dynamic agents already calls, with audit; move to `/api/access` with #2889 (agent action `use` already maps to OpenFGA relation `agent#can_use`).
- [ ] **T108** Add the Helm `global.llmGateway` values, implement a shared helper, and invoke it from the `dynamic-agents` and `caipe-ui` chart templates. Render environment values as strings; explicit subchart `config`/`env` keys take precedence. Keep adapter selection and admin credential secret references BFF-only. Test default-disabled output, enabled settings and subchart overrides with `helm template`. Add matching commented keys in `.env.example`, including `LLM_GATEWAY_BASE_URL` (FR-020). Implement mode-dependent credential injection and a pod-template change for each switch transition; split mixed secrets or select individual keys. Include pod-template checksums for chart-managed Secrets and document explicit rolling restarts after external Secret synchronization and mode-specific Compose injection with container recreation (see plan).
- [ ] **T109** Startup warning for configured experimental Harness Engine runtimes when the switch is on (FR-023); docs list which runtimes are budgeted.

### JWT validation gate

- [ ] **T110** Verify both deployment-mode transitions on paths 1–3. Assert provider credentials are absent from gateway-enabled pod environments and mounts, disabling restores secret references and replaces pods, and direct calls succeed only after credential loading and readiness. Verify consumed-secret rotation replaces pods and loads updated credentials, including an explicit rolling restart for externally managed Secrets. Test missing secrets, rollout failure and explicit overrides; do not report success until all old pods terminate. Exercise the equivalent Compose container recreation. Verify the global switch: with a configured, reachable gateway and routing disabled, direct-provider calls succeed and zero inference requests reach the gateway. With routing enabled, a gateway outage fails closed without direct-provider fallback.
- [ ] **T111** Gate phase 1 on successful first calls for existing, new and ownerless agents, a successful AI-assist suggestion before saving an agent (T105), and fail-closed behavior when identity preparation is missing. Run the success checks after T103, T104 and T105 preparation is complete for the selected auth mode. Validate ownership transfers across applicable auth modes:
  - Successful transfers charge the committed owner and invalidate previous-owner cached credentials.
  - Failure between ownership and credential-binding writes, and recovery after process interruption, leave no persistent billing mismatch.
  - Concurrent new calls, including calls with cached credentials, are rejected while a transfer is unresolved; mismatched credentials are neither used nor cached.
  - Calls admitted before the transfer may complete against the previous team's budget.

### Key mode

- [ ] **T112** Key auth mode (`LLM_GATEWAY_AUTH=key`) reading per-agent keys from the credentials store.

### Conditional signer fallback

- [ ] **T113** Only if K2 fails the remaining validation and [C1](./research.md#identity-option-legend) is selected, configure signing key management and gateway trust; resolve agent and team claims from CAIPE data. Complete this before enabling C1 routing and repeat the applicable validation gates.

## Phase 2: errors and telemetry
- [ ] **T201** Preserve error status and existing classification (④) through the runtime. Test gateway limit rejections, forwarded provider 429/5xx responses and ambiguous 402/429 responses, including messages containing "budget" or "quota". Verify no inferred origin, scope, reset time or budget-increase advice, and no direct-provider fallback. Adapter `none` requires no error-recognition configuration.
- [ ] **T202** Metrics (FR-009): extend `da_llm_*` with team, caller kind and outcome; add failed-request, gateway-connection-failure and token-cache counters. No user label.
- [ ] **T203** Structured logs (FR-021) for gateway calls, rejected requests, fail-closed and token-mint failures; test that no token, key or prompt is logged.
- [ ] **T204** Traces (FR-022): gateway-call and token-acquisition spans; `traceparent` carries the gateway-call span. Measure the added hop for SC-006.

## Phase 3: control plane
- [ ] **T301** `LlmGatewayAdapter` interface + `none` adapter.
- [ ] **T302** LiteLLM adapter (reference: `ai_platform_engineering/mcp/litellm/`).
- [ ] **T303** AgentGateway adapter.
- [ ] **T304** Kong adapter.
- [ ] **T305** AgentRouter adapter (optional): models listed; limits through Kubernetes CRDs or `none`; usage from Prometheus.
- [ ] **T306** Implement gateway model sync gated by `models.list`, persisting catalogue entries in `llm_models`. Verify that `none` hides sync while configuration/admin-created entries remain usable for gateway inference.
- [ ] **T307** Automate gateway principal provisioning through `ensure_principal` where supported, including the default team and first-use onboarding; replace phase 1 manual preparation for these gateways.
- [ ] **T308** Admin UI: limits per user, agent and team; live usage.
  - Verify that cached responses cannot cross users, agents, teams, operations, reporting windows or gateway configurations, including identical IDs across principal types. Verify that a caller whose access has been revoked is denied even when the requested data is cached, and that cache entries expire.

## Phase 4: RAG
- [ ] **T401** Embeddings through the gateway (same model id only); render `global.llmGateway` into the RAG charts.
- [ ] **T402** Ontology agent through `llm_wrapper` + the gateway.

- [ ] **T403** Extend T110 credential-isolation and deployment-transition tests to embeddings and the ontology agent: disabled mode succeeds through direct providers with zero gateway inference requests; enabled mode fails closed on gateway outage.

## Phase 5: end-user UX
- [ ] **T501** Remaining-budget display (UI) where the adapter supports it.
- [ ] **T502** Quota-increase requests (`llm_quota_requests`) + admin approval.
- [ ] **T503** Preserve runtime failure reporting in Slack and Webex without inferred budget scope, reset time or budget-increase advice.

## Required validation
- [ ] **T601** Build and run the [gateway conformance suite](./contracts/routing-backend-contract.md) against at least two different gateways. Record each gateway's version, configured authentication mode, JWT expiry leeway (0–60 seconds where applicable) and results; test the expiry boundary with controlled clocks. Passing all applicable checks for every in-scope path on both gateways is required for implementation completion (SC-007), not for merging this spec/ADR.

## Optional
- [ ] **T701** Gateways with ext_authz ask the BFF CAS adapter (#2909) for the model decision and verified identity headers.

## Housekeeping
- [ ] **T801** Document `setup-caipe.sh --litellm` as a dev/demo example gateway against these contracts.
- [ ] **T802** Fix `docs/docs/security/rbac/index.md`: the `tenant` claim row has no implementation.
