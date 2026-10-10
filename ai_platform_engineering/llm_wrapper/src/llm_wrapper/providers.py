"""Mapping from CAIPE's public provider strings to LangChain provider strings.

CAIPE's provider spellings are a compatibility surface: they are persisted in
agent records and rendered in the admin UI, so they cannot change (spec FR-006).
LangChain's ``init_chat_model`` uses different spellings. This module is the
translation, and the only place that knows both.

Single shared source, imported directly. See README.md.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

#: Provider option for any OpenAI-compatible endpoint: a self-hosted gateway,
#: the egress boundary in front of a sandboxed runtime, or a LiteLLM Proxy.
#: Required rather than optional -- a sandboxed runtime cannot hold raw provider
#: credentials, so this is a precondition for sandboxed execution (spec FR-021).
#:
#: This is also how LiteLLM is reached. There is deliberately no in-process
#: LiteLLM provider: a routing library in an agent process brings its own
#: provider closure (FR-024), and `ChatLiteLLM` cannot use the provider-native
#: paths -- Bedrock and Anthropic prompt caching, shared transport clients --
#: that the native providers give. Behind a proxy, this option reaches the same
#: models with no extra dependency.
OPENAI_COMPATIBLE = "openai-compatible"


@dataclass(frozen=True)
class ProviderSpec:
    """How to reach one provider.

    Attributes:
        langchain_provider: The ``init_chat_model`` ``model_provider`` value.
        model_env: Environment variable holding the model id when the caller
            supplies none.
        model_default: Value to use when ``model_env`` is unset. ``None`` means
            the model id is required and its absence is a configuration error.
    """

    langchain_provider: str
    model_env: str
    model_default: str | None = None


#: CAIPE public provider string -> how to build it.
#:
#: ``aws-bedrock`` is absent by design: it resolves per-model to one of three
#: client families. Use :func:`resolve_provider` rather than reading this map.
PROVIDERS: dict[str, ProviderSpec] = {
    "openai": ProviderSpec("openai", "OPENAI_MODEL_NAME"),
    "azure-openai": ProviderSpec("azure_openai", "AZURE_OPENAI_DEPLOYMENT"),
    "anthropic-claude": ProviderSpec("anthropic", "ANTHROPIC_MODEL_NAME"),
    "google-gemini": ProviderSpec("google_genai", "GOOGLE_GEMINI_MODEL_NAME", "gemini-2.0-flash"),
    "gcp-vertexai": ProviderSpec("google_vertexai", "VERTEXAI_MODEL_NAME"),
    "groq": ProviderSpec("groq", "GROQ_MODEL_NAME"),
    OPENAI_COMPATIBLE: ProviderSpec("openai", "OPENAI_COMPATIBLE_MODEL"),
}

BEDROCK = "aws-bedrock"


def normalize(provider: str) -> str:
    """Normalize a provider spelling to its canonical CAIPE form."""
    return provider.strip().lower().replace("_", "-")


def is_bedrock(provider: str) -> bool:
    """Return whether ``provider`` names AWS Bedrock."""
    return normalize(provider) in {BEDROCK, "bedrock"}


def supported_providers() -> set[str]:
    """Return every CAIPE provider string this wrapper can build."""
    return set(PROVIDERS) | {BEDROCK}


def resolve_model_id(provider: str, model_override: str | None) -> str | None:
    """Resolve the model id for ``provider``.

    An explicit ``model_override`` always wins. Otherwise the provider's
    environment variable is read, falling back to its default if it has one.
    Returns ``None`` when nothing supplies a model id, which callers surface as
    a configuration error naming the variable.
    """
    if model_override:
        return model_override
    if is_bedrock(provider):
        return os.getenv("AWS_BEDROCK_MODEL_ID")
    spec = PROVIDERS.get(normalize(provider))
    if spec is None:
        return None
    return os.getenv(spec.model_env) or spec.model_default


def model_env_var(provider: str) -> str:
    """Return the environment variable that supplies ``provider``'s model id."""
    if is_bedrock(provider):
        return "AWS_BEDROCK_MODEL_ID"
    spec = PROVIDERS.get(normalize(provider))
    return spec.model_env if spec else "<unknown provider>"
