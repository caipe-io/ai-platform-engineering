# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Tests for DirectoryAgentSource and DirectorySyncService."""

import unittest.mock as mock

import pytest

from dynamic_agents.services.directory_source import (
    DirectoryAgentRecord,
    DirectoryAgentSource,
    _extract_a2a_card,
    _extract_a2a_url,
    _extract_capabilities,
    _extract_mcp_endpoint,
    _extract_mcp_module,
    _extract_metadata,
)
from dynamic_agents.services.directory_sync import (
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

OASF_RECORD_MCP = {
    "cid": "bafybei_mcp_001",
    "agent": {
        "name": "github-mcp-server",
        "description": "GitHub MCP server for code management",
        "version": "2.0.0",
        "labels": {"platform": "caipe", "type": "mcp"},
        "modules": [
            {
                "name": "integration/mcp",
                "data": {
                    "name": "github-mcp-server",
                    "description": "GitHub MCP server",
                    "connections": [
                        {
                            "type": "streamable-http",
                            "url": "http://github-mcp:3000/mcp",
                        }
                    ],
                    "tools": [
                        {"name": "list_repos", "description": "List repositories"},
                        {"name": "create_pr", "description": "Create pull request"},
                    ],
                },
            }
        ],
    },
}

OASF_RECORD_MCP_SSE = {
    "cid": "bafybei_mcp_002",
    "agent": {
        "name": "confluence-mcp-server",
        "description": "Confluence MCP server",
        "version": "1.0.0",
        "modules": [
            {
                "name": "integration/mcp",
                "data": {
                    "name": "confluence-mcp",
                    "connections": [
                        {
                            "type": "sse",
                            "url": "http://confluence-mcp:3000/sse",
                        }
                    ],
                    "tools": [{"name": "search_pages"}],
                },
            }
        ],
    },
}

OASF_RECORD_MCP_STDIO_ONLY = {
    "cid": "bafybei_mcp_003",
    "agent": {
        "name": "local-only-server",
        "description": "Only has stdio transport — not remotely callable",
        "modules": [
            {
                "name": "integration/mcp",
                "data": {
                    "name": "local-server",
                    "connections": [
                        {
                            "type": "stdio",
                            "command": "npx",
                            "args": ["-y", "@modelcontextprotocol/server-local"],
                        }
                    ],
                },
            }
        ],
    },
}

OASF_RECORD_BOTH_MCP_AND_A2A = {
    "cid": "bafybei_both_001",
    "agent": {
        "name": "dual-protocol-agent",
        "description": "Agent with both MCP and A2A modules",
        "version": "3.0.0",
        "modules": [
            {
                "name": "integration/mcp",
                "data": {
                    "name": "dual-agent-mcp",
                    "connections": [
                        {"type": "streamable-http", "url": "http://dual:3000/mcp"}
                    ],
                    "tools": [{"name": "do_stuff"}],
                },
            },
            {
                "name": "integration/a2a",
                "data": {
                    "card_data": {
                        "name": "dual-protocol-agent",
                        "url": "http://dual:8080/a2a",
                    }
                },
            },
        ],
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


# =============================================================================
# MCP module extraction tests
# =============================================================================


def test_extract_mcp_module_present():
    mcp = _extract_mcp_module(OASF_RECORD_MCP)
    assert mcp is not None
    assert mcp["name"] == "github-mcp-server"
    assert len(mcp["connections"]) == 1
    assert mcp["connections"][0]["type"] == "streamable-http"


def test_extract_mcp_module_missing():
    assert _extract_mcp_module(OASF_RECORD) is None  # Only has A2A
    assert _extract_mcp_module(OASF_RECORD_NO_A2A) is None


def test_extract_mcp_endpoint_streamable_http():
    mcp = _extract_mcp_module(OASF_RECORD_MCP)
    result = _extract_mcp_endpoint(mcp)
    assert result == ("http://github-mcp:3000/mcp", "streamable-http")


def test_extract_mcp_endpoint_sse():
    mcp = _extract_mcp_module(OASF_RECORD_MCP_SSE)
    result = _extract_mcp_endpoint(mcp)
    assert result == ("http://confluence-mcp:3000/sse", "sse")


def test_extract_mcp_endpoint_stdio_only_returns_none():
    mcp = _extract_mcp_module(OASF_RECORD_MCP_STDIO_ONLY)
    result = _extract_mcp_endpoint(mcp)
    assert result is None  # Not remotely callable


# =============================================================================
# Protocol-aware fetch_agents tests
# =============================================================================


def test_fetch_agents_mcp_record_returns_mcp_protocol():
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD_MCP]):
        results = src.fetch_agents()
    assert len(results) == 1
    record = results[0]
    assert record.is_mcp is True
    assert record.protocol == "mcp"
    assert record.transport == "streamable-http"
    assert record.url == "http://github-mcp:3000/mcp"
    assert record.mcp_tools is not None
    assert len(record.mcp_tools) == 2


def test_fetch_agents_a2a_record_returns_a2a_protocol():
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD]):
        results = src.fetch_agents()
    assert len(results) == 1
    record = results[0]
    assert record.is_mcp is False
    assert record.protocol == "a2a"
    assert record.transport == "http"


