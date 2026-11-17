"""Jobs record the human who triggered them so ingestion notifications can reach them."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from common.job_manager import JobInfo, JobStatus
from common.models.rbac import UserContext
from server import restapi


def _user(**overrides) -> UserContext:
    base = dict(subject="sub-1", email="user@example.com", role="user", is_authenticated=True)
    base.update(overrides)
    return UserContext(**base)


def test_human_user_is_recorded() -> None:
    assert restapi.job_actor(_user()) == {"triggered_by_subject": "sub-1", "triggered_by_email": "user@example.com"}


def test_service_account_and_missing_user_are_not_recorded() -> None:
    assert restapi.job_actor(_user(subject_type="service_account", client_id="ingestor")) == {}
    assert restapi.job_actor(_user(is_authenticated=False)) == {}
    assert restapi.job_actor(None) == {}


@pytest.mark.asyncio
async def test_update_job_passes_acting_user(monkeypatch: pytest.MonkeyPatch) -> None:
    jm = AsyncMock()
    jm.get_job.return_value = JobInfo(job_id="j1", status=JobStatus.IN_PROGRESS, created_at=1, datasource_id="ds-1")
    jm.upsert_job.return_value = True
    monkeypatch.setattr(restapi, "jobmanager", jm, raising=False)
    monkeypatch.setattr(restapi, "authorize_ingestor_job_transport", AsyncMock())
    await restapi.update_job(MagicMock(), "j1", job_status=JobStatus.COMPLETED, user=_user())
    kwargs = jm.upsert_job.call_args.kwargs
    assert kwargs["triggered_by_subject"] == "sub-1"
    assert kwargs["triggered_by_email"] == "user@example.com"
