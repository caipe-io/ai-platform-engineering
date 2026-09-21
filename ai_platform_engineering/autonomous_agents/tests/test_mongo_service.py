"""Tests for :class:`autonomous_agents.services.mongo.MongoService`.

Covers lifecycle, task CRUD, run history, chat-history publishing,
the conversation participant routing for custom-agent tasks, the
adapter-Protocol bindings, index creation, and the optional
two-db-one-client split. ``mongomock_motor`` provides the
``AsyncIOMotorClient`` surface so the real code path runs without a
Mongo container.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient

from autonomous_agents.config import Settings
from autonomous_agents.models import (
    CronTrigger,
    IntervalTrigger,
    TaskDefinition,
    TaskRun,
    TaskStatus,
    WebhookTrigger,
)
from autonomous_agents.services.chat_history import conversation_id_for_task
from autonomous_agents.services.mongo import (
    MongoChatHistoryPublisherAdapter,
    MongoRunStoreAdapter,
    MongoService,
    MongoTaskStoreAdapter,
    RunStore,
    TaskAlreadyExistsError,
    TaskNotFoundError,
    TaskStore,
)
from autonomous_agents.services.secret_encryption import (
    WebhookSecretEncryptionError,
    WebhookSecretEnvelope,
    secret_ref_id,
)

_UI_UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_BASE_TIME = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _spaced(index: int) -> datetime:
    """``_BASE_TIME + index seconds`` for above-millisecond ordering."""
    return _BASE_TIME + timedelta(seconds=index)


def _settings(**overrides) -> Settings:
    """Fresh Settings with hermetic test defaults (no env-var pickup)."""
    base = {
        "mongodb_database": "test_autonomous",
        "mongodb_collection": "autonomous_runs",
        "mongodb_tasks_collection": "autonomous_tasks",
        "chat_history_database": None,
        "chat_history_conversations_collection": "conversations",
        "chat_history_messages_collection": "messages",
        "chat_history_owner_email": "autonomous@system",
        "credential_kms_cmk_id": None,
        "credential_kms_region": None,
    }
    base.update(overrides)
    return Settings(**base)


class _FakeSecretProtector:
    """Opaque in-memory protector; real crypto/KMS behavior has focused tests."""

    def __init__(self) -> None:
        self._plaintext_by_token: dict[str, str] = {}

    async def encrypt(
        self, task_id: str, plaintext: str
    ) -> WebhookSecretEnvelope:
        token = f"opaque-{uuid.uuid4()}"
        self._plaintext_by_token[token] = plaintext
        return {
            "secretRefId": secret_ref_id(task_id),
            "algorithm": "AES-256-GCM",
            "ciphertext": token,
            "encryptedDek": "opaque-dek",
            "keyProvider": "aws-kms",
            "cmkId": "alias/test-credentials",
        }

    async def decrypt(self, task_id: str, envelope: dict) -> str:
        assert envelope["secretRefId"] == secret_ref_id(task_id)
        return self._plaintext_by_token[envelope["ciphertext"]]


@pytest.fixture
def service() -> MongoService:
    """Fresh MongoService backed by an in-memory mock client per test."""
    svc = MongoService(
        settings=_settings(), secret_protector=_FakeSecretProtector()
    )
    svc.connect_with_client(AsyncMongoMockClient())
    return svc


def _task(
    task_id: str = "t1",
    *,
    trigger=None,
    enabled: bool = True,
    name: str | None = None,
) -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name=name or f"Task {task_id}",
        agent="github",
        prompt="hello",
        trigger=trigger or CronTrigger(schedule="0 9 * * *"),
        enabled=enabled,
    )


def _make_run(
    run_id: str,
    task_id: str = "t1",
    status: TaskStatus = TaskStatus.RUNNING,
    started_at: datetime | None = None,
) -> TaskRun:
    fields: dict = {
        "run_id": run_id,
        "task_id": task_id,
        "task_name": f"task {task_id}",
        "status": status,
    }
    if started_at is not None:
        fields["started_at"] = started_at
    return TaskRun(**fields)


class TestLifecycle:
    """Connect / disconnect / use-before-connect behaviour."""

    def test_is_connected_false_before_connect(self):
        """Before ``connect`` is called, ``is_connected`` is False."""
        svc = MongoService(settings=_settings())
        assert svc.is_connected is False

    def test_is_connected_true_after_connect_with_client(self):
        """``connect_with_client`` flips ``is_connected`` to True."""
        svc = MongoService(settings=_settings())
        svc.connect_with_client(AsyncMongoMockClient())
        assert svc.is_connected is True

    def test_disconnect_is_idempotent(self):
        """``disconnect`` may be called twice without raising."""
        svc = MongoService(settings=_settings())
        svc.connect_with_client(AsyncMongoMockClient())
        svc.disconnect()
        svc.disconnect()
        assert svc.is_connected is False

    def test_collection_accessors_raise_when_not_connected(self):
        """Use-before-connect raises a clear RuntimeError, not AttributeError."""
        svc = MongoService(settings=_settings())
        with pytest.raises(RuntimeError, match="not connected"):
            svc._tasks()
        with pytest.raises(RuntimeError, match="not connected"):
            svc._runs()
        with pytest.raises(RuntimeError, match="not connected"):
            svc._conversations()

    async def test_connect_refuses_without_mongo_settings(self):
        """``connect()`` returns False (never raises) when URI/DB are missing."""
        svc = MongoService(settings=_settings(mongodb_uri=None, mongodb_database=None))
        assert await svc.connect() is False
        assert svc.is_connected is False


class TestTaskCrud:
    """``create_task`` / ``get_task`` / ``list_tasks`` / ``update_task`` / ``delete_task``."""

    async def test_create_and_get_round_trip(self, service: MongoService):
        """``create_task`` returns the input and ``get_task`` echoes it back."""
        task = _task("t1")
        created = await service.create_task(task)
        assert created == task

        fetched = await service.get_task("t1")
        assert fetched == task

    async def test_get_returns_none_for_missing_task(self, service: MongoService):
        """``get_task`` returns None for unknown ids."""
        assert await service.get_task("ghost") is None

    async def test_create_translates_duplicate_key_to_typed_error(self, service: MongoService):
        """Duplicate id raises ``TaskAlreadyExistsError`` (typed for the API layer)."""
        await service.create_task(_task("t1"))
        with pytest.raises(TaskAlreadyExistsError) as exc:
            await service.create_task(_task("t1"))
        assert exc.value.task_id == "t1"

    async def test_list_tasks_sorted_by_id(self, service: MongoService):
        """``list_tasks`` returns documents sorted by id ascending."""
        for tid in ("zeta", "alpha", "mu"):
            await service.create_task(_task(tid))
        listed = await service.list_tasks()
        assert [t.id for t in listed] == ["alpha", "mu", "zeta"]

    async def test_update_replaces_in_place(self, service: MongoService):
        """``update_task`` swaps the stored document in place."""
        await service.create_task(_task("t1"))
        new_version = TaskDefinition(
            id="t1",
            name="Renamed",
            agent="argocd",
            prompt="updated",
            trigger=IntervalTrigger(minutes=5),
            enabled=False,
        )
        returned = await service.update_task("t1", new_version)
        assert returned == new_version

        fetched = await service.get_task("t1")
        assert fetched is not None
        assert fetched.name == "Renamed"
        assert fetched.agent == "argocd"
        assert fetched.enabled is False

    async def test_update_rejects_id_mismatch(self, service: MongoService):
        """Mismatched path id vs body id raises ValueError."""
        await service.create_task(_task("t1"))
        with pytest.raises(ValueError, match="does not match"):
            await service.update_task("t1", _task("t2"))

    async def test_update_raises_when_target_missing(self, service: MongoService):
        """``update_task`` on a missing id raises and never upserts."""
        with pytest.raises(TaskNotFoundError) as exc:
            await service.update_task("ghost", _task("ghost"))
        assert exc.value.task_id == "ghost"
        assert await service.get_task("ghost") is None

    async def test_delete_removes_document(self, service: MongoService):
        """``delete_task`` removes only the targeted row."""
        await service.create_task(_task("t1"))
        await service.create_task(_task("t2"))
        await service.delete_task("t1")

        assert await service.get_task("t1") is None
        assert await service.get_task("t2") is not None

    async def test_delete_purges_runs_and_chat_history_for_reused_task_id(self, service: MongoService):
        """``delete_task`` cascades to runs + chat history so a recreated task starts clean."""
        task = _task("t1")
        await service.create_task(task)

        run = _make_run("r1", task_id="t1", status=TaskStatus.SUCCESS)
        run.response_preview = "old response"
        await service.record_run(run)
        await service.publish_creation_intent(task)
        await service.publish_preflight_ack(
            task,
            {
                "ack_status": "ok",
                "ack_detail": "ready",
                "dry_run_summary": "old summary",
                "ack_at": _spaced(1).isoformat(),
            },
        )

        conv_id = conversation_id_for_task("t1")
        assert await service._runs().count_documents({"task_id": "t1"}) == 1
        assert await service._conversations().count_documents({"_id": conv_id}) == 1
        assert await service._messages().count_documents({"conversation_id": conv_id}) == 2

        await service.delete_task("t1")

        assert await service._runs().count_documents({"task_id": "t1"}) == 0
        assert await service._conversations().count_documents({"_id": conv_id}) == 0
        assert await service._messages().count_documents({"conversation_id": conv_id}) == 0

        recreated = _task("t1", name="Replacement task")
        await service.create_task(recreated)
        await service.publish_creation_intent(recreated)

        assert await service._runs().count_documents({"task_id": "t1"}) == 0
        assert await service._conversations().count_documents({"_id": conv_id}) == 1
        messages = [
            doc async for doc in service._messages().find(
                {"conversation_id": conv_id},
                sort=[("created_at", 1), ("message_id", 1)],
            )
        ]
        assert len(messages) == 1
        assert messages[0]["message_id"] == "task:t1:creation_intent"
        assert "Replacement task" in messages[0]["content"]

    async def test_delete_raises_when_target_missing(self, service: MongoService):
        """``delete_task`` on a missing id raises ``TaskNotFoundError``."""
        with pytest.raises(TaskNotFoundError) as exc:
            await service.delete_task("ghost")
        assert exc.value.task_id == "ghost"

    async def test_round_trip_preserves_all_trigger_types(self, service: MongoService):
        """Cron / interval / webhook trigger discriminators all survive the round trip."""
        cron = _task("cron-1", trigger=CronTrigger(schedule="*/5 * * * *"))
        interval = _task("interval-1", trigger=IntervalTrigger(seconds=30))
        webhook = _task("webhook-1", trigger=WebhookTrigger(secret="sssh"))
        for t in (cron, interval, webhook):
            await service.create_task(t)

        assert (await service.get_task("cron-1")).trigger == cron.trigger
        assert (await service.get_task("interval-1")).trigger == interval.trigger
        assert (await service.get_task("webhook-1")).trigger == webhook.trigger

    async def test_webhook_secret_is_never_stored_as_plaintext(
        self, service: MongoService
    ):
        """New task writes replace trigger.secret with an encrypted envelope."""
        await service.create_task(
            _task("webhook-encrypted", trigger=WebhookTrigger(secret="very-secret"))
        )

        stored = await service._tasks().find_one({"_id": "webhook-encrypted"})
        assert "secret" not in stored["trigger"]
        assert stored["trigger"]["secret_envelope"]["keyProvider"] == "aws-kms"
        assert "very-secret" not in repr(stored)
        fetched = await service.get_task("webhook-encrypted")
        assert fetched.trigger.secret == "very-secret"

    async def test_per_task_secret_fails_closed_without_kms(self):
        """Missing KMS config must never fall back to a plaintext Mongo write."""
        svc = MongoService(settings=_settings())
        svc.connect_with_client(AsyncMongoMockClient())

        with pytest.raises(WebhookSecretEncryptionError, match="CREDENTIAL_KMS_CMK_ID"):
            await svc.create_task(
                _task("no-kms", trigger=WebhookTrigger(secret="must-not-leak"))
            )
        assert await svc._tasks().count_documents({}) == 0

    async def test_task_without_per_task_secret_does_not_require_kms(self):
        """Cron and unsigned/global-fallback webhook tasks remain usable."""
        svc = MongoService(settings=_settings())
        svc.connect_with_client(AsyncMongoMockClient())

        await svc.create_task(_task("cron-no-kms"))
        await svc.create_task(
            _task("webhook-no-kms", trigger=WebhookTrigger(secret=None))
        )
        assert len(await svc.list_tasks()) == 2


class TestRunHistory:
    """``record_run`` / ``list_runs`` / ``list_runs_by_task`` semantics."""

    async def test_record_run_upserts_in_place(self, service: MongoService):
        """RUNNING => SUCCESS upserts the same row instead of inserting two."""
        await service.record_run(_make_run("r1", status=TaskStatus.RUNNING))
        updated = _make_run("r1", status=TaskStatus.SUCCESS)
        updated.response_preview = "ok"
        await service.record_run(updated)

        runs = await service.list_runs()
        assert len(runs) == 1
        assert runs[0].status == TaskStatus.SUCCESS
        assert runs[0].response_preview == "ok"

    async def test_list_runs_newest_first(self, service: MongoService):
        """``list_runs`` returns rows newest-first."""
        for i in range(3):
            await service.record_run(_make_run(f"r{i}", started_at=_spaced(i)))
        runs = await service.list_runs()
        assert [r.run_id for r in runs] == ["r2", "r1", "r0"]

    async def test_list_runs_by_task_filters_and_orders(self, service: MongoService):
        """``list_runs_by_task`` filters by task and orders newest-first."""
        await service.record_run(_make_run("a1", task_id="alpha", started_at=_spaced(0)))
        await service.record_run(_make_run("b1", task_id="beta", started_at=_spaced(1)))
        await service.record_run(_make_run("a2", task_id="alpha", started_at=_spaced(2)))

        alphas = await service.list_runs_by_task("alpha")
        assert [r.run_id for r in alphas] == ["a2", "a1"]

        betas = await service.list_runs_by_task("beta")
        assert [r.run_id for r in betas] == ["b1"]

    async def test_list_runs_by_task_empty_for_unknown_task(self, service: MongoService):
        """Unknown task returns an empty list."""
        await service.record_run(_make_run("r1", task_id="alpha"))
        assert await service.list_runs_by_task("does-not-exist") == []

    async def test_list_runs_respects_limit(self, service: MongoService):
        """``limit`` caps the number of returned rows."""
        for i in range(5):
            await service.record_run(_make_run(f"r{i}", started_at=_spaced(i)))
        assert len(await service.list_runs(limit=3)) == 3

    async def test_zero_or_negative_limit_returns_empty_list(self, service: MongoService):
        """Zero / negative ``limit`` returns an empty list (no exception)."""
        await service.record_run(_make_run("r1"))
        assert await service.list_runs(limit=0) == []
        assert await service.list_runs(limit=-1) == []
        assert await service.list_runs_by_task("t1", limit=0) == []


class TestChatHistory:
    """``publish_run`` / ``publish_creation_intent`` / ``publish_preflight_ack`` write to chat history."""

    async def test_publish_run_writes_one_conversation_two_messages(self, service: MongoService):
        """Each run publishes one conversation and one user/assistant message pair."""
        run = TaskRun(
            run_id="run-001",
            task_id="weekly-prs",
            task_name="Weekly PR Review",
            status=TaskStatus.SUCCESS,
            started_at=_spaced(0),
            finished_at=_spaced(1),
            response_preview="here",
        )
        await service.publish_run(
            run,
            prompt="list open prs",
            response="here they are",
            error=None,
            agent="github",
        )
        convs = [doc async for doc in service._conversations().find({})]
        msgs = [doc async for doc in service._messages().find({})]
        assert len(convs) == 1
        assert len(msgs) == 2

    async def test_conversation_id_matches_ui_uuid_shape(self, service: MongoService):
        """Derived conversation id matches the UI's ``validateUUID`` regex."""
        cid = conversation_id_for_task(str(uuid.uuid4()))
        assert _UI_UUID_REGEX.match(cid), f"derived id {cid!r} fails UI UUID regex"

    async def test_conversation_document_carries_required_ui_fields(self, service: MongoService):
        """Conversation doc carries every field the UI's chat list / detail pages render."""
        run = TaskRun(
            run_id="r1",
            task_id="weekly-prs",
            task_name="Weekly PR Review",
            status=TaskStatus.SUCCESS,
            started_at=_spaced(0),
            finished_at=_spaced(1),
        )
        await service.publish_run(
            run,
            prompt="hello",
            response="world",
            error=None,
            agent="github",
        )
        conv = await service._conversations().find_one({})
        assert _UI_UUID_REGEX.match(conv["_id"])
        assert conv["source"] == "autonomous"
        assert conv["owner_id"] == "autonomous@system"
        assert conv["agent_id"] == "github"
        assert conv["task_id"] == "weekly-prs"
        assert conv["metadata"]["task_name"] == "Weekly PR Review"
        assert "autonomous" in conv["tags"]
        assert "weekly-prs" in conv["tags"]
        assert conv["is_archived"] is False
        assert conv["is_pinned"] is False
        assert conv["participants"] == [
            {"type": "user", "id": "autonomous@system"},
            {"type": "agent", "id": "github"},
        ]

    async def test_publish_run_is_idempotent_across_status_transitions(self, service: MongoService):
        """RUNNING => SUCCESS overwrites the existing message slots; no duplicates."""
        run = TaskRun(
            run_id="r1",
            task_id="t1",
            task_name="t1",
            status=TaskStatus.RUNNING,
            started_at=_spaced(0),
        )
        await service.publish_run(
            run, prompt="hello", response=None, error=None, agent="github"
        )
        run.status = TaskStatus.SUCCESS
        run.response_preview = "world"
        await service.publish_run(
            run, prompt="hello", response="world", error=None, agent="github"
        )

        convs = [doc async for doc in service._conversations().find({})]
        msgs = [doc async for doc in service._messages().find({})]
        assert len(convs) == 1
        assert len(msgs) == 2

        assistant = await service._messages().find_one({"role": "assistant"})
        assert assistant["content"] == "world"
        assert assistant["metadata"]["is_final"] is True

    async def test_failed_run_assistant_message_carries_error_text(self, service: MongoService):
        """Failed runs surface the error text in the assistant message."""
        run = TaskRun(
            run_id="r-fail",
            task_id="t1",
            task_name="t1",
            status=TaskStatus.FAILED,
            started_at=_spaced(0),
            error="boom",
        )
        await service.publish_run(
            run, prompt="please work", response=None, error="boom", agent="github"
        )
        assistant = await service._messages().find_one({"role": "assistant"})
        assert "boom" in assistant["content"]
        assert assistant["metadata"]["is_final"] is True

    async def test_publish_creation_intent_and_preflight_ack(self, service: MongoService):
        """Creation-intent + preflight-ack land on the same per-task conversation with kind metadata."""
        task = _task("form-task")
        await service.publish_creation_intent(task)
        await service.publish_preflight_ack(
            task,
            {
                "ack_status": "accepted",
                "ack_detail": "Looks good.",
                "dry_run_summary": "Will ping GitHub for recent PRs.",
                "ack_at": "2026-04-20T10:00:00Z",
            },
        )
        convs = [doc async for doc in service._conversations().find({})]
        msgs = [doc async for doc in service._messages().find({}).sort("created_at", 1)]
        assert len(convs) == 1
        assert convs[0]["_id"] == conversation_id_for_task("form-task")
        kinds = [m["metadata"]["kind"] for m in msgs]
        assert "creation_intent" in kinds
        assert "preflight_ack" in kinds


