"""Tests for Dynamic Agents LLM construction helpers."""

import importlib

llm_module = importlib.import_module("dynamic_agents.services.llm")


def test_get_configured_llm_does_not_pass_botocore_config_to_openai(monkeypatch):
    calls = []

    def _build(provider, model=None, **kwargs):
        calls.append((provider, model, kwargs))
        return "llm"

    monkeypatch.setattr(llm_module, "build_chat_model", _build)

    result = llm_module.get_configured_llm("bedrock/global.anthropic.claude-sonnet-4-6", "openai")

    assert result == "llm"
    assert calls == [
        (
            "openai",
            "bedrock/global.anthropic.claude-sonnet-4-6",
            {},
        )
    ]


def test_get_configured_llm_passes_botocore_config_to_aws_bedrock(monkeypatch):
    calls = []

    def _build(provider, model=None, **kwargs):
        calls.append((provider, model, kwargs))
        return "llm"

    def fake_botocore_config(**kwargs):
        return {"botocore_config": kwargs}

    monkeypatch.setattr(llm_module, "build_chat_model", _build)
    monkeypatch.setattr(llm_module, "BotocoreConfig", fake_botocore_config)

    result = llm_module.get_configured_llm("anthropic.claude-sonnet-4-5", "aws-bedrock")

    assert result == "llm"
    assert calls == [
        (
            "aws-bedrock",
            "anthropic.claude-sonnet-4-5",
            {"config": {"botocore_config": {"read_timeout": 300, "connect_timeout": 60}}},
        )
    ]


def test_get_configured_llm_passes_botocore_config_to_bedrock_alias(monkeypatch):
    calls = []

    def _build(provider, model=None, **kwargs):
        calls.append((provider, model, kwargs))
        return "llm"

    def fake_botocore_config(**kwargs):
        return {"botocore_config": kwargs}

    monkeypatch.setattr(llm_module, "build_chat_model", _build)
    monkeypatch.setattr(llm_module, "BotocoreConfig", fake_botocore_config)

    result = llm_module.get_configured_llm("anthropic.claude-sonnet-4-5", "bedrock")

    assert result == "llm"
    assert calls == [
        (
            "bedrock",
            "anthropic.claude-sonnet-4-5",
            {"config": {"botocore_config": {"read_timeout": 300, "connect_timeout": 60}}},
        )
    ]