def test_fetch_agents_dual_protocol_prefers_mcp():
    """Records with both MCP and A2A modules should be treated as MCP."""
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD_BOTH_MCP_AND_A2A]):
        results = src.fetch_agents()
    assert len(results) == 1
    record = results[0]
    assert record.is_mcp is True
    assert record.url == "http://dual:3000/mcp"  # MCP endpoint, not A2A
    assert record.a2a_card is not None  # A2A card still captured


def test_fetch_agents_stdio_only_falls_through_to_a2a():
    """MCP records with only stdio transport fall back to A2A if available."""
    # Combine stdio-only MCP with A2A module
    record_with_both = {
        "cid": "bafybei_fallback",
        "agent": {
            "name": "fallback-agent",
            "modules": [
                {
                    "name": "integration/mcp",
                    "data": {
                        "name": "fallback",
                        "connections": [
                            {"type": "stdio", "command": "node", "args": ["server.js"]}
                        ],
                    },
                },
                {
                    "name": "integration/a2a",
                    "data": {
                        "card_data": {
                            "name": "fallback-agent",
                            "url": "http://fallback:8080",
                        }
                    },
                },
            ],
        },
    }
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([record_with_both]):
        results = src.fetch_agents()
    assert len(results) == 1
    record = results[0]
    assert record.is_mcp is False  # Fell through to A2A
    assert record.protocol == "a2a"
    assert record.url == "http://fallback:8080"


def test_fetch_agents_stdio_only_no_a2a_skipped():
    """MCP records with only stdio and no A2A module are skipped entirely."""
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD_MCP_STDIO_ONLY]):
        results = src.fetch_agents()
    assert len(results) == 0


def test_fetch_agents_mixed_protocols():
    """Multiple records with different protocols are all discovered."""
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx([OASF_RECORD_MCP, OASF_RECORD, OASF_RECORD_MCP_SSE]):
        results = src.fetch_agents()
    assert len(results) == 3
    mcp_records = [r for r in results if r.is_mcp]
    a2a_records = [r for r in results if not r.is_mcp]
    assert len(mcp_records) == 2
    assert len(a2a_records) == 1


# =============================================================================
# CatalogEntry format tests (real AI Finder response shape)
# =============================================================================


def test_fetch_agents_catalog_entry_inline_oasf():
    """CatalogEntry with inline OASF data should be parsed correctly."""
    catalog_entry = {
        "identifier": "urn:agntcy:github-mcp",
        "display_name": "GitHub MCP Server",
        "media_type": "application/oasf-agent-record+json",
        "data": {
            "name": "github-mcp-server",
            "description": "GitHub MCP server",
            "modules": [
                {
                    "name": "integration/mcp",
                    "id": 202,
                    "data": {
                        "name": "github-mcp",
                        "connections": [{"type": "streamable-http", "url": "http://github:3000/mcp"}],
                        "tools": [{"name": "list_repos"}],
                    },
                }
            ],
        },
    }
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx({"results": [catalog_entry]}):
        results = src.fetch_agents()
    assert len(results) == 1
    record = results[0]
    assert record.name == "github-mcp-server"
    assert record.is_mcp is True
    assert record.url == "http://github:3000/mcp"


