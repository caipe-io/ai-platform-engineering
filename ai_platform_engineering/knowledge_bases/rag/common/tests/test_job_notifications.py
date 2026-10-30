"""Notification emission from JobManager.upsert_job (ingestion.* events)."""

import json
import urllib.error
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest

from common import notifications_client as nc
from common.constants import REDIS_DATASOURCE_PREFIX
from common.job_manager import JobManager, JobStatus

PUBLISH = "common.job_manager.schedule_publish"


class FakeRedis:
    """Tiny in-memory stand-in for the redis.asyncio calls JobManager uses."""

    def __init__(self) -> None:
        self.hashes: Dict[str, Dict[str, str]] = {}
        self.sets: Dict[str, set] = {}
        self.strings: Dict[str, str] = {}

    async def exists(self, key: str) -> int:
        return int(key in self.hashes)

    async def hget(self, key: str, field: str) -> Optional[str]:
        return self.hashes.get(key, {}).get(field)

    async def hmget(self, key: str, fields: List[str]) -> List[Optional[str]]:
        return [self.hashes.get(key, {}).get(f) for f in fields]

    async def hset(self, key: str, mapping: Dict[str, str]) -> int:
        self.hashes.setdefault(key, {}).update(mapping)
        return len(mapping)

    async def sadd(self, key: str, *values: str) -> int:
        self.sets.setdefault(key, set()).update(values)
        return len(values)

    async def srem(self, key: str, *values: str) -> int:
        self.sets.get(key, set()).difference_update(values)
        return 1

    async def smembers(self, key: str) -> set:
        return set(self.sets.get(key, set()))

    async def get(self, key: str) -> Optional[str]:
        return self.strings.get(key)


@pytest.fixture
def redis_fake() -> FakeRedis:
    fake = FakeRedis()
    fake.strings[f"{REDIS_DATASOURCE_PREFIX}ds-1"] = json.dumps(
        {"datasource_id": "ds-1", "name": "Team Wiki", "creator_subject": "sub-creator", "owner_subject": "sub-owner"}
    )
    return fake


@pytest.fixture
def manager(redis_fake: FakeRedis) -> JobManager:
    return JobManager(redis_fake)  # type: ignore[arg-type]


def _events(publish: Any) -> List[Dict[str, Any]]:
    return [call.args[0] for call in publish.call_args_list]


@pytest.mark.asyncio
async def test_completed_emits_once_with_touched_recipients(manager: JobManager, redis_fake: FakeRedis) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j1", status=JobStatus.PENDING, datasource_id="ds-1", triggered_by_subject="sub-a", triggered_by_email="a@example.com")
        await manager.upsert_job("j1", status=JobStatus.IN_PROGRESS, message="working on SECRET-DOC", datasource_id="ds-1", triggered_by_subject="sub-b", triggered_by_email="b@example.com")
        redis_fake.hashes["job:j1"]["document_count"] = "3"
        redis_fake.hashes["job:j1"]["chunk_count"] = "9"
        await manager.upsert_job("j1", status=JobStatus.COMPLETED, message="SECRET-DOC done", datasource_id="ds-1")
        # a later non-status upsert and a repeated terminal upsert must not re-emit
        await manager.upsert_job("j1", message="late message", datasource_id="ds-1")
        await manager.upsert_job("j1", status=JobStatus.COMPLETED, datasource_id="ds-1")

    events = _events(publish)
    types = [e["type"] for e in events]
    assert types == ["ingestion.started", "ingestion.completed"]
    done = events[-1]
    assert done["attempt_id"] == "j1"
    assert done["resource"] == {"type": "datasource", "id": "ds-1"}
    assert done["include_org_admins"] is True
    assert done["data"]["status"] == "completed"
    assert "Team Wiki" in done["data"]["title"]
    assert "3 documents" in done["data"]["summary"] and "9 chunks" in done["data"]["summary"]
    assert "SECRET" not in json.dumps(done)
    subjects = {r.get("subject") for r in done["recipients"]}
    assert {"sub-creator", "sub-owner", "sub-a", "sub-b"} <= subjects
    assert {"email": "a@example.com", "subject": "sub-a"} in done["recipients"]
    assert len(done["recipients"]) == 4