class TestConversationParticipants:
    """``participants`` drives the UI's follow-up routing for autonomous chats."""

    async def test_publish_run_writes_participants_for_supervisor_task(self, service: MongoService):
        """Supervisor tasks land an agent participant matching ``agent``."""
        run = TaskRun(
            run_id="r1",
            task_id="t-sup",
            task_name="Supervisor task",
            status=TaskStatus.SUCCESS,
            started_at=_spaced(0),
            finished_at=_spaced(1),
        )
        await service.publish_run(
            run,
            prompt="hello",
            response="world",
            error=None,
            agent="github",
        )
        conv = await service._conversations().find_one({})
        assert conv["agent_id"] == "github"
        assert conv["participants"] == [
            {"type": "user", "id": "autonomous@system"},
            {"type": "agent", "id": "github"},
        ]

    async def test_publish_creation_intent_prefers_dynamic_agent_id_over_agent(self, service: MongoService):
        """``dynamic_agent_id`` wins over ``agent`` for the participant routing target."""
        task = TaskDefinition(
            id="custom-task",
            name="Custom Task",
            agent=None,
            dynamic_agent_id="my_custom_agent",
            prompt="do the thing",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )
        await service.publish_creation_intent(task)

        conv = await service._conversations().find_one({})
        assert conv["agent_id"] == "my_custom_agent"
        assert conv["participants"] == [
            {"type": "user", "id": "autonomous@system"},
            {"type": "agent", "id": "my_custom_agent"},
        ]

        mixed = TaskDefinition(
            id="mixed-task",
            name="Mixed Task",
            agent="github",
            dynamic_agent_id="my_custom_agent",
            prompt="do the thing",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )
        await service.publish_creation_intent(mixed)
        mixed_conv = await service._conversations().find_one(
            {"_id": conversation_id_for_task("mixed-task")}
        )
        assert mixed_conv["agent_id"] == "my_custom_agent"
        assert {"type": "agent", "id": "my_custom_agent"} in mixed_conv["participants"]

    async def test_upsert_conversation_omits_agent_participant_when_no_routing_target(self, service: MongoService):
        """No ``agent`` and no ``dynamic_agent_id`` => only the user participant is written."""
        task = TaskDefinition(
            id="router-task",
            name="Router-decides Task",
            agent=None,
            dynamic_agent_id=None,
            prompt="figure it out",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )
        await service.publish_creation_intent(task)

        conv = await service._conversations().find_one({})
        assert conv["agent_id"] is None
        assert conv["participants"] == [
            {"type": "user", "id": "autonomous@system"},
        ]