def test_fetch_agents_catalog_entry_inline_a2a():
    """CatalogEntry with inline A2A card should be parsed correctly."""
    catalog_entry = {
        "identifier": "urn:agntcy:some-a2a-agent",
        "display_name": "Some A2A Agent",
        "media_type": "application/a2a-agent-card+json",
        "data": {
            "name": "some-a2a-agent",
            "description": "An A2A agent",
            "url": "http://a2a-agent:8080",
        },
    }
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx({"results": [catalog_entry]}):
        results = src.fetch_agents()
    assert len(results) == 1
    record = results[0]
    assert record.name == "Some A2A Agent"
    assert record.is_mcp is False
    assert record.url == "http://a2a-agent:8080"


def test_fetch_agents_catalog_entry_inline_mcp_card():
    """CatalogEntry with inline MCP server card should be parsed correctly."""
    catalog_entry = {
        "identifier": "urn:agntcy:confluence-mcp",
        "display_name": "Confluence MCP",
        "media_type": "application/mcp-server-card+json",
        "data": {
            "name": "confluence-mcp",
            "description": "Confluence MCP server",
            "connections": [{"type": "sse", "url": "http://confluence:3000/sse"}],
            "tools": [{"name": "search_pages"}],
        },
    }
    src = DirectoryAgentSource("http://dir:9999")
    with _patch_httpx({"results": [catalog_entry]}):
        results = src.fetch_agents()
    assert len(results) == 1
    record = results[0]
    assert record.name == "Confluence MCP"
    assert record.is_mcp is True
    assert record.transport == "sse"


def test_fetch_agents_catalog_entry_with_url_reference():
    """CatalogEntry with URL reference calls export endpoint."""
    catalog_entry = {
        "identifier": "bafybeiabc123",
        "display_name": "Remote Agent",
        "media_type": "application/oasf-agent-record+json",
        "url": "https://example.com/agents/remote",
    }
    # The source will try to call /v1/agents/{cid}/export
    src = DirectoryAgentSource("http://dir:9999")

    export_resp = mock.MagicMock()
    export_resp.status_code = 200
    export_resp.json.return_value = {
        "name": "remote-agent",
        "modules": [
            {
                "name": "integration/a2a",
                "data": {"card_data": {"name": "remote-agent", "url": "http://remote:8080"}},
            }
        ],
    }
    export_resp.raise_for_status = mock.MagicMock()

    list_resp = mock.MagicMock()
    list_resp.json.return_value = {"results": [catalog_entry]}
    list_resp.raise_for_status = mock.MagicMock()

    client = mock.MagicMock()
    # First call is listing, second is export
    client.get.side_effect = [list_resp, export_resp]
    ctx = mock.MagicMock()
    ctx.__enter__ = mock.MagicMock(return_value=client)
    ctx.__exit__ = mock.MagicMock(return_value=False)

    with mock.patch("dynamic_agents.services.directory_source.httpx.Client", return_value=ctx):
        results = src.fetch_agents()

    assert len(results) == 1
    assert results[0].name == "remote-agent"
    assert results[0].protocol == "a2a"


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
    with _patch_httpx({"results": [OASF_RECORD]}):
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
        params={"filter": "platform=caipe"},
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
        protocol="a2a",
        transport="http",
    )
    doc = _agent_record_to_mcp_document(record)
    assert doc["_id"] == "directory-test-agent"
    assert doc["name"] == "[Directory] test-agent"
    assert doc["transport"] == "http"
    assert doc["endpoint"] == "http://test:8080"
    assert doc["enabled"] is False
    assert doc["source"] == "directory"
    assert doc["directory_agent"] is True
    assert doc["directory_protocol"] == "a2a"
    assert doc["directory_cid"] == "bafytest123"
    assert doc["directory_capabilities"] == ["kubernetes"]
    assert "directory_a2a_card" in doc


