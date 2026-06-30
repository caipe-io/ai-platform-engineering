# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Tests for DirectoryAgentSource."""

import unittest.mock as mock
import pytest

from ai_platform_engineering.multi_agents.directory_source import (
    DirectoryAgentSource,
    _extract_a2a_card,
    _extract_a2a_url,
)


OASF_RECORD = {
    "cid": "bafybeiabc123",
    "agent": {
        "name": "argocd-agent",
        "description": "ArgoCD deployment agent",
        "modules": [
            {
                "name": "integration/a2a",
                "data": {
                    "card_data": {
                        "name": "argocd-agent",
                        "description": "ArgoCD deployment agent",
                        "supportedInterfaces": [{"url": "http://argocd-agent:8080"}],
                    }
                },
            }
        ],
    },
}

OASF_RECORD_LEGACY_URL = {
    "cid": "bafybeiabc456",
    "agent": {
        "name": "legacy-agent",
        "modules": [
            {
                "name": "integration/a2a",
                "data": {
                    "card_data": {
                        "name": "legacy-agent",
                        "url": "http://legacy-agent:8000",
                    }
                },
            }
        ],
    },
}

OASF_RECORD_NO_A2A = {
    "cid": "bafybeiabc789",
    "agent": {
        "name": "no-a2a-agent",
        "modules": [{"name": "skills/nlp", "data": {}}],
    },
}


def test_extract_a2a_card():
    card = _extract_a2a_card(OASF_RECORD)
    assert card is not None
    assert card["name"] == "argocd-agent"


def test_extract_a2a_card_missing():
    assert _extract_a2a_card(OASF_RECORD_NO_A2A) is None


def test_extract_a2a_url_from_supported_interfaces():
    card = _extract_a2a_card(OASF_RECORD)
    assert _extract_a2a_url(card) == "http://argocd-agent:8080"


def test_extract_a2a_url_legacy_top_level():
    card = _extract_a2a_card(OASF_RECORD_LEGACY_URL)
    assert _extract_a2a_url(card) == "http://legacy-agent:8000"


def test_from_env_disabled(monkeypatch):
    monkeypatch.delenv("DIRECTORY_ENABLED", raising=False)
    assert DirectoryAgentSource.from_env() is None


def test_from_env_enabled(monkeypatch):
    monkeypatch.setenv("DIRECTORY_ENABLED", "true")
    monkeypatch.setenv("DIRECTORY_BASE_URL", "http://dir:9999")
    monkeypatch.setenv("DIRECTORY_LABEL_FILTER", "platform=caipe")
    src = DirectoryAgentSource.from_env()
    assert src is not None
    assert src._base_url == "http://dir:9999"
    assert src._label_filter == "platform=caipe"


def _make_mock_response(payload):
    resp = mock.MagicMock()
    resp.json.return_value = payload
    resp.raise_for_status = mock.MagicMock()
    return resp


def _patch_httpx(payload):
    resp = _make_mock_response(payload)
    client = mock.MagicMock()
    client.get.return_value = resp
    ctx = mock.MagicMock()
    ctx.__enter__ = mock.MagicMock(return_value=client)
    ctx.__exit__ = mock.MagicMock(return_value=False)
    return mock.patch("httpx.Client", return_value=ctx)


def test_fetch_agents_returns_valid_record():
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD]):
        results = src.fetch_agents()
    assert len(results) == 1
    name, url, card = results[0]
    assert name == "argocd-agent"
    assert url == "http://argocd-agent:8080"
    assert card["url"] == "http://argocd-agent:8080"


def test_fetch_agents_skips_record_without_a2a():
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD_NO_A2A, OASF_RECORD]):
        results = src.fetch_agents()
    assert len(results) == 1
    assert results[0][0] == "argocd-agent"


def test_fetch_agents_accepts_agents_wrapper():
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx({"agents": [OASF_RECORD]}):
        results = src.fetch_agents()
    assert len(results) == 1


def test_fetch_agents_returns_empty_on_http_error():
    src = DirectoryAgentSource("http://dir:9999")
    with mock.patch("httpx.Client", side_effect=Exception("connection refused")):
        results = src.fetch_agents()
    assert results == []
