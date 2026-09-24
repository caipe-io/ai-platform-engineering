# Phase 0 Research: Remove the cnoe-agent-utils Dependency

**Date**: 2026-09-24 | **Plan**: [plan.md](./plan.md)

Every NEEDS CLARIFICATION from Technical Context is resolved below. Each entry records what was chosen, why, and what was rejected.

## D1 — Replacement for `LLMFactory`

**Decision**: `langchain.chat_models.init_chat_model`, wrapped by a thin in-repo factory.

**Rationale**: Already in the dependency tree via `langchain==1.4.1`, so it adds nothing. Returns provider-native `BaseChatModel` instances, so the entire middleware stack, every provider kwarg, and the transport-sharing paths keep working without adaptation. Verified against `libs/langchain_v1/langchain/chat_models/base.py`: the registry has 28 provider strings, including `anthropic_bedrock` → `ChatAnthropicBedrock` and `litellm` → `ChatLiteLLM`.

**Alternatives considered**:

- **LiteLLM Python SDK** — rejected on return shape, not quality. `litellm.completion()` returns OpenAI-format responses; `create_deep_agent(model=...)` and the `langchain` middleware stack are typed on `BaseChatModel`. Adopting it means rewriting the agent runtime off LangGraph. Two further findings from its published metadata: `openai>=2.20.0` is a **core** dependency, so a Bedrock-only image would ship the OpenAI SDK; and the official `anthropic` package is not a base dependency (only under the `proxy-runtime` extra), so the SDK path reimplements the Anthropic wire protocol — placing our most common configuration on a reimplementation of the API we depend on most.
- **`langchain-litellm` (`ChatLiteLLM`)** — implemented as an opt-in provider, then removed. It occupies no niche the other two paths leave open: native providers give provider-native behaviour it cannot (Bedrock and Anthropic prompt caching, shared transport clients), and an OpenAI-compatible proxy reaches the same model set with no extra dependency and works for a sandboxed runtime. Its one unique offer, client-side routing and fallbacks, is already covered server-side by the proxy and in-process by `ModelFallbackMiddleware`. Keeping it would also have meant a broad routing library inside an agent-serving process, which FR-024 forbids — calling an unused optional extra exempt was a distinction without a difference. LiteLLM remains fully supported through its proxy.
- **`any-llm` (Mozilla.ai)** — architecturally the most interesting alternative: Apache-2.0, 60+ providers, and it delegates to each vendor's **official SDK** instead of reimplementing wire protocols. Rejected on the same return-shape grounds. Worth revisiting only if CAIPE ever moves off LangChain.
- **`aisuite`** — actively maintained (0.2.0, 2026-09-18, with an Agents API), contrary to some older write-ups. Fewer providers and the same return-shape problem.

## D2 — Does removing `cnoe-agent-utils` cost provider breadth?

**Decision**: No. Keep the seven providers in use; reach everything else through additional provider strings and the gateway option.

**Rationale**: `init_chat_model` exposes 28 provider strings. Seven are wired today. Seventeen more (`deepseek`, `mistralai`, `cohere`, `xai`, `together`, `fireworks`, `perplexity`, `nvidia`, `ibm`, `azure_ai`, `ollama`, `huggingface`, `baseten`, `upstage`, `meta`, `google_anthropic_vertex`, `langsmith`) are a dependency line plus a map entry each — not an architectural change. One is an aggregator: `openrouter` fronts several hundred models behind a single string. LiteLLM is reached through its proxy via the `openai-compatible` provider rather than in-process.

**Alternatives considered**: Adding native integrations for more vendors up front — rejected under YAGNI. Which of the seventeen are actually wanted is an open question in the spec, not a guess to implement.

## D3 — Replacement for `TracingManager`

**Decision**: Langfuse SDK plus OpenTelemetry directly.

**Rationale**: `langfuse==3.15.0` is already a root dependency, and `agent_ontology/agent.py:27` already uses `langfuse.langchain.CallbackHandler`, so the pattern exists in-repo. Langfuse integrates with LangChain natively — it is not a reason to adopt any particular model library.

**Alternatives considered**: Keeping `cnoe-agent-utils` for tracing alone — rejected because it would retain the entire provider dependency closure for one facility, defeating the purpose.

## D4 — Replacement for `resolve_bedrock_client`

**Decision**: Vendor the classification rules unchanged into `bedrock_family.py`.

**Rationale**: About twenty lines. It maps a Bedrock model id to `anthropic` / `converse` / `legacy`, which selects the prompt-caching middleware and the attachment block shape. Spec A-006 states the current behaviour is correct and is being preserved, not redesigned. `init_chat_model` covers model *construction* for all three families; this is *classification*, a separate concern.

