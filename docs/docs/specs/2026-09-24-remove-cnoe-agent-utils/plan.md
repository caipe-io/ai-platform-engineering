# Implementation Plan: Remove the cnoe-agent-utils Dependency

**Branch**: `2026-09-24-remove-cnoe-agent-utils` | **Date**: 2026-09-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/spec.md`

## Summary

Replace the three `cnoe-agent-utils` surfaces with in-repo equivalents so CAIPE owns the versions of every LLM provider integration it ships.

Chat-model construction moves to `langchain.chat_models.init_chat_model`, which returns provider-native `BaseChatModel` instances and therefore preserves every middleware, provider kwarg, and transport-sharing path already in use. Tracing moves to the Langfuse SDK plus OpenTelemetry directly, both already direct dependencies. The Bedrock client-family classifier is vendored unchanged.

The replacement logic lives in a canonical directory, `ai_platform_engineering/utils/llm_wrapper/`, split into small single-purpose modules. Consumers vendor the modules they need; CI verifies vendored copies against canonical and fails on undeclared drift. This is **not** a published package and **not** a uv workspace member — that distinction is the point, because a package would impose one `langchain-aws` / `boto3` / `langchain-anthropic` version on every consumer, which is the exact mechanism being removed.

## Technical Context

**Language/Version**: Python 3.14 (`requires-python = ">=3.14,<3.15"`)
**Primary Dependencies**: `langchain==1.4.1`, `langchain-core==1.6.3`, `langgraph==1.2.11`, `deepagents==0.6.8`, `langfuse==3.15.0`; provider integrations (`langchain-aws`, `langchain-openai`, `langchain-anthropic`, `langchain-google-genai`, `langchain-google-vertexai`, `langchain-groq`) become directly declared
**Storage**: N/A — no persisted state is created, read, or migrated
**Testing**: pytest (`pytest==9.1.1`, `pytest-asyncio==1.4.0`); existing suites `dynamic_agents/tests/test_llm.py` and `test_llm_clients_fallback.py` already monkeypatch the factory seam and must be retargeted
**Target Platform**: Linux containers (Docker Compose and Helm)
**Project Type**: Backend service refactor — internal dependency replacement, no new service
**Performance Goals**: Parity, not improvement. Per-turn token usage including cache reads within 5% of baseline (SC-005); per-runtime memory with transport sharing within 10% (SC-006)
**Constraints**: Zero configuration change for existing deployments (SC-003/004). No env var renamed, removed, or newly required. UI provider strings unchanged — they are persisted in agent records
**Scale/Scope**: 6 real import sites in `dynamic_agents`, 1 in `agent_ontology`, 1 stale declaration in `autonomous_agents`. ~150 lines of new canonical source. 259 of 266 lines in `llm_clients.py` unchanged

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Worse is Better | ⚠️ **Deviation** | The canonical-directory + drift-check setup is an abstraction introduced ahead of its second consumer. See Complexity Tracking. |
| II. YAGNI | ⚠️ **Deviation** | Same. The vendoring machinery is not needed by any code shipping in Phase 1. |
| III. Rule of Three | ⚠️ **Deviation** | Explicitly says tolerate duplication until the third occurrence. This plan establishes the sharing mechanism at the first. |
| IV. Composition over Inheritance | ✅ Pass | Plain functions and module-level maps. No class hierarchy. The factory is called, not subclassed. |
| V. Specs as Source of Truth | ✅ Pass | spec → plan → tasks → implement, artifacts under `docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/`. |
| VI. CI Gates Non-Negotiable | ✅ Pass | Adds a gate (vendor drift check) rather than relaxing one. Ruff and pytest unchanged. |
| VII. Security by Default | ✅ **Strengthened** | Removes an override that exists solely to escape GHSA-gr75-jv2w-4656 and restores same-day patching of provider integrations. No secrets move. The gateway provider is the mechanism that lets sandboxed workers run without raw provider credentials. |

Three deviations, all the same deviation. They are recorded and justified in Complexity Tracking rather than silently taken. **A reviewer should decide whether the justification holds**; if it does not, the fallback is stated there and costs nothing to adopt.

## Project Structure

### Documentation (this feature)

```text
docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/
├── spec.md                    # Phase -1 (/speckit.specify)
├── plan.md                    # This file
├── research.md                # Phase 0 — decisions and rejected alternatives
├── quickstart.md              # Phase 1 — how to add a provider, how to vendor
├── checklists/requirements.md # spec quality checklist
└── tasks.md                   # Phase 2 (/speckit.tasks — not created here)
```

No `data-model.md`: this feature introduces no entities. No `contracts/`: it exposes no new external interface — the env contract and provider strings are explicitly *preserved*, and preservation is verified by tests rather than described by a new contract.

### Source Code (repository root)

```text
ai_platform_engineering/
├── utils/                          # existing shared-source dir; auth/ is already vendored from
│   ├── auth/                       # precedent: dynamic_agents vendors from here today
│   ├── tracing/                    # existing sibling
│   └── llm_wrapper/                # NEW — canonical source, vendored not installed
│       ├── README.md               # what it is, why it is vendored
│       ├── providers.py            # public provider string -> (init_chat_model provider, model env var)
│       ├── bedrock_family.py       # resolve_bedrock_client -> anthropic | converse | legacy
│       ├── build.py                # build_chat_model() over init_chat_model
│       └── tests/
│           ├── test_providers.py
│           ├── test_bedrock_family.py
│           └── test_build.py
│
├── dynamic_agents/                 # PHASE 1 — the only full-surface consumer
│   └── src/dynamic_agents/
│       ├── _vendor/llm_wrapper/   # vendored copy, drift-checked in CI
│       ├── services/
│       │   ├── llm_clients.py      # 259/266 lines unchanged; factory call swapped
│       │   ├── llm.py              # import swap
│       │   ├── agent_runtime.py    # resolve_bedrock_client + tracing swaps
│       │   ├── middleware.py       # resolve_bedrock_client swap
│       │   └── tracing.py          # NEW — langfuse + OTel, replaces TracingManager
│       ├── routes/assistant.py     # import swap
│       └── main.py                 # tracing bootstrap swap
│
├── knowledge_bases/rag/agent_ontology/  # PHASE 2 — one zero-arg call, ~10 lines inline
├── autonomous_agents/                   # PHASE 2 — delete unused declaration
└── harness_engine/                      # UNTOUCHED — deliberately has no LangChain