class TestAdapters:
    """Mongo adapters satisfy the TaskStore / RunStore / ChatHistoryPublisher Protocols."""

    def test_adapters_satisfy_protocols(self, service: MongoService):
        """Adapter instances pass ``isinstance`` against their Protocol."""
        assert isinstance(MongoTaskStoreAdapter(service), TaskStore)
        assert isinstance(MongoRunStoreAdapter(service), RunStore)
        from autonomous_agents.services.chat_history import ChatHistoryPublisher

        assert isinstance(MongoChatHistoryPublisherAdapter(service), ChatHistoryPublisher)

    async def test_task_store_adapter_delegates_to_service(self, service: MongoService):
        """TaskStore adapter forwards to the service."""
        adapter = MongoTaskStoreAdapter(service)
        await adapter.create(_task("t1"))
        got = await adapter.get("t1")
        assert got is not None and got.id == "t1"
        assert len(await adapter.list_all()) == 1
        await adapter.delete("t1")
        assert await adapter.get("t1") is None

    async def test_run_store_adapter_delegates_to_service(self, service: MongoService):
        """RunStore adapter forwards to the service."""
        adapter = MongoRunStoreAdapter(service)
        await adapter.record(_make_run("r1", started_at=_spaced(0)))
        await adapter.record(_make_run("r2", started_at=_spaced(1)))
        all_runs = await adapter.list_all()
        assert [r.run_id for r in all_runs] == ["r2", "r1"]

    async def test_chat_publisher_adapter_delegates_to_service(self, service: MongoService):
        """ChatHistoryPublisher adapter forwards to the service."""
        adapter = MongoChatHistoryPublisherAdapter(service)
        run = TaskRun(
            run_id="r1",
            task_id="t1",
            task_name="t1",
            status=TaskStatus.SUCCESS,
            started_at=_spaced(0),
        )
        await adapter.publish_run(
            run, prompt="hi", response="hello", error=None, agent="github"
        )
        assert await service._messages().count_documents({}) == 2


