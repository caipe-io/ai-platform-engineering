# Quickstart: the vendored LLM wrapper

**Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

## What this is

`ai_platform_engineering/llm_wrapper/` is **canonical source that consumers copy**, not a package they install. Copying is deliberate: an installed package would pin one `langchain-aws` / `boto3` / `langchain-anthropic` version for every consumer, which is the coupling this feature exists to remove.

Three modules, so a consumer can take a subset:

| Module | Contains | Who needs it |
|---|---|---|
| `providers.py` | public provider string → (`init_chat_model` provider, model-id env var) | every consumer |
| `bedrock_family.py` | `resolve_bedrock_client()` → `anthropic` / `converse` / `legacy` | anything selecting prompt-caching middleware or shaping attachments |
| `build.py` | `build_chat_model()` over `init_chat_model` | consumers that construct models with credentials present |

A sandboxed harness worker is expected to take the first two and not the third — it holds no raw provider credentials.

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

## Vendoring into a consumer

```bash
# from repo root
cp ai_platform_engineering/llm_wrapper/{providers,bedrock_family,build}.py \
   ai_platform_engineering/<consumer>/src/<consumer>/_vendor/llm_wrapper/
python scripts/check_vendored.py            # must pass before commit
```

`scripts/check_vendored.py` hashes every vendored copy against canonical. It fails on any difference unless the path is listed as a deliberate divergence in `vendored.toml`, with a reason.

**When you change canonical**, re-copy into every consumer in the same PR. The gate will fail otherwise, which is the intended behaviour: a `resolve_bedrock_client` that classifies a model id differently in two copies produces different prompt-caching and attachment shaping for the same model — a bug that reproduces in one service and not the other.

**When a consumer must diverge**, record it explicitly:

```toml
# vendored.toml
[[divergence]]
path = "ai_platform_engineering/<worker>/_vendor/llm_wrapper/build.py"
reason = "Sandboxed worker holds no AWS credentials; LLM_CLIENT_SHARING path removed."
```

Silent divergence is the failure mode. Declared divergence is fine.

## What not to do

- **Do not make this a package or a uv workspace member.** See research D5.
- **Do not import it into `harness_engine`.** That control plane has no LangChain by design, and its `ModelPolicy` already owns the portable model layer. See research D6.
- **Do not add a multi-provider routing library** to any agent-serving process (FR-024). Breadth comes from provider strings and the gateway.
- **Do not change the public provider strings** (`aws-bedrock`, `azure-openai`, `anthropic-claude`, `google-gemini`, `gcp-vertexai`, `openai`, `groq`). They are persisted in agent records and rendered in the admin UI (FR-006).

## Verifying a change

```bash
uv run pytest ai_platform_engineering/llm_wrapper/tests -q
uv run pytest ai_platform_engineering/dynamic_agents/tests -q
python scripts/check_vendored.py
uv run ruff check ai_platform_engineering/utils/llm_wrapper
```

For anything touching model construction, also confirm the US3 capabilities by hand on at least one Bedrock and one non-Bedrock provider: cache-read tokens still reported on turn 2, per-runtime memory unchanged with `LLM_CLIENT_SHARING=true`, a long tool call not hitting a read timeout, and a text-family attachment accepted.
