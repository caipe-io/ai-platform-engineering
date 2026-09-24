# Implementation Plan: Remove the cnoe-agent-utils Dependency

**Branch**: `2026-09-24-remove-cnoe-agent-utils` | **Date**: 2026-09-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/spec.md`

## Summary

Replace the three `cnoe-agent-utils` surfaces with in-repo equivalents so CAIPE owns the versions of every LLM provider integration it ships.

Chat-model construction moves to `langchain.chat_models.init_chat_model`, which returns provider-native `BaseChatModel` instances and therefore preserves every middleware, provider kwarg, and transport-sharing path already in use. Tracing moves to the Langfuse SDK plus OpenTelemetry directly, both already direct dependencies. The Bedrock client-family classifier is ported unchanged.

The replacement logic lives in `ai_platform_engineering/llm_wrapper/` as a **single shared source**, imported directly. It is not vendored, not published, and declares no dependencies of its own — which is what lets it be shared without coupling: each consuming package pins the provider integrations it ships. A package that declared those integrations would impose one `langchain-aws` / `boto3` / `langchain-anthropic` version on every consumer, the exact mechanism being removed.

Sharing it requires the consuming image to build with the **repository root** as its Docker context. The dynamic-agents image previously used `context: ai_platform_engineering/dynamic_agents`, which is why shared modules such as `utils.auth` were duplicated into component trees; widening the context removes that constraint at its root rather than working around it.

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
| I. Worse is Better | ⚠️ **Deviation** | A shared directory created ahead of its second consumer. Milder than earlier drafts — the vendoring and drift-gate machinery is gone — but still shared structure for one consumer. See Complexity Tracking. |
| II. YAGNI | ⚠️ **Deviation** | Same. Nothing in Phase 1 needs the code to be shared; `dynamic_agents` is its only consumer. |
| III. Rule of Three | ⚠️ **Deviation** | Explicitly says tolerate duplication until the third occurrence. This plan establishes the sharing mechanism at the first. |
| IV. Composition over Inheritance | ✅ Pass | Plain functions and module-level maps. No class hierarchy — `build_chat_model` is called, not subclassed. |
| V. Specs as Source of Truth | ✅ Pass | spec → plan → tasks → implement, artifacts under `docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/`. |
| VI. CI Gates Non-Negotiable | ✅ Pass | Ruff, pytest and the uv-lock check all unchanged and passing. No gate relaxed. |
| VII. Security by Default | ✅ **Strengthened** | Removes an override that exists solely to escape GHSA-gr75-jv2w-4656 and restores same-day patching of provider integrations. No secrets move. The gateway provider is the mechanism that lets sandboxed workers run without raw provider credentials. |

Three deviations, all the same deviation. They are recorded and justified in Complexity Tracking rather than silently taken. **A reviewer should decide whether the justification holds**; if it does not, the fallback is stated there and costs nothing to adopt.

## Project Structure

### Documentation (this feature)

```text
docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/
├── spec.md                    # Phase -1 (/speckit.specify)
├── plan.md                    # This file
├── research.md                # Phase 0 — decisions and rejected alternatives
├── quickstart.md              # Phase 1 — how to add a provider, how it reaches images
├── checklists/requirements.md # spec quality checklist
└── tasks.md                   # Phase 2 (/speckit.tasks — not created here)
```

No `data-model.md`: this feature introduces no entities. No `contracts/`: it exposes no new external interface — the env contract and provider strings are explicitly *preserved*, and preservation is verified by tests rather than described by a new contract.

### Source Code (repository root)

```text
ai_platform_engineering/
├── llm_wrapper/                    # NEW — single shared source, imported directly.
│   │                               # NOT under utils/: that directory builds a wheel
│   │                               # (packages = ["."]), and shared source imported
│   │                               # directly must not ship inside a published package.
│   │                               # Declares no dependencies of its own.
│   ├── README.md                   # what it is, how images get it
│   ├── providers.py                # public provider string -> (init_chat_model provider, model env var)
│   ├── bedrock_family.py           # resolve_bedrock_client -> anthropic | converse | legacy
│   ├── reasoning.py                # reasoning effort -> provider-native thinking config
│   ├── build.py                    # build_chat_model() over init_chat_model
│   └── tests/
│
├── dynamic_agents/                 # PHASE 1 — the only full-surface consumer
│   └── src/dynamic_agents/
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

