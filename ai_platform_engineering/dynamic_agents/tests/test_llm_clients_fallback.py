"""Tests for `services.llm_clients` env-default fallback (Bug fix: Slack-bot
DM error "Something went wrong - some tools or subagents may have timed out"
caused by the seeded Hello World agent persisting an empty `model.provider`
and empty `model.id`).

The seed-config (`ui/src/lib/seed-config.ts:507`) intentionally writes
`model: {id: "", provider: ""}` and its comment promises the dynamic-agents
backend will substitute the deployment default. These tests pin that
contract and the actionable-error behaviour when no default is configured.
"""

from __future__ import annotations

import importlib
import os
import sys
import types

import pytest


class _PlaceholderFactory:
    def __init__(self, provider):
        self.provider = provider

    def get_llm(self, **kwargs):
        return ("llm", self.provider, kwargs)


sys.modules.setdefault(
    "cnoe_agent_utils",
    types.SimpleNamespace(LLMFactory=_PlaceholderFactory),
)

llm_clients = importlib.import_module("dynamic_agents.services.llm_clients")


@pytest.fixture(autouse=True)
def _disable_share_clients(monkeypatch):
    """SHARE_CLIENTS=True would push us into the bedrock/httpx branches.
    These tests pin the resolver behaviour, not the transport plumbing.
    """
    monkeypatch.setattr(llm_clients, "SHARE_CLIENTS", False)


def test_get_llm_uses_agent_values_when_both_set(monkeypatch):
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, **kwargs):
            captured["kwargs"] = kwargs
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)
    monkeypatch.setenv("LLM_PROVIDER", "openai")

    result = llm_clients.get_llm("aws-bedrock", "claude-sonnet-4-6")

    assert result == "llm"
    assert captured["provider"] == "aws-bedrock"
    assert captured["kwargs"] == {"model": "claude-sonnet-4-6"}


def test_get_llm_falls_back_to_env_provider_when_agent_provider_empty(monkeypatch):
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, **kwargs):
            captured["kwargs"] = kwargs
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)
    monkeypatch.setenv("LLM_PROVIDER", "aws-bedrock")

    result = llm_clients.get_llm("", "claude-sonnet-4-6")

    assert result == "llm"
    assert captured["provider"] == "aws-bedrock"
    assert captured["kwargs"] == {"model": "claude-sonnet-4-6"}


def test_get_llm_skips_model_kwarg_when_agent_model_empty(monkeypatch):
    """Empty `model_id` must NOT be forwarded as `model=""` — LLMFactory
    needs to fall through to its provider-specific env-var lookup
    (e.g. AWS_BEDROCK_MODEL_ID, OPENAI_MODEL_NAME).
    """
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, **kwargs):
            captured["kwargs"] = kwargs
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)
    monkeypatch.setenv("LLM_PROVIDER", "aws-bedrock")

    result = llm_clients.get_llm("aws-bedrock", "")

    assert result == "llm"
    assert captured["provider"] == "aws-bedrock"
    assert "model" not in captured["kwargs"], (
        "Empty model_id leaked into kwargs; LLMFactory would treat it "
        "as an explicit override instead of falling back to env."
    )


def test_get_llm_both_empty_falls_back_to_env(monkeypatch):
    """The exact shape of the seeded Hello World agent."""
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, **kwargs):
            captured["kwargs"] = kwargs
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)
    monkeypatch.setenv("LLM_PROVIDER", "aws-bedrock")

    result = llm_clients.get_llm("", "")

    assert result == "llm"
    assert captured["provider"] == "aws-bedrock"
    assert captured["kwargs"] == {}


def test_get_llm_raises_actionable_error_when_no_provider_anywhere(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)

    with pytest.raises(llm_clients.LLMConfigError) as excinfo:
        llm_clients.get_llm("", "")

    msg = str(excinfo.value)
    assert "LLM provider" in msg
    assert "LLM_PROVIDER" in msg
    assert "Admin UI" in msg