class TestIndexes:
    """``_ensure_indexes`` creates the indexes the read paths depend on."""

    async def test_creates_required_run_and_chat_indexes(self, service: MongoService):
        """``_ensure_indexes`` creates the run-history and chat-history indexes."""
        await service._ensure_indexes()

        runs_info = await service._runs().index_information()
        run_keys = {tuple(idx["key"]) for idx in runs_info.values()}
        assert (("task_id", 1), ("started_at", -1)) in run_keys
        assert (("started_at", -1),) in run_keys

        conv_info = await service._conversations().index_information()
        conv_keys = {tuple(idx["key"]) for idx in conv_info.values()}
        assert (("source", 1), ("updated_at", -1)) in conv_keys
        assert (("run_id", 1),) in conv_keys

        msg_info = await service._messages().index_information()
        msg_keys = {tuple(idx["key"]) for idx in msg_info.values()}
        assert (("conversation_id", 1), ("message_id", 1)) in msg_keys

    async def test_is_idempotent(self, service: MongoService):
        """Calling ``_ensure_indexes`` twice does not raise."""
        await service._ensure_indexes()
        await service._ensure_indexes()


class TestTwoDbOneClient:
    """``CHAT_HISTORY_DATABASE`` pins chat collections at a separate DB on the same client."""

    def test_chat_db_overrides_primary_when_set(self):
        """Distinct primary / chat db names share the same client."""
        svc = MongoService(
            settings=_settings(
                mongodb_database="primary",
                chat_history_database="chat_only",
            )
        )
        client = AsyncMongoMockClient()
        svc.connect_with_client(client)
        assert svc._primary_db.name == "primary"
        assert svc._chat_db.name == "chat_only"
        assert svc._client is client

    def test_chat_db_falls_back_to_primary_when_unset(self):
        """Unset ``chat_history_database`` falls back to the primary DB."""
        svc = MongoService(
            settings=_settings(
                mongodb_database="primary",
                chat_history_database=None,
            )
        )
        svc.connect_with_client(AsyncMongoMockClient())
        assert svc._primary_db.name == "primary"
        assert svc._chat_db.name == "primary"


