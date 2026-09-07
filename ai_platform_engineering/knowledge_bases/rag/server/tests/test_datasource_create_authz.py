"""Tests for explicit data-source author authorization in the RAG server.

Covers ``authorize_datasource_create`` and ``write_datasource_ownership``
(spec 2026-06-03-explicit-ingest-capability). Creating a NEW data source is the
explicit org-level ``can_ingest`` capability plus optional owning-team
membership — NOT per-KB ingest. Source management and indexed-data search are
projected independently: an owner team manages the source, while Search teams
can query the resulting knowledge base.

assisted-by Cursor claude-opus-4.8
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from common.models.rbac import Role, UserContext
from server import rbac, restapi


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
    # Configure a PDP for every test here.
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setenv("CAIPE_ORG_KEY", "caipe")

    async def _no_org_admin(_user: UserContext) -> bool:
        return False

    async def _deny_object(
        _user: UserContext,
        _relation: str,
        _object_type: str,
        _object_id: str,
    ) -> bool:
        return False

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _no_org_admin, raising=False)
    monkeypatch.setattr(rbac, "_openfga_check_object", _deny_object, raising=False)


# ---------------------------------------------------------------------------
# authorize_datasource_create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_does_not_trust_coarse_admin_without_openfga_grant() -> None:
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_datasource_create(None, _user(role=Role.ADMIN), "src_new", None)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_create_allows_org_admin_without_owner_team(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _is_admin(_user: UserContext) -> bool:
        return True

    monkeypatch.setattr(rbac, "_openfga_check_org_admin", _is_admin, raising=False)
    # Org admin may create a personal source (no owning team).
    await rbac.authorize_datasource_create(None, _user(), "src_new", None)


@pytest.mark.asyncio
async def test_create_rejects_personal_without_org_author_capability() -> None:
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_datasource_create(None, _user(), "src_new", None)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_create_allows_personal_with_org_author_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _can_author(_user, relation, object_type, object_id):
        return (
            relation == "can_ingest"
            and object_type == "organization"
            and object_id == "caipe"
        )

    monkeypatch.setattr(rbac, "_openfga_check_object", _can_author, raising=False)
    await rbac.authorize_datasource_create(None, _user(), "src_new", None)


@pytest.mark.asyncio
async def test_personal_create_uses_configured_organization_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAIPE_ORG_KEY", "example-org")

    async def _can_author(_user, relation, object_type, object_id):
        return (
            relation == "can_ingest"
            and object_type == "organization"
            and object_id == "example-org"
        )

    monkeypatch.setattr(rbac, "_openfga_check_object", _can_author, raising=False)
    await rbac.authorize_datasource_create(None, _user(), "src_new", None)


@pytest.mark.asyncio
async def test_create_allows_member_of_opted_in_team(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _is_member(_user, relation, object_type, object_id):
        return relation == "can_use" and object_type == "team" and object_id == "team-a"

    async def _opted_in(user, relation, object_ref):
        return user == "team:team-a#member" and relation == "ingestor"

    monkeypatch.setattr(rbac, "_openfga_check_object", _is_member, raising=False)
    monkeypatch.setattr(rbac, "_openfga_read_tuple_exists", _opted_in, raising=False)
    await rbac.authorize_datasource_create(None, _user(), "src_new", "team-a")


@pytest.mark.asyncio
async def test_create_rejects_member_of_non_opted_in_team(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _is_member(_user, relation, object_type, object_id):
        return True  # member of the team...

    async def _not_opted_in(_user, _relation, _object_ref):
        return False  # ...but team lacks the org capability

    monkeypatch.setattr(rbac, "_openfga_check_object", _is_member, raising=False)
    monkeypatch.setattr(rbac, "_openfga_read_tuple_exists", _not_opted_in, raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_datasource_create(None, _user(), "src_new", "team-a")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_create_rejects_non_member_even_if_team_opted_in(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _not_member(_user, _relation, _object_type, _object_id):
        return False

    async def _opted_in(_user, _relation, _object_ref):
        return True

    monkeypatch.setattr(rbac, "_openfga_check_object", _not_member, raising=False)
    monkeypatch.setattr(rbac, "_openfga_read_tuple_exists", _opted_in, raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_datasource_create(None, _user(), "src_new", "team-a")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_create_503_when_pdp_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_openfga_http_url", lambda: None, raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.authorize_datasource_create(None, _user(), "src_new", "team-a")
    assert exc.value.status_code == 503


# ---------------------------------------------------------------------------
# write_datasource_ownership
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ownership_team_separates_management_from_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, str]] = []

    async def _capture(writes):
        captured.extend(writes)

    monkeypatch.setattr(rbac, "_openfga_write_tuples", _capture, raising=False)
    await rbac.write_datasource_ownership("src_x", "team-a", _user(subject="alice-sub"))

    assert {"user": "knowledge_base:src_x", "relation": "parent_kb", "object": "data_source:src_x"} in captured
    assert {"user": "team:team-a#member", "relation": "reader", "object": "ingestion_source:src_x"} in captured
    assert {"user": "team:team-a#admin", "relation": "manager", "object": "ingestion_source:src_x"} in captured
    assert not any(
        item["user"].startswith("team:team-a#")
        and item["object"] == "knowledge_base:src_x"
        for item in captured
    )
    assert {"user": "user:alice-sub", "relation": "creator", "object": "knowledge_base:src_x"} in captured
    assert {"user": "user:alice-sub", "relation": "creator", "object": "ingestion_source:src_x"} in captured


@pytest.mark.asyncio
async def test_ownership_personal_writes_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict[str, str]] = []

    async def _capture(writes):
        captured.extend(writes)

    monkeypatch.setattr(rbac, "_openfga_write_tuples", _capture, raising=False)
    await rbac.write_datasource_ownership("src_x", None, _user(subject="alice-sub"))

    assert {"user": "user:alice-sub", "relation": "owner", "object": "knowledge_base:src_x"} in captured
    assert {"user": "user:alice-sub", "relation": "owner", "object": "ingestion_source:src_x"} in captured
    assert {"user": "knowledge_base:src_x", "relation": "parent_kb", "object": "data_source:src_x"} in captured
    # No team tuples for a personal source.
    assert not any(t["user"].startswith("team:") for t in captured)


@pytest.mark.asyncio
async def test_search_teams_receive_query_access_without_management(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, str]] = []

    async def _capture(writes):
        captured.extend(writes)

    monkeypatch.setattr(rbac, "_openfga_write_tuples", _capture, raising=False)
    await rbac.write_datasource_ownership(
        "src_x",
        "owner-team",
        _user(subject="alice-sub"),
        shared_team_slugs=["search-team"],
    )

    kb_object = "knowledge_base:src_x"
    assert {
        "user": "team:search-team#member",
        "relation": "reader",
        "object": kb_object,
    } in captured
    assert not any(
        item["user"] == "team:search-team#member"
        and item["relation"] == "ingestor"
        for item in captured
    )
    assert not any(
        item["user"].startswith("team:search-team#")
        and item["relation"] == "manager"
        for item in captured
    )


@pytest.mark.asyncio
async def test_search_users_receive_query_access_without_management(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, str]] = []

    async def _capture(writes):
        captured.extend(writes)

    monkeypatch.setattr(rbac, "_openfga_write_tuples", _capture, raising=False)
    await rbac.write_datasource_ownership(
        "src_x",
        "owner-team",
        _user(subject="alice-sub"),
        shared_user_subjects=["reader-sub", "reader-sub"],
    )

    kb_object = "knowledge_base:src_x"
    assert {
        "user": "user:reader-sub",
        "relation": "reader",
        "object": kb_object,
    } in captured
    assert not any(
        item["user"] == "user:reader-sub" and item["relation"] == "ingestor"
        for item in captured
    )
    assert not any(
        item["user"] == "user:reader-sub" and item["relation"] == "manager"
        for item in captured
    )


@pytest.mark.asyncio
async def test_owner_team_may_also_receive_explicit_search_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, str]] = []

    async def _capture(writes):
        captured.extend(writes)

    monkeypatch.setattr(rbac, "_openfga_write_tuples", _capture, raising=False)
    await rbac.write_datasource_ownership(
        "src_x",
        "owner-team",
        _user(subject="alice-sub"),
        shared_team_slugs=["owner-team"],
    )

    assert {
        "user": "team:owner-team#member",
        "relation": "reader",
        "object": "knowledge_base:src_x",
    } in captured
    assert not any(
        item["user"] == "team:owner-team#member"
        and item["relation"] == "ingestor"
        and item["object"] == "knowledge_base:src_x"
        for item in captured
    )
    assert {
        "user": "team:owner-team#admin",
        "relation": "manager",
        "object": "ingestion_source:src_x",
    } in captured
    assert not any(
        item["user"] == "team:owner-team#admin"
        and item["relation"] == "manager"
        and item["object"] == "knowledge_base:src_x"
        for item in captured
    )


@pytest.mark.asyncio
async def test_direct_human_create_cannot_bypass_search_publication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write = AsyncMock(return_value=None)
    monkeypatch.setattr(restapi, "write_datasource_ownership", write)
    user = _user(subject="alice-sub")

    with pytest.raises(HTTPException) as exc:
        await restapi.provision_legacy_datasource_ownership(
            "src_x",
            "owner-team",
            ["owner-team", "readers"],
            ["reader-sub"],
            user,
            False,
            None,
        )

    assert exc.value.status_code == 403
    assert "publication workflow" in str(exc.value.detail)
    write.assert_not_awaited()


@pytest.mark.asyncio
async def test_trusted_ingestor_create_can_project_preconfigured_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write = AsyncMock(return_value=None)
    monkeypatch.setattr(restapi, "write_datasource_ownership", write)
    monkeypatch.setattr(restapi, "is_trusted_ingestor_service", lambda _user: True)
    service = UserContext(
        subject="ingestor-sub",
        subject_type="service_account",
        client_id="example-ingestor",
        email="example-ingestor@example.com",
        role=Role.READONLY,
        is_authenticated=True,
        groups=[],
    )

    await restapi.provision_legacy_datasource_ownership(
        "src_x",
        "owner-team",
        ["owner-team", "readers"],
        ["reader-sub"],
        service,
        False,
        None,
    )

    write.assert_awaited_once_with(
        "src_x",
        "owner-team",
        service,
        shared_team_slugs=["owner-team", "readers"],
        shared_user_subjects=["reader-sub"],
    )


@pytest.mark.asyncio
async def test_ownership_write_failure_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(_writes):
        raise RuntimeError("openfga down")

    monkeypatch.setattr(rbac, "_openfga_write_tuples", _boom, raising=False)
    with pytest.raises(HTTPException) as exc:
        await rbac.write_datasource_ownership("src_x", "team-a", _user())
    assert exc.value.status_code == 503