def test_get_llm_wraps_factory_value_error_as_llm_config_error(monkeypatch):
    class _BoomFactory:
        def __init__(self, provider):
            pass

        def get_llm(self, **kwargs):
            raise ValueError("Unsupported provider: 'bogus'")

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _BoomFactory, raising=False)

    with pytest.raises(llm_clients.LLMConfigError) as excinfo:
        llm_clients.get_llm("bogus", "some-model")

    msg = str(excinfo.value)
    assert "provider='bogus'" in msg
    assert "Unsupported provider" in msg


def test_get_llm_whitespace_only_provider_treated_as_empty(monkeypatch):
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, **kwargs):
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)
    monkeypatch.setenv("LLM_PROVIDER", "openai")

    llm_clients.get_llm("   ", "   ")

    assert captured["provider"] == "openai"


def test_resolve_helper_returns_none_for_empty_model_id():
    """Direct contract test for `_resolve_llm_defaults`: empty model
    must become `None`, not `""`, so callers can decide whether to
    include the `model=` kwarg.
    """
    provider, model = llm_clients._resolve_llm_defaults("aws-bedrock", "")
    assert provider == "aws-bedrock"
    assert model is None

    provider, model = llm_clients._resolve_llm_defaults("aws-bedrock", "  ")
    assert model is None

    provider, model = llm_clients._resolve_llm_defaults("aws-bedrock", "claude-x")
    assert model == "claude-x"


def test_get_llm_passes_supported_reasoning_effort(monkeypatch):
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, reasoning_effort=None, **kwargs):
            if reasoning_effort is not None:
                kwargs["reasoning_effort"] = reasoning_effort
            captured["kwargs"] = kwargs
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)

    result = llm_clients.get_llm("openai", "gpt-5.5", "max")

    assert result == "llm"
    assert captured["kwargs"] == {"model": "gpt-5.5", "reasoning_effort": "max"}


def test_get_llm_uses_supported_api_version_for_azure_gpt5_reasoning(monkeypatch):
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, **kwargs):
            captured["kwargs"] = kwargs
            captured["responses"] = os.environ["AZURE_OPENAI_USE_RESPONSES"]
            captured["api_version"] = os.environ["AZURE_OPENAI_API_VERSION"]
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)
    monkeypatch.setenv("AZURE_OPENAI_USE_RESPONSES", "false")
    monkeypatch.setenv("AZURE_OPENAI_API_VERSION", "2024-11-01-preview")

    result = llm_clients.get_llm("azure-openai", "gpt-5.5", "high")

    assert result == "llm"
    assert captured["responses"] == "true"
    assert captured["api_version"] == "2025-03-01-preview"
    assert captured["kwargs"] == {"model": "gpt-5.5", "reasoning_effort": "high"}
    assert os.environ["AZURE_OPENAI_USE_RESPONSES"] == "false"
    assert os.environ["AZURE_OPENAI_API_VERSION"] == "2024-11-01-preview"


def test_get_llm_uses_valid_temperature_for_bedrock_reasoning(monkeypatch):
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, **kwargs):
            captured["kwargs"] = kwargs
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)

    result = llm_clients.get_llm(
        "aws-bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0", "medium"
    )

    assert result == "llm"
    assert captured["kwargs"] == {
        "model": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "reasoning_effort": "medium",
        "temperature": 1.0,
    }


def test_get_llm_omits_effort_for_unsupported_model(monkeypatch):
    captured = {}

    class _Factory:
        def __init__(self, provider):
            captured["provider"] = provider

        def get_llm(self, **kwargs):
            captured["kwargs"] = kwargs
            return "llm"

    monkeypatch.setattr("cnoe_agent_utils.LLMFactory", _Factory, raising=False)

    llm_clients.get_llm("openai", "gpt-4.1", "medium")

    assert captured["kwargs"] == {"model": "gpt-4.1"}
