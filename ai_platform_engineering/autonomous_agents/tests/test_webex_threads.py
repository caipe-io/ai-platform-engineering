"""Tests for the Webex thread map and the scheduler post-run hook.

The thread map is the seam that lets a later in-thread Webex reply
be routed back to the autonomous task that produced ``messageId``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from autonomous_agents.models import (
    TaskDefinition,
    TaskRun,
    TaskStatus,
    WebhookTrigger,
)
from autonomous_agents.services.task_runner import (
    execute_task,
    set_run_store,
    set_webex_thread_map,
)
from autonomous_agents.services.webex_threads import (
    WebexThreadEntry,
    extract_webex_message_ids,
)


class _FakeWebexThreadMap:
    def __init__(self) -> None:
        self._entries: dict[str, WebexThreadEntry] = {}

    async def record(self, entry: WebexThreadEntry) -> None:
        stamped = (
            entry
            if entry.created_at is not None
            else WebexThreadEntry(
                message_id=entry.message_id,
                task_id=entry.task_id,
                run_id=entry.run_id,
                room_id=entry.room_id,
                created_at=datetime.now(timezone.utc),
            )
        )
        self._entries[entry.message_id] = stamped

    async def lookup(self, message_id: str) -> WebexThreadEntry | None:
        return self._entries.get(message_id)


class _DictRunStore:
    def __init__(self) -> None:
        self._runs: dict[str, TaskRun] = {}

    async def record(self, run: TaskRun) -> None:
        self._runs.pop(run.run_id, None)
        self._runs[run.run_id] = run

    async def list_all(self, limit: int = 500) -> list[TaskRun]:
        return list(self._runs.values())[-limit:][::-1]

    async def list_by_task(
        self, task_id: str, limit: int = 100
    ) -> list[TaskRun]:
        matching = [r for r in self._runs.values() if r.task_id == task_id]
        return matching[-limit:][::-1]


@pytest.fixture(autouse=True)
def _reset_scheduler_singletons():
    """The run-store and Webex thread-map singletons live in
    ``services.task_runner`` after the scheduler/runner split; rebind
    them there directly so each test starts clean."""
    import autonomous_agents.services.task_runner as runner_mod

    original_runs = runner_mod._run_store
    original_threads = runner_mod._webex_thread_map
    runner_mod._run_store = None
    runner_mod._webex_thread_map = None
    yield
    runner_mod._run_store = original_runs
    runner_mod._webex_thread_map = original_threads


@pytest.fixture
def store() -> _DictRunStore:
    s = _DictRunStore()
    set_run_store(s)
    return s


@pytest.fixture
def thread_map() -> _FakeWebexThreadMap:
    m = _FakeWebexThreadMap()
    set_webex_thread_map(m)
    return m


@pytest.fixture
def webhook_task() -> TaskDefinition:
    return TaskDefinition(
        id="wh-1",
        name="Webhook task",
        dynamic_agent_id="agent-x",
        prompt="Acknowledge on Webex.",
        trigger=WebhookTrigger(secret=None),
    )


def _make_post_message_events(
    *pairs: tuple[str, str | None],
) -> list[dict]:
    """Synthesise A2A streaming events that mimic the Webex MCP descriptor."""
    events: list[dict] = []
    for message_id, room_id in pairs:
        descriptor = f"messageId={message_id}"
        if room_id is not None:
            descriptor += f", roomId={room_id}"
        events.append(
            {
                "kind": "artifact-update",
                "artifact": {
                    "name": "tool_notification_end",
                    "parts": [
                        {
                            "kind": "text",
                            "text": (
                                "Tool call completed: post_message - "
                                f"Message sent successfully ({descriptor})."
                            ),
                        }
                    ],
                },
            }
        )
    return events


class TestExtractWebexMessageIds:
    """``extract_webex_message_ids`` walks supervisor streaming events."""

    def test_extract_returns_empty_for_no_events(self):
        """``None`` and ``[]`` both yield no pairs."""
        assert extract_webex_message_ids(None) == []
        assert extract_webex_message_ids([]) == []

    def test_extract_returns_empty_when_no_post_message_calls(self):
        """Streaming text and other tool notifications are ignored."""
        events = [
            {
                "kind": "artifact-update",
                "artifact": {
                    "name": "streaming_result",
                    "parts": [{"kind": "text", "text": "Hello world"}],
                },
            },
            {
                "kind": "artifact-update",
                "artifact": {
                    "name": "tool_notification_end",
                    "parts": [
                        {
                            "kind": "text",
                            "text": "Tool call completed: list_rooms - 3 rooms.",
                        }
                    ],
                },
            },
        ]
        assert extract_webex_message_ids(events) == []

    def test_extract_lifts_message_and_room_ids_from_tool_descriptor(self):
        """A ``post_message`` descriptor yields one ``(messageId, roomId)`` pair."""
        events = _make_post_message_events(("MSG_ABC", "ROOM_XYZ"))
        assert extract_webex_message_ids(events) == [("MSG_ABC", "ROOM_XYZ")]

    def test_extract_handles_multiple_post_message_calls_in_one_run(self):
        """Acknowledge then summary: both messages are recorded in order."""
        events = _make_post_message_events(
            ("MSG_ACK", "ROOM_XYZ"),
            ("MSG_SUMMARY", "ROOM_XYZ"),
        )
        pairs = extract_webex_message_ids(events)
        assert pairs == [
            ("MSG_ACK", "ROOM_XYZ"),
            ("MSG_SUMMARY", "ROOM_XYZ"),
        ]

    def test_extract_dedupes_duplicate_message_ids(self):
        """A retry that re-emits the same ack must only record once."""
        events = _make_post_message_events(
            ("MSG_DUP", "ROOM_XYZ"),
            ("MSG_DUP", "ROOM_XYZ"),
        )
        assert extract_webex_message_ids(events) == [("MSG_DUP", "ROOM_XYZ")]

    def test_extract_falls_back_to_none_room_id_when_missing(self):
        """Direct messages with no roomId record ``None``."""
        events = [
            {
                "kind": "artifact-update",
                "artifact": {
                    "name": "tool_notification_end",
                    "parts": [
                        {
                            "kind": "text",
                            "text": (
                                "Tool call completed: post_message - "
                                "Message sent successfully (messageId=DM_42)."
                            ),
                        }
                    ],
                },
            }
        ]
        assert extract_webex_message_ids(events) == [("DM_42", None)]

    def test_extract_ignores_malformed_events(self):
        """Non-dict entries, missing parts, etc. are silently skipped."""
        events = [
            None,  # type: ignore[list-item]
            "not a dict",  # type: ignore[list-item]
            {"artifact": "still not a dict"},
            {"artifact": {"name": "tool_notification_end", "parts": None}},
            {"artifact": {"name": "tool_notification_end", "parts": [{"kind": "text"}]}},
        ]
        assert extract_webex_message_ids(events) == []  # type: ignore[arg-type]


class TestSchedulerPostRunHook:
    """``execute_task`` records thread entries only on SUCCESS."""

    async def test_execute_task_records_thread_entries_on_success(
        self,
        store: _DictRunStore,
        thread_map: _FakeWebexThreadMap,
        webhook_task: TaskDefinition,
    ):
        """Successful runs persist ``(messageId, roomId)`` pairs in the thread map."""
        events = _make_post_message_events(("MSG_42", "ROOM_X"))
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("acknowledged", events)),
        ):
            run = await execute_task(webhook_task)

        assert run.status == TaskStatus.SUCCESS
        found = await thread_map.lookup("MSG_42")
        assert found is not None
        assert found.task_id == webhook_task.id
        assert found.run_id == run.run_id
        assert found.room_id == "ROOM_X"

    async def test_execute_task_records_nothing_when_no_post_message(
        self,
        store: _DictRunStore,
        thread_map: _FakeWebexThreadMap,
        webhook_task: TaskDefinition,
    ):
        """A run that never calls Webex leaves the thread map untouched."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("done", [])),
        ):
            await execute_task(webhook_task)

        assert await thread_map.lookup("MSG_42") is None

    async def test_execute_task_skips_thread_map_on_failure(
        self,
        store: _DictRunStore,
        thread_map: _FakeWebexThreadMap,
        webhook_task: TaskDefinition,
    ):
        """FAILED runs must not record any thread entries."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            run = await execute_task(webhook_task)

        assert run.status == TaskStatus.FAILED
        assert await thread_map.lookup("MSG_42") is None

    async def test_execute_task_works_without_thread_map_configured(
        self,
        store: _DictRunStore,
        webhook_task: TaskDefinition,
    ):
        """``set_webex_thread_map(None)`` makes the post-run hook a no-op."""
        set_webex_thread_map(None)
        events = _make_post_message_events(("MSG_42", "ROOM_X"))

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("acknowledged", events)),
        ):
            run = await execute_task(webhook_task)

        assert run.status == TaskStatus.SUCCESS

    async def test_execute_task_swallows_thread_map_write_failures(
        self,
        store: _DictRunStore,
        webhook_task: TaskDefinition,
    ):
        """A flaky thread-map must not abort task execution."""

        class _BoomThreadMap:
            async def record(self, entry):
                raise RuntimeError("mongo went pop")

            async def lookup(self, message_id):  # pragma: no cover - unused here
                return None

        set_webex_thread_map(_BoomThreadMap())
        events = _make_post_message_events(("MSG_42", "ROOM_X"))

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("acknowledged", events)),
        ):
            run = await execute_task(webhook_task)

        assert run.status == TaskStatus.SUCCESS
