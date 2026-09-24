# Quickstart: the shared LLM wrapper

**Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

## What this is

`ai_platform_engineering/llm_wrapper/` is **one shared source, imported directly** — not copied into consumers, not installed as a package. It declares no dependencies of its own, which is what lets it be shared without coupling: each consuming package pins the provider integrations it ships. A package that declared them would pin one `langchain-aws` / `boto3` / `langchain-anthropic` version for everyone, the coupling this feature exists to remove.

Separate modules, so a consumer can take a subset:

| Module | Contains | Who needs it |
|---|---|---|
| `providers.py` | public provider string → (`init_chat_model` provider, model-id env var) | every consumer |
| `bedrock_family.py` | `resolve_bedrock_client()` → `anthropic` / `converse` / `legacy` | anything selecting prompt-caching middleware or shaping attachments |
| `reasoning.py` | reasoning effort → provider-native thinking config | every consumer that exposes reasoning effort |
| `build.py` | `build_chat_model()` over `init_chat_model` | consumers that construct models with credentials present |

A sandboxed harness worker is expected to take the dependency-free modules and not `build.py` — it holds no raw provider credentials.

## Adding a provider

Two lines. Say you want DeepSeek:

```python
# ai_platform_engineering/llm_wrapper/providers.py
_PROVIDERS = {
    ...
    "deepseek": ("deepseek", "DEEPSEEK_MODEL_NAME"),
}
```

```toml
# the consuming package's pyproject.toml — only the images that need it
"langchain-deepseek==<pin>",
```

Then add the string to the UI provider list. That is the whole change: `init_chat_model` already knows 28 provider strings, so nothing in `build.py` changes.

**Do not** add a provider to `llm_wrapper` and to the root `pyproject.toml` at the same time. The point of this structure is that each image installs only the integrations it uses.

## Using the gateway provider

For any OpenAI-compatible endpoint — a self-hosted LiteLLM Proxy, Bifrost, Portkey, or an egress proxy in front of a sandbox. **This is also how LiteLLM is reached**; there is no in-process LiteLLM provider:

```bash
export LLM_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://gateway.internal:4000/v1
export OPENAI_COMPATIBLE_API_KEY=<key>
export OPENAI_COMPATIBLE_MODEL=<model the gateway exposes>
```

This is implemented as `ChatOpenAI(base_url=...)` and adds no dependency. It is required for sandboxed harness workers, which cannot hold raw provider credentials — see research D7.

## How an image gets it

Imported directly as `ai_platform_engineering.llm_wrapper.<module>`. The
consuming image must build with the **repository root** as its Docker context
and copy the directory in:

```dockerfile
COPY ai_platform_engineering/__init__.py /app/shared/ai_platform_engineering/__init__.py
COPY ai_platform_engineering/llm_wrapper/ /app/shared/ai_platform_engineering/llm_wrapper/
ENV PYTHONPATH="/app/shared"
```

`/app/shared` rather than `/app`: `/app/dynamic_agents` holds `src/`, `tests/`
and `pyproject.toml` but no `__init__.py`, so `/app` on `PYTHONPATH` would make
it a namespace package shadowing the real `dynamic_agents` in the venv.

A component-scoped build context cannot see this directory — that constraint is
why other shared modules here were duplicated into component trees. The CI
workflow for a consuming image must pass `context: .`.

## What not to do

- **Do not make this a package, a uv workspace member, or copy it into consumers.** See research D5.
- **Do not import it into `harness_engine`.** That control plane has no LangChain by design, and its `ModelPolicy` already owns the portable model layer. See research D6.
- **Do not add a multi-provider routing library** to any agent-serving process (FR-024). Breadth comes from provider strings and the gateway.
- **Do not change the public provider strings** (`aws-bedrock`, `azure-openai`, `anthropic-claude`, `google-gemini`, `gcp-vertexai`, `openai`, `groq`). They are persisted in agent records and rendered in the admin UI (FR-006).

## Verifying a change

```bash
PYTHONPATH=.:ai_platform_engineering/dynamic_agents/src \
  uv run pytest ai_platform_engineering/llm_wrapper/tests \
                ai_platform_engineering/dynamic_agents/tests -q
uv run ruff check ai_platform_engineering/llm_wrapper
```

The dependency-free modules must also import without LangChain — that property
is what lets a sandboxed worker take a subset:

```bash
python -m pytest ai_platform_engineering/llm_wrapper/tests/test_providers.py \
                 ai_platform_engineering/llm_wrapper/tests/test_bedrock_family.py -q
```

For anything touching model construction, also confirm the US3 capabilities by hand on at least one Bedrock and one non-Bedrock provider: cache-read tokens still reported on turn 2, per-runtime memory unchanged with `LLM_CLIENT_SHARING=true`, a long tool call not hitting a read timeout, and a text-family attachment accepted.