**Correction on record**: earlier drafts of this analysis claimed `init_chat_model` could not reach `ChatAnthropicBedrock` and that the branch would stay hand-rolled. That was wrong — `anthropic_bedrock` is in the registry. The work is smaller than first sized.

## D5 — Shared-code mechanism

**Decision**: Canonical directory plus vendored copies, verified by a CI drift gate. Not a published package, not a uv workspace member.

**Rationale**: A package sets one `langchain-aws` / `boto3` / `langchain-anthropic` version for every consumer — the exact mechanism being removed. Vendoring preserves independent pinning and permits deliberate divergence, which is a requirement rather than a flaw: a sandboxed Deep Agents worker cannot use the `LLM_CLIENT_SHARING` boto3 injection, because it holds no AWS credentials. There is repo precedent — `dynamic_agents/pyproject.toml:22` records vendoring `utils.auth` rather than depending on `ai-platform-engineering-utils`, for image-size reasons.

**Alternatives considered**:

- **Internal package (`caipe-llm-wrapper` on PyPI or as a workspace member)** — rejected. Reimposes the shared version floor. The repo has no `[tool.uv.workspace]` block, so it would also need new build wiring. Evidence that components legitimately diverge: the harness branch pins `boto3` three ways — root `1.42.7`, `dynamic_agents` `1.43.16`, `harness_engine` `1.43.78`.
- **A single module inside `dynamic_agents`, extracted later** — viable, cheaper, and what the constitution's Rule of Three prescribes. Rejected by decision rather than analysis; see Complexity Tracking in plan.md, which records the fallback and keeps it a `git mv`.

## D6 — Scope boundary against Harness Engine

**Decision**: The wrapper stays consumer-local. It does not become a platform-wide model abstraction.

**Rationale**: `harness_engine/pyproject.toml` has no LangChain by design — its dependencies are `boto3`, `claude-agent-sdk`, `fastapi`, `pydantic`, `pydantic-settings`, `pymongo`, `uvicorn`. Its `HarnessAdapter` Protocol has four methods (`descriptor`, `session_manager`, `evaluate`, `stream`) and no model-construction method. `ModelPolicy` is three strings, passed straight through: `agentcore.py:235` puts `model.id` into `bedrockModelConfig.modelId`; `claude_sdk.py:200` passes `model=profile.model`. Neither wants a `BaseChatModel`. A shared factory spanning all three harnesses would rebuild `cnoe-agent-utils` one level up.

**Future consumer**: a Deep Agents **sandbox worker image**, not the control plane. Under `sandbox-worker-v1.md` the worker receives "provider endpoint alias or egress-proxy route, never a raw long-lived secret", so it would need `providers.py` and `bedrock_family.py` but not the credential-dependent parts of `build.py`.

## D7 — Why the gateway provider is not optional

**Decision**: Ship the OpenAI-compatible gateway provider in Phase 1, implemented as `ChatOpenAI(base_url=...)`.

**Rationale**: `sandbox-worker-v1.md` states that "a harness that requires a raw credential inside the worker is unavailable under the production sandbox profile." A sandboxed worker therefore cannot hold provider API keys, and must reach models through an endpoint alias with credentials attached at the egress boundary. That makes the gateway a **precondition for sandboxed execution**, not only a breadth feature — FR-021 and the sandbox work are the same requirement seen from two directions.

**Implementation note**: implement as `ChatOpenAI(base_url=...)`, not by repointing `ChatOpenRouter`. Verified in `langchain_openrouter/chat_models.py`: `ChatOpenRouter` does expose `base_url` (field `openrouter_api_base`, line 173), but its `_create_chat_result` parses OpenRouter's error envelope, and its distinguishing features (`provider`, `route`, `plugins`, `trace`) only work against OpenRouter's own service. Repointing it yields a branded client speaking generic OpenAI protocol with degraded error handling.

**Alternatives considered**: Adding `openrouter` as a named provider in Phase 1 — deferred. It adds a dependency (`langchain-openrouter` → `openrouter`) and nobody has asked for it. It is also a hosted service, so it cannot serve air-gapped or strict-data-governance deployments and cannot be the platform's only breadth story.

## D8 — Sequencing against PR #2401

**Decision**: Land Phases 0–3 before the harness-engine cutover.

**Rationale**: [#2401](https://github.com/caipe-io/ai-platform-engineering/pull/2401) changes zero files under `ai_platform_engineering/dynamic_agents/`, verified against its file list, so there is no merge conflict in either order. The ordering matters for a different reason: the deferred Deep Agents adapter would otherwise be born inheriting the `boto3==1.43.16` lockstep pin. Doing this first means it starts clean.

**Note**: #2401's branch is currently stale relative to `main` — its root `pyproject.toml` shows `version = 0.5.69-dev.1` and `requires-python >=3.13,<4.0` against main's `1.3.0-rc.3` and `>=3.14,<3.15`. It needs a merge from main regardless of this work.
