# Plan: Centralise LLM Routing, Quotas and Budgets

**Spec**: [spec.md](./spec.md)

**Issue**: #2874

**Epic**: #2537

This PR delivers the **spec/ADR only**. Implementation lands as separate PRs under Epic #2537 (see [tasks.md](./tasks.md)).

## Summary

- Agents use any OpenAI-compatible gateway through the `openai-compatible` provider (`llm_wrapper`).
- Every call carries a short-lived JWT naming the user, agent and owning team. The gateway enforces limits and meters usage.
- The UI backend manages models, limits and usage through a capability-flagged adapter.
- No bundled gateway. One global switch, `LLM_GATEWAY_ENABLED`, is off by default.

## Technical context

| Plane | Language | Where | Why |
|---|---|---|---|
| Data plane ①–④ | Python 3.14 | `llm_wrapper`, `dynamic_agents`, RAG | `build_chat_model` is the one choke point for paths 1–3 (FR-003); RAG already uses Python |
| Control plane ⑤, identity lifecycle | TypeScript (Next.js BFF) | `ui/src/app/api/`, `ui/src/lib/` | The BFF already owns Keycloak admin, the credentials store, CAS and admin routes |

- No new language, framework or service. New dependencies: none expected; a gateway SDK only if an adapter cannot use plain HTTP.
- Rejected: a separate gateway-management microservice. It adds an image, a chart and a second auth surface for five operations.

## Deployment

```mermaid
flowchart LR
  subgraph CAIPE["CAIPE release (existing charts and images)"]
    da["dynamic-agents"]
    bff["caipe-ui (BFF)"]
    rag["rag-server / agent-ontology"]
    kc["Keycloak"]
  end
  subgraph OP["Operator-run (BYO)"]
    gw["LLM gateway"]
  end
  prov["Model providers"]
  da -- "① inference + JWT" --> gw
  rag -- "① embeddings (phase 4)" --> gw
  bff -- "⑤ admin API" --> gw
  gw -- "JWKS" --> kc
  gw --> prov
```

- CAIPE changes ship in the existing `dynamic-agents`, `caipe-ui`, `rag-server` and `agent-ontology` images. No new image, chart or Compose service.
- The gateway is deployed and run by the operator (any namespace, cluster or SaaS) and reached by `LLM_GATEWAY_BASE_URL`.
- Network: CAIPE pods need egress to the gateway; the gateway needs egress to Keycloak's JWKS (JWT mode) and to providers.
- Dev/demo only: `setup-caipe.sh --litellm` stays an example gateway (T801). The default Compose path is unchanged.
- Rollout per environment: deploy the gateway → prepare identities (phase 1) → set values → flip `LLM_GATEWAY_ENABLED`. Rollback: flip it off.

### Helm and Compose

Today (main): pods already receive arbitrary env through values, so no template change is needed to inject a variable.

| Chart | Non-secret env | Secret env |
|---|---|---|
| `dynamic-agents` | `config:` map → ConfigMap (`templates/configmap.yaml`) | `llmSecret`, `existingSecret`, `externalSecrets` |
| `caipe-ui` | `config:` map → ConfigMap | existing secret strategies |
| `rag-server`, `agent-ontology` | `env:` map | `llmSecrets` |
| Compose | `.env` via `env_file` | `.env` |

Gap: the same five settings would be copied into two to four subcharts, so dynamic agents and the BFF can drift (FR-002). Proposal:

```yaml
global:
  llmGateway:
    enabled: false          # LLM_GATEWAY_ENABLED
    baseUrl: ""             # LLM_GATEWAY_BASE_URL
    auth: jwt               # LLM_GATEWAY_AUTH
    audience: llm-gateway   # LLM_GATEWAY_AUDIENCE
    adapter: none           # LLM_GATEWAY_ADAPTER (BFF only)
    defaultTeam: platform   # LLM_GATEWAY_DEFAULT_TEAM
    budgetSignal: ""        # LLM_GATEWAY_BUDGET_SIGNAL
    adminCredential:        # BFF only; existing secret strategies
      existingSecret: ""
```

- A shared helper renders these into `dynamic-agents` and `caipe-ui` (phase 1), then RAG charts (phase 4). A key set in a subchart's `config`/`env` still wins.
- `helm template` tests assert the rendered env per chart and that defaults render nothing new when `enabled: false`.
- `.env.example` gets the same keys, commented out. The minimal first-install profile is unchanged.

