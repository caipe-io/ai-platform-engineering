"""Tests for the explicit search-capability authorization in the RAG server.

Covers ``authorize_search`` (spec 2026-06-03-explicit-search-capability). Using
the search data path (``/v1/query`` and ``/v1/mcp/invoke`` for built-in AND
custom tools) is the explicit org-level ``can_search`` capability — layered
ABOVE the narrower per-tool ``mcp_tool#can_call`` and per-datasource
``data_source#can_read`` checks. Holding ``can_call`` alone does NOT permit
search.

assisted-by Cursor claude-opus-4.8
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from common.models.rbac import Role, UserContext
from server import rbac


def _user(subject: str | None = "alice-sub", role: str = Role.READONLY) -> UserContext:
    return UserContext(
        subject=subject,
        email="alice@example.com",
        role=role,
        is_authenticated=True,
        groups=[],
    )


@pytest.fixture(autouse=True)
def _team_scope_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setenv("CAIPE_ORG_KEY", "caipe")

    async def _no_org_admin(_user: UserContext) -> bool:
        return False

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _no_org_admin, raising=False)


@pytest.mark.asyncio
async def test_search_does_not_trust_coarse_admin_role(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _deny(*_a, **_k):
        return False

    monkeypatch.setattr(rbac, "_openfga_check_object", _deny, raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_search(_user(role=Role.ADMIN))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_search_allows_org_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _is_admin(_user: UserContext) -> bool:
        return True

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _is_admin, raising=False)
    await rbac.authorize_search(_user())


@pytest.mark.asyncio
async def test_search_allows_holder_of_can_search(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _check(_user, relation, object_type, object_id):
        return relation == "can_search" and object_type == "organization" and object_id == "caipe"

    monkeypatch.setattr(rbac, "_openfga_check_object", _check, raising=False)
    await rbac.authorize_search(_user())


@pytest.mark.asyncio
async def test_search_rejects_without_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _deny(_user, _relation, _object_type, _object_id):
        return False

    monkeypatch.setattr(rbac, "_openfga_check_object", _deny, raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_search(_user())
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_search_503_when_pdp_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_openfga_http_url", lambda: None, raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_search(_user())
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_search_503_on_pdp_error(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(*_a, **_k):
        raise RuntimeError("openfga down")

    monkeypatch.setattr(rbac, "_openfga_check_object", _boom, raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_search(_user())
    assert exc.value.status_code == 503
