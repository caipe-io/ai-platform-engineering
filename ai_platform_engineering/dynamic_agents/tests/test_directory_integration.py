# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Tests for DirectoryAgentSource and DirectorySyncService."""

import asyncio
import unittest.mock as mock
from datetime import datetime, timezone

import pytest

from dynamic_agents.services.directory_source import (
    DirectoryAgentRecord,
    DirectoryAgentSource,
    _extract_a2a_card,
    _extract_a2a_url,
    _extract_capabilities,
    _extract_metadata,
)
from dynamic_agents.services.directory_sync import (
    DIRECTORY_MCP_PREFIX,
    DirectorySyncService,
    _agent_record_to_mcp_document,
)


# =============================================================================
# Test data
# =============================================================================

OASF_RECORD = {
    "cid": "bafybeiabc123",
    "agent": {
        "name": "argocd-agent",
        "description": "ArgoCD deployment agent",
        "version": "1.2.0",
        "labels": {"platform": "caipe", "team": "infra"},
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
            },
            {"name": "skills/kubernetes", "data": {}},
        ],
        "annotations": {"skills": ["gitops", "deployment"]},
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


# =============================================================================
# DirectoryAgentSource tests
# =============================================================================


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


def test_extract_capabilities():
    caps = _extract_capabilities(OASF_RECORD)
    assert "kubernetes" in caps
    assert "gitops" in caps
    assert "deployment" in caps


def test_extract_metadata():
    meta = _extract_metadata(OASF_RECORD)
    assert meta["directory_cid"] == "bafybeiabc123"
    assert meta["directory_labels"] == {"platform": "caipe", "team": "infra"}
    assert meta["description"] == "ArgoCD deployment agent"
    assert meta["version"] == "1.2.0"


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
    return mock.patch("dynamic_agents.services.directory_source.httpx.Client", return_value=ctx)


def test_fetch_agents_returns_valid_record():
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD]):
        results = src.fetch_agents()
    assert len(results) == 1
    record = results[0]
    assert isinstance(record, DirectoryAgentRecord)
    assert record.name == "argocd-agent"
    assert record.url == "http://argocd-agent:8080"
    assert record.a2a_card["url"] == "http://argocd-agent:8080"
    assert "kubernetes" in record.capabilities


def test_fetch_agents_skips_record_without_a2a():
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD_NO_A2A, OASF_RECORD]):
        results = src.fetch_agents()
    assert len(results) == 1
    assert results[0].name == "argocd-agent"


def test_fetch_agents_accepts_agents_wrapper():
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx({"agents": [OASF_RECORD]}):
        results = src.fetch_agents()
    assert len(results) == 1


def test_fetch_agents_returns_empty_on_http_error():
    src = DirectoryAgentSource("http://dir:9999")
    with mock.patch("dynamic_agents.services.directory_source.httpx.Client", side_effect=Exception("connection refused")):
        results = src.fetch_agents()
    assert results == []


def test_fetch_agents_with_label_filter():
    src = DirectoryAgentSource("http://dir:9999", label_filter="platform=caipe")
    resp = _make_mock_response([OASF_RECORD])
    client = mock.MagicMock()
    client.get.return_value = resp
    ctx = mock.MagicMock()
    ctx.__enter__ = mock.MagicMock(return_value=client)
    ctx.__exit__ = mock.MagicMock(return_value=False)
    with mock.patch("dynamic_agents.services.directory_source.httpx.Client", return_value=ctx):
        src.fetch_agents()
    # Verify the label filter was passed as a query param
    client.get.assert_called_once_with(
        "http://dir:9999/v1/agents",
        params={"labels": "platform=caipe"},
    )


# =============================================================================
# DirectorySyncService tests
# =============================================================================


def test_agent_record_to_mcp_document():
    record = DirectoryAgentRecord(
        name="test-agent",
        url="http://test:8080",
        a2a_card={"name": "test-agent", "url": "http://test:8080"},
        capabilities=["kubernetes"],
        metadata={"directory_cid": "bafytest123", "description": "Test agent"},
    )
    doc = _agent_record_to_mcp_document(record)
    assert doc["_id"] == "directory-test-agent"
    assert doc["name"] == "[Directory] test-agent"
    assert doc["transport"] == "http"
    assert doc["endpoint"] == "http://test:8080"
    assert doc["enabled"] is True
    assert doc["source"] == "directory"
    assert doc["directory_cid"] == "bafytest123"
    assert doc["directory_capabilities"] == ["kubernetes"]


