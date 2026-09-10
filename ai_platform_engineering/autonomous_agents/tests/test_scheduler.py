"""Tests for ``autonomous_agents.services.scheduler``.

Covers RunStore wiring, the ChatHistoryPublisher fan-out, follow-up
prompt augmentation and ``parent_run_id`` linking, and the
``register_scheduler_task`` / ``unregister_scheduler_task`` hot-reload
helpers. The dynamic-agents client is mocked everywhere so no live runtime is required.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from autonomous_agents.models import (
    CronTrigger,
    FollowUpContext,
    IntervalTrigger,
    TaskDefinition,
    TaskRun,
    TaskStatus,
    WebhookTrigger,
)
from autonomous_agents.services.chat_history import (
    conversation_id_for_task,
    conversation_id_for_webhook_run,
)
from autonomous_agents.services.scheduler import (
    get_scheduler,
    register_scheduler_task,
    register_scheduler_tasks,
    unregister_scheduler_task,
)
from autonomous_agents.services.task_runner import (
    _augment_prompt_for_followup,
    execute_task,
    fire_webhook_task,
    get_run_store,
    set_chat_history_publisher,
    set_run_store,
)


class _DictRunStore:
    """Minimal ``RunStore`` fake; ``record`` is upsert by ``run_id``."""

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


class _FlakyStore:
    """RunStore that always raises; counts ``record`` invocations."""

    def __init__(self) -> None:
        self.record_calls = 0

    async def record(self, run):
        self.record_calls += 1
        raise RuntimeError("simulated store outage")

    async def list_all(self, limit: int = 500):  # pragma: no cover
        return []

    async def list_by_task(self, task_id: str, limit: int = 100):  # pragma: no cover
        return []


class _RecordingPublisher:
    """Captures every ``publish_run`` invocation for later assertions."""

    enabled = True

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def publish_run(
        self,
        run,
        *,
        prompt,
        response,
        error,
        agent,
        conversation_id=None,
    ) -> None:
        self.calls.append(
            {
                "run_id": run.run_id,
                "task_id": run.task_id,
                "status": run.status,
                "prompt": prompt,
                "response": response,
                "error": error,
                "agent": agent,
                "conversation_id": conversation_id,
            }
        )


class _FlakyPublisher:
    """Raises on every ``publish_run``; counts invocations."""

    enabled = True

    def __init__(self) -> None:
        self.calls = 0

    async def publish_run(self, run, **kwargs) -> None:
        self.calls += 1
        raise RuntimeError("simulated chat-history outage")


@pytest.fixture(autouse=True)
def _reset_scheduler_globals():
    """Restore module-level singletons (run_store, publisher) after each test.

    The singletons now live in ``services.task_runner`` (extracted from
    ``scheduler.py``); the fixture rebinds the underscore globals there
    directly so each test starts from a clean runner state.
    """
    import autonomous_agents.services.task_runner as runner_mod

    original_run = runner_mod._run_store
    original_pub = runner_mod._chat_history_publisher
    runner_mod._run_store = None
    runner_mod._chat_history_publisher = None
    yield
    runner_mod._run_store = original_run
    runner_mod._chat_history_publisher = original_pub


@pytest.fixture
def store() -> _DictRunStore:
    s = _DictRunStore()
    set_run_store(s)
    return s


@pytest.fixture
def publisher() -> _RecordingPublisher:
    p = _RecordingPublisher()
    set_chat_history_publisher(p)
    return p


@pytest.fixture
def task() -> TaskDefinition:
    return TaskDefinition(
        id="test-task",
        name="Test Task",
        dynamic_agent_id="agent-x",
        prompt="echo hello",
        trigger=CronTrigger(schedule="0 9 * * *"),
    )


@pytest.fixture
def cron_task() -> TaskDefinition:
    return TaskDefinition(
        id="weekly-prs",
        name="Weekly PR Review",
        dynamic_agent_id="agent-x",
        prompt="list open PRs",
        trigger=CronTrigger(schedule="0 9 * * MON"),
    )


@pytest.fixture
def webhook_task() -> TaskDefinition:
    return TaskDefinition(
        id="wh-1",
        name="Webhook task",
        dynamic_agent_id="agent-x",
        prompt="Triage the inbound issue.",
        trigger=WebhookTrigger(secret=None),
    )


class TestRunStoreWiring:
    """``execute_task`` records a single terminal-state TaskRun via the injected RunStore."""

    def test_get_run_store_raises_when_uninjected(self):
        """No in-memory fallback; uninjected store surfaces a clear error."""
        with pytest.raises(RuntimeError, match="RunStore not initialized"):
            get_run_store()

    def test_set_run_store_replaces_active_store(self):
        """``set_run_store`` swaps the active RunStore singleton."""
        first = _DictRunStore()
        set_run_store(first)
        assert get_run_store() is first

        second = _DictRunStore()
        set_run_store(second)
        assert get_run_store() is second

    async def test_execute_task_records_running_then_success(
        self, store: _DictRunStore, task: TaskDefinition
    ):
        """Two record() calls (RUNNING + SUCCESS) upsert to one entry."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("hello world", [])),
        ):
            run = await execute_task(task)

        assert run.status == TaskStatus.SUCCESS
        assert run.response_preview == "hello world"

        runs = await store.list_all()
        assert len(runs) == 1
        assert runs[0].run_id == run.run_id
        assert runs[0].status == TaskStatus.SUCCESS
        assert runs[0].finished_at is not None

    async def test_execute_task_records_failure_with_error_message(
        self, store: _DictRunStore, task: TaskDefinition
    ):
        """A2A failure persists as FAILED with the exception message."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            run = await execute_task(task)

        assert run.status == TaskStatus.FAILED

        runs = await store.list_all()
        assert len(runs) == 1
        persisted = runs[0]
        assert persisted.run_id == run.run_id
        assert persisted.status == TaskStatus.FAILED
        assert persisted.error == "boom"
        assert persisted.finished_at is not None

    async def test_running_state_is_visible_before_completion(
        self, store: _DictRunStore, task: TaskDefinition
    ):
        """RUNNING entry is queryable while the dynamic-agents call is in flight."""
        snapshot: list[TaskStatus] = []

        async def slow_agent(*args, **kwargs):
            rs = await store.list_all()
            if rs:
                snapshot.append(rs[0].status)
            return ("done", [])

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(side_effect=slow_agent),
        ):
            await execute_task(task)

        assert snapshot == [TaskStatus.RUNNING]
        runs = await store.list_all()
        assert runs[0].status == TaskStatus.SUCCESS

    async def test_execute_task_routes_dynamic_agent_to_dynamic_client(
        self, store: _DictRunStore
    ):
        """Execution dispatches the task to the dynamic-agents streaming client."""
        da_task = TaskDefinition(
            id="custom-task",
            name="Custom Task",
            dynamic_agent_id="agent-x",
            prompt="run the custom thing",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )

        invoke_da = AsyncMock(return_value=("custom agent answer", []))

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=invoke_da,
        ):
            run = await execute_task(
                da_task,
                context={"event": "message.created", "roomId": "room-123"},
            )

        assert run.status == TaskStatus.SUCCESS
        assert run.response_full == "custom agent answer"
        invoke_da.assert_awaited_once()
        assert invoke_da.await_args.kwargs["agent_id"] == "agent-x"
        assert invoke_da.await_args.kwargs["context"] == {
            "event": "message.created",
            "roomId": "room-123",
        }

    async def test_execute_task_returns_same_run_object_as_persisted(
        self, store: _DictRunStore, task: TaskDefinition
    ):
        """Returned TaskRun is the same instance the store holds."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("x", [])),
        ):
            run = await execute_task(task)

        persisted = (await store.list_all())[0]
        assert persisted is run

    async def test_run_store_failure_does_not_abort_task(self, task: TaskDefinition, caplog):
        """Broken RunStore must not bubble out of execute_task."""
        set_run_store(_FlakyStore())

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            run = await execute_task(task)

        assert run.status == TaskStatus.SUCCESS
        assert run.response_preview == "ok"
        assert run.finished_at is not None

    async def test_run_store_failure_is_logged_at_error_level(self, task: TaskDefinition, caplog):
        """Store outages log at ERROR so operators still see them."""
        flaky = _FlakyStore()
        set_run_store(flaky)

        with caplog.at_level("ERROR", logger="autonomous_agents"):
            with patch(
                "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
                new=AsyncMock(return_value=("ok", [])),
            ):
                await execute_task(task)

        assert flaky.record_calls == 2
        error_messages = [r.message for r in caplog.records if r.levelname == "ERROR"]
        assert sum("Failed to persist run" in msg for msg in error_messages) == 2

    async def test_run_store_failure_during_finalization_still_returns_completed_run(
        self, task: TaskDefinition,
    ):
        """Terminal record() failure still returns a fully-populated TaskRun."""
        set_run_store(_FlakyStore())

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("hello", [])),
        ):
            run = await execute_task(task)

        assert run.status == TaskStatus.SUCCESS
        assert run.response_preview == "hello"
        assert run.finished_at is not None