def test_agent_record_to_mcp_document_mcp_protocol():
    """MCP-typed records should be enabled=False (catalog-only) with correct transport mapping."""
    record = DirectoryAgentRecord(
        name="mcp-server",
        url="http://mcp:3000/mcp",
        a2a_card=None,
        capabilities=["code_management"],
        metadata={"directory_cid": "bafymcp001", "description": "MCP server"},
        protocol="mcp",
        transport="streamable-http",
        mcp_tools=[{"name": "list_repos"}, {"name": "create_pr"}],
    )
    doc = _agent_record_to_mcp_document(record)
    assert doc["_id"] == "directory-mcp-server"
    assert doc["enabled"] is False  # All directory records are catalog-only
    assert doc["transport"] == "http"  # streamable-http maps to "http" in CAIPE
    assert doc["directory_protocol"] == "mcp"
    assert "directory_a2a_card" not in doc  # No A2A card
    assert doc["directory_mcp_tools"] == [{"name": "list_repos"}, {"name": "create_pr"}]


def test_agent_record_to_mcp_document_sse_transport():
    """SSE transport should map correctly."""
    record = DirectoryAgentRecord(
        name="sse-server",
        url="http://sse:3000/sse",
        a2a_card=None,
        capabilities=[],
        metadata={},
        protocol="mcp",
        transport="sse",
    )
    doc = _agent_record_to_mcp_document(record)
    assert doc["enabled"] is False  # Catalog-only until admin activates
    assert doc["transport"] == "sse"


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


# =============================================================================
# DirectoryRegisterService tests
# =============================================================================

from dynamic_agents.services.directory_register import (  # noqa: E402
    DirectoryRegisterService,
    _server_to_oasf_record_dict,
)


def test_server_to_oasf_record_basic():
    """Test conversion of MCP server doc to OASF record."""
    server = {
        "_id": "github",
        "name": "GitHub",
        "description": "GitHub repositories and pull requests",
        "transport": "http",
        "endpoint": "http://github-mcp:8082/mcp",
        "enabled": True,
    }
    record = _server_to_oasf_record_dict(server, {"platform": "caipe"})
    assert record["name"] == "GitHub"
    assert record["description"] == "GitHub repositories and pull requests"
    assert record["schema_version"] == "1.0.0"
    assert record["annotations"]["source"] == "caipe"
    assert record["annotations"]["platform"] == "caipe"
    assert record["annotations"]["server_id"] == "github"
    # Check MCP module
    assert len(record["modules"]) == 1
    mcp_mod = record["modules"][0]
    assert mcp_mod["name"] == "integration/mcp"
    assert mcp_mod["id"] == 202
    assert mcp_mod["data"]["connections"][0]["type"] == "streamable-http"
    assert mcp_mod["data"]["connections"][0]["url"] == "http://github-mcp:8082/mcp"


def test_server_to_oasf_record_sse_transport():
    """SSE transport maps correctly."""
    server = {"_id": "sse-server", "name": "SSE", "transport": "sse", "endpoint": "http://sse:3000/sse"}
    record = _server_to_oasf_record_dict(server, {})
    assert record["modules"][0]["data"]["connections"][0]["type"] == "sse"


def test_register_service_from_env_disabled(monkeypatch):
    monkeypatch.delenv("DIRECTORY_SELF_REGISTER", raising=False)
    assert DirectoryRegisterService.from_env() is None


def test_register_service_from_env_enabled(monkeypatch):
    monkeypatch.setenv("DIRECTORY_SELF_REGISTER", "true")
    monkeypatch.setenv("DIRECTORY_SERVER_ADDRESS", "dir:8888")
    monkeypatch.setenv("DIRECTORY_REGISTER_LABELS", "platform=caipe,env=prod")
    monkeypatch.setenv("DIRECTORY_REGISTER_PUBLISH", "false")
    svc = DirectoryRegisterService.from_env()
    assert svc is not None
    assert svc._labels == {"platform": "caipe", "env": "prod"}
    assert svc._server_address == "dir:8888"
    assert svc._publish_to_routing is False


