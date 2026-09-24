"""LLM construction helpers for Dynamic Agents."""

from __future__ import annotations

from typing import Any

from ai_platform_engineering.llm_wrapper.build import build_chat_model
from botocore.config import Config as BotocoreConfig


def _provider_supports_botocore_config(provider: str) -> bool:
    """Return whether the model constructor should receive a Botocore ``config`` kwarg."""
    normalized = provider.lower().replace("_", "-")
    return normalized in {"aws-bedrock", "bedrock"}


def get_configured_llm(model_id: str, model_provider: str) -> Any:
    """Instantiate an LLM with provider-specific runtime options.

    Dynamic Agents use extended Botocore timeouts for Bedrock so long-running
    tool calls do not hit AWS read timeouts. That ``config`` kwarg is not valid
    for OpenAI-compatible providers such as LiteLLM, so only attach it for the
    Bedrock provider.
    """
    kwargs: dict[str, Any] = {}
    if _provider_supports_botocore_config(model_provider):
        kwargs["config"] = BotocoreConfig(read_timeout=300, connect_timeout=60)

    return build_chat_model(model_provider, model_id, **kwargs)