@pytest.mark.parametrize(
    "status,event_type,expected_status",
    [
        (JobStatus.COMPLETED, "ingestion.completed", "completed"),
        (JobStatus.COMPLETED_WITH_ERRORS, "ingestion.completed", "completed_with_errors"),
        (JobStatus.FAILED, "ingestion.failed", "failed"),
        (JobStatus.TERMINATED, "ingestion.failed", "terminated"),
    ],
)
@pytest.mark.asyncio
async def test_each_terminal_state_emits(manager: JobManager, status: JobStatus, event_type: str, expected_status: str) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j2", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("j2", status=status, datasource_id="ds-1")
    events = _events(publish)
    assert len(events) == 1
    assert events[0]["type"] == event_type
    assert events[0]["data"]["status"] == expected_status


@pytest.mark.asyncio
async def test_non_terminal_upserts_do_not_emit(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j3", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("j3", message="still pending", datasource_id="ds-1")
        await manager.upsert_job("j3", total=10, datasource_id="ds-1")
    assert publish.call_count == 0


@pytest.mark.asyncio
async def test_terminal_state_does_not_emit_twice_on_status_change(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j4", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("j4", status=JobStatus.FAILED, datasource_id="ds-1")
        await manager.upsert_job("j4", status=JobStatus.COMPLETED, datasource_id="ds-1")
    assert [e["type"] for e in _events(publish)] == ["ingestion.failed"]


@pytest.mark.asyncio
async def test_scheduled_job_without_user_still_notifies_creator_and_admins(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("j5", status=JobStatus.PENDING, datasource_id="ds-1")
        await manager.upsert_job("j5", status=JobStatus.FAILED, datasource_id="ds-1")
    event = _events(publish)[0]
    assert event["include_org_admins"] is True
    assert {r["subject"] for r in event["recipients"]} == {"sub-creator", "sub-owner"}


@pytest.mark.asyncio
async def test_touched_users_persist_across_jobs(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("ja", status=JobStatus.COMPLETED, datasource_id="ds-1", triggered_by_subject="sub-a", triggered_by_email="a@example.com")
        await manager.upsert_job("jb", status=JobStatus.COMPLETED, datasource_id="ds-1")
    second = _events(publish)[1]
    assert "sub-a" in {r.get("subject") for r in second["recipients"]}


@pytest.mark.asyncio
async def test_creating_job_directly_in_terminal_state_emits(manager: JobManager) -> None:
    with patch(PUBLISH) as publish:
        await manager.upsert_job("jc", status=JobStatus.FAILED, datasource_id="ds-1")
    assert [e["type"] for e in _events(publish)] == ["ingestion.failed"]


@pytest.mark.asyncio
async def test_publish_failure_does_not_change_job_outcome(manager: JobManager, redis_fake: FakeRedis) -> None:
    with patch(PUBLISH, side_effect=RuntimeError("publisher exploded")):
        ok = await manager.upsert_job("jd", status=JobStatus.COMPLETED, datasource_id="ds-1")
    assert ok is True
    assert redis_fake.hashes["job:jd"]["status"] == "completed"


@pytest.mark.parametrize("failure", [urllib.error.URLError("refused"), TimeoutError("slow")])
@pytest.mark.asyncio
async def test_real_client_swallows_network_errors(manager: JobManager, redis_fake: FakeRedis, monkeypatch: pytest.MonkeyPatch, failure: Exception) -> None:
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setattr(nc.time, "sleep", lambda _s: None)

    def boom(*_args: object) -> int:
        raise failure

    monkeypatch.setattr(nc, "_post", boom)
    assert await manager.upsert_job("je", status=JobStatus.FAILED, datasource_id="ds-1") is True
    for pending in list(nc._background_tasks):
        assert await pending is False
    assert redis_fake.hashes["job:je"]["status"] == "failed"


@pytest.mark.asyncio
async def test_real_client_5xx_swallowed(manager: JobManager, redis_fake: FakeRedis, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setattr(nc.time, "sleep", lambda _s: None)
    monkeypatch.setattr(nc, "_post", lambda *_a: 500)
    assert await manager.upsert_job("jf", status=JobStatus.COMPLETED, datasource_id="ds-1") is True
    for pending in list(nc._background_tasks):
        assert await pending is False


@pytest.mark.asyncio
async def test_kill_switch_and_missing_token_send_nothing(manager: JobManager, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: List[Any] = []
    monkeypatch.setattr(nc, "_post", lambda *a: calls.append(a) or 202)
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setenv("NOTIFICATION_EVENTS_ENABLED", "false")
    await manager.upsert_job("jg", status=JobStatus.COMPLETED, datasource_id="ds-1")
    monkeypatch.delenv("NOTIFICATION_EVENTS_ENABLED")
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "")
    await manager.upsert_job("jh", status=JobStatus.COMPLETED, datasource_id="ds-1")
    assert calls == []
