# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-model input-capability declarations.

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
3. A permissive default (**accepts everything**) for anything undeclared, so a
   model we simply haven't catalogued behaves exactly as it does today —
   degradation only ever fires for a model *explicitly* declared limited.

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

logger = logging.getLogger("caipe.dynamic_agents.model_capabilities")


class ModelCapabilities(BaseModel):
    """What input modalities a model accepts.

    Both default to ``True`` so an undeclared or partially-declared model is
    treated as fully capable — the conservative choice that preserves today's
    behavior. Set a flag to ``False`` only to declare a genuine limitation
    (e.g. a text-only model that cannot read images).
    """

    accepts_images: bool = Field(
        True, description="Model can ingest image input (png/jpeg/gif/webp)."
    )
    accepts_documents: bool = Field(
        True,
        description="Model can ingest document input (pdf/csv/office/text/…).",
    )


# Permissive fallback for any model id not present in the registry. Shared
# singleton — do not mutate.
_PERMISSIVE = ModelCapabilities(accepts_images=True, accepts_documents=True)


# Seed registry. Keyed by exact model id or a family prefix. Every model we
# deploy today is fully multimodal; the prefix entries cover the versioned
# Bedrock ids (…-v1:0 suffixes) so new point releases inherit automatically.
DEFAULT_MODEL_CAPABILITIES: dict[str, ModelCapabilities] = {
    # Claude on Bedrock — all current families read images and documents.
    "global.anthropic.claude-": ModelCapabilities(
        accepts_images=True, accepts_documents=True
    ),
    "anthropic.claude-": ModelCapabilities(
        accepts_images=True, accepts_documents=True
    ),
    # OpenAI / Gemini families deployed for routing — multimodal.
    "gpt-5": ModelCapabilities(accepts_images=True, accepts_documents=True),
    "gemini-": ModelCapabilities(accepts_images=True, accepts_documents=True),
}


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