scripts/check_vendored.py           # NEW — CI drift gate
.github/workflows/                   # wire the gate in
```

**Structure Decision**: Canonical source under `ai_platform_engineering/utils/llm_wrapper/`, vendored into consumers under a `_vendor/` subpackage. Three separate modules rather than one file, so a future consumer can vendor a subset — the anticipated Deep Agents sandbox worker needs `providers.py` and `bedrock_family.py` but not the transport-sharing logic in `build.py`, because a sandboxed worker holds no raw provider credentials.

`utils/` is the right home rather than a new top-level directory: it already holds `auth/`, `tracing/`, `agui/`, and `oauth/` as sibling subpackages, and `dynamic_agents` already vendors from `utils.auth` — the pattern this plan formalises is the one that directory is already used for. The name drops a `caipe` prefix because the repository is already CAIPE.

One packaging note: `utils/pyproject.toml` sets `packages = ["."]`, so everything under `utils/` ships in the `ai-platform-engineering-utils` wheel, and that package does not declare LangChain. `llm_wrapper` would therefore be importable-but-broken for anyone who installs that wheel and imports it directly. This is pre-existing rather than new — `utils/tracing/` already imports OpenTelemetry without `utils/pyproject.toml` declaring it — and it does not affect consumers, who vendor the source rather than installing the package. Left as-is to avoid widening scope; worth a separate cleanup.

## Database migrations

*N/A — no `db-migration.md`.* This feature creates, reads, and migrates no persisted state. Existing agent records are read unchanged; FR-006 requires the stored provider strings keep their current spelling precisely so that no data migration is needed.

## Phase sequencing

| Phase | Scope | Ships independently | Gate |
|---|---|---|---|
| 0 | Canonical source + tests + CI drift gate | Yes — no consumer yet | New tests pass; gate green on an empty vendor set |
| 1 | `dynamic_agents`: 6 import sites, tracing, vendored copy, drop `cnoe-agent-utils` + `override-dependencies` | Yes (FR-025) | US3 capability checks; SC-003/004/005/006 |
| 2 | `agent_ontology` inline; delete stale `autonomous_agents` declaration | Yes | Ontology agent answers a turn |
| 3 | Remove from root `pyproject.toml`; drop the lockstep `boto3` pin | Yes | SC-001: lock resolves with zero overrides |

Sequence Phases 0–3 **before** the harness-engine cutover in [#2401](https://github.com/caipe-io/ai-platform-engineering/pull/2401). That PR changes no files under `dynamic_agents/`, so there is no merge conflict; the ordering matters because a future Deep Agents adapter inside `harness_engine` would otherwise inherit the `boto3==1.43.16` lockstep pin. The harness branch already shows the cost — root `1.42.7`, `dynamic_agents` `1.43.16`, `harness_engine` `1.43.78`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Canonical directory + vendoring + CI drift gate established at the **first** consumer, against Principles I, II, and III | The second consumer is known and named rather than speculative: [#2401](https://github.com/caipe-io/ai-platform-engineering/pull/2401) defers a "Deep Agents adapter and certification", and its sandbox-worker contract requires model construction inside a worker image. Establishing the mechanism before two teams edit the same logic is cheaper than retrofitting it after they have diverged. The drift risk being guarded is a **correctness** risk, not tidiness: if `resolve_bedrock_client` classifies a model id differently in two copies, prompt-caching middleware selection and attachment block shaping silently diverge for the same model. | The alternative — a single module inside `dynamic_agents`, promoted later — was the original recommendation and remains viable at near-zero cost. It was rejected by decision, not by analysis. **Honest statement of the weakness:** with one consumer the vendored copy is byte-identical to canonical, so the drift gate passes trivially and guards nothing until Phase 2 of the harness work. Principle III would say wait for the third occurrence; this waits for the first. If a reviewer prefers the constitution's reading, collapse `utils/llm_wrapper/` into `dynamic_agents/services/llm_factory.py` and delete `scripts/check_vendored.py` — the module boundaries in this plan are drawn so that this is a `git mv`, not a refactor. |
| A vendored copy that is byte-identical to its canonical source | Required for the drift gate to be meaningful once a second consumer exists, and makes the consumer's import path stable across the transition. | Importing canonical directly via a path dependency would reintroduce a shared version floor across consumers — the precise failure this feature removes, and the reason `dynamic_agents` already vendors `utils.auth` rather than depending on `ai-platform-engineering-utils`. |