class TestChatHistoryPublisherOwnership:
    """Verify conversation ownership is scoped to the task owner via TaskRun.owner_id."""

    async def test_publish_run_sets_owner_id_to_task_owner(self, service: MongoService):
        """When run has owner_id (copied from task), the conversation is created with that email."""
        run = TaskRun(
            run_id="run-1",
            task_id="task-with-owner",
            task_name="Owned Task",
            status=TaskStatus.SUCCESS,
            owner_id="alice@example.com",
        )

        await service.publish_run(
            run,
            prompt="do something",
            response="done",
            error=None,
            agent=None,
        )

        conv = await service._conversations().find_one(
            {"_id": conversation_id_for_task("task-with-owner")}
        )
        assert conv is not None
        assert conv["owner_id"] == "alice@example.com"
        assert conv["owner_id"] != "autonomous@system"

    async def test_publish_run_falls_back_to_system_email_when_no_owner(
        self, service: MongoService
    ):
        """When run has no owner_id (legacy task), falls back to chat_history_owner_email."""
        run = TaskRun(
            run_id="run-2",
            task_id="legacy-task",
            task_name="Legacy Task",
            status=TaskStatus.SUCCESS,
            # owner_id intentionally absent (legacy run)
        )

        await service.publish_run(
            run,
            prompt="do something",
            response="done",
            error=None,
            agent=None,
        )

        conv = await service._conversations().find_one(
            {"_id": conversation_id_for_task("legacy-task")}
        )
        assert conv is not None
        assert conv["owner_id"] == "autonomous@system"  # fallback sentinel

    async def test_participants_use_task_owner_email(self, service: MongoService):
        """The user participant in a conversation uses the task owner's email, not the system sentinel."""
        run = TaskRun(
            run_id="run-3",
            task_id="owned-task",
            task_name="Owned Task",
            status=TaskStatus.SUCCESS,
            owner_id="bob@example.com",
        )

        await service.publish_run(
            run,
            prompt="do something",
            response="done",
            error=None,
            agent="github",
        )

        conv = await service._conversations().find_one(
            {"_id": conversation_id_for_task("owned-task")}
        )
        assert conv is not None
        user_participants = [p for p in conv["participants"] if p["type"] == "user"]
        assert len(user_participants) == 1
        assert user_participants[0]["id"] == "bob@example.com"