def test_register_servers_skips_directory_source():
    """Servers with source='directory' should not be re-registered."""
    svc = DirectoryRegisterService("dir:8888")
    servers = [
        {"_id": "dir-agent", "enabled": True, "source": "directory", "directory_agent": True},
    ]
    result = svc.register_servers(servers)
    assert result["registered"] == 0
    assert result["skipped"] == 1


def test_register_servers_skips_disabled():
    """Disabled servers should not be registered."""
    svc = DirectoryRegisterService("dir:8888")
    servers = [
        {"_id": "disabled-server", "enabled": False, "source": "config"},
    ]
    result = svc.register_servers(servers)
    assert result["registered"] == 0
    assert result["skipped"] == 1


def test_register_servers_pushes_via_sdk(monkeypatch):
    """Enabled non-directory servers should be pushed via SDK client."""
    svc = DirectoryRegisterService("dir:8888", publish_to_routing=False)

    # Mock the SDK client
    from unittest.mock import MagicMock

    from agntcy.dir.core.v1 import record_pb2

    mock_ref = record_pb2.RecordRef(cid="bafake123cid")
    mock_client = MagicMock()
    mock_client.push.return_value = [mock_ref]
    svc._client = mock_client

    servers = [
        {
            "_id": "github",
            "name": "GitHub",
            "description": "GitHub MCP",
            "transport": "http",
            "endpoint": "http://github:8082/mcp",
            "enabled": True,
            "source": "config",
        },
    ]

    result = svc.register_servers(servers)

    assert result["registered"] == 1
    assert "github" in svc._registered_ids
    assert svc._registered_cids["github"] == "bafake123cid"
    # Verify SDK push was called with a Record
    mock_client.push.assert_called_once()
    pushed_records = mock_client.push.call_args[0][0]
    assert len(pushed_records) == 1
    assert pushed_records[0].data["name"] == "GitHub"


def test_register_servers_publishes_to_routing(monkeypatch):
    """When publish_to_routing=True, records are published for network discovery."""
    svc = DirectoryRegisterService("dir:8888", publish_to_routing=True)

    from unittest.mock import MagicMock

    from agntcy.dir.core.v1 import record_pb2

    mock_ref = record_pb2.RecordRef(cid="bafake456cid")
    mock_client = MagicMock()
    mock_client.push.return_value = [mock_ref]
    svc._client = mock_client

    servers = [
        {
            "_id": "argocd",
            "name": "ArgoCD",
            "description": "ArgoCD MCP",
            "transport": "http",
            "endpoint": "http://argocd:8080/mcp",
            "enabled": True,
            "source": "config",
        },
    ]

    result = svc.register_servers(servers)

    assert result["registered"] == 1
    # Verify publish was called
    mock_client.publish.assert_called_once()


def test_register_servers_skips_already_registered():
    """Servers already registered in this session are skipped."""
    svc = DirectoryRegisterService("dir:8888")
    svc._registered_ids.add("github")

    servers = [
        {"_id": "github", "name": "GitHub", "enabled": True, "source": "config",
         "transport": "http", "endpoint": "http://github:8082/mcp"},
    ]

    result = svc.register_servers(servers)
    assert result["registered"] == 0
    assert result["skipped"] == 1


def test_register_service_status():
    """Test status reporting."""
    svc = DirectoryRegisterService("dir:8888")
    svc._registered_ids = {"github", "argocd"}
    svc._registered_cids = {"github": "bafcid1", "argocd": "bafcid2"}

    status = svc.status
    assert status["enabled"] is True
    assert status["server_address"] == "dir:8888"
    assert status["registered_count"] == 2
    assert "github" in status["registered_ids"]
    assert status["registered_cids"]["github"] == "bafcid1"
