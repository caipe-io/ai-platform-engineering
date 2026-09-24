"""Construct a LangChain chat model from CAIPE provider configuration.

Thin wrapper over ``langchain.chat_models.init_chat_model``. It returns
provider-native ``BaseChatModel`` instances, so the agent middleware stack,
provider-specific kwargs, and shared-transport injection all keep working
unchanged.

Single shared source, imported directly. See README.md.
"""

from __future__ import annotations

import os
from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel

from .bedrock_family import BEDROCK_FAMILY_TO_PROVIDER, resolve_bedrock_client
from .providers import (
    OPENAI_COMPATIBLE,
    PROVIDERS,
    is_bedrock,
    model_env_var,
    normalize,
    resolve_model_id,
    supported_providers,
)


class LLMConfigError(ValueError):
    """Raised when provider configuration cannot produce a usable model.

    Distinct from the generic ``ValueError`` that ``init_chat_model`` raises so
    callers can translate it into an actionable message rather than surfacing a
    raw provider error (spec FR-008).
    """


def langchain_provider_for(provider: str, model_id: str | None, enable_cache: bool = False) -> str:
    """Return the ``init_chat_model`` provider string for a CAIPE provider.

    Bedrock resolves per-model to one of three client families; every other
    provider is a fixed mapping.
    """
    canonical = normalize(provider)
    if is_bedrock(canonical):
        family = resolve_bedrock_client(model_id or "", enable_cache=enable_cache)
        return BEDROCK_FAMILY_TO_PROVIDER[family]
    spec = PROVIDERS.get(canonical)
    if spec is None:
        allowed = ", ".join(sorted(supported_providers()))
        raise LLMConfigError(
            f"Unsupported LLM provider {provider!r}. Expected one of: {allowed}."
        )
    return spec.langchain_provider


def build_chat_model(
    provider: str,
    model_id: str | None = None,
    *,
    enable_cache: bool = False,
    **kwargs: Any,
) -> BaseChatModel:
    """Build a chat model for ``provider``.

    Args:
        provider: A CAIPE public provider string, e.g. ``aws-bedrock``.
        model_id: Explicit model id. When ``None`` the provider's environment
            variable is read.
        enable_cache: Whether prompt caching is wanted. Only affects Bedrock,
            where it selects the Converse client over the legacy one.
        **kwargs: Passed through to the underlying chat model -- shared
            transport clients, timeouts, reasoning effort, and so on.

    Returns:
        A provider-native ``BaseChatModel``.

    Raises:
        LLMConfigError: The provider is unknown, no model id is available, or
            the provider rejected the configuration.
    """
    canonical = normalize(provider)
    resolved_model = resolve_model_id(canonical, model_id)
    if not resolved_model:
        raise LLMConfigError(
            f"No model id for provider {provider!r}. Set {model_env_var(canonical)} "
            f"or choose a model for this agent in the admin UI."
        )

    lc_provider = langchain_provider_for(canonical, resolved_model, enable_cache=enable_cache)

    if canonical == OPENAI_COMPATIBLE:
        base_url = os.getenv("OPENAI_COMPATIBLE_BASE_URL")
        if not base_url:
            raise LLMConfigError(
                "OPENAI_COMPATIBLE_BASE_URL is required for the "
                f"{OPENAI_COMPATIBLE!r} provider."
            )
        kwargs.setdefault("base_url", base_url)
        # A sandboxed runtime reaches its egress boundary without a credential;
        # the boundary attaches one. Send a placeholder so the OpenAI client
        # does not refuse to construct.
        kwargs.setdefault("api_key", os.getenv("OPENAI_COMPATIBLE_API_KEY", "not-needed"))

    try:
        return init_chat_model(model=resolved_model, model_provider=lc_provider, **kwargs)
    except ImportError as exc:
        raise LLMConfigError(
            f"Provider {provider!r} needs an integration package that is not installed "
            f"in this image ({exc}). Use an image built with that provider, or pick a "
            f"provider this deployment ships."
        ) from exc
    except ValueError as exc:
        raise LLMConfigError(
            f"Cannot initialize LLM (provider={provider!r}, model={resolved_model!r}): {exc}"
        ) from exc
