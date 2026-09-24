# llm_wrapper

Canonical source for building LangChain chat models from CAIPE provider
configuration. **Consumers copy these files; they do not install them.**

Spec: [`docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/`](../../docs/docs/specs/2026-09-24-remove-cnoe-agent-utils/)

## Why vendored and not a package

An installed package sets one `langchain-aws` / `boto3` / `langchain-anthropic`
version for every consumer. That coupling is exactly what this code was written
to remove: CAIPE previously could not patch a provider integration without
waiting on an upstream release, and carried a dependency override to escape
GHSA-gr75-jv2w-4656 as a result.

Components legitimately want different versions — `boto3` is pinned differently
in the platform root, in `dynamic_agents`, and in `harness_engine`. Vendoring
lets each consumer pin its own, and lets a consumer take a subset.

## Why not under `utils/`

`utils/pyproject.toml` sets `packages = ["."]`, so that directory builds the
`ai-platform-engineering-utils` wheel and everything under it ships inside it.
Canonical-source-to-vendor must not live in a published package: installing
that wheel would deliver source importing LangChain the package does not
declare, and running these tests in that context would push someone to add
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

## Vendoring

```bash
cp ai_platform_engineering/llm_wrapper/{__init__,providers,bedrock_family,build}.py \
   ai_platform_engineering/<consumer>/src/<consumer>/_vendor/llm_wrapper/
python scripts/check_vendored.py
```

`scripts/check_vendored.py` hashes each vendored copy against canonical and
fails on any difference not declared in `vendored.toml`. **Change canonical and
re-copy in the same PR.** A `resolve_bedrock_client` that classifies a model id
differently in two copies produces different prompt caching and attachment
shaping for the same model — a bug that reproduces in one service and not the
other.

Deliberate divergence is fine when declared:

```toml
[[divergence]]
path = "ai_platform_engineering/<worker>/_vendor/llm_wrapper/build.py"
reason = "Sandboxed worker holds no AWS credentials; shared-client path removed."
```

## Adding a provider

Two lines — one entry in `PROVIDERS`, one dependency in the consuming package's
`pyproject.toml`. `init_chat_model` already knows 28 provider strings, so
`build.py` does not change. Do **not** add the dependency to the platform root:
each image should install only the integrations it uses.

## Compatibility rules

- Do not change the public provider strings (`aws-bedrock`, `azure-openai`,
  `anthropic-claude`, `google-gemini`, `gcp-vertexai`, `openai`, `groq`). They
  are persisted in agent records and rendered in the admin UI (spec FR-006).
- Do not import this into `harness_engine`. That control plane has no LangChain
  by design and its `ModelPolicy` already owns the portable model layer.
- `bedrock_family.py` preserves `cnoe_agent_utils` 0.5.0 behaviour exactly,
  including the `AWS_BEDROCK_CLIENT` override. Changing it changes cost and
  document handling (spec FR-014, A-006).
