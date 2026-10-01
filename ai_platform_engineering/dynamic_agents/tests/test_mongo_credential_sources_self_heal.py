# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for read-time ``credential_sources`` self-heal in MongoDBService.

AgentGateway discovery historically persisted ``mcp_servers`` documents
without ``credential_sources``; transform-based gateway routes then emitted an
empty Bearer and the upstream returned 401 (most visibly ``knowledge-base``).
``get_server`` / ``get_servers_by_ids`` fill the built-in sources at read time
for known servers when the stored value is absent/empty, without overwriting an
operator-customized list.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from dynamic_agents.services.mongo import (
    MongoDBService,
    _builtin_credential_sources,
)


def _make_service() -> MongoDBService:
    service = MongoDBService.__new__(MongoDBService)
    service.settings = MagicMock()
    service._db = MagicMock()
    return service


def _mock_servers(service: MongoDBService, *, find_one=None, find=None) -> None:
    collection = MagicMock()
    collection.find_one.return_value = find_one
    collection.find.return_value = find or []
    service._get_servers_collection = MagicMock(return_value=collection)


def _kb_doc(**overrides) -> dict:
    base = {
        "_id": "knowledge-base",
        "name": "Knowledge Base",
        "transport": "http",
        "endpoint": "http://rag-server:9446/mcp",
        "enabled": True,
    }
    base.update(overrides)
    return base


def test_builtin_map_includes_knowledge_base_caller_token():
    """The packaged seed config must declare the KB caller_token source."""
    builtin = _builtin_credential_sources()
    assert "knowledge-base" in builtin
    kb = builtin["knowledge-base"]
    assert kb == [
        {
            "kind": "caller_token",
            "name": "X-CAIPE-Provider-Token",
            "target": "header",
            "fallback_client_credentials": True,
        }
    ]


def test_get_server_injects_builtin_when_missing():
    """A built-in server stored without credential_sources is self-healed."""
    service = _make_service()
    _mock_servers(service, find_one=_kb_doc())

    server = service.get_server("knowledge-base")

    assert server is not None
    assert server.credential_sources is not None
    assert server.credential_sources[0].kind == "caller_token"
    assert server.credential_sources[0].name == "X-CAIPE-Provider-Token"
    assert server.credential_sources[0].fallback_client_credentials is True


def test_get_server_injects_builtin_when_empty_list():
    """An explicit empty credential_sources is treated as missing and healed."""
    service = _make_service()
    _mock_servers(service, find_one=_kb_doc(credential_sources=[]))

    server = service.get_server("knowledge-base")

    assert server.credential_sources
    assert server.credential_sources[0].kind == "caller_token"


def test_get_server_preserves_operator_customized_sources():
    """A non-empty stored list is never overwritten by the built-in default."""
    custom = [
        {"kind": "secret_ref", "name": "Authorization", "target": "header", "secret_ref": "my-secret"}
    ]
    service = _make_service()
    _mock_servers(service, find_one=_kb_doc(credential_sources=custom))

    server = service.get_server("knowledge-base")

    assert len(server.credential_sources) == 1
    assert server.credential_sources[0].kind == "secret_ref"
    assert server.credential_sources[0].secret_ref == "my-secret"


def test_get_server_unknown_id_left_untouched():
    """A non-built-in server without sources stays without sources."""
    service = _make_service()
    _mock_servers(
        service,
        find_one={
            "_id": "custom-thing",
            "name": "Custom",
            "transport": "http",
            "endpoint": "http://example:1234/mcp",
            "enabled": True,
        },
    )

    server = service.get_server("custom-thing")

    assert server is not None
    assert server.credential_sources is None


def test_get_servers_by_ids_injects_per_document():
    """Batch reads self-heal each known built-in independently."""
    service = _make_service()
    _mock_servers(
        service,
        find=[
            _kb_doc(),
            {
                "_id": "argocd",
                "name": "ArgoCD",
                "transport": "http",
                "endpoint": "http://argocd:18002/mcp",
                "enabled": True,
            },
        ],
    )

    servers = {s.id: s for s in service.get_servers_by_ids(["knowledge-base", "argocd"])}

    # knowledge-base is healed; argocd has no built-in sources in config.yaml.
    assert servers["knowledge-base"].credential_sources[0].kind == "caller_token"
    assert servers["argocd"].credential_sources is None
