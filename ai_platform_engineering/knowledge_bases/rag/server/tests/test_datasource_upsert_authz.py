"""Authorization tests for full DataSourceInfo replacement.

Legacy ingestion grants permit content ingestion, not reassignment of the
connector or replacement of source metadata. Full-record writes therefore
belong only to the trusted ingestor transport and the org-admin migration.
"""

from __future__ import annotations

from unittest.mock import ANY, AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from common.models.rag import DataSourceInfo
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
    ingestor_id="webloader:default",
    source_type="web",
    last_updated=0,
  )


def _request() -> MagicMock:
  return MagicMock(headers={})


@pytest.fixture
def storage(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
  value = AsyncMock()
  value.get_datasource_info.return_value = None
  monkeypatch.setattr(restapi, "metadata_storage", value, raising=False)
  return value


@pytest.mark.asyncio
async def test_human_full_upsert_requires_org_admin(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  admin_check = AsyncMock(return_value=None)
  transport_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "is_trusted_ingestor_service", lambda _user: False)
  monkeypatch.setattr(restapi, "authorize_org_admin", admin_check)
  monkeypatch.setattr(restapi, "authorize_ingestor_transport", transport_check)

  await restapi.upsert_datasource(_datasource(), None, _user())

  admin_check.assert_awaited_once()
  transport_check.assert_not_awaited()
  storage.store_datasource_info.assert_awaited_once()


@pytest.mark.asyncio
async def test_denied_human_cannot_replace_datasource_metadata(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  async def deny(_user: UserContext) -> None:
    raise HTTPException(status_code=403, detail="denied")

  monkeypatch.setattr(restapi, "is_trusted_ingestor_service", lambda _user: False)
  monkeypatch.setattr(restapi, "authorize_org_admin", deny)

  with pytest.raises(HTTPException) as exc:
    await restapi.upsert_datasource(_datasource(), None, _user())

  assert exc.value.status_code == 403
  storage.store_datasource_info.assert_not_awaited()


@pytest.mark.asyncio
async def test_trusted_ingestor_uses_assignment_check(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  transport_check = AsyncMock(return_value=None)
  admin_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "is_trusted_ingestor_service", lambda _user: True)
  monkeypatch.setattr(restapi, "authorize_ingestor_transport", transport_check)
  monkeypatch.setattr(restapi, "authorize_org_admin", admin_check)
  datasource = _datasource()

  await restapi.upsert_datasource(datasource, None, _user())

  transport_check.assert_awaited_once_with(
    ANY,
    datasource.datasource_id,
    datasource.ingestor_id,
    allow_create=True,
  )
  admin_check.assert_not_awaited()
  storage.store_datasource_info.assert_awaited_once_with(datasource)


@pytest.mark.asyncio
async def test_trusted_ingestor_cannot_replace_existing_authorization_policy(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  existing = _datasource()
  existing.creator_subject = "creator-sub"
  existing.owner_subject = "owner-sub"
  existing.owner_team_slug = "query-team"
  existing.shared_with_teams = ["shared-team"]
  existing.search_with_teams = ["search-team"]
  existing.search_with_users = ["search-user"]
  storage.get_datasource_info.return_value = existing

  incoming = _datasource()
  incoming.creator_subject = "forged-creator"
  incoming.owner_subject = "forged-owner"
  incoming.owner_team_slug = "forged-team"
  incoming.shared_with_teams = ["forged-share"]
  incoming.search_with_teams = ["forged-search"]
  incoming.search_with_users = ["forged-user"]

  monkeypatch.setattr(restapi, "is_trusted_ingestor_service", lambda _user: True)
  monkeypatch.setattr(
    restapi,
    "authorize_ingestor_transport",
    AsyncMock(return_value=None),
  )

  await restapi.upsert_datasource(incoming, None, _user())

  assert incoming.creator_subject == "creator-sub"
  assert incoming.owner_subject == "owner-sub"
  assert incoming.owner_team_slug == "query-team"
  assert incoming.shared_with_teams == ["shared-team"]
  assert incoming.search_with_teams == ["search-team"]
  assert incoming.search_with_users == ["search-user"]
  storage.store_datasource_info.assert_awaited_once_with(incoming)


@pytest.mark.asyncio
async def test_source_manager_can_update_only_owner_team(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.description = "Keep this metadata"
  storage.get_datasource_info.return_value = datasource
  management_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "check_datasource_management_access", management_check)

  result = await restapi.update_datasource_owner_team(
    "primary",
    restapi.DatasourceOwnerTeamUpdateRequest(owner_team_slug="  query-team  "),
    _request(),
    _user(),
  )

  management_check.assert_awaited_once_with(ANY, "primary")
  assert datasource.owner_team_slug == "query-team"
  assert datasource.description == "Keep this metadata"
  storage.store_datasource_info.assert_awaited_once_with(datasource)
  assert result == {
    "datasource_id": "primary",
    "owner_team_slug": "query-team",
    "owner_subject": None,
    "search_with_teams": [],
    "search_with_users": [],
    "changed": True,
  }


@pytest.mark.asyncio
async def test_source_manager_can_persist_independent_search_teams(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.owner_team_slug = "primary"
  datasource.search_with_teams = ["old-search"]
  storage.get_datasource_info.return_value = datasource
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    AsyncMock(return_value=None),
  )

  result = await restapi.update_datasource_owner_team(
    "primary",
    restapi.DatasourceOwnerTeamUpdateRequest(
      search_with_teams=["primary", "readers", "primary"],
    ),
    _request(),
    _user(),
  )

  assert datasource.owner_team_slug == "primary"
  assert datasource.search_with_teams == ["primary", "readers"]
  assert result == {
    "datasource_id": "primary",
    "owner_team_slug": "primary",
    "owner_subject": None,
    "search_with_teams": ["primary", "readers"],
    "search_with_users": [],
    "changed": True,
  }
  storage.store_datasource_info.assert_awaited_once_with(datasource)


@pytest.mark.asyncio
async def test_source_manager_can_read_narrow_publication_state(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.creator_subject = "creator-subject"
  datasource.owner_subject = "owner-subject"
  datasource.description = "Not returned"
  storage.get_datasource_info.return_value = datasource
  management_check = AsyncMock(return_value=None)
  publication_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "check_datasource_management_access", management_check)
  monkeypatch.setattr(
    restapi,
    "check_publication_request_apply_access",
    publication_check,
  )

  result = await restapi.get_datasource_publication_state(
    "primary",
    _request(),
    _user(),
  )

  assert result == {
    "datasource_id": "primary",
    "owner_team_slug": None,
    "owner_subject": "owner-subject",
    "creator_subject": "creator-subject",
  }
  management_check.assert_awaited_once_with(ANY, "primary")
  publication_check.assert_not_awaited()


@pytest.mark.asyncio
async def test_delegated_approver_can_read_narrow_publication_state(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.creator_subject = "creator-subject"
  datasource.owner_team_slug = "owner-team"
  storage.get_datasource_info.return_value = datasource
  management_check = AsyncMock(
    side_effect=HTTPException(status_code=403, detail="denied"),
  )
  publication_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "check_datasource_management_access", management_check)
  monkeypatch.setattr(
    restapi,
    "check_publication_request_apply_access",
    publication_check,
  )
  request = MagicMock(
    headers={"X-Publication-Authorization-Id": "publication-policy-primary"},
  )

  result = await restapi.get_datasource_publication_state(
    "primary",
    request,
    _user(),
  )

  assert result["owner_team_slug"] == "owner-team"
  publication_check.assert_awaited_once_with(
    ANY,
    "publication-policy-primary",
    "rag_datasource",
    "primary",
  )


@pytest.mark.asyncio
async def test_publication_state_denies_non_manager_without_request_capability(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  async def deny(*_args: object) -> None:
    raise HTTPException(status_code=403, detail="denied")

  storage.get_datasource_info.return_value = _datasource()
  monkeypatch.setattr(restapi, "check_datasource_management_access", deny)
  monkeypatch.setattr(restapi, "check_publication_request_apply_access", deny)

  with pytest.raises(HTTPException) as exc:
    await restapi.get_datasource_publication_state(
      "primary",
      _request(),
      _user(),
    )

  assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_source_manager_can_transfer_to_person_and_persist_direct_search_users(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.creator_subject = "creator-sub"
  datasource.owner_team_slug = "primary"
  storage.get_datasource_info.return_value = datasource
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    AsyncMock(return_value=None),
  )

  result = await restapi.update_datasource_owner_team(
    "primary",
    restapi.DatasourceOwnerTeamUpdateRequest(
      owner_team_slug=None,
      owner_subject="new-owner-sub",
      search_with_users=["reader-sub", "reader-sub"],
    ),
    _request(),
    _user(),
  )

  assert datasource.owner_team_slug is None
  assert datasource.owner_subject == "new-owner-sub"
  assert datasource.search_with_users == ["reader-sub"]
  assert result == {
    "datasource_id": "primary",
    "owner_team_slug": None,
    "owner_subject": "new-owner-sub",
    "search_with_teams": [],
    "search_with_users": ["reader-sub"],
    "changed": True,
  }
  storage.store_datasource_info.assert_awaited_once_with(datasource)


@pytest.mark.asyncio
async def test_source_manager_can_restore_an_unowned_datasource(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.owner_team_slug = "temporary-owner"
  storage.get_datasource_info.return_value = datasource
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    AsyncMock(return_value=None),
  )

  result = await restapi.update_datasource_owner_team(
    "primary",
    restapi.DatasourceOwnerTeamUpdateRequest(owner_team_slug=None),
    _request(),
    _user(),
  )

  assert datasource.owner_team_slug is None
  storage.store_datasource_info.assert_awaited_once_with(datasource)
  assert result["owner_team_slug"] is None


@pytest.mark.asyncio
async def test_source_manager_can_update_jira_connector_configuration(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.source_type = "jira"
  datasource.metadata = {
    "jql": "project = EXAMPLE",
    "include_comments": True,
    "include_links": True,
  }
  storage.get_datasource_info.return_value = datasource
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    AsyncMock(return_value=None),
  )

  await restapi.rename_datasource(
    "primary",
    restapi.DatasourceUpdateRequest(
      jql="project = EXAMPLE AND status != Done",
      include_comments=False,
      include_links=False,
      custom_fields={"service": "customfield_123"},
    ),
    MagicMock(),
    _user(),
  )

  assert datasource.metadata == {
    "jql": "project = EXAMPLE AND status != Done",
    "include_comments": False,
    "include_links": False,
    "custom_fields": {"service": "customfield_123"},
  }
  storage.store_datasource_info.assert_awaited_once_with(datasource)


@pytest.mark.asyncio
async def test_source_manager_can_clear_optional_connector_configuration(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.source_type = "jira"
  datasource.metadata = {
    "jql": "project = EXAMPLE",
    "include_comments": True,
    "include_links": True,
  }
  storage.get_datasource_info.return_value = datasource
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    AsyncMock(return_value=None),
  )

  await restapi.rename_datasource(
    "primary",
    restapi.DatasourceUpdateRequest(
      include_comments=None,
      include_links=None,
    ),
    MagicMock(),
    _user(),
  )

  assert datasource.metadata == {"jql": "project = EXAMPLE"}
  storage.store_datasource_info.assert_awaited_once_with(datasource)


@pytest.mark.asyncio
async def test_connector_configuration_rejects_fields_for_another_source_type(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  datasource = _datasource()
  datasource.source_type = "slack"
  storage.get_datasource_info.return_value = datasource
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    AsyncMock(return_value=None),
  )

  with pytest.raises(HTTPException) as exc:
    await restapi.rename_datasource(
      "primary",
      restapi.DatasourceUpdateRequest(jql="project = EXAMPLE"),
      MagicMock(),
      _user(),
    )

  assert exc.value.status_code == 400
  storage.store_datasource_info.assert_not_awaited()


@pytest.mark.asyncio
async def test_source_manager_can_transfer_query_owner_without_content_access(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  storage.get_datasource_info.return_value = _datasource()
  source_management_check = AsyncMock(return_value=None)
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    source_management_check,
  )

  result = await restapi.update_datasource_owner_team(
    "primary",
    restapi.DatasourceOwnerTeamUpdateRequest(owner_team_slug="query-team"),
    _request(),
    _user(),
  )

  source_management_check.assert_awaited_once_with(ANY, "primary")
  assert result["owner_team_slug"] == "query-team"
  storage.store_datasource_info.assert_awaited_once()


@pytest.mark.asyncio
async def test_owner_update_denies_caller_without_management_or_approval_grant(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  async def deny(*_args: object) -> None:
    raise HTTPException(status_code=403, detail="denied")

  storage.get_datasource_info.return_value = _datasource()
  monkeypatch.setattr(restapi, "check_datasource_management_access", deny)
  monkeypatch.setattr(restapi, "check_publication_request_apply_access", deny)

  with pytest.raises(HTTPException) as exc:
    await restapi.update_datasource_owner_team(
      "primary",
      restapi.DatasourceOwnerTeamUpdateRequest(owner_team_slug="query-team"),
      _request(),
      _user(),
    )

  assert exc.value.status_code == 403
  storage.store_datasource_info.assert_not_awaited()


@pytest.mark.asyncio
async def test_request_scoped_approver_can_apply_reviewed_owner_transfer(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  async def deny_management(*_args: object) -> None:
    raise HTTPException(status_code=403, detail="denied")

  datasource = _datasource()
  datasource.owner_subject = "previous-owner"
  storage.get_datasource_info.return_value = datasource
  publication_check = AsyncMock(return_value=None)
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    deny_management,
  )
  monkeypatch.setattr(
    restapi,
    "check_publication_request_apply_access",
    publication_check,
  )
  request = MagicMock(
    headers={"X-Publication-Authorization-Id": "publication-policy-primary"},
  )

  result = await restapi.update_datasource_owner_team(
    "primary",
    restapi.DatasourceOwnerTeamUpdateRequest(
      owner_team_slug="new-owner-team",
      owner_subject=None,
    ),
    request,
    _user(),
  )

  assert result["owner_team_slug"] == "new-owner-team"
  assert result["owner_subject"] is None
  publication_check.assert_awaited_once_with(
    ANY,
    "publication-policy-primary",
    "rag_datasource",
    "primary",
  )
  storage.store_datasource_info.assert_awaited_once_with(datasource)


@pytest.mark.asyncio
async def test_owner_update_rejects_invalid_team_slug(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  storage.get_datasource_info.return_value = _datasource()
  monkeypatch.setattr(
    restapi,
    "check_datasource_management_access",
    AsyncMock(return_value=None),
  )

  with pytest.raises(HTTPException) as exc:
    await restapi.update_datasource_owner_team(
      "primary",
      restapi.DatasourceOwnerTeamUpdateRequest(owner_team_slug="team:invalid"),
      _request(),
      _user(),
    )

  assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_existence_probe_allows_existing_source_manager_without_create_grant(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  storage.get_datasource_info.return_value = _datasource()
  source_check = AsyncMock(return_value=None)
  create_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "check_ingestion_source_access", source_check)
  monkeypatch.setattr(restapi, "authorize_datasource_create", create_check)

  result = await restapi.datasource_exists(
    "primary",
    None,
    "author-team",
    _user(),
  )

  assert result == {"datasource_id": "primary", "exists": True}
  source_check.assert_awaited_once_with(ANY, "primary", "can_manage")
  create_check.assert_not_awaited()


@pytest.mark.asyncio
async def test_existence_probe_falls_back_to_source_authorization_for_new_source(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  storage.get_datasource_info.return_value = None
  source_check = AsyncMock(
    side_effect=HTTPException(status_code=403, detail="no source policy"),
  )
  create_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "check_ingestion_source_access", source_check)
  monkeypatch.setattr(restapi, "authorize_datasource_create", create_check)

  result = await restapi.datasource_exists(
    "new-source",
    None,
    "author-team",
    _user(),
  )

  assert result == {"datasource_id": "new-source", "exists": False}
  create_check.assert_awaited_once_with(
    None,
    ANY,
    "new-source",
    "author-team",
  )


@pytest.mark.asyncio
async def test_existence_probe_does_not_turn_pdp_outage_into_author_fallback(
  monkeypatch: pytest.MonkeyPatch,
  storage: AsyncMock,
) -> None:
  source_check = AsyncMock(
    side_effect=HTTPException(status_code=503, detail="PDP unavailable"),
  )
  create_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "check_ingestion_source_access", source_check)
  monkeypatch.setattr(restapi, "authorize_datasource_create", create_check)

  with pytest.raises(HTTPException) as exc:
    await restapi.datasource_exists(
      "primary",
      None,
      "author-team",
      _user(),
    )

  assert exc.value.status_code == 503
  create_check.assert_not_awaited()
  storage.get_datasource_info.assert_not_awaited()
  storage.store_datasource_info.assert_not_awaited()


@pytest.mark.asyncio
async def test_human_cannot_forge_internal_job_progress(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  request = MagicMock()
  request.headers = {}
  monkeypatch.setattr(restapi, "is_trusted_ingestor_service", lambda _user: False)

  with pytest.raises(HTTPException) as exc:
    await restapi.authorize_ingestor_job_transport(request, _user(), "primary")

  assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_job_transport_checks_claimed_ingestor_assignment(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  request = MagicMock()
  request.headers = {
    "X-Ingestor-Type": "webloader",
    "X-Ingestor-Name": "default",
  }
  assignment_check = AsyncMock(return_value=None)
  monkeypatch.setattr(restapi, "is_trusted_ingestor_service", lambda _user: True)
  monkeypatch.setattr(restapi, "authorize_ingestor_transport", assignment_check)

  await restapi.authorize_ingestor_job_transport(request, _user(), "primary")

  assignment_check.assert_awaited_once_with(
    ANY,
    "primary",
    "webloader:default",
  )
