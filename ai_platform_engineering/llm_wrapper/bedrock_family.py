"""Resolve which LangChain Bedrock chat client a model id belongs to.

Vendored from ``cnoe_agent_utils.llm_factory.resolve_bedrock_client`` (0.5.0)
with behaviour preserved exactly. The classification selects the prompt-caching
middleware and the attachment block shape, so changing it changes cost and
document handling -- see spec FR-014 and A-006.

This module is canonical source that consumers copy. See README.md.
"""

from __future__ import annotations

import os
from typing import Literal

BedrockFamily = Literal["anthropic", "converse", "legacy"]

#: Operator-facing spellings for ``AWS_BEDROCK_CLIENT``. ``auto`` defers to the
#: model id; every other value forces a family.
_BEDROCK_CLIENT_ALIASES: dict[str, str] = {
    "auto": "auto",
    "anthropic": "anthropic",
    "anthropic-bedrock": "anthropic",
    "chat-anthropic-bedrock": "anthropic",
    "chatanthropicbedrock": "anthropic",
    "converse": "converse",
    "bedrock-converse": "converse",
    "chat-bedrock-converse": "converse",
    "chatbedrockconverse": "converse",
    "legacy": "legacy",
    "bedrock": "legacy",
    "chat-bedrock": "legacy",
    "chatbedrock": "legacy",
}

#: ``BedrockFamily`` -> ``init_chat_model`` provider string.
BEDROCK_FAMILY_TO_PROVIDER: dict[str, str] = {
    "anthropic": "anthropic_bedrock",  # ChatAnthropicBedrock
    "converse": "bedrock_converse",    # ChatBedrockConverse
    "legacy": "bedrock",               # ChatBedrock
}


def resolve_bedrock_client(model_id: str, enable_cache: bool = False) -> BedrockFamily:
    """Return which LangChain Bedrock chat client to use for ``model_id``.

    ``AWS_BEDROCK_CLIENT`` forces a family when set to anything but ``auto``.
    Under ``auto``, any model id containing ``anthropic`` uses the Anthropic
    Messages client; everything else uses Converse when caching is wanted and
    the legacy client otherwise.

    Raises:
        ValueError: ``AWS_BEDROCK_CLIENT`` is set to an unrecognized value.
    """
    configured = os.getenv("AWS_BEDROCK_CLIENT", "auto").strip().lower()
    selected = _BEDROCK_CLIENT_ALIASES.get(configured)
    if selected is None:
        allowed = ", ".join(sorted(_BEDROCK_CLIENT_ALIASES))
        raise ValueError(
            f"Unsupported AWS_BEDROCK_CLIENT={configured!r}. Expected one of: {allowed}."
        )
    if selected != "auto":
        return selected  # type: ignore[return-value]
    if "anthropic" in model_id.lower():
        return "anthropic"
    return "converse" if enable_cache else "legacy"


def uses_anthropic_bedrock_client(model_id: str) -> bool:
    """Return whether ``model_id`` resolves to the Anthropic Messages client."""
    return resolve_bedrock_client(model_id) == "anthropic"