## Phases

Phases describe delivery order. One global switch controls gateway routing across all migrated paths: `LLM_GATEWAY_ENABLED=false` uses direct-provider configuration and bypasses the gateway even when configured and reachable. Valid direct-provider configuration and credentials must remain available. With the switch on, gateway failures fail closed without automatic direct-provider fallback. Rolling back an individual phase requires reverting the relevant deployment or code changes while respecting phase dependencies.

```mermaid
flowchart LR
  p0["0 Spec + spike S1"] --> p1["1 Identity preparation + agent paths 1–3"]
  p1 --> p2["2 Errors + telemetry"]
  p1 --> p3["3 Control plane"]
  p2 --> p4["4 RAG"]
  p3 --> p5["5 End-user UX"]
  p1 -.-> opt["opt Gateway authz via CAS"]
```

| Phase | Delivers | Main code | Gate |
|---|---|---|---|
| 0 | Spec/ADR (this PR) + spike S1 | `docs/`, Keycloak spike | approval |
| 1 | Identity setup and lifecycle for existing/new agents, default team; routing and authorization for agent paths 1–3 | `llm_wrapper/src/llm_wrapper/build.py`, `dynamic_agents/services/{llm_clients,llm}.py`, `dynamic_agents/auth/authz.py`, `ui/src/lib/rbac/keycloak-admin.ts`, agent lifecycle routes | S1 decides [K2](./research.md#identity-option-legend) or [C1](./research.md#identity-option-legend); #1753; #2890 for autonomous runs; identity readiness before routing (see [tasks](./tasks.md#phase-1-identity-preparation-and-agent-data-plane)) |
| 2 | Budget-signal rules ④ + attribution ③ + metrics, logs, traces | `llm_wrapper`, `dynamic_agents` | phase 1 |
| 3 | Control plane: adapter, automated gateway principal provisioning, `llm_models` sync, admin limits/usage UI | `ui/src/app/api/`, `ui/src/lib/`, `ui/src/lib/rbac/keycloak-admin.ts` | phase 1 |
| 4 | RAG paths 4–5 (same embedding model id only) | `knowledge_bases/rag/` | phases 1–2 |
| 5 | End-user UX: remaining budget, quota requests | `ui/`, bots (message text only) | phase 3 |
| opt | Gateways with ext_authz ask the BFF CAS adapter for the decision and verified identity headers | `ui/src/lib/authz/` (#2909) | phase 1 |

**Implementation completion gate (SC-007):** the [required conformance task T601](./tasks.md#required-validation) must pass all applicable checks for every in-scope path against at least two different gateways, with versions, authentication modes and results recorded. This gate applies to the implemented feature; it does not block merging this spec/ADR.

## Constitution check

| Principle | Assessment |
|---|---|
| Worse is Better / YAGNI | No bundled gateway, no in-process router, no CAIPE copy of limits. |
| Composition over Inheritance | Gateways sit behind fixed contracts plus an adapter. |
| Security by Default | Per-call verifiable identity, no provider or admin keys in agents, fail closed. |
| Single source of truth | Gateway for limits and usage; OpenFGA for access; Mongo for catalogue and requests. |
| Docker Compose first install | Default profile unchanged; the switch is off by default. |

## Risks

| Risk | Mitigation |
|---|---|
| Keycloak can't emit per-agent scope claims at scale | Spike S1; fall back to [C1](./research.md#identity-option-legend) (dynamic agents sign) |
| Gateway licence tiers lack JWT or budgets | `LLM_GATEWAY_AUTH=key`; adapter `none` |
| Shared agents drain the owning team's budget | Per-user limit on top (T1) |
| Embedding model drift invalidates indexes | Phase 4 only moves if the model id is identical |
| Gateway outage stops all LLM traffic | Fail closed with a clear error; the switch restores direct calls |
| Signer change resets budgets | Budget keys use `org` + principal, never `iss` |
| ACP runtime refactor (#2883) moves call sites | The hook lives in `llm_wrapper`, below the runtime |
| Per-user metric labels explode Prometheus cardinality | Users only in traces, logs and gateway usage (FR-009) |
| Gateway settings drift between subcharts | One `global.llmGateway` block ([Helm and Compose](#helm-and-compose)) |