ai_platform_engineering/dynamic_agents/build/Dockerfile   # build context widened to repo root
.github/workflows/{prebuild,ci}-dynamic-agents.yml        # context: .
```

**Structure Decision**: One shared source under `ai_platform_engineering/llm_wrapper/`, imported directly as `ai_platform_engineering.llm_wrapper.<module>`. Separate modules rather than one file so a consumer can take a subset: `providers.py`, `bedrock_family.py` and `reasoning.py` import nothing third-party, which both lets them be tested without LangChain installed and suits the anticipated Deep Agents sandbox worker, which holds no raw provider credentials and cannot use the transport paths in `build.py`.

Sharing requires the consuming image to build with the **repository root** as its Docker context. The dynamic-agents image used `context: ai_platform_engineering/dynamic_agents`, so nothing outside that directory could enter it — the same constraint that forced `utils.auth` to be duplicated into the component tree. Widening it removes the cause rather than working around it; the repository already builds slack-bot with `context: .`.

`llm_wrapper/` sits beside the consumers rather than inside `utils/`. `utils/` was considered first, because `dynamic_agents` already copies from `utils.auth` and the directory holds `auth/`, `tracing/`, `agui/` and `oauth/` as siblings. It was rejected on packaging: `utils/pyproject.toml` sets `packages = ["."]`, so that directory builds the `ai-platform-engineering-utils` wheel and everything under it ships inside it.

Two failure modes follow from putting directly-imported shared source inside a published package. Anyone installing that wheel would get `llm_wrapper` source importing LangChain the package does not declare. And running `llm_wrapper`'s tests in that package's context would eventually push someone to add `langchain` to `utils/pyproject.toml`, at which point every utils consumer inherits the full provider closure — reconstructing the exact coupling this feature removes, inside the fix. A hatch `exclude` would also work but is a config line that can be silently undone; a separate directory makes the rule structural.

Measured, not assumed: today nothing declares `ai-platform-engineering-utils` as a dependency and no Dockerfile copies `ai_platform_engineering/utils/`, so this is about preventing a future trap rather than fixing present bloat.

## Database migrations

*N/A — no `db-migration.md`.* This feature creates, reads, and migrates no persisted state. Existing agent records are read unchanged; FR-006 requires the stored provider strings keep their current spelling precisely so that no data migration is needed.

## Phase sequencing

| Phase | Scope | Ships independently | Gate |
|---|---|---|---|
| 0 | `llm_wrapper/` + tests | Yes — no consumer yet | New tests pass, including the LangChain-free subset |
| 1 | `dynamic_agents`: 6 import sites, tracing, build context, drop `cnoe-agent-utils` + `override-dependencies` | Yes (FR-025) | US3 capability checks; SC-003/004/005/006 |
| 2 | `agent_ontology` inline; delete stale `autonomous_agents` declaration | Yes | Ontology agent answers a turn |
| 3 | Remove from root `pyproject.toml`; drop the lockstep `boto3` pin | Yes | SC-001: lock resolves with zero overrides |

Sequence Phases 0–3 **before** the harness-engine cutover in [#2401](https://github.com/caipe-io/ai-platform-engineering/pull/2401). That PR changes no files under `dynamic_agents/`, so there is no merge conflict; the ordering matters because a future Deep Agents adapter inside `harness_engine` would otherwise inherit the `boto3==1.43.16` lockstep pin. The harness branch already shows the cost — root `1.42.7`, `dynamic_agents` `1.43.16`, `harness_engine` `1.43.78`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| A shared directory, `ai_platform_engineering/llm_wrapper/`, created at the **first** consumer, against Principles I, II and III | The second consumer is named rather than speculative: [#2401](https://github.com/caipe-io/ai-platform-engineering/pull/2401) defers a "Deep Agents adapter and certification", and its sandbox-worker contract requires model construction inside a worker image. The module split also has present value independent of sharing: `providers.py` and `bedrock_family.py` import nothing third-party, which is what lets the reasoning and classification logic be unit-tested without LangChain installed. | A single module inside `dynamic_agents`, promoted later, remains viable at near-zero cost and is what Principle III prescribes. It was rejected by decision, not by analysis. **Honest statement of the weakness:** with one consumer, sharing buys nothing today. If a reviewer prefers the constitution's reading, moving `llm_wrapper/` under `dynamic_agents/src/dynamic_agents/services/` is a `git mv` plus reverting the build-context change. |
| Widening the dynamic-agents Docker build context from the component directory to the repository root | Required for a single shared source: with `context: ai_platform_engineering/dynamic_agents`, nothing outside that directory can enter the image. That constraint is why `utils.auth` is duplicated into the component tree today. The repository already builds slack-bot with `context: .`, so this follows an existing convention. | Vendoring — a copy in each consumer plus a CI drift gate — was implemented first and rejected: it means two copies of the same file in one repository, and the gate guards nothing until a second consumer exists. Publishing a package was rejected because it would set one `langchain-aws` / `boto3` / `langchain-anthropic` version for every consumer, which is the coupling this feature removes. |