def test_sync_service_from_env_disabled(monkeypatch):
    monkeypatch.delenv("DIRECTORY_ENABLED", raising=False)
    assert DirectorySyncService.from_env() is None


def test_sync_service_from_env_enabled(monkeypatch):
    monkeypatch.setenv("DIRECTORY_ENABLED", "true")
    monkeypatch.setenv("DIRECTORY_BASE_URL", "http://dir:9999")
    monkeypatch.setenv("DIRECTORY_SYNC_INTERVAL", "60")
    svc = DirectorySyncService.from_env()
    assert svc is not None
    assert svc._sync_interval == 60.0


@pytest.mark.asyncio
async def test_sync_once_inserts_new_agents():
    """Test that sync_once inserts new records into MongoDB."""
    record = DirectoryAgentRecord(
        name="new-agent",
        url="http://new:8080",
        a2a_card={"name": "new-agent", "url": "http://new:8080"},
        capabilities=["testing"],
        metadata={"directory_cid": "bafynew"},
    )
    source = mock.MagicMock()
    source.fetch_agents.return_value = [record]

    svc = DirectorySyncService(source=source, sync_interval=300)

    # Mock MongoDB
    collection = mock.MagicMock()
    collection.find_one.return_value = None  # new record
    db = mock.MagicMock()
    db.__getitem__ = mock.MagicMock(return_value=collection)

    mongo_svc = mock.MagicMock()
    mongo_svc._db = db

    with mock.patch("dynamic_agents.services.mongo.get_mongo_service", return_value=mongo_svc):
        result = await svc.sync_once()

    assert result["synced"] == 1
    assert result["added"] == 1
    assert result["updated"] == 0
    collection.insert_one.assert_called_once()


@pytest.mark.asyncio
async def test_sync_once_updates_existing_agents():
    """Test that sync_once updates existing records in MongoDB."""
    record = DirectoryAgentRecord(
        name="existing-agent",
        url="http://existing:8080",
        a2a_card={"name": "existing-agent", "url": "http://existing:8080"},
        capabilities=["testing"],
        metadata={"directory_cid": "bafyexisting"},
    )
    source = mock.MagicMock()
    source.fetch_agents.return_value = [record]

    svc = DirectorySyncService(source=source, sync_interval=300)

    # Mock MongoDB - record already exists
    collection = mock.MagicMock()
    collection.find_one.return_value = {"_id": "directory-existing-agent", "endpoint": "http://old:8080"}
    db = mock.MagicMock()
    db.__getitem__ = mock.MagicMock(return_value=collection)

    mongo_svc = mock.MagicMock()
    mongo_svc._db = db

    with mock.patch("dynamic_agents.services.mongo.get_mongo_service", return_value=mongo_svc):
        result = await svc.sync_once()

    assert result["synced"] == 1
    assert result["added"] == 0
    assert result["updated"] == 1
    collection.update_one.assert_called_once()


@pytest.mark.asyncio
async def test_sync_once_handles_empty_discovery():
    """Test that sync handles empty results gracefully."""
    source = mock.MagicMock()
    source.fetch_agents.return_value = []

    svc = DirectorySyncService(source=source, sync_interval=300)
    result = await svc.sync_once()

    assert result["synced"] == 0


@pytest.mark.asyncio
async def test_sync_once_handles_mongo_disconnected():
    """Test that sync handles MongoDB being disconnected."""
    record = DirectoryAgentRecord(
        name="agent",
        url="http://agent:8080",
        a2a_card={"name": "agent", "url": "http://agent:8080"},
        capabilities=[],
        metadata={},
    )
    source = mock.MagicMock()
    source.fetch_agents.return_value = [record]

    svc = DirectorySyncService(source=source, sync_interval=300)

    mongo_svc = mock.MagicMock()
    mongo_svc._db = None

    with mock.patch("dynamic_agents.services.mongo.get_mongo_service", return_value=mongo_svc):
        result = await svc.sync_once()

    assert result["synced"] == 0
    assert result.get("error") == "mongodb_not_connected"


def test_sync_service_status():
    """Test status reporting."""
    source = mock.MagicMock()
    source._base_url = "http://dir:9999"
    svc = DirectorySyncService(source=source, sync_interval=120)

    status = svc.status
    assert status["enabled"] is True
    assert status["running"] is False
    assert status["last_sync"] is None
    assert status["sync_interval_seconds"] == 120
    assert status["base_url"] == "http://dir:9999"
