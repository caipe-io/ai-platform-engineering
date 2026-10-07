"""Tests for OpenFGA-based custom MCP tool authorization in the RAG server.

Covers `authorize_mcp_tool_create` / `authorize_mcp_tool_manage`, which replaced
the legacy coarse `require_role(Role.ADMIN)` gate on the
POST/PUT/DELETE /v1/mcp/custom-tools endpoints (spec
2026-06-03-unified-shareable-resource-rbac). Human callers are READONLY at the
coarse layer, so authorization is resolved through OpenFGA on the `mcp_tool`
and `team` types.
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
def _openfga_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setenv("CAIPE_ORG_KEY", "caipe")

    async def _no_org_admin(user: UserContext) -> bool:
        return False

    async def _deny_all(user: UserContext, relation: str, object_type: str, object_id: str) -> bool:
        return False

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _no_org_admin, raising=False)
    monkeypatch.setattr(rbac, "_openfga_check_object", _deny_all, raising=False)


# ---------------------------------------------------------------------------
# authorize_mcp_tool_manage (update / delete)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manage_does_not_trust_coarse_admin_role() -> None:
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_manage(_user(role=Role.ADMIN), "tool-x")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_manage_allows_org_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _org_admin(user: UserContext) -> bool:
        return True

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _org_admin, raising=False)

    await rbac.authorize_mcp_tool_manage(_user(), "tool-x")


@pytest.mark.asyncio
async def test_manage_allows_can_manage(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str]] = []

    async def _check(user: UserContext, relation: str, object_type: str, object_id: str) -> bool:
        calls.append((relation, object_type, object_id))
        return relation == "can_manage" and object_type == "mcp_tool" and object_id == "tool-x"

    monkeypatch.setattr(rbac, "_openfga_check_object", _check, raising=False)

    await rbac.authorize_mcp_tool_manage(_user(), "tool-x")
    assert ("can_manage", "mcp_tool", "tool-x") in calls


@pytest.mark.asyncio
async def test_manage_denies_when_not_authorized() -> None:
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_manage(_user(), "tool-x")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_manage_fails_closed_on_pdp_error(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(user: UserContext) -> bool:
        raise RuntimeError("openfga down")

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _boom, raising=False)

    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_manage(_user(), "tool-x")
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_manage_fails_closed_when_pdp_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENFGA_HTTP", raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_manage(_user(), "tool-x")
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_manage_fails_closed_without_stable_subject() -> None:
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_manage(_user(subject=None), "tool-x")
    assert exc.value.status_code == 503


# ---------------------------------------------------------------------------
# authorize_mcp_tool_create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_does_not_trust_coarse_admin_role() -> None:
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_create(_user(role=Role.ADMIN), "primary")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_create_allows_org_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _org_admin(user: UserContext) -> bool:
        return True

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _org_admin, raising=False)

    await rbac.authorize_mcp_tool_create(_user(), None)


@pytest.mark.asyncio
async def test_create_allows_owner_team_member(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str]] = []

    async def _check(user: UserContext, relation: str, object_type: str, object_id: str) -> bool:
        calls.append((relation, object_type, object_id))
        return relation == "can_use" and object_type == "team" and object_id == "primary"

    monkeypatch.setattr(rbac, "_openfga_check_object", _check, raising=False)

    await rbac.authorize_mcp_tool_create(_user(), "  primary  ")
    assert ("can_use", "team", "primary") in calls


@pytest.mark.asyncio
async def test_create_denies_non_member() -> None:
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_create(_user(), "primary")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_create_denies_when_no_owner_team_and_not_org_admin() -> None:
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_create(_user(), None)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_create_fails_closed_on_pdp_error(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(user: UserContext) -> bool:
        raise RuntimeError("openfga down")

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _boom, raising=False)

    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_mcp_tool_create(_user(), "primary")
    assert exc.value.status_code == 503
