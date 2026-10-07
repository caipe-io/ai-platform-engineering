"""Endpoint-wiring tests for the custom MCP tool routes (spec
2026-06-03-unified-shareable-resource-rbac, US6).

``test_mcp_tool_authz.py`` covers the ``authorize_mcp_tool_create`` /
``authorize_mcp_tool_manage`` helpers directly. This module pins the FastAPI
*wiring* of ``POST/PUT/DELETE /v1/mcp/custom-tools``:

  - the endpoints call the OpenFGA-based authorize helper and surface its
    ``403`` (vs ``2xx`` when it allows);
  - a denied authorize never reaches the storage write (fail-closed);
  - the endpoints are protected by ``require_authenticated_user`` (``401`` with
    no token);
  - a coarse role does not replace an explicit OpenFGA grant.

The TestClient is used WITHOUT a ``with`` block so the app lifespan (Milvus /
Redis / Neo4j connections) is not triggered.

assisted-by Cursor claude-opus-4-8
"""

from __future__ import annotations

from unittest.mock import ANY, AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from common.models.rag import MCPToolConfig
from common.models.rbac import Role, UserContext
from server import restapi
from server.rbac import get_auth_manager, require_authenticated_user


def _user(role: str = Role.READONLY, subject: str = "alice-sub") -> UserContext:
    return UserContext(
        subject=subject,
        email="alice@example.com",
        role=role,
        is_authenticated=True,
        groups=[],
    )


def _allow():
    async def _ok(*args, **kwargs):
        return None

    return _ok


def _deny(status_code: int = 403, detail: str = "forbidden"):
    async def _raise(*args, **kwargs):
        raise HTTPException(status_code=status_code, detail=detail)

    return _raise


def _tool_body(tool_id: str = "custom-search", **extra) -> dict:
    return MCPToolConfig(tool_id=tool_id, **extra).model_dump(mode="json")