class TestChatHistoryPublisher:
    """On terminal status, ``execute_task`` fans out to the configured publisher."""

    async def test_successful_run_is_published_with_response(
        self, store: _DictRunStore, publisher: _RecordingPublisher, cron_task: TaskDefinition,
    ):
        """SUCCESS terminal state publishes prompt, response, agent, and conversation_id."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("here are the PRs", [])),
        ):
            run = await execute_task(cron_task)

        assert run.status == TaskStatus.SUCCESS
        assert len(publisher.calls) == 1
        call = publisher.calls[0]
        assert call["run_id"] == run.run_id
        assert call["status"] == TaskStatus.SUCCESS
        assert call["prompt"] == "list open PRs"
        assert call["response"] == "here are the PRs"
        assert call["error"] is None
        assert call["agent"] == "agent-x"
        assert call["conversation_id"] == run.conversation_id

    async def test_failed_run_is_published_with_error(
        self, store: _DictRunStore, publisher: _RecordingPublisher, cron_task: TaskDefinition,
    ):
        """FAILED terminal state publishes error message, no response."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(side_effect=RuntimeError("runtime down")),
        ):
            run = await execute_task(cron_task)

        assert run.status == TaskStatus.FAILED
        assert len(publisher.calls) == 1
        call = publisher.calls[0]
        assert call["status"] == TaskStatus.FAILED
        assert call["response"] is None
        assert call["error"] == "runtime down"

    async def test_conversation_id_is_set_on_taskrun_and_matches_derivation(
        self, store: _DictRunStore, publisher: _RecordingPublisher, cron_task: TaskDefinition,
    ):
        """conversation_id is per-task; persisted run carries the same id the publisher saw."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            run = await execute_task(cron_task)

        assert run.conversation_id is not None
        assert run.conversation_id == conversation_id_for_task(cron_task.id)
        persisted = (await store.list_all())[0]
        assert persisted.conversation_id == run.conversation_id

    async def test_webhook_context_is_redacted_in_published_prompt_by_default(
        self, store: _DictRunStore, publisher: _RecordingPublisher, cron_task: TaskDefinition,
    ):
        """By default, webhook payloads are redacted (only a marker is left)."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            await execute_task(cron_task, context={"event": "pull_request.opened", "pr": 42})

        assert len(publisher.calls) == 1
        prompt = publisher.calls[0]["prompt"]
        assert prompt.startswith("list open PRs")
        assert "Context: <redacted" in prompt
        assert "pull_request.opened" not in prompt
        assert "42" not in prompt

    async def test_webhook_context_is_inlined_when_opted_in(
        self, store: _DictRunStore, publisher: _RecordingPublisher, cron_task: TaskDefinition,
        monkeypatch,
    ):
        """``CHAT_HISTORY_INCLUDE_CONTEXT=true`` inlines the raw payload."""
        from autonomous_agents.config import get_settings

        get_settings.cache_clear()
        monkeypatch.setenv("CHAT_HISTORY_INCLUDE_CONTEXT", "true")
        try:
            with patch(
                "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
                new=AsyncMock(return_value=("ok", [])),
            ):
                await execute_task(
                    cron_task,
                    context={"event": "pull_request.opened", "pr": 42},
                )

            prompt = publisher.calls[0]["prompt"]
            assert prompt.startswith("list open PRs")
            assert "Context:" in prompt
            assert "pull_request.opened" in prompt
            assert "42" in prompt
        finally:
            get_settings.cache_clear()

    async def test_unserialisable_context_does_not_abort_task(
        self, store: _DictRunStore, publisher: _RecordingPublisher, cron_task: TaskDefinition,
        monkeypatch,
    ):
        """Non-JSON-serialisable webhook payload must not bubble out of execute_task."""
        from autonomous_agents.config import get_settings

        get_settings.cache_clear()
        monkeypatch.setenv("CHAT_HISTORY_INCLUDE_CONTEXT", "true")
        try:
            weird_context = {"sentinel": object()}
            with patch(
                "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
                new=AsyncMock(return_value=("ok", [])),
            ):
                run = await execute_task(cron_task, context=weird_context)
            assert run.status == TaskStatus.SUCCESS
        finally:
            get_settings.cache_clear()

    async def test_publisher_failure_does_not_abort_task(
        self, store: _DictRunStore, cron_task: TaskDefinition,
    ):
        """Broken publisher must not bubble out of execute_task."""
        flaky = _FlakyPublisher()
        set_chat_history_publisher(flaky)

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            run = await execute_task(cron_task)

        assert run.status == TaskStatus.SUCCESS
        assert run.response_preview == "ok"
        assert flaky.calls == 1
        persisted = (await store.list_all())[0]
        assert persisted.status == TaskStatus.SUCCESS

    async def test_publisher_failure_is_logged_at_error_level(
        self, store: _DictRunStore, cron_task: TaskDefinition, caplog,
    ):
        """Chat-publishing failures log at ERROR."""
        set_chat_history_publisher(_FlakyPublisher())

        with caplog.at_level("ERROR", logger="autonomous_agents"):
            with patch(
                "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
                new=AsyncMock(return_value=("ok", [])),
            ):
                await execute_task(cron_task)

        error_messages = [r.message for r in caplog.records if r.levelname == "ERROR"]
        assert any("Failed to publish run" in msg for msg in error_messages)

    async def test_default_publisher_is_noop_when_unset(
        self, store: _DictRunStore, cron_task: TaskDefinition,
    ):
        """Disabled publishing runs normally without advertising a chat link."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            run = await execute_task(cron_task)
        assert run.status == TaskStatus.SUCCESS
        assert run.conversation_id is None

    async def test_disabled_publisher_keeps_internal_dynamic_agent_conversation_id(
        self, store: _DictRunStore, cron_task: TaskDefinition,
    ):
        """The runtime context id remains stable even when no UI chat is published."""
        invoke = AsyncMock(return_value=("ok", []))
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=invoke,
        ):
            await execute_task(cron_task)

        assert invoke.await_args.kwargs["conversation_id"] == conversation_id_for_task(
            cron_task.id
        )


class TestFollowUp:
    """Inbound bridges re-fire webhook tasks; ``execute_task`` augments prompt and links parent."""

    def test_augment_prompt_returns_base_when_followup_is_none(self):
        """No follow-up => prompt is returned unchanged."""
        assert _augment_prompt_for_followup("hello", None) == "hello"

    def test_augment_prompt_appends_clearly_labelled_section(self):
        """Augmented prompt has a visually distinct ``Operator follow-up`` section."""
        augmented = _augment_prompt_for_followup(
            "Original task body.",
            FollowUpContext(
                parent_run_id="r-prev",
                user_text="dig deeper into the auth path",
                user_ref="alice@example.com",
                transport="webex",
            ),
        )
        assert augmented.startswith("Original task body.")
        assert "Operator follow-up (webex, from alice@example.com," in augmented
        assert "in reply to run r-prev" in augmented
        assert augmented.rstrip().endswith("dig deeper into the auth path")

    def test_augment_prompt_falls_back_to_generic_labels_when_metadata_missing(self):
        """Missing transport/user_ref render as generic labels."""
        augmented = _augment_prompt_for_followup(
            "Body.",
            FollowUpContext(parent_run_id="r-prev", user_text="please retry"),
        )
        assert "Operator follow-up (follow-up, from operator," in augmented

    async def test_execute_task_followup_records_parent_run_id(
        self, store: _DictRunStore, webhook_task: TaskDefinition
    ):
        """Follow-up run persists with ``parent_run_id`` set."""
        follow_up = FollowUpContext(
            parent_run_id="r-original",
            user_text="please retry verbosely",
            user_ref="alice@example.com",
            transport="webex",
        )

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            run = await execute_task(webhook_task, context={}, follow_up=follow_up)

        assert run.status == TaskStatus.SUCCESS
        assert run.parent_run_id == "r-original"
        assert run.request_prompt is not None
        assert "please retry verbosely" in run.request_prompt

        persisted = (await store.list_all())[0]
        assert persisted.parent_run_id == "r-original"
        assert persisted.request_prompt is not None
        assert "please retry verbosely" in persisted.request_prompt

    async def test_execute_task_followup_passes_augmented_prompt_to_a2a(
        self, store: _DictRunStore, webhook_task: TaskDefinition
    ):
        """Augmented prompt (with follow-up section) reaches the A2A client."""
        follow_up = FollowUpContext(
            parent_run_id="r-original",
            user_text="extra context: it's a 500 not a 404",
            transport="webex",
        )

        captured = {}

        async def fake_streaming(**kwargs):
            captured.update(kwargs)
            return ("ok", [])

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(side_effect=fake_streaming),
        ):
            await execute_task(webhook_task, context={}, follow_up=follow_up)

        assert captured["prompt"].startswith("Triage the inbound issue.")
        assert "Operator follow-up" in captured["prompt"]
        assert "extra context: it's a 500 not a 404" in captured["prompt"]

    async def test_webhook_followup_is_never_published_to_chat(
        self,
        store: _DictRunStore,
        publisher: _RecordingPublisher,
        webhook_task: TaskDefinition,
    ):
        """Webhook runs stay in Autonomous run history and never enter chat."""
        follow_up = FollowUpContext(
            parent_run_id="r-original",
            user_text="webex says this is still failing",
            user_ref="alice@example.com",
            transport="webex",
        )

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            await execute_task(webhook_task, context={}, follow_up=follow_up)

        assert publisher.calls == []

    async def test_execute_task_followup_does_not_mutate_task_definition(
        self, store: _DictRunStore, webhook_task: TaskDefinition
    ):
        """Augmentation works on a model_copy, never on the persisted task."""
        original_prompt = webhook_task.prompt
        follow_up = FollowUpContext(parent_run_id="r-original", user_text="hi")

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            await execute_task(webhook_task, context={}, follow_up=follow_up)

        assert webhook_task.prompt == original_prompt

    async def test_fire_webhook_task_forwards_follow_up(
        self, store: _DictRunStore, webhook_task: TaskDefinition
    ):
        """``fire_webhook_task`` forwards ``follow_up`` to ``execute_task``."""
        follow_up = FollowUpContext(parent_run_id="r-original", user_text="x")

        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            run = await fire_webhook_task(
                webhook_task, context={}, follow_up=follow_up
            )

        assert run.parent_run_id == "r-original"

    async def test_execute_task_without_follow_up_leaves_parent_run_id_none(
        self, store: _DictRunStore, webhook_task: TaskDefinition
    ):
        """First-fire / cron / interval runs carry no parent."""
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=AsyncMock(return_value=("ok", [])),
        ):
            run = await execute_task(webhook_task)

        assert run.parent_run_id is None

    async def test_initial_webhook_deliveries_use_isolated_execution_contexts(
        self, store: _DictRunStore, webhook_task: TaskDefinition
    ):
        """Separate deliveries for one task never share model/checkpointer state."""
        invoke = AsyncMock(return_value=("ok", []))
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=invoke,
        ):
            first = await execute_task(webhook_task, run_id="delivery-1")
            second = await execute_task(webhook_task, run_id="delivery-2")

        first_context = invoke.await_args_list[0].kwargs["conversation_id"]
        second_context = invoke.await_args_list[1].kwargs["conversation_id"]
        assert first_context == conversation_id_for_webhook_run(
            webhook_task.id, "delivery-1"
        )
        assert second_context == conversation_id_for_webhook_run(
            webhook_task.id, "delivery-2"
        )
        assert first_context != second_context
        assert first.root_run_id == "delivery-1"
        assert second.root_run_id == "delivery-2"

    async def test_webhook_followup_reuses_only_selected_run_context(
        self, store: _DictRunStore, webhook_task: TaskDefinition
    ):
        """A follow-up inherits its parent delivery's isolated context."""
        invoke = AsyncMock(return_value=("ok", []))
        with patch(
            "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
            new=invoke,
        ):
            parent = await execute_task(webhook_task, run_id="delivery-root")
            follow_up = await execute_task(
                webhook_task,
                follow_up=FollowUpContext(
                    parent_run_id=parent.run_id,
                    user_text="look more closely",
                    transport="webui",
                ),
                run_id="delivery-follow-up",
            )

        assert follow_up.parent_run_id == parent.run_id
        assert follow_up.root_run_id == parent.run_id
        assert follow_up.execution_context_id == parent.execution_context_id
        assert invoke.await_args_list[1].kwargs["conversation_id"] == (
            parent.execution_context_id
        )


