---
description: "Task list for Centralise LLM Routing and Provider Selection"
---

# Tasks: Centralise LLM Routing and Provider Selection

**Input**: Design documents from `docs/docs/specs/2026-07-20-centralise-llm-routing/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: No unit-test-first (TDD) tasks. Validation tasks are included because Success Criteria
(SC-002, SC-004, SC-005, SC-007, SC-008) require behavioural verification — these use the existing
integration harness and quickstart scenarios, not new unit suites.

**Organization**: By user story. This is an infrastructure feature — a default-off Helm subchart
plus config wiring — so "implementation" means chart/template/values/compose/docs, not application code.
No agent source changes (FR-003).

## Path Conventions

Umbrella chart: `charts/ai-platform-engineering/`. New subchart: `charts/ai-platform-engineering/charts/litellm/`.
Local dev: `deploy/litellm/`, `docker-compose.yaml`, `docker-compose.dev.yaml`. Docs: `docs/docs/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold the default-off routing subchart and register it, wired to nothing yet.

- [x] T001 Scaffold the routing subchart skeleton at `charts/ai-platform-engineering/charts/litellm/` — `Chart.yaml` (name `litellm`, chart version, appVersion), empty `templates/`, stub `values.yaml`, and a `README.md` explaining what it does and how to enable it (Constitution: component READMEs).
- [x] T002 [P] Pin the LiteLLM OSS proxy image (the plain, **non-`-database`** stateless tag — no Postgres this slice) in `charts/ai-platform-engineering/charts/litellm/values.yaml`, with a comment recording why the stateless variant is chosen (research.md Decision 1).
- [x] T003 Register the subchart as a **condition-gated, default-off** dependency in `charts/ai-platform-engineering/Chart.yaml` (condition = the flag from T004) and refresh `charts/ai-platform-engineering/Chart.lock` via `helm dependency update`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Naming and secret conventions every story depends on.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [x] T004 Apply the **decided** opt-in flag key `llmRouting.litellm.enabled` (default `false`, superseding the earlier working name `budgetGateway.*`): use it as the `Chart.yaml` dependency condition and the subchart guard, and record it in plan.md and the subchart README. (Aligns spec/plan/quickstart/data-model — analyze finding F1.)
- [x] T005 Define the shared-credential convention in `charts/ai-platform-engineering/charts/litellm/values.yaml` and the umbrella `values.yaml`: reuse `global.llmSecrets` (key `OPENAI_API_KEY`) as BOTH each agent's `OPENAI_API_KEY` and the proxy `master_key`, sourced only via secret refs (no plaintext), so the same value works across all three secret strategies (FR-011, Constitution VII).

**Checkpoint**: Naming + secret plumbing fixed — routing stand-up can begin.

---

## Phase 3: User Story 1 - Configure the LLM provider for every agent in one place (Priority: P1) 🎯 MVP

**Goal**: Stand up the routing endpoint and wire every agent to it centrally, so provider choice is one edit and no agent config is touched.

**Independent Test**: With the flag on, any agent (e.g. GitHub) returns a completion via the proxy; changing the upstream in one place changes it for all agents; an unauthenticated call to the endpoint is refused; with the proxy down, agents fail closed.

### Implementation for User Story 1

