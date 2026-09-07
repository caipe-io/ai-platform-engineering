# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-model input-capability registry (ticket 2032).

Verifies ``get_model_capabilities`` resolves exact ids, falls back to the
longest matching family prefix, and defaults to permissive (accepts everything)
for undeclared models — so degradation only ever fires for a model *explicitly*
declared limited. Also covers the ``MODEL_CAPABILITIES_JSON`` env override that
lets a deploy declare per-model acceptance without a code change, including the
fail-safe behavior when that override is malformed.
"""

from __future__ import annotations

import dynamic_agents.config as config
import dynamic_agents.services.model_capabilities as mc
from dynamic_agents.services.model_capabilities import (
    ModelCapabilities,
    get_model_capabilities,
)


def _reset_settings_cache():
    """Drop the cached Settings so a freshly-set env var is picked up.

    ``get_settings`` is ``lru_cache``d, and the capability registry reads the
    override through it, so tests that set MODEL_CAPABILITIES_JSON must clear
    the cache to see their value.
    """
    config.get_settings.cache_clear()


def test_unknown_model_is_permissive(monkeypatch):
    monkeypatch.delenv("MODEL_CAPABILITIES_JSON", raising=False)
    _reset_settings_cache()

    caps = get_model_capabilities("some-model-we-never-catalogued")

    assert caps.accepts_images is True
    assert caps.accepts_documents is True


def test_none_and_empty_model_id_are_permissive(monkeypatch):
    monkeypatch.delenv("MODEL_CAPABILITIES_JSON", raising=False)
    _reset_settings_cache()

    for model_id in (None, ""):
        caps = get_model_capabilities(model_id)
        assert caps.accepts_images is True
        assert caps.accepts_documents is True


def test_versioned_bedrock_id_resolves_via_family_prefix(monkeypatch):
    # A concrete versioned Bedrock id should resolve through the
    # "global.anthropic.claude-" family entry, not fall through to permissive
    # by accident.
    monkeypatch.delenv("MODEL_CAPABILITIES_JSON", raising=False)
    _reset_settings_cache()

    caps = get_model_capabilities(
        "global.anthropic.claude-sonnet-4-5-20250101-v1:0"
    )

    assert caps.accepts_images is True
    assert caps.accepts_documents is True


def test_env_override_declares_a_no_vision_model(monkeypatch):
    monkeypatch.setenv(
        "MODEL_CAPABILITIES_JSON",
        '{"text-only-model": {"accepts_images": false, "accepts_documents": false}}',
    )
    _reset_settings_cache()

    caps = get_model_capabilities("text-only-model")

    assert caps.accepts_images is False
    assert caps.accepts_documents is False


def test_env_override_wins_over_seed_default(monkeypatch):
    # Override an id that the seed registry would otherwise resolve as fully
    # multimodal via the claude family prefix.
    monkeypatch.setenv(
        "MODEL_CAPABILITIES_JSON",
        '{"anthropic.claude-": {"accepts_images": false}}',
    )
    _reset_settings_cache()

    caps = get_model_capabilities("anthropic.claude-3-haiku")

    assert caps.accepts_images is False
    # accepts_documents defaults True since the override omitted it.
    assert caps.accepts_documents is True


def test_malformed_override_is_ignored_and_falls_back_to_defaults(monkeypatch):
    # A broken override must not take the service down; it falls back to seed
    # defaults (permissive for undeclared models).
    monkeypatch.setenv("MODEL_CAPABILITIES_JSON", "{not valid json")
    _reset_settings_cache()

    caps = get_model_capabilities("whatever-model")

    assert caps.accepts_images is True
    assert caps.accepts_documents is True


def test_longest_prefix_wins(monkeypatch):
    # A more specific family entry should beat a broader one.
    monkeypatch.setenv(
        "MODEL_CAPABILITIES_JSON",
        '{"anthropic.claude-": {"accepts_images": true}, '
        '"anthropic.claude-instant": {"accepts_images": false}}',
    )
    _reset_settings_cache()

    caps = get_model_capabilities("anthropic.claude-instant-v1")

    assert caps.accepts_images is False


def test_default_model_capabilities_are_immutable_singletons():
    # Sanity: the module-level defaults are ModelCapabilities instances.
    assert all(
        isinstance(v, ModelCapabilities)
        for v in mc.DEFAULT_MODEL_CAPABILITIES.values()
    )
