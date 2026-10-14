# Specification Quality Checklist: Centralise LLM Routing, Quotas and Budgets

**Created**: 2026-10-10 · **Feature**: [spec.md](../spec.md) · **Issue**: #2874

## Content quality
- [x] Problem and goal stated without committing to one gateway product
- [x] User journeys for platform admin, agent author, end user and agent runtime
- [x] Bullets and Mermaid diagrams over prose

## Design criteria (from #2874)
- [x] Plug-and-play: any OpenAI-compatible gateway; swap needs no agent change (FR-001, FR-002, SC-001)
- [x] Budgets: JWT mode enforces user, agent and team limits; key mode enforces agent and team limits, with best-effort per-user limits (FR-004, FR-005, contract ②)
- [x] AuthN: JWT mode verifies user, agent and team identity; key mode verifies agent/team bindings but leaves user attribution unverified. Neither mode uses provider or shared admin keys in agents (FR-004–FR-007)
- [x] AuthZ: OpenFGA governs agent and model access (FR-010)
- [x] Journeys include first-use onboarding (J1–J4, research Decision 6)
- [x] Data: one source of truth each, no drifting copies (research Decision 8, FR-015)
- [x] Rollout: off by default, phased, reversible (FR-018, FR-019, plan)
- [x] Reliability: fail closed, streaming and tool calls, clear quota errors (FR-012, FR-013)
- [x] Observability: metrics by agent, team and model; users in traces and logs (FR-009, FR-021, FR-022)
- [x] Reuse: `llm_wrapper`, Keycloak, CAS, `llm_models` (no parallel mechanisms)

## Readiness
- [x] Success criteria measurable
- [x] Open decisions explicit (OD-1, spike S1)
- [x] Implementation split into follow-up issues ([tasks.md](../tasks.md))
