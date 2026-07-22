# Phase 0 Research: Centralise LLM Routing and Provider Selection

## Decision 1 — Routing-layer mechanism for v1

**Decision:** Ship a **stateless LiteLLM proxy as a default-off subchart** under `charts/ai-platform-engineering/charts/litellm/`, and support **bring-your-own** by letting the operator point `OPENAI_ENDPOINT` at any OpenAI-compatible proxy (subchart disabled).

**Rationale:**

- **Translation is the hard requirement (FR-008), and LiteLLM's core competence is exactly that** — an OpenAI-compatible front door that translates to Azure, Bedrock, Anthropic, and 100+ providers. It satisfies the non-OpenAI-native requirement out of the box.
- **This slice needs no database.** Budgets, per-agent virtual keys, and spend persistence are the only things that require Postgres, and all three are out of scope (FR-011 defers keys; budgets are a separate epic). A translation-only LiteLLM proxy runs from a config file with a single static master key — no Postgres, no StatefulSet, no migrations. This is the biggest simplification versus the budget epic's plan (which specs "proxy + Postgres") and the reason the footprint here is small.
- **Minimally intrusive (the overriding principle).** As a net-new, default-off, isolated subchart it touches nothing on the existing critical path. No contributor's dev loop changes; no agent code changes (the `LLMFactory` seam already exists); the OSS minimal install profile is untouched.
- **Fits the existing pattern.** The umbrella already ships keycloak/openfga/agentgateway as subcharts and already has the `global.llmSecrets` + three-strategy secret framework and the `LLM_PROVIDER`/`OPENAI_ENDPOINT`/`OPENAI_API_KEY` env seam. This is assembly, not invention.
- **Clean runway for the budget epic.** Phase 2 extends the *same* subchart with Postgres + `/key/generate` provisioning + spend metrics, rather than throwing this away.

**This is deliberately NOT the budget epic's rationale.** That epic chose LiteLLM-first partly because dollar budgets are native to it — irrelevant to a routing-only slice. Re-examined for translation-only, LiteLLM still wins, but on different grounds: *stateless OpenAI-compatible translation as an isolated default-off component.*

**Alternatives considered:**

| Alternative | Why rejected for v1 |
|---|---|
| **agentgateway (in-stack) with `llm:` mode** | Verified in-repo: the agentgateway subchart is **MCP-only today** (`description: AgentGateway standalone proxy for CAIPE MCP traffic`; config-bridge builds config from MCP targets, ext_authz is MCP-scoped). Turning on an LLM data plane enables new behaviour on a component that is already on the shared MCP-critical path — the larger blast radius the source analysis warned about. Its per-agent identity/CEL/rate-limit machinery is budget-epic concern, unused here. Reconsider as a second backend behind the same contract once budgets arrive. |
| **Bring-your-own only** | Violates FR-010 — a fresh install would have no working endpoint until the operator stands up external infra. BYO is kept as a supported mode, not the only one. |
| **LiteLLM with Postgres now** | Violates YAGNI / Worse-is-Better. Postgres exists only to persist budgets/keys/spend, all out of scope. Adds a StatefulSet and migrations for nothing this slice uses. |

## Decision 2 — Endpoint authentication (implements FR-011)

**Decision:** A **single shared credential** (the proxy's master/virtual key) that every agent presents as its `OPENAI_API_KEY`, delivered through the existing secret framework (`global.llmSecrets` → base Helm-generated, existing-secrets, or external-secrets), **plus a NetworkPolicy** restricting the proxy Service to in-cluster agent callers.

**Rationale:** The proxy fronts the real upstream provider key (the only thing that costs money); it must never be reachable unauthenticated. A shared key is the minimum that gives a real auth boundary without pulling per-agent virtual-key provisioning forward (deferred to the budget epic, which replaces the shared key with per-agent keys). Secrets ride the three existing strategies — no new mechanism, no plaintext (Constitution VII).

**Alternatives considered:** network-trust only (rejected — defence-in-depth wants an application credential too, and it would leave the money key open to anything in-cluster); per-agent keys now (rejected — out of scope, contradicts the spec boundary).

## Decision 3 — Upstream error handling (implements FR-012)

**Decision:** Configure the proxy for **transparent passthrough** of upstream provider errors (5xx, 429, timeout), preserving status and semantics; **no proxy-level retry** that could mask failures. LiteLLM passes provider errors through by default; ensure no retry/fallback policy is enabled that would alter the error class an agent sees versus a direct call.

**Rationale:** Migration correctness — agents that used to call providers directly must observe the same error behaviour (reinforces FR-003). Retry policy is a later, explicit choice, not a silent default.

## Decision 4 — Availability posture (implements spec Assumption)

**Decision:** **Single replica** for v1; fail-closed when down (agents error, no bypass). HA is out of scope.

**Rationale:** Matches the spec's accepted, documented SPOF tradeoff and the source implementation-plan's Phase-2C placement of HA. Keeps the first slice small. The subchart's replica count is a value operators can raise later; shared-state HA is the budget epic's concern once persistence exists.

## Decision 5 — Latency (implements SC-008)

**Decision:** No hard SLO. The integration harness measures round-trip latency through the proxy versus a direct call for at least one agent and records the delta in the integration guide.

**Rationale:** LLM calls dominate wall-clock time; a proxy hop is expected to add single-digit-to-low-tens of milliseconds. Measure-and-document gives operators the real number without over-committing before the proxy is deployed.

## Resolved unknowns

- **Does the agent seam already support `provider=openai` + custom endpoint?** Yes — verified `cnoe_agent_utils.LLMFactory` reads `LLM_PROVIDER`, `OPENAI_ENDPOINT`, `OPENAI_API_KEY`; the chart already exposes `global.llmSecrets` and per-component `agentSecrets`. No agent code change needed.
- **Is there existing LiteLLM in-repo?** Only as an MCP admin tool (`ai_platform_engineering/mcp/litellm/`) pointing at a remote proxy — not an in-cluster proxy. This slice adds the in-cluster proxy subchart; the admin tool is unrelated here (it becomes relevant to the budget epic's provisioning adapter).
- **Storage?** None for this slice — resolved to stateless config-only.