def _job_task(
    task_id: str = "t1",
    *,
    enabled: bool = True,
    trigger=None,
) -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name=f"Task {task_id}",
        dynamic_agent_id="agent-x",
        prompt="hello",
        trigger=trigger or CronTrigger(schedule="0 9 * * *"),
        enabled=enabled,
    )


@pytest.fixture
async def _fresh_scheduler():
    """Reset the module-level APScheduler singleton, started paused."""
    import autonomous_agents.services.scheduler as scheduler_mod

    scheduler_mod._scheduler = None
    sched = scheduler_mod.get_scheduler()
    sched.start(paused=True)
    yield
    if scheduler_mod._scheduler is not None and scheduler_mod._scheduler.running:
        scheduler_mod._scheduler.shutdown(wait=False)
    scheduler_mod._scheduler = None


class TestHotReload:
    """Scheduler helpers keep APScheduler in sync with UI CRUD edits."""

    @pytest.mark.asyncio
    async def test_register_scheduler_task_adds_cron_job(self, _fresh_scheduler):
        """Cron task lands as an APScheduler job."""
        register_scheduler_task(_job_task("cron-1", trigger=CronTrigger(schedule="*/30 * * * *")))

        jobs = get_scheduler().get_jobs()
        assert [j.id for j in jobs] == ["cron-1"]

    @pytest.mark.asyncio
    async def test_register_scheduler_task_adds_interval_job(self, _fresh_scheduler):
        """Interval task lands as an APScheduler job."""
        register_scheduler_task(_job_task("int-1", trigger=IntervalTrigger(minutes=30)))

        jobs = get_scheduler().get_jobs()
        assert [j.id for j in jobs] == ["int-1"]

    @pytest.mark.asyncio
    async def test_register_scheduler_task_skips_webhook_trigger(self, _fresh_scheduler):
        """Webhook tasks never enter the APScheduler jobstore."""
        register_scheduler_task(_job_task("hook-1", trigger=WebhookTrigger()))

        assert get_scheduler().get_jobs() == []

    @pytest.mark.asyncio
    async def test_register_scheduler_task_skips_disabled_task(self, _fresh_scheduler):
        """Disabled tasks are not scheduled."""
        register_scheduler_task(_job_task("dis-1", enabled=False))

        assert get_scheduler().get_jobs() == []

    @pytest.mark.asyncio
    async def test_register_scheduler_task_is_idempotent_for_same_id(self, _fresh_scheduler):
        """Re-registering the same id swaps the job atomically."""
        register_scheduler_task(_job_task("t1", trigger=CronTrigger(schedule="0 9 * * *")))
        register_scheduler_task(_job_task("t1", trigger=CronTrigger(schedule="0 18 * * *")))

        jobs = get_scheduler().get_jobs()
        assert len(jobs) == 1
        assert jobs[0].id == "t1"

    @pytest.mark.asyncio
    async def test_register_scheduler_task_replaces_trigger_on_re_register(self, _fresh_scheduler):
        """Re-registering swaps the underlying trigger spec."""
        register_scheduler_task(_job_task("t1", trigger=CronTrigger(schedule="0 9 * * *")))
        first_trigger = get_scheduler().get_job("t1").trigger

        register_scheduler_task(_job_task("t1", trigger=IntervalTrigger(minutes=60)))
        second_trigger = get_scheduler().get_job("t1").trigger

        assert type(first_trigger).__name__ == "CronTrigger"
        assert type(second_trigger).__name__ == "IntervalTrigger"

    @pytest.mark.asyncio
    async def test_unregister_scheduler_task_removes_existing_job(self, _fresh_scheduler):
        """``unregister_scheduler_task`` removes the matching APScheduler job."""
        register_scheduler_task(_job_task("t1"))

        removed = unregister_scheduler_task("t1")

        assert removed is True
        assert get_scheduler().get_jobs() == []

    @pytest.mark.asyncio
    async def test_unregister_scheduler_task_returns_false_for_unknown_id(self, _fresh_scheduler):
        """Unknown id returns False; never raises."""
        assert unregister_scheduler_task("ghost") is False

    @pytest.mark.asyncio
    async def test_unregister_then_register_round_trip(self, _fresh_scheduler):
        """Delete-then-create lands a single fresh job."""
        register_scheduler_task(_job_task("t1"))
        assert unregister_scheduler_task("t1") is True

        register_scheduler_task(_job_task("t1", trigger=IntervalTrigger(hours=1)))

        jobs = get_scheduler().get_jobs()
        assert len(jobs) == 1
        assert jobs[0].id == "t1"

    @pytest.mark.asyncio
    async def test_register_scheduler_tasks_bulk_keeps_scheduler_running(self, _fresh_scheduler):
        """Bulk register adds every cron/interval entry and leaves the scheduler running."""
        tasks = [
            _job_task("cron-1", trigger=CronTrigger(schedule="0 * * * *")),
            _job_task("int-1", trigger=IntervalTrigger(minutes=30)),
            _job_task("hook-1", trigger=WebhookTrigger()),
            _job_task("dis-1", enabled=False),
        ]

        register_scheduler_tasks(tasks)

        scheduler = get_scheduler()
        assert {j.id for j in scheduler.get_jobs()} == {"cron-1", "int-1"}
        assert scheduler.running is True

    @pytest.mark.asyncio
    async def test_bulk_registration_skips_existing_task_below_frequency_floor(
        self, _fresh_scheduler, caplog
    ):
        tasks = [
            _job_task("safe", trigger=IntervalTrigger(minutes=30)),
            _job_task("too-fast", trigger=IntervalTrigger(minutes=5)),
        ]

        register_scheduler_tasks(tasks)

        assert {job.id for job in get_scheduler().get_jobs()} == {"safe"}
        assert "Schedule rejected during startup" in caplog.text

    @pytest.mark.asyncio
    async def test_register_scheduler_task_detaches_existing_job_when_disabled(self, _fresh_scheduler):
        """Re-registering with ``enabled=False`` actively pulls the prior job."""
        register_scheduler_task(_job_task("t1", trigger=CronTrigger(schedule="0 9 * * *")))
        assert get_scheduler().get_job("t1") is not None

        register_scheduler_task(_job_task("t1", enabled=False, trigger=CronTrigger(schedule="0 9 * * *")))

        assert get_scheduler().get_job("t1") is None

    @pytest.mark.asyncio
    async def test_register_scheduler_task_swap_to_webhook_detaches_prior_cron_job(self, _fresh_scheduler):
        """Cron => webhook swap on the same id clears the APScheduler entry."""
        register_scheduler_task(_job_task("t1", trigger=CronTrigger(schedule="0 9 * * *")))
        assert get_scheduler().get_job("t1") is not None

        register_scheduler_task(_job_task("t1", trigger=WebhookTrigger()))

        assert get_scheduler().get_job("t1") is None

    @pytest.mark.asyncio
    async def test_register_scheduler_tasks_does_not_double_start_running_scheduler(self, _fresh_scheduler):
        """A second bulk-register call must not crash the running scheduler."""
        register_scheduler_tasks([_job_task("t1")])
        register_scheduler_tasks([_job_task("t1"), _job_task("t2")])

        scheduler = get_scheduler()
        assert {j.id for j in scheduler.get_jobs()} == {"t1", "t2"}
        assert scheduler.running is True


class TestAutoPauseOnAuthorizationRevoke:
    """A run denied after entitlement/access revocation auto-pauses the task."""

    async def test_authorization_revoked_disables_task_and_fails_run(
        self, store: _DictRunStore, task: TaskDefinition
    ):
        from autonomous_agents.services.dynamic_agents_client import (
            DynamicAgentsAuthorizationRevokedError,
        )

        updated: dict = {}

        class _FakeTaskStore:
            async def update(self, task_id, new_task):
                updated["task_id"] = task_id
                updated["task"] = new_task
                return new_task

        with (
            patch(
                "autonomous_agents.services.task_runner.invoke_dynamic_agent_streaming",
                new=AsyncMock(
                    side_effect=DynamicAgentsAuthorizationRevokedError(
                        "autonomous access revoked for agent 'agent-x'"
                    )
                ),
            ),
            patch(
                "autonomous_agents.services.task_lifecycle.get_task_store",
                return_value=_FakeTaskStore(),
            ),
        ):
            run = await execute_task(task)

        assert run.status == TaskStatus.FAILED
        assert "revoked" in (run.error or "").lower()
        # Auto-paused: the task was persisted with enabled=False.
        assert updated["task_id"] == task.id
        assert updated["task"].enabled is False
