"""Authorization projection tests for ``GET /v1/datasources``.

Datasource content and ingestion-source configuration are independently
shareable. A query-only grant may expose catalog/status fields, but it must not
also reveal connector configuration. Source readers receive the full record.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from common.models.rag import DataSourceInfo, IngestorInfo
from common.models.rbac import Role, UserContext
from server import restapi


def _user() -> UserContext:
  return UserContext(
    subject="test-user",
    email="test-user@example.com",
    role=Role.READONLY,
    is_authenticated=True,
  )


def _datasource() -> DataSourceInfo:
  return DataSourceInfo(
    datasource_id="primary",
    name="Primary source",
    ingestor_id="jira:default",
    description="Shared catalog description",
    source_type="jira",
    last_updated=123,
    default_chunk_size=5000,
    default_chunk_overlap=500,
    reload_interval=3600,
    creator_subject="creator-sub",
    owner_subject="owner-sub",
    owner_team_slug="owner-team",
    shared_with_teams=["shared-team"],
    metadata={"project_key": "PRIMARY", "jql": "project = PRIMARY"},
  )


def _wire_access(
  monkeypatch: pytest.MonkeyPatch,
  *,
  datasource: dict[str, list[str]],
  source: dict[str, list[str]],
) -> None:
  async def _datasource_access(_user: UserContext, scope: str) -> list[str]:
    return datasource.get(scope, [])

  async def _source_access(_user: UserContext, relation: str) -> list[str]:
    return source.get(relation, [])

  monkeypatch.setattr(restapi, "get_accessible_datasource_ids", _datasource_access)
  monkeypatch.setattr(restapi, "get_accessible_ingestion_source_ids", _source_access)
  monkeypatch.setattr(restapi, "is_trusted_ingestor_service", lambda _user: False)


@pytest.fixture
def storage(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
  value = AsyncMock()
  value.fetch_all_datasource_info.return_value = [_datasource()]
  monkeypatch.setattr(restapi, "metadata_storage", value, raising=False)
  return value


@pytest.mark.asyncio
async def test_query_reader_gets_catalog_but_not_source_configuration(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  _wire_access(
    monkeypatch,
    datasource={"read": ["primary"], "ingest": ["primary"]},
    source={},
  )

  result = await restapi.list_datasources(None, None, _user())

  row = result["datasources"][0]
  assert row["datasource_id"] == "primary"
  assert row["name"] == "Primary source"
  assert row["description"] == "Shared catalog description"
  assert row["source_type"] == "jira"
  assert row["last_updated"] == 123
  for hidden in (
    "ingestor_id",
    "metadata",
    "default_chunk_size",
    "default_chunk_overlap",
    "reload_interval",
    "creator_subject",
    "owner_subject",
    "owner_team_slug",
    "shared_with_teams",
  ):
    assert hidden not in row
  assert row["_permissions"] == {
    "can_read_content": True,
    "can_ingest": True,
    "can_manage_query": False,
    "can_read_source_config": False,
    "can_manage_source": False,
  }


@pytest.mark.asyncio
async def test_source_reader_gets_full_connector_configuration(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  _wire_access(
    monkeypatch,
    datasource={},
    source={"can_read": ["primary"], "can_manage": ["primary"]},
  )

  result = await restapi.list_datasources(None, None, _user())

  row = result["datasources"][0]
  assert row["ingestor_id"] == "jira:default"
  assert row["metadata"] == {"project_key": "PRIMARY", "jql": "project = PRIMARY"}
  assert row["default_chunk_size"] == 5000
  assert row["reload_interval"] == 3600
  assert row["creator_subject"] == "creator-sub"
  assert row["_permissions"]["can_read_content"] is False
  assert row["_permissions"]["can_read_source_config"] is True
  assert row["_permissions"]["can_manage_source"] is True


@pytest.mark.asyncio
async def test_query_manager_keeps_query_ownership_without_source_config(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  _wire_access(
    monkeypatch,
    datasource={"read": ["primary"], "admin": ["primary"]},
    source={},
  )

  result = await restapi.list_datasources(None, None, _user())

  row = result["datasources"][0]
  assert row["owner_team_slug"] == "owner-team"
  assert row["shared_with_teams"] == ["shared-team"]
  assert row["creator_subject"] == "creator-sub"
  assert "metadata" not in row
  assert row["_permissions"]["can_manage_query"] is True
  assert row["_permissions"]["can_read_source_config"] is False


@pytest.mark.asyncio
async def test_row_hidden_without_either_read_policy(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  _wire_access(monkeypatch, datasource={}, source={})

  result = await restapi.list_datasources(None, None, _user())

  assert result == {"success": True, "datasources": [], "count": 0}


@pytest.mark.asyncio
@pytest.mark.parametrize("admin_check_status", [403, 503])
async def test_ingestor_catalog_redacts_worker_metadata_without_confirmed_org_admin(
  monkeypatch: pytest.MonkeyPatch,
  admin_check_status: int,
) -> None:
  storage = AsyncMock()
  storage.fetch_all_ingestor_info.return_value = [
    IngestorInfo(
      ingestor_id="jira:primary",
      ingestor_type="jira",
      ingestor_name="primary",
      description="Issue tracker worker for https://tracker.example.test",
      metadata={"server_url": "https://tracker.example.test", "project_filter": "PRIMARY"},
      last_seen=123,
    )
  ]
  monkeypatch.setattr(restapi, "metadata_storage", storage, raising=False)
  monkeypatch.setattr(
    restapi,
    "authorize_org_admin",
    AsyncMock(side_effect=HTTPException(status_code=admin_check_status)),
  )

  response = await restapi.list_ingestors(_user())
  body = json.loads(response.body)

  assert body[0]["ingestor_id"] == "jira:primary"
  assert body[0]["ingestor_type"] == "jira"
  assert body[0]["description"] == ""
  assert body[0]["metadata"] == {}


@pytest.mark.asyncio
async def test_ingestor_catalog_includes_worker_metadata_for_org_admin(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  storage = AsyncMock()
  storage.fetch_all_ingestor_info.return_value = [
    IngestorInfo(
      ingestor_id="jira:primary",
      ingestor_type="jira",
      ingestor_name="primary",
      description="Issue tracker worker for https://tracker.example.test",
      metadata={"server_url": "https://tracker.example.test"},
      last_seen=123,
    )
  ]
  monkeypatch.setattr(restapi, "metadata_storage", storage, raising=False)
  monkeypatch.setattr(restapi, "authorize_org_admin", AsyncMock(return_value=None))

  response = await restapi.list_ingestors(_user())
  body = json.loads(response.body)

  assert body[0]["description"] == "Issue tracker worker for https://tracker.example.test"
  assert body[0]["metadata"] == {"server_url": "https://tracker.example.test"}