@pytest.fixture
def client() -> TestClient:
    return TestClient(restapi.app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _wire(monkeypatch: pytest.MonkeyPatch):
    """Default wiring: an authenticated READONLY user, async metadata storage,
    and a no-op tool reload. Each test sets the authorize_* behavior it needs."""
    # NOTE: keep the lambda — a bare `_user` would expose its (role, subject)
    # default params to FastAPI as query parameters. The lambda hides the
    # signature so the override is always called with zero args.
    restapi.app.dependency_overrides[require_authenticated_user] = lambda: _user()

    storage = AsyncMock()
    storage.get_mcp_tool_config = AsyncMock(return_value=None)
    storage.store_mcp_tool_config = AsyncMock(return_value=None)
    storage.delete_mcp_tool_config = AsyncMock(return_value=None)
    monkeypatch.setattr(restapi, "metadata_storage", storage, raising=False)

    async def _noop_reload():
        return None

    monkeypatch.setattr(restapi, "_reload_mcp_tools", _noop_reload, raising=False)
    # Ensure the unauthenticated test sees a real 401 (no dev bypass).
    monkeypatch.delenv("CAIPE_UNSAFE_RBAC_BYPASS", raising=False)

    yield storage

    restapi.app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# POST /v1/mcp/custom-tools (create)
# ---------------------------------------------------------------------------


def test_create_denied_returns_403_and_does_not_store(client, _wire, monkeypatch):
    storage = _wire
    monkeypatch.setattr(restapi, "authorize_mcp_tool_create", _deny(), raising=False)

    res = client.post("/v1/mcp/custom-tools", json=_tool_body(owner_team_slug="platform"))

    assert res.status_code == 403
    storage.store_mcp_tool_config.assert_not_awaited()


def test_create_allowed_returns_201_and_stores(client, _wire, monkeypatch):
    storage = _wire
    monkeypatch.setattr(restapi, "authorize_mcp_tool_create", _allow(), raising=False)

    res = client.post("/v1/mcp/custom-tools", json=_tool_body(owner_team_slug="platform"))

    assert res.status_code == 201
    storage.store_mcp_tool_config.assert_awaited_once()


def test_create_passes_owner_team_slug_to_authorize(client, _wire, monkeypatch):
    spy = AsyncMock(return_value=None)
    monkeypatch.setattr(restapi, "authorize_mcp_tool_create", spy, raising=False)

    client.post("/v1/mcp/custom-tools", json=_tool_body(owner_team_slug="platform"))

    spy.assert_awaited_once_with(ANY, "platform")


def test_create_does_not_trust_coarse_admin_via_real_helper(client, monkeypatch):
    restapi.app.dependency_overrides[require_authenticated_user] = lambda: _user(role=Role.ADMIN)
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")

    async def _deny_org_admin(_user):
        return False

    async def _deny_team(_user, _relation, _object_type, _object_id):
        return False

    monkeypatch.setattr("server.rbac._openfga_check_org_admin", _deny_org_admin)
    monkeypatch.setattr("server.rbac._openfga_check_object", _deny_team)

    res = client.post("/v1/mcp/custom-tools", json=_tool_body(owner_team_slug="platform"))

    assert res.status_code == 403


# ---------------------------------------------------------------------------
# PUT /v1/mcp/custom-tools/{tool_id} (update)
# ---------------------------------------------------------------------------


def test_update_denied_returns_403(client, _wire, monkeypatch):
    storage = _wire
    storage.get_mcp_tool_config = AsyncMock(
        return_value=MCPToolConfig(tool_id="custom-search", created_at=111)
    )
    monkeypatch.setattr(restapi, "authorize_mcp_tool_manage", _deny(), raising=False)

    res = client.put("/v1/mcp/custom-tools/custom-search", json=_tool_body())

    assert res.status_code == 403
    storage.store_mcp_tool_config.assert_not_awaited()


def test_update_allowed_returns_200_and_stores(client, _wire, monkeypatch):
    storage = _wire
    storage.get_mcp_tool_config = AsyncMock(
        return_value=MCPToolConfig(tool_id="custom-search", created_at=111)
    )
    monkeypatch.setattr(restapi, "authorize_mcp_tool_manage", _allow(), raising=False)

    res = client.put("/v1/mcp/custom-tools/custom-search", json=_tool_body())

    assert res.status_code == 200
    storage.store_mcp_tool_config.assert_awaited_once()


def test_update_passes_tool_id_to_authorize(client, _wire, monkeypatch):
    storage = _wire
    storage.get_mcp_tool_config = AsyncMock(
        return_value=MCPToolConfig(tool_id="custom-search", created_at=111)
    )
    spy = AsyncMock(return_value=None)
    monkeypatch.setattr(restapi, "authorize_mcp_tool_manage", spy, raising=False)

    client.put("/v1/mcp/custom-tools/custom-search", json=_tool_body())

    spy.assert_awaited_once_with(ANY, "custom-search")


# ---------------------------------------------------------------------------
# DELETE /v1/mcp/custom-tools/{tool_id}
# ---------------------------------------------------------------------------


def test_delete_denied_returns_403_and_does_not_delete(client, _wire, monkeypatch):
    storage = _wire
    storage.get_mcp_tool_config = AsyncMock(
        return_value=MCPToolConfig(tool_id="custom-search", created_at=111)
    )
    monkeypatch.setattr(restapi, "authorize_mcp_tool_manage", _deny(), raising=False)

    res = client.delete("/v1/mcp/custom-tools/custom-search")

    assert res.status_code == 403
    storage.delete_mcp_tool_config.assert_not_awaited()


def test_delete_allowed_returns_200_and_deletes(client, _wire, monkeypatch):
    storage = _wire
    storage.get_mcp_tool_config = AsyncMock(
        return_value=MCPToolConfig(tool_id="custom-search", created_at=111)
    )
    monkeypatch.setattr(restapi, "authorize_mcp_tool_manage", _allow(), raising=False)

    res = client.delete("/v1/mcp/custom-tools/custom-search")

    assert res.status_code == 200
    storage.delete_mcp_tool_config.assert_awaited_once_with("custom-search")


# ---------------------------------------------------------------------------
# Authentication wiring
# ---------------------------------------------------------------------------


def test_create_requires_authentication(client):
    """With no auth override and no Bearer token, the endpoint is protected by
    require_authenticated_user → 401 (get_auth_manager stubbed so resolution of
    the dependency itself does not touch real OIDC config)."""
    restapi.app.dependency_overrides.pop(require_authenticated_user, None)
    # NOTE: keep the lambda — passing the bare `object` builtin makes FastAPI
    # attempt signature introspection on it; the lambda yields a plain stub.
    restapi.app.dependency_overrides[get_auth_manager] = lambda: object()

    res = client.post("/v1/mcp/custom-tools", json=_tool_body())

    assert res.status_code == 401