- [x] T006 [US1] Author the proxy config as a ConfigMap template in `charts/ai-platform-engineering/charts/litellm/templates/configmap.yaml`: render the LiteLLM `model_list` (request-model → upstream + native params), `general_settings.master_key` from the shared secret, and **disable retries/fallbacks** so upstream errors pass through unchanged (FR-012, contracts/openai-endpoint.md).
- [x] T007 [US1] Author the proxy Deployment in `charts/ai-platform-engineering/charts/litellm/templates/deployment.yaml`: single replica (spec Assumption), image from values, config mounted from the ConfigMap, upstream provider key injected from the secret framework, `/health` readiness/liveness probes.
- [x] T008 [P] [US1] Author the proxy Service in `charts/ai-platform-engineering/charts/litellm/templates/service.yaml` (ClusterIP, port 4000).
- [x] T009 [P] [US1] Author a NetworkPolicy in `charts/ai-platform-engineering/charts/litellm/templates/networkpolicy.yaml` restricting the proxy Service to in-cluster agent callers so the upstream key is never reachable off-cluster (FR-011).
- [x] T010 [US1] Wire central routing in the umbrella `charts/ai-platform-engineering/values.yaml`: set `global` `LLM_PROVIDER=openai` and `OPENAI_ENDPOINT` → the proxy Service, and the shared credential via `global.llmSecrets`, so every agent inherits it with no per-agent edits (FR-002, FR-004, SC-001).
- [x] T011 [US1] Document configuring the upstream provider once on the proxy (real cost-bearing key + `model_list`) via the secret framework, in the subchart README (FR-011 upstream key, quickstart A step 1).
- [x] T012 [US1] `helm lint` + `helm template` the umbrella with the flag ON: assert every agent Deployment inherits `LLM_PROVIDER=openai`, the proxy `OPENAI_ENDPOINT`, and the shared key from `global.llmSecrets`; assert a **newly-added agent template also inherits** the global routing env with no per-agent config (FR-004); assert nothing renders when the flag is OFF (default).
- [x] T013 [US1] End-to-end validate (quickstart A steps 2–5): proxy healthy; unauthenticated `/v1/chat/completions` → 401; a GitHub-agent completion succeeds via the proxy; swapping the upstream in `model_list` takes effect for all agents after one change (SC-001).
- [x] T014 [US1] Validate **fail-closed** behaviour (FR-007, SC-005): stop / misconfigure the proxy and confirm agent LLM calls fail with an error that identifies the routing layer, with **zero silent fallback** to a direct or unrouted provider call; confirm no fallback/retry policy is configured anywhere that would bypass the endpoint.

**Checkpoint**: MVP — central provider selection works, is secured (401 + NetworkPolicy), and fails closed. Deploy/demo-able on Helm.

---

## Phase 4: User Story 2 - Migrate without breaking agents; reversibility; BYO (Priority: P2)

**Goal**: An existing deployment adopts central routing by config only, can revert cleanly, and can bring its own proxy — across all environments.

**Independent Test**: Migrate a deployment on a direct OpenAI-compatible provider per the docs → agents still return correct completions, no agent source changed; flag off → back to direct calls, no residue; BYO endpoint works with the subchart disabled.

### Implementation for User Story 2

- [ ] T015 [P] [US2] Add the shared-credential + endpoint wiring to `charts/ai-platform-engineering/values-existing-secrets.yaml` and `charts/ai-platform-engineering/values-external-secrets.yaml` so central routing works under all three secret strategies (FR-011, data-model.md entity 3).
- [ ] T016 [P] [US2] Add BYO support: document/point `global.OPENAI_ENDPOINT` at an operator's external OpenAI-compatible proxy with the subchart disabled (FR-010, quickstart B); note the BYO proxy must itself do upstream translation.
- [x] T017 [US2] Add an **opt-in Docker Compose profile** for the proxy in `docker-compose.yaml` + `docker-compose.dev.yaml` and a `deploy/litellm/config.yaml` for compose parity — following `.claude/skills/docker-compose-first-install/SKILL.md`; the proxy MUST NOT be in the default minimal profile (`mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor`).
- [ ] T018 [US2] Verify reversibility (FR-005, SC-004) with a **runtime revert test**: enable routing, exercise an agent, then flag off + restore prior `LLM_PROVIDER`/endpoint and confirm at runtime that every agent returns to direct provider calls and still completes, with no orphaned secrets/config. (Static helm-template diff alone is insufficient — SC-004 requires behavioural verification.)
- [ ] T019 [US2] Verify upstream-error equivalence (FR-012): induce an upstream 429/5xx and confirm the agent observes the same error class as a direct call (migration correctness).
- [ ] T020 [US2] Write the integration guide at `docs/docs/development/centralise-llm-routing.md`: proxy setup, upstream-provider config, `provider=openai` routing and its non-OpenAI consequence, shared-credential + network restriction, reversibility, and BYO (FR-009, SC-006).

