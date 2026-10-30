"""Notification emission from ``execute_task`` (agent.completed / agent.failed)."""

from __future__ import annotations

import urllib.error
from unittest.mock import AsyncMock, patch

import pytest

from autonomous_agents.models import CronTrigger, TaskDefinition, TaskRun, TaskStatus
from autonomous_agents.services import notifications_client as nc
from autonomous_agents.services.task_runner import execute_task, set_run_store

AGENT_PATH = "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming"
PUBLISH_PATH = "autonomous_agents.services.task_runner.schedule_publish"


class _Store:
    def __init__(self) -> None:
        self.runs: dict[str, TaskRun] = {}

    async def record(self, run: TaskRun) -> None:
        self.runs[run.run_id] = run


@pytest.fixture(autouse=True)
def _store() -> _Store:
    store = _Store()
    set_run_store(store)  # type: ignore[arg-type]
    return store


@pytest.fixture
def task() -> TaskDefinition:
    return TaskDefinition(
        id="task-1",
        name="Nightly report",
        dynamic_agent_id="agent-x",
        prompt="SECRET PROMPT TEXT",
        trigger=CronTrigger(schedule="0 * * * *"),
        owner_id="owner@example.com",
        owner_sub="sub-owner-1",
    )


async def test_success_emits_agent_completed(task: TaskDefinition) -> None:
    with patch(AGENT_PATH, new=AsyncMock(return_value=("SECRET RESPONSE", []))), patch(PUBLISH_PATH) as publish:
        run = await execute_task(task)

    publish.assert_called_once()
    event = publish.call_args.args[0]
    assert event["type"] == "agent.completed"
    assert event["resource"] == {"type": "autonomous_task", "id": "task-1"}
    assert event["attempt_id"] == run.run_id
    assert event["recipients"] == [{"subject": "sub-owner-1", "email": "owner@example.com"}]
    assert event["data"]["status"] == "success"
    assert "Nightly report" in event["data"]["title"]
    assert event["data"]["href"] == "/autonomous"
    assert "SECRET" not in str(event)


async def test_failure_emits_agent_failed_without_error_text(task: TaskDefinition) -> None:
    with patch(AGENT_PATH, new=AsyncMock(side_effect=RuntimeError("token=abc123"))), patch(PUBLISH_PATH) as publish:
        run = await execute_task(task)

    assert run.status == TaskStatus.FAILED
    event = publish.call_args.args[0]
    assert event["type"] == "agent.failed"
    assert event["attempt_id"] == run.run_id
    assert "abc123" not in str(event)


async def test_each_run_gets_a_new_attempt_id(task: TaskDefinition) -> None:
    with patch(AGENT_PATH, new=AsyncMock(return_value=("ok", []))), patch(PUBLISH_PATH) as publish:
        await execute_task(task)
        await execute_task(task)
    ids = {call.args[0]["attempt_id"] for call in publish.call_args_list}
    assert len(ids) == 2


async def test_task_without_owner_does_not_emit() -> None:
    ownerless = TaskDefinition(
        id="t2", name="n", dynamic_agent_id="a", prompt="p", trigger=CronTrigger(schedule="0 * * * *")
    )
    with patch(AGENT_PATH, new=AsyncMock(return_value=("ok", []))), patch(PUBLISH_PATH) as publish:
        await execute_task(ownerless)
    publish.assert_not_called()


async def test_publish_helper_exception_does_not_change_outcome(task: TaskDefinition, _store: _Store) -> None:
    with patch(AGENT_PATH, new=AsyncMock(return_value=("ok", []))), patch(PUBLISH_PATH, side_effect=RuntimeError("x")):
        run = await execute_task(task)
    assert run.status == TaskStatus.SUCCESS
    assert _store.runs[run.run_id].status == TaskStatus.SUCCESS


@pytest.mark.parametrize("failure", [urllib.error.URLError("refused"), TimeoutError("slow")])
async def test_real_client_swallows_network_errors(
    task: TaskDefinition, monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setattr(nc.time, "sleep", lambda _s: None)

    def boom(*_args: object) -> int:
        raise failure

    monkeypatch.setattr(nc, "_post", boom)
    with patch(AGENT_PATH, new=AsyncMock(return_value=("ok", []))):
        run = await execute_task(task)
        # Let the background publish task finish so errors would surface.
        for pending in list(nc._background_tasks):
            assert await pending is False
    assert run.status == TaskStatus.SUCCESS


async def test_real_client_5xx_does_not_change_outcome(task: TaskDefinition, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setattr(nc.time, "sleep", lambda _s: None)
    monkeypatch.setattr(nc, "_post", lambda *_a: 500)
    with patch(AGENT_PATH, new=AsyncMock(side_effect=RuntimeError("boom"))):
        run = await execute_task(task)
        for pending in list(nc._background_tasks):
            assert await pending is False
    assert run.status == TaskStatus.FAILED


async def test_kill_switch_and_missing_token_send_nothing(task: TaskDefinition, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []
    monkeypatch.setattr(nc, "_post", lambda *a: calls.append(a) or 202)
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setenv("NOTIFICATION_EVENTS_ENABLED", "false")
    with patch(AGENT_PATH, new=AsyncMock(return_value=("ok", []))):
        await execute_task(task)
    monkeypatch.delenv("NOTIFICATION_EVENTS_ENABLED")
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "")
    with patch(AGENT_PATH, new=AsyncMock(return_value=("ok", []))):
        await execute_task(task)
    assert calls == []
