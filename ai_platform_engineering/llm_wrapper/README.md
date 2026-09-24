# llm_wrapper

Single source for building LangChain chat models from CAIPE provider
configuration. **One copy, imported directly — not vendored, not published.**

Spec: [`docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/`](../../docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/)

## Why it declares no dependencies

This directory has no `pyproject.toml` and no dependencies of its own. That is
what lets it be a single shared source without coupling its consumers: each
consuming package pins the provider integrations *it* ships, and this code just
imports whatever is installed there.

A package that declared `langchain-aws` / `boto3` / `langchain-anthropic` would
set one version for everyone, which is exactly the coupling this code was
written to remove — CAIPE previously could not patch a provider integration
without waiting on an upstream release, and carried a dependency override to
escape GHSA-gr75-jv2w-4656 as a result. Components legitimately differ: `boto3`
is pinned differently in the platform root, in `dynamic_agents`, and in
`harness_engine`.

`build.py` imports LangChain; `providers.py` and `bedrock_family.py` import
nothing third-party. `__init__.py` re-exports nothing so that a consumer needing
only the latter two can import them without LangChain installed.

## Why not under `utils/`

`utils/pyproject.toml` sets `packages = ["."]`, so that directory builds the
`ai-platform-engineering-utils` wheel and everything under it ships inside it.
Shared source that is imported directly must not sit in a published package:
installing that wheel would deliver source importing LangChain the package does
not declare, and running these tests in that context would push someone to add
`langchain` to `utils/pyproject.toml`, giving every utils consumer the full
provider closure.

## Files

| File | Purpose | Who needs it |
|---|---|---|
| `providers.py` | CAIPE provider string → LangChain provider string + model env var | every consumer |
| `bedrock_family.py` | `resolve_bedrock_client()` → `anthropic` / `converse` / `legacy` | anything selecting prompt-caching middleware or shaping attachments |
| `build.py` | `build_chat_model()` over `init_chat_model` | consumers that construct models with credentials present |

A sandboxed harness worker is expected to take the first two and not the third:
it holds no raw provider credentials, so the shared-transport paths in `build.py`
do not apply to it.

## How consumers get it

Imported directly as `ai_platform_engineering.llm_wrapper.<module>`. There is
one copy in the repository and one in each image.

Container images must therefore be built with the **repository root** as the
Docker build context, and must copy this directory in. `dynamic_agents` does
this:

```dockerfile
COPY ai_platform_engineering/__init__.py /app/shared/ai_platform_engineering/__init__.py
COPY ai_platform_engineering/llm_wrapper/ /app/shared/ai_platform_engineering/llm_wrapper/
ENV PYTHONPATH="/app/shared"
```

It lands under `/app/shared` rather than `/app` on purpose: `/app/dynamic_agents`
holds `src/`, `tests/` and `pyproject.toml` but no `__init__.py`, so putting
`/app` on `PYTHONPATH` would make it a namespace package shadowing the real
`dynamic_agents` installed into the venv.

A component-scoped build context cannot see this directory. That constraint is
why other shared modules in this repository were duplicated into component
trees; widening the context is the fix, and the CI workflow for a consuming
image must pass `context: .`.

## Adding a provider

Two lines — one entry in `PROVIDERS`, one dependency in the consuming package's
`pyproject.toml`. `init_chat_model` already knows 28 provider strings, so
`build.py` does not change. Do **not** add the dependency to the platform root:
each image should install only the integrations it uses.

## Reaching LiteLLM (and anything else a gateway fronts)

Set the `openai-compatible` provider at a LiteLLM Proxy, Bifrost, Portkey, or
any other OpenAI-compatible endpoint:

```bash
export LLM_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://litellm-proxy:4000/v1
export OPENAI_COMPATIBLE_API_KEY=<key>
export OPENAI_COMPATIBLE_MODEL=<model the gateway exposes>
```

There is deliberately **no in-process LiteLLM provider**. `langchain-litellm`
was considered and dropped: it occupies no niche the other two paths leave
open. Native providers give provider-native behaviour `ChatLiteLLM` cannot
(Bedrock and Anthropic prompt caching, shared transport clients), and a proxy
reaches the same model set with no extra dependency and works for a sandboxed
runtime, which cannot hold provider credentials. Its only unique offer is
client-side routing and fallbacks, which the proxy does server-side and
`ModelFallbackMiddleware` already does in-process. Adding it back would also
put a broad routing library in an agent-serving process, which FR-024 forbids.

## Compatibility rules

- Do not change the public provider strings (`aws-bedrock`, `azure-openai`,
  `anthropic-claude`, `google-gemini`, `gcp-vertexai`, `openai`, `groq`). They
  are persisted in agent records and rendered in the admin UI (spec FR-006).
- Do not import this into `harness_engine`. That control plane has no LangChain
  by design and its `ModelPolicy` already owns the portable model layer.
- `bedrock_family.py` preserves `cnoe_agent_utils` 0.5.0 behaviour exactly,
  including the `AWS_BEDROCK_CLIENT` override. Changing it changes cost and
  document handling (spec FR-014, A-006).