**Checkpoint**: Existing deployments can adopt, revert, and BYO across Helm and Compose.

---

## Phase 5: User Story 3 - Uniform behaviour across every agent type (Priority: P2)

**Goal**: Prove every agent type routes through the endpoint and none bypasses it, including non-OpenAI-native upstreams.

**Independent Test**: The integration harness runs every agent type through the proxy; each returns a correct completion; a Bedrock/Anthropic-native run returns correct completions via translation.

### Implementation for User Story 3

- [ ] T021 [US3] Run the existing integration harness with the flag on across all agent types (GitHub, Jira, ArgoCD, AWS, PagerDuty, Slack, and the rest); assert each returns a correct completion through the proxy and none bypasses the endpoint (SC-002, FR-006); include a freshly-added agent to confirm default inheritance (FR-004).
- [x] T022 [P] [US3] Run at least one **non-OpenAI-native** upstream (Bedrock or Anthropic native) through the proxy and confirm correct completions via translation (FR-008, SC-007). Requires a real provider key.
- [ ] T023 [P] [US3] Measure and record the added routing-hop latency vs a direct call for at least one agent, and write the figure into the integration guide (SC-008).

**Checkpoint**: All agent types and all supported upstreams verified through the central control point.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T024 [P] Record the mechanism decision (stateless LiteLLM subchart, default-off; agentgateway deferred) as an ADR/architecture note in `.specify/ARCHITECTURE.md` or `docs/`.
- [ ] T025 Run the full `quickstart.md` validation (shapes A, B, C) end to end and confirm each step's assertions.
- [ ] T026 Confirm the docker-compose first-install minimal profile is unchanged and the OSS day-0 path still works with routing off (docker-compose first-install gate).
- [ ] T027 Run the repo quality gates before marking done (Constitution VI): `helm lint` on the umbrella, `helm template` clean, and `uv run ruff check` / `uv run pytest` for any Python touched (expected minimal — no agent code changes).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: after Setup — BLOCKS all user stories (flag name + secret convention).
- **User Stories (Phase 3–5)**: after Foundational. US1 is the MVP and should land first; US2 and US3 depend on the US1 endpoint existing (both exercise the running proxy), so they are not fully parallel with US1, though US2 and US3 can run in parallel with each other once US1 is done.
- **Polish (Phase 6)**: after the desired stories.

### User Story Dependencies

- **US1 (P1)**: after Foundational. The MVP; delivers the endpoint + central wiring + fail-closed.
- **US2 (P2)**: after US1 (needs a running endpoint to migrate to / revert from / compare against).
- **US3 (P2)**: after US1 (needs the endpoint to route every agent through). Independent of US2.

### Parallel Opportunities

- T002 within Setup; T008 ‖ T009 (different template files) in US1; T015 ‖ T016 in US2; T022 ‖ T023 in US3; T024 in Polish.
- Once US1 is done, US2 and US3 can proceed in parallel by different people.

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → 4. **STOP and validate** (T012–T014: template assertions, end-to-end, fail-closed) → 5. Deploy/demo. At this point central provider selection works, is secured, and fails closed.

### Incremental Delivery

1. Setup + Foundational → subchart exists, default-off.
2. US1 → central routing works on Helm (MVP).
3. US2 → migration, reversibility, BYO, Compose.
4. US3 → all-agent-type + all-provider verification.

---

## Notes

- [P] = different files, no incomplete-task dependency. [US#] maps each task to its story.
- No agent source code changes anywhere (FR-003) — the seam is inherited config.
- No database / migrations this slice (stateless proxy). Postgres + per-agent keys arrive in the budget epic.
- Commit after each task or logical group (each commit needs a human DCO `Signed-off-by`).
- The opt-in flag (`llmRouting.litellm.enabled`) stays default-off; never add the routing proxy to the default minimal install profile.
