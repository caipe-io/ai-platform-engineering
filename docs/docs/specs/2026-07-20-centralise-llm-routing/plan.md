# Implementation Plan: Centralise LLM Routing and Provider Selection

**Branch**: `prebuild/feat/centralise-llm-routing` | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `docs/docs/specs/2026-07-20-centralise-llm-routing/spec.md`

## Summary

Centralise every CAIPE agent's LLM traffic onto one endpoint so the "which provider" decision lives in a single place instead of N per-agent configs. Agents already reach their model through one seam — `cnoe_agent_utils.LLMFactory` driven by `LLM_PROVIDER` / `OPENAI_ENDPOINT` / `OPENAI_API_KEY` — so the routing change is **configuration, not agent code**: standardise every agent on `LLM_PROVIDER=openai` pointed at a central endpoint, and put a translating OpenAI-compatible proxy behind that endpoint.

**Mechanism decision (see [research.md](./research.md)): ship a stateless LiteLLM proxy as a default-off subchart, and support bring-your-own by letting the operator point `OPENAI_ENDPOINT` at any OpenAI-compatible proxy.** For this routing-only slice the proxy needs **no database** — budgets, per-agent keys, and spend persistence (the only things that need Postgres) are out of scope. That keeps the footprint to an isolated, default-off subchart that touches nothing on the existing critical path. Notably this is *not* the budget epic's "LiteLLM-for-dollar-budgets" rationale (irrelevant here); it is that a stateless OpenAI-compatible translation proxy is the smallest thing that satisfies FR-008 translation for Bedrock/Anthropic while staying minimally intrusive. agentgateway is rejected for v1 because it is MCP-only today and adding an LLM data plane to it would enable new behaviour on the shared MCP-critical component.

## Technical Context

**Language/Version**: Primarily Helm/YAML + Docker Compose; Python 3.11+ only for integration tests. No agent source changes (FR-003).  
**Primary Dependencies**: LiteLLM proxy (OSS container, OpenAI-compatible, translates to Azure/Bedrock/Anthropic); existing `cnoe-agent-utils==0.4.0` LLM seam; Helm; Docker Compose. No new Python runtime deps.  
**Storage**: N/A for this slice — the routing proxy runs stateless (config-only). No Postgres, no migrations. (Budget epic adds persistence later.)  
**Testing**: `pytest` integration harness across all agent types; `helm lint` + `helm template`; `docker compose` smoke; `ruff` for any touched Python.  
**Target Platform**: Kubernetes (Helm umbrella `charts/ai-platform-engineering`) and local Docker Compose.  
**Project Type**: Infrastructure / platform — a default-off subchart plus config wiring, not an application feature.  
**Performance Goals**: No hard SLO (SC-008); measure and document the added routing-hop latency, expected negligible vs LLM call time.  
**Constraints**: Default-off / opt-in (FR-010, FR-005); no agent code changes (FR-003); single shared credential + network restriction (FR-011); transparent upstream error passthrough (FR-012); single-instance v1, fail-closed (spec Assumptions); reproducible from the codebase (never hand-patched); must not disturb the OSS first-install minimal profile.  
**Scale/Scope**: ~15–20 built-in agent types plus dynamic agents; one shared upstream provider credential; one routing endpoint.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| I. Worse is Better | **Pass.** Stateless config-only proxy is the simplest thing that works; no DB we don't yet need. |
| II. YAGNI | **Pass.** No Postgres, no per-agent keys, no budget machinery — all deferred to the epic that needs them. |
| III. Rule of Three | **Pass.** Reuses the existing subchart pattern (keycloak/openfga/agentgateway) rather than inventing packaging. |
| IV. Composition over Inheritance | **Pass.** The routing layer is a swappable backend behind a config seam; BYO is the same seam pointed elsewhere. |
| V. Specs as Source of Truth | **Pass.** Spec + clarifications drive this plan. |
| VI. CI Gates Non-Negotiable | **Pass.** Lint/test gates apply; integration harness across agent types is an acceptance criterion. |
| VII. Security by Default | **Pass.** Shared credential via env/secret injection only (no secrets in source, three secret strategies); endpoint network-restricted; upstream key never reachable unauthenticated (FR-011). |

**Docker-compose first-install gate:** this feature adds a Compose profile and a subchart, so it MUST follow `.claude/skills/docker-compose-first-install/SKILL.md`. The routing gateway is **not** added to the default minimal profile (`mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor`); it is opt-in.

**Result: PASS — no violations, Complexity Tracking not required.**

## Project Structure

### Documentation (this feature)

```text
docs/docs/specs/2026-07-20-centralise-llm-routing/
├── plan.md              # This file
├── research.md          # Phase 0 — mechanism decision + alternatives
├── data-model.md        # Phase 1 — the routing config model (not DB)
├── quickstart.md        # Phase 1 — enable, configure, migrate, BYO
├── contracts/
│   ├── routing-backend-contract.md   # what any routing backend must satisfy
│   └── openai-endpoint.md            # the OpenAI-compatible wire contract agents speak
└── tasks.md             # Phase 2 (/speckit.tasks — not created here)
```

### Source Code (repository root)

```text
charts/ai-platform-engineering/
├── charts/
│   └── litellm/                      # NEW default-off routing subchart (stateless proxy)
│       ├── Chart.yaml
│       ├── values.yaml               # image tag, model_list/config, shared-key secret ref, networkPolicy
│       └── templates/                # Deployment, Service, ConfigMap (proxy config), NetworkPolicy
├── templates/
│   └── servicemonitor-litellm.yaml   # (optional here; full metrics land with the budget epic)
├── values.yaml                       # global LLM routing wiring: LLM_PROVIDER=openai + OPENAI_ENDPOINT
│                                     #   → central endpoint; shared key via global.llmSecrets
├── values-existing-secrets.yaml      # BYO/existing-secret path for the shared key
└── values-external-secrets.yaml      # ESO path for the shared key

deploy/litellm/                       # NEW local dev: proxy config for compose parity
docker-compose.yaml                   # NEW opt-in profile for the routing proxy (NOT in default set)
docker-compose.dev.yaml               # dev override for the proxy

docs/docs/                            # integration guide (FR-009): provider=openai routing,
                                      #   non-OpenAI consequence, shared-key + network restriction
```

**Structure Decision**: Add a **new `litellm` subchart** under the existing umbrella `charts/ai-platform-engineering/charts/`, following the established keycloak/openfga/agentgateway subchart pattern, gated behind the opt-in flag `llmRouting.litellm.enabled` (default `false`). Central routing is wired in the umbrella `values.yaml` by pointing the existing `global` LLM env (`LLM_PROVIDER`, `OPENAI_ENDPOINT`, shared key via `global.llmSecrets`) at the proxy Service. No agent chart templates change beyond inheriting the global LLM env they already consume. BYO is the same wiring with `OPENAI_ENDPOINT` set to an external proxy and the subchart left disabled.

## Database migrations

*N/A — no `db-migration.md`.* The routing proxy runs stateless (config-only) for this slice; there is no persisted storage. When the budget epic adds per-agent keys and spend, it introduces Postgres and its own migration doc.

## Complexity Tracking

No constitution violations — not required.
