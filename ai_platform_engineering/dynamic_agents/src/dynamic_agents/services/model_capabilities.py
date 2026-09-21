# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-model input and reasoning-capability declarations.

Different LLMs accept different input modalities: most current Claude models on
Bedrock read images *and* documents, while some smaller/older models are
text-only ("no-vision"). The runtime needs to know, per model, what a file can
be sent as — otherwise a no-vision model is handed image blocks it cannot
process and errors at the provider instead of degrading cleanly.

This module is the single source of truth for that. Capabilities are a property
of the *model*, not the agent, so many agents sharing one model id all inherit
the same declaration automatically.

Resolution order for ``get_model_capabilities(model_id)``:

1. Exact match in the merged registry.
2. Longest matching *prefix* (so ``global.anthropic.claude-sonnet-4-5-…-v1:0``
   resolves via the ``global.anthropic.claude-`` family entry).
3. A fallback that preserves permissive input handling but does not assume an
   unknown model accepts provider-specific reasoning parameters.

The registry is seeded with the deployed defaults below and can be extended or
overridden at deploy time via the ``MODEL_CAPABILITIES_JSON`` env var (see
``config.Settings.model_capabilities_json``) — this is the values-driven seam a
follow-up ticket uses to declare per-model acceptance from Helm values without a
code change.
"""

from __future__ import annotations

import json
import logging

from pydantic import BaseModel, Field

from dynamic_agents.config import get_settings
from dynamic_agents.models import ReasoningEffort

logger = logging.getLogger("caipe.dynamic_agents.model_capabilities")


class ModelCapabilities(BaseModel):
    """What input modalities and reasoning controls a model accepts.

    Both default to ``True`` so an undeclared or partially-declared model is
    treated as fully input-capable — the choice that preserves existing file
    behavior. Reasoning support defaults to empty because sending an unknown
    provider parameter can fail the entire request.
    """

    accepts_images: bool = Field(
        True, description="Model can ingest image input (png/jpeg/gif/webp)."
    )
    accepts_documents: bool = Field(
        True,
        description="Model can ingest document input (pdf/csv/office/text/…).",
    )
    reasoning_efforts: list[ReasoningEffort] = Field(
        default_factory=list,
        description="Portable reasoning-effort levels accepted by this model family.",
    )


# Permissive fallback for any model id not present in the registry. Shared
# singleton — do not mutate.
_PERMISSIVE = ModelCapabilities(accepts_images=True, accepts_documents=True)


# Seed registry. Keyed by exact model id or a family prefix. Every model we
# deploy today is fully multimodal; more-specific reasoning entries win through
# longest-prefix matching without claiming support for older Claude models.
_ALL_REASONING_EFFORTS: list[ReasoningEffort] = [
    "low",
    "medium",
    "high",
    "max",
]


def _reasoning_capabilities() -> ModelCapabilities:
    return ModelCapabilities(
        accepts_images=True,
        accepts_documents=True,
        reasoning_efforts=_ALL_REASONING_EFFORTS,
    )


DEFAULT_MODEL_CAPABILITIES: dict[str, ModelCapabilities] = {
    # Claude models are multimodal. Configurable thinking begins at 3.7;
    # family-specific entries below override these broad input declarations.
    "global.anthropic.claude-": ModelCapabilities(
        accepts_images=True,
        accepts_documents=True,
    ),
    "anthropic.claude-": ModelCapabilities(
        accepts_images=True,
        accepts_documents=True,
    ),
    "global.anthropic.claude-3-7": _reasoning_capabilities(),
    "anthropic.claude-3-7": _reasoning_capabilities(),
    "global.anthropic.claude-sonnet-4": _reasoning_capabilities(),
    "anthropic.claude-sonnet-4": _reasoning_capabilities(),
    "global.anthropic.claude-opus-4": _reasoning_capabilities(),
    "anthropic.claude-opus-4": _reasoning_capabilities(),
    "global.anthropic.claude-haiku-4": _reasoning_capabilities(),
    "anthropic.claude-haiku-4": _reasoning_capabilities(),
    "global.anthropic.claude-sonnet-5": _reasoning_capabilities(),
    "anthropic.claude-sonnet-5": _reasoning_capabilities(),
    "global.anthropic.claude-opus-5": _reasoning_capabilities(),
    "anthropic.claude-opus-5": _reasoning_capabilities(),
    "global.anthropic.claude-fable-5": _reasoning_capabilities(),
    "anthropic.claude-fable-5": _reasoning_capabilities(),
    "global.anthropic.claude-mythos-5": _reasoning_capabilities(),
    "anthropic.claude-mythos-5": _reasoning_capabilities(),
    "claude-3-7": _reasoning_capabilities(),
    "claude-sonnet-4": _reasoning_capabilities(),
    "claude-opus-4": _reasoning_capabilities(),
    "claude-haiku-4": _reasoning_capabilities(),
    "claude-sonnet-5": _reasoning_capabilities(),
    "claude-opus-5": _reasoning_capabilities(),
    "claude-fable-5": _reasoning_capabilities(),
    "claude-mythos-5": _reasoning_capabilities(),
    # OpenAI / Gemini families deployed for routing — multimodal.
    "gpt-5": _reasoning_capabilities(),
    "gpt-6": _reasoning_capabilities(),
    "o1": _reasoning_capabilities(),
    "o3": _reasoning_capabilities(),
    "o4": _reasoning_capabilities(),
    "gemini-2.5": _reasoning_capabilities(),
    "gemini-3": _reasoning_capabilities(),
    "openai/gpt-oss": _reasoning_capabilities(),
}


def supports_reasoning_effort(model_id: str | None, effort: ReasoningEffort) -> bool:
    """Return whether a model advertises the portable effort level."""
    return effort in get_model_capabilities(model_id).reasoning_efforts


def _parse_override(raw: str) -> dict[str, ModelCapabilities]:
    """Parse the MODEL_CAPABILITIES_JSON env override into the registry shape.

    Malformed JSON or bad entries are logged and skipped rather than raised —
    a broken override must not take the whole service down; it just falls back
    to the seed defaults.
    """
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as exc:
        logger.warning(
            "[model_capabilities] Ignoring MODEL_CAPABILITIES_JSON: not valid JSON (%s)",
            exc,
        )
        return {}
    if not isinstance(data, dict):
        logger.warning(
            "[model_capabilities] Ignoring MODEL_CAPABILITIES_JSON: expected a JSON "
            "object mapping model id -> capabilities, got %s",
            type(data).__name__,
        )
        return {}

    out: dict[str, ModelCapabilities] = {}
    for model_id, caps in data.items():
        try:
            out[model_id] = ModelCapabilities.model_validate(caps)
        except Exception as exc:  # noqa: BLE001 — one bad entry shouldn't sink the rest
            logger.warning(
                "[model_capabilities] Skipping override for %r: %s", model_id, exc
            )
    return out


def _merged_registry() -> dict[str, ModelCapabilities]:
    """Seed defaults with the env override layered on top (override wins)."""
    merged = dict(DEFAULT_MODEL_CAPABILITIES)
    merged.update(_parse_override(get_settings().model_capabilities_json))
    return merged


def get_model_capabilities(model_id: str | None) -> ModelCapabilities:
    """Resolve the capabilities for ``model_id`` (exact → prefix → permissive).

    Never raises and never returns ``None``; an unknown or empty model id
    yields the permissive default so behavior is unchanged for undeclared
    models.
    """
    if not model_id:
        return _PERMISSIVE
    registry = _merged_registry()
    exact = registry.get(model_id)
    if exact is not None:
        return exact
    # Longest matching prefix wins, so a more specific family entry beats a
    # broader one.
    best_key = ""
    for key in registry:
        if model_id.startswith(key) and len(key) > len(best_key):
            best_key = key
    if best_key:
        return registry[best_key]
    return _PERMISSIVE
