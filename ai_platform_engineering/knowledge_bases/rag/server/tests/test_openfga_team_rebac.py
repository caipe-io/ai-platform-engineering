"""Tests for team-derived OpenFGA authorization in the RAG server."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from common.models.rbac import Role, UserContext
from common.models.server import QueryRequest
from server import rbac


def _user(subject: str = "alice-sub", role: str = Role.READONLY) -> UserContext:
    return UserContext(
        subject=subject,
        email="alice@example.com",
        role=role,
        is_authenticated=True,
        groups=[],
    )


@pytest.fixture(autouse=True)
def _default_no_org_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_check_object(
        user: UserContext,
        relation: str,
        object_type: str,
        object_id: str,
    ) -> bool:
        return False

    monkeypatch.setattr(rbac, "_openfga_check_object", fake_check_object, raising=False)


@pytest.mark.asyncio
async def test_accessible_datasource_ids_are_loaded_from_openfga_list_objects(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str]] = []

    async def fake_list_objects(user: UserContext, relation: str, object_type: str) -> list[str]:
        calls.append((user.subject or "", relation, object_type))
        return ["data_source:kb-alpha", "data_source:kb-beta"]

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_list_objects", fake_list_objects, raising=False)

    result = await rbac.get_accessible_datasource_ids(_user(), "read")

    assert set(result) == {"kb-alpha", "kb-beta"}
    assert calls == [("alice-sub", "can_read", "data_source")]


@pytest.mark.asyncio
async def test_accessible_datasource_ids_come_from_openfga(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_list_objects(user: UserContext, relation: str, object_type: str) -> list[str]:
        return ["data_source:openfga-ds"]

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_list_objects", fake_list_objects, raising=False)
    result = await rbac.get_accessible_datasource_ids(_user(), "read")

    assert set(result) == {"openfga-ds"}


@pytest.mark.asyncio
async def test_accessible_datasource_ids_allow_org_admin_super_grant(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_list_objects(user: UserContext, relation: str, object_type: str) -> list[str]:
        return []

    async def fake_check_object(
        user: UserContext,
        relation: str,
        object_type: str,
        object_id: str,
    ) -> bool:
        return object_type == "organization" and relation == "can_manage" and object_id == "caipe"

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setenv("CAIPE_ORG_KEY", "caipe")
    monkeypatch.setattr(rbac, "_openfga_list_objects", fake_list_objects, raising=False)
    monkeypatch.setattr(rbac, "_openfga_check_object", fake_check_object, raising=False)

    result = await rbac.get_accessible_datasource_ids(_user(), "read")

    assert result == ["*"]


@pytest.mark.asyncio
async def test_datasource_access_check_allows_data_source_relation(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str]] = []

    async def fake_check(user: UserContext, relation: str, object_id: str) -> bool:
        calls.append((user.subject or "", relation, object_id))
        return True

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_check_data_source", fake_check, raising=False)

    await rbac.check_datasource_access(_user(), "kb-alpha", "read")

    assert calls == [("alice-sub", "can_read", "kb-alpha")]


@pytest.mark.asyncio
async def test_kb_access_check_denies_when_openfga_denies(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_check(user: UserContext, relation: str, object_id: str) -> bool:
        return False

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_check_data_source", fake_check, raising=False)

    with pytest.raises(HTTPException) as exc:
        await rbac.check_datasource_access(_user(), "kb-alpha", "read")

    assert exc.value.status_code == 403
    assert exc.value.detail == "Access denied for this datasource"


@pytest.mark.asyncio
async def test_kb_access_check_allows_org_admin_super_grant(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str, str]] = []

    async def fake_check_data_source(user: UserContext, relation: str, object_id: str) -> bool:
        calls.append(("data_source", user.subject or "", relation, object_id))
        return False

    async def fake_check_object(
        user: UserContext,
        relation: str,
        object_type: str,
        object_id: str,
    ) -> bool:
        calls.append((object_type, user.subject or "", relation, object_id))
        return object_type == "organization" and relation == "can_manage" and object_id == "caipe"

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setenv("CAIPE_ORG_KEY", "caipe")
    monkeypatch.setattr(rbac, "_openfga_check_data_source", fake_check_data_source, raising=False)
    monkeypatch.setattr(rbac, "_openfga_check_object", fake_check_object, raising=False)

    await rbac.check_datasource_access(_user(), "new-datasource", "ingest")

    assert calls == [
        ("data_source", "alice-sub", "can_ingest", "new-datasource"),
        ("organization", "alice-sub", "can_manage", "caipe"),
    ]


@pytest.mark.asyncio
async def test_kb_access_check_fails_closed_when_openfga_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_check(user: UserContext, relation: str, object_id: str) -> bool:
        raise RuntimeError("openfga down")

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_check_data_source", fake_check, raising=False)

    with pytest.raises(HTTPException) as exc:
        await rbac.check_datasource_access(_user(), "kb-alpha", "read")

    assert exc.value.status_code == 503
    assert exc.value.detail == "Authorization service is temporarily unavailable"


@pytest.mark.asyncio
async def test_kb_access_check_fails_closed_when_openfga_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENFGA_HTTP", raising=False)

    with pytest.raises(HTTPException) as exc:
        await rbac.check_datasource_access(_user(), "kb-alpha", "read")

    assert exc.value.status_code == 503
    assert exc.value.detail == "Authorization service is temporarily unavailable"


@pytest.mark.asyncio
async def test_source_policy_is_authoritative_for_datasource_management(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(
        rbac,
        "_openfga_object_has_tuples",
        AsyncMock(return_value=True),
    )
    source_check = AsyncMock(return_value=None)
    datasource_check = AsyncMock(return_value=None)
    monkeypatch.setattr(rbac, "check_ingestion_source_access", source_check)
    monkeypatch.setattr(rbac, "check_datasource_access", datasource_check)

    await rbac.check_datasource_management_access(_user(), "primary")

    source_check.assert_awaited_once_with(_user(), "primary", "can_manage")
    datasource_check.assert_not_awaited()


@pytest.mark.asyncio
async def test_legacy_datasource_management_falls_back_when_source_policy_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(
        rbac,
        "_openfga_object_has_tuples",
        AsyncMock(return_value=False),
    )
    source_check = AsyncMock(return_value=None)
    datasource_check = AsyncMock(return_value=None)
    monkeypatch.setattr(rbac, "check_ingestion_source_access", source_check)
    monkeypatch.setattr(rbac, "check_datasource_access", datasource_check)

    await rbac.check_datasource_management_access(_user(), "legacy")

    source_check.assert_not_awaited()
    datasource_check.assert_awaited_once_with(_user(), "legacy", "admin")


@pytest.mark.asyncio
async def test_source_policy_is_authoritative_for_connector_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(
        rbac,
        "_openfga_object_has_tuples",
        AsyncMock(return_value=True),
    )
    source_check = AsyncMock(return_value=None)
    datasource_check = AsyncMock(return_value=None)
    monkeypatch.setattr(rbac, "check_ingestion_source_access", source_check)
    monkeypatch.setattr(rbac, "check_datasource_access", datasource_check)

    await rbac.check_connector_configuration_access(_user(), "primary")

    source_check.assert_awaited_once_with(_user(), "primary", "can_manage")
    datasource_check.assert_not_awaited()


@pytest.mark.asyncio
async def test_legacy_connector_configuration_keeps_ingest_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(
        rbac,
        "_openfga_object_has_tuples",
        AsyncMock(return_value=False),
    )
    source_check = AsyncMock(return_value=None)
    datasource_check = AsyncMock(return_value=None)
    monkeypatch.setattr(rbac, "check_ingestion_source_access", source_check)
    monkeypatch.setattr(rbac, "check_datasource_access", datasource_check)

    await rbac.check_connector_configuration_access(_user(), "legacy")

    source_check.assert_not_awaited()
    datasource_check.assert_awaited_once_with(_user(), "legacy", "ingest")


@pytest.mark.asyncio
async def test_datasource_management_fails_closed_when_source_policy_lookup_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(
        rbac,
        "_openfga_object_has_tuples",
        AsyncMock(side_effect=RuntimeError("unavailable")),
    )

    with pytest.raises(HTTPException) as exc:
        await rbac.check_datasource_management_access(_user(), "primary")

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_client_credentials_require_explicit_openfga_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = UserContext(
        subject="ingestor-sub",
        subject_type="service_account",
        client_id="rag-ingestor",
        email="client:rag-ingestor",
        role=Role.INGESTONLY,
        is_authenticated=True,
    )
    calls: list[tuple[str, str]] = []

    async def fake_check(user: UserContext, relation: str, object_id: str) -> bool:
        calls.append((relation, object_id))
        return False

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_check_data_source", fake_check, raising=False)

    with pytest.raises(HTTPException) as exc:
        await rbac.check_datasource_access(user, "kb-alpha", "admin")

    assert exc.value.status_code == 403
    assert calls == [("can_manage", "kb-alpha")]


@pytest.mark.asyncio
async def test_human_principals_must_pass_openfga(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _user(role=Role.ADMIN)
    calls: list[tuple[str, str, str]] = []

    async def fake_check(user: UserContext, relation: str, object_id: str) -> bool:
        calls.append((user.email, relation, object_id))
        return False

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_check_data_source", fake_check, raising=False)

    with pytest.raises(HTTPException) as exc:
        await rbac.check_datasource_access(user, "kb-alpha", "admin")

    assert exc.value.status_code == 403
    assert calls == [(user.email, "can_manage", "kb-alpha")]


@pytest.mark.asyncio
async def test_query_filter_is_constrained_to_openfga_readable_datasources(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_list_objects(user: UserContext, relation: str, object_type: str) -> list[str]:
        assert relation == "can_read"
        assert object_type == "data_source"
        return ["data_source:kb-alpha"]

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_list_objects", fake_list_objects, raising=False)

    query = QueryRequest(query="deployments", filters=None)
    empty = await rbac.inject_kb_filter(query, _user())

    assert empty is False
    assert query.filters == {"datasource_id": "kb-alpha"}


@pytest.mark.asyncio
async def test_query_filter_rejects_unintersectable_datasource_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_list_objects(user: UserContext, relation: str, object_type: str) -> list[str]:
        return ["data_source:kb-alpha"]

    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")
    monkeypatch.setattr(rbac, "_openfga_list_objects", fake_list_objects, raising=False)
    query = QueryRequest(query="deployments", filters={"datasource_id": True})

    assert await rbac.inject_kb_filter(query, _user()) is True


# ---------------------------------------------------------------------------
# get_datasource_ids_for_collection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_collection_datasource_ids_come_from_parent_collection_read(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str]] = []

    async def fake_read_related(object_type: str, relation: str, user: str) -> list[str]:
        calls.append((object_type, relation, user))
        return ["kb-alpha", "kb-beta"]

    monkeypatch.setattr(rbac, "_openfga_read_related_objects", fake_read_related, raising=False)

    result = await rbac.get_datasource_ids_for_collection("coll-1")

    assert result == ["kb-alpha", "kb-beta"]
    assert calls == [("knowledge_base", "parent_collection", "rag_collection:coll-1")]


@pytest.mark.asyncio
async def test_collection_datasource_ids_empty_for_blank_collection_id() -> None:
    assert await rbac.get_datasource_ids_for_collection("") == []


@pytest.mark.asyncio
async def test_collection_datasource_ids_returns_empty_for_unknown_collection(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_read_related(object_type: str, relation: str, user: str) -> list[str]:
        return []

    monkeypatch.setattr(rbac, "_openfga_read_related_objects", fake_read_related, raising=False)

    assert await rbac.get_datasource_ids_for_collection("coll-unknown") == []


@pytest.mark.asyncio
async def test_collection_datasource_ids_503_on_pdp_error(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_read_related(object_type: str, relation: str, user: str) -> list[str]:
        raise RuntimeError("openfga down")

    monkeypatch.setattr(rbac, "_openfga_read_related_objects", fake_read_related, raising=False)

    with pytest.raises(HTTPException) as exc:
        await rbac.get_datasource_ids_for_collection("coll-1")

    assert exc.value.status_code == 503
