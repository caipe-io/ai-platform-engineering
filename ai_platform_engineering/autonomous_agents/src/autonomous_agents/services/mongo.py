"""MongoDB persistence for the Autonomous Agents backend.

``MongoService`` owns one AsyncIOMotorClient and all MongoDB reads/writes
for task definitions, run history, webhook dedup rows, Webex thread
mappings, and optional chat-history publishing. Callers use the
process-wide singleton from :func:`get_mongo_service`.

Routes and schedulers depend on small Protocols such as ``TaskStore`` and
``RunStore``. The adapter classes at the bottom of this module preserve
those interfaces while delegating to the single ``MongoService`` instance.

The service uses the configured primary database for autonomous-agent state
and optionally a separate chat-history database when
``CHAT_HISTORY_DATABASE`` is set.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Protocol, runtime_checkable

from autonomous_agents.config import Settings, get_settings
from autonomous_agents.models import (
    TaskDefinition,
    TaskRun,
    TaskStatus,
)
from autonomous_agents.services.chat_history import (
    MessageKind,
    conversation_id_for_task,
)
from autonomous_agents.services.secret_encryption import (
    WebhookSecretEncryptionError,
    WebhookSecretProtector,
    build_webhook_secret_protector,
)

logger = logging.getLogger("autonomous_agents")


class TaskAlreadyExistsError(Exception):
    """Raised when creating a task with an id that already exists.

    The API layer catches this typed error and returns HTTP 409 without
    string-matching database error messages.
    """

    def __init__(self, task_id: str) -> None:
        super().__init__(f"Task '{task_id}' already exists")
        self.task_id = task_id


class TaskNotFoundError(Exception):
    """Raised when updating or deleting a task id that does not exist.

    The API layer catches this typed error and returns HTTP 404 without
    doing a separate existence check that could race with concurrent deletes.
    """

    def __init__(self, task_id: str) -> None:
        super().__init__(f"Task '{task_id}' not found")
        self.task_id = task_id


@runtime_checkable
class TaskStore(Protocol):
    """Async CRUD interface for :class:`TaskDefinition` records.

    Implementations MUST be safe to call concurrently from the FastAPI
    event loop. Mutating methods are atomic per call: a failed
    :meth:`create` / :meth:`update` / :meth:`delete` MUST leave the
    store in its prior state.

    Production wires this to :class:`MongoTaskStoreAdapter`; tests can
    inject tiny in-file fakes without pulling in ``mongomock_motor`` for
    every route or scheduler test.
    """

    async def list_all(self) -> list[TaskDefinition]:
        pass

    async def list_by_owner(self, owner_id: str) -> list[TaskDefinition]:
        pass

    async def get(self, task_id: str) -> TaskDefinition | None:
        pass

    async def create(self, task: TaskDefinition) -> TaskDefinition:
        pass

    async def update(self, task_id: str, task: TaskDefinition) -> TaskDefinition:
        pass

    async def delete(self, task_id: str) -> None:
        pass


@runtime_checkable
class RunStore(Protocol):
    """Async, append-mostly store for :class:`TaskRun` records.

    Implementations MUST be safe to call concurrently from the scheduler
    event loop. :meth:`record` is upsert-by-``run_id`` so the scheduler
    can call it once when a run starts (status=RUNNING) and again when
    it finishes (status=SUCCESS|FAILED) without the store needing a
    separate "update" path.

    Production wires this to :class:`MongoRunStoreAdapter`; tests can
    inject in-file fakes for scheduler and route tests.
    """

    async def record(self, run: TaskRun) -> None:
        pass

    async def list_by_task(self, task_id: str, limit: int = 100) -> list[TaskRun]:
        pass

    async def list_all(self, limit: int = 500) -> list[TaskRun]:
        pass


# Collection name defaults shared by settings, tests, and index setup.
DEFAULT_TASKS_COLLECTION = "autonomous_tasks"
DEFAULT_RUNS_COLLECTION = "autonomous_runs"
DEFAULT_CONVERSATIONS_COLLECTION = "conversations"
DEFAULT_MESSAGES_COLLECTION = "messages"


class MongoService:
    """All MongoDB reads / writes for the autonomous agents service.

    Lifecycle:

    1. Construct (cheap; no I/O).
    2. ``await service.connect()`` -> opens client, pings, builds
       indexes. Returns ``True`` on success, ``False`` on failure.
    3. Call CRUD / publish methods during the service's lifetime.
    4. ``service.disconnect()`` on shutdown.

    The constructor accepts an explicit ``Settings`` override so tests
    can pin a specific configuration without touching
    :func:`get_settings`'s lru_cache. Tests that need to inject a mock
    client (``AsyncMongoMockClient`` from ``mongomock_motor``) go
    through :meth:`connect_with_client` instead of the real connect
    path.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        secret_protector: WebhookSecretProtector | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._secret_protector = secret_protector or build_webhook_secret_protector(
            cmk_id=self.settings.credential_kms_cmk_id,
            region=self.settings.credential_kms_region,
        )
        self._client: Any | None = None
        self._primary_db: Any | None = None
        self._chat_db: Any | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> bool:
        """Open a motor client against ``MONGODB_URI`` and ping it.

        Returns ``True`` if both the connection and the initial
        ``admin.command("ping")`` succeed. Returns ``False`` on any
        failure so the lifespan can decide whether to retry or crash.
        Never raises on transport failure -- noisy failure modes
        belong in the caller, not here.
        """
        uri = self.settings.mongodb_uri
        db_name = self.settings.mongodb_database
        if not uri or not db_name:
            logger.warning(
                "MongoService.connect() called without MONGODB_URI/"
                "MONGODB_DATABASE configured -- refusing to open a client."
            )
            return False

        try:
            # Deferred import so ``import autonomous_agents.services.mongo``
            # (e.g. from a route importing TaskStore/RunStore for type
            # annotations) never
            # pays motor's import cost.
            from motor.motor_asyncio import AsyncIOMotorClient

            # ``tz_aware=True`` + ``tzinfo=timezone.utc`` so BSON
            # datetimes come back UTC-aware. Without it reads mix
            # naive/aware datetimes and comparisons raise TypeError.
            self._client = AsyncIOMotorClient(
                uri,
                serverSelectionTimeoutMS=5000,
                tz_aware=True,
                tzinfo=timezone.utc,
            )
            # Actively verify connectivity -- constructing the client
            # is lazy so a bad URI would otherwise silently "succeed"
            # until the first query.
            await self._client.admin.command("ping")

            self._primary_db = self._client[db_name]
            chat_db_name = self.settings.chat_history_database or db_name
            self._chat_db = self._client[chat_db_name]

            logger.info(
                "MongoService connected (primary=%s, chat=%s)",
                db_name,
                chat_db_name,
            )
            await self._ensure_indexes()
            return True
        except Exception as exc:  # noqa: BLE001 -- connect() contract: never raise
            # Reset partial state so reset_mongo_service()+retry actually
            # starts from a clean slate.
            logger.error("MongoService failed to connect: %s", exc)
            self._client = None
            self._primary_db = None
            self._chat_db = None
            return False

    def connect_with_client(
        self,
        client: Any,
        *,
        primary_db: str | None = None,
        chat_db: str | None = None,
    ) -> None:
        """Inject an already-built client -- used by unit tests.

        Accepts ``AsyncMongoMockClient`` (mongomock_motor) or any
        object that answers ``client[db_name]``. Skips the ping +
        ensure_indexes round-trip because mongomock does not need the
        production startup index pass and some tests assert on a
        pristine index set.
        """
        self._client = client
        primary = primary_db or self.settings.mongodb_database or "autonomous_test"
        chat = chat_db or self.settings.chat_history_database or primary
        self._primary_db = client[primary]
        self._chat_db = client[chat]

    def disconnect(self) -> None:
        """Close the underlying motor client, if any.

        Safe to call multiple times. Motor's ``close()`` is synchronous
        (it cancels pending ops and tears down sockets without awaiting
        a server reply) so this method stays sync to keep shutdown
        code paths simple.
        """
        if self._client is not None:
            try:
                self._client.close()
            except Exception as exc:  # noqa: BLE001
                logger.warning("MongoService.disconnect swallowed: %s", exc)
        self._client = None
        self._primary_db = None
        self._chat_db = None

    @property
    def is_connected(self) -> bool:
        """True iff :meth:`connect` (or connect_with_client) succeeded."""
        return self._client is not None and self._primary_db is not None

    # ------------------------------------------------------------------
    # Collection accessors
    # ------------------------------------------------------------------

    def _require_primary(self) -> Any:
        if self._primary_db is None:
            raise RuntimeError(
                "MongoService not connected -- call await connect() first"
            )
        return self._primary_db

    def _require_chat(self) -> Any:
        if self._chat_db is None:
            raise RuntimeError(
                "MongoService not connected -- call await connect() first"
            )
        return self._chat_db

    def _tasks(self) -> Any:
        return self._require_primary()[self.settings.mongodb_tasks_collection]

    def _runs(self) -> Any:
        return self._require_primary()[self.settings.mongodb_collection]

    def _conversations(self) -> Any:
        return self._require_chat()[
            self.settings.chat_history_conversations_collection
        ]

    def _messages(self) -> Any:
        return self._require_chat()[self.settings.chat_history_messages_collection]

    def _webex_threads(self) -> Any:
        return self._require_primary()[
            self.settings.mongodb_webex_thread_map_collection
        ]

    def _trigger_instances(self) -> Any:
        return self._require_primary()[
            self.settings.mongodb_trigger_instances_collection
        ]

    # ------------------------------------------------------------------
    # Indexes
    # ------------------------------------------------------------------

    async def _ensure_indexes(self) -> None:
        """Create every index the service depends on. Idempotent.

        Mongo's ``create_index`` is a no-op when an identical spec
        already exists so calling this at startup is cheap. Index
        errors (e.g. an operator with read-only creds) are logged and
        swallowed: queries still work against a missing index, just
        slower, and we'd rather the service come up degraded than
        crash on a permissions issue.
        """
        try:
            # ---- Runs: serves list_runs_by_task (filter + sort).
            await self._runs().create_index(
                [("task_id", 1), ("started_at", -1)]
            )
            # ---- Runs: serves list_runs (unfiltered sort by recency).
            #      The compound index above leads on task_id and Mongo
            #      won't walk it for an unfiltered sort.
            await self._runs().create_index([("started_at", -1)])

            # ---- Tasks: only the automatic _id_ index is needed.
            #      We pin _id = task.id in create_task so Mongo's
            #      built-in unique index covers lookups already.
            # ---- Conversations: filter chip (source + recency).
            await self._conversations().create_index(
                [("source", 1), ("updated_at", -1)]
            )
            # ---- Conversations: legacy deep-link by run_id. Current
            #      autonomous conversations are task-scoped, but older
            #      documents may still carry run_id; keep the sparse
            #      index so those lookups remain cheap.
            await self._conversations().create_index(
                [("run_id", 1)],
                unique=True,
                sparse=True,
            )
            # ---- Messages: upsert lookup (not unique; different
            #      conversations may legitimately share message_id).
            await self._messages().create_index(
                [("conversation_id", 1), ("message_id", 1)]
            )
            # ---- Webex thread map: TTL on created_at so abandoned
            #      threads age out instead of growing the collection
            #      forever. ``message_id`` is also the document _id
            #      (we pin it in record_webex_thread) so primary-key
            #      lookup is already covered.
            ttl_seconds = (
                self.settings.webex_thread_map_ttl_days * 24 * 60 * 60
            )
            await self._webex_threads().create_index(
                [("created_at", 1)],
                expireAfterSeconds=ttl_seconds,
            )
            # ---- Trigger instances: TTL on received_at so dedup
            #      records age out (default 7 days). The ``_id`` is
            #      pinned to the dedup key so primary-key lookup is
            #      already covered by the automatic ``_id_`` index.
            trigger_ttl_seconds = (
                self.settings.trigger_instance_ttl_days * 24 * 60 * 60
            )
            await self._trigger_instances().create_index(
                [("received_at", 1)],
                expireAfterSeconds=trigger_ttl_seconds,
            )
            # ---- Trigger instances: secondary index on task_id so
            #      operator dashboards can list deliveries per task
            #      without a collection scan.
            await self._trigger_instances().create_index(
                [("task_id", 1), ("received_at", -1)]
            )
            # ---- Tasks: owner_id index for per-user task list filtering
            await self._tasks().create_index([("owner_id", 1)])
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "MongoService.ensure_indexes swallowed: %s -- queries will "
                "still work but may be slow until indexes are created.",
                exc,
            )

    # ==================================================================
    # Task definitions
    # ==================================================================

    async def list_tasks(self) -> list[TaskDefinition]:
        cursor = self._tasks().find({}, sort=[("_id", 1)])
        return [await self._doc_to_task(doc) async for doc in cursor]

    async def list_tasks_by_owner(self, owner_id: str) -> list[TaskDefinition]:
        """Return tasks owned by ``owner_id`` only.

        Tasks without an owner_id field (created before the per-user ownership
        feature) are intentionally excluded — they are only returned by
        ``list_tasks()`` (admin path).
        """
        cursor = self._tasks().find({"owner_id": owner_id}, sort=[("_id", 1)])
        return [await self._doc_to_task(doc) async for doc in cursor]

    async def get_task(self, task_id: str) -> TaskDefinition | None:
        doc = await self._tasks().find_one({"_id": task_id})
        return await self._doc_to_task(doc) if doc else None

    async def create_task(self, task: TaskDefinition) -> TaskDefinition:
        """Insert ``task`` or raise :class:`TaskAlreadyExistsError`.

        The typed exception lets the CRUD routes map
        duplicates to HTTP 409 without string-matching.
        """
        doc = await self._task_to_doc(task)
        try:
            await self._tasks().insert_one(doc)
        except Exception as exc:  # noqa: BLE001 -- translated below
            # DuplicateKeyError lives in pymongo.errors, but matching by
            # class name keeps this module import-light for tests and
            # mirrors motor's own cross-version compatibility pattern.
            if exc.__class__.__name__ == "DuplicateKeyError":
                raise TaskAlreadyExistsError(task.id) from exc
            raise
        return task

    async def update_task(
        self, task_id: str, task: TaskDefinition
    ) -> TaskDefinition:
        """Full-replace the task document. Raises on missing target."""
        if task.id != task_id:
            raise ValueError(
                f"path task_id '{task_id}' does not match body id '{task.id}'"
            )
        doc = await self._task_to_doc(task)
        result = await self._tasks().replace_one({"_id": task_id}, doc, upsert=False)
        if result.matched_count == 0:
            raise TaskNotFoundError(task_id)
        return task

    async def delete_task(self, task_id: str) -> None:
        result = await self._tasks().delete_one({"_id": task_id})
        if result.deleted_count == 0:
            raise TaskNotFoundError(task_id)
        await self._purge_task_history(task_id)

    # ==================================================================
    # Run history
    # ==================================================================

    async def record_run(self, run: TaskRun) -> None:
        """Upsert a ``TaskRun`` keyed on ``run_id``.

        Upsert semantics mean the scheduler can call this once on
        RUNNING and again on SUCCESS|FAILED without leaving two rows.
        ``_id`` is pinned to ``run_id`` so Mongo's automatic ``_id_``
        index enforces uniqueness without a dedicated index.
        """
        # mode="python" preserves datetime objects so pymongo encodes
        # them as native BSON datetime (required for the (task_id,
        # started_at desc) index to be usable).
        doc = run.model_dump()
        doc["_id"] = run.run_id
        await self._runs().replace_one({"_id": run.run_id}, doc, upsert=True)

    async def list_runs(self, limit: int = 500) -> list[TaskRun]:
        if limit <= 0:
            return []
        cursor = self._runs().find({}, sort=[("started_at", -1)]).limit(limit)
        return [self._doc_to_run(doc) async for doc in cursor]

    async def list_runs_by_task(
        self, task_id: str, limit: int = 100
    ) -> list[TaskRun]:
        if limit <= 0:
            return []
        cursor = (
            self._runs()
            .find({"task_id": task_id}, sort=[("started_at", -1)])
            .limit(limit)
        )
        return [self._doc_to_run(doc) async for doc in cursor]

    # ==================================================================
    # Webex thread map (messageId -> task_id, run_id)
    # ==================================================================

    async def record_webex_thread(
        self,
        *,
        message_id: str,
        task_id: str,
        run_id: str,
        room_id: str | None = None,
    ) -> None:
        """Upsert a Webex messageId -> (task_id, run_id) mapping.

        Pinned ``_id = message_id`` so Mongo's automatic ``_id_`` index
        gives O(1) lookup without a dedicated declaration. ``created_at``
        is always set to ``now()`` on the write so the TTL index in
        ``_ensure_indexes`` keeps the collection bounded -- a follow-up
        run that re-records the same messageId resets the TTL clock,
        which is the intended behaviour (active threads stay; stale
        ones expire).
        """
        doc: dict[str, Any] = {
            "_id": message_id,
            "message_id": message_id,
            "task_id": task_id,
            "run_id": run_id,
            "created_at": datetime.now(timezone.utc),
        }
        if room_id is not None:
            doc["room_id"] = room_id
        await self._webex_threads().replace_one(
            {"_id": message_id}, doc, upsert=True
        )

    # ==================================================================
    # Trigger instances (webhook delivery dedup)
    # ==================================================================

    async def record_trigger_instance(
        self, doc: dict[str, Any]
    ) -> tuple[bool, dict[str, Any] | None]:
        """Insert ``doc`` (keyed on ``_id`` = dedup key) or report a duplicate.

        Returns ``(created, existing_doc)``:

        * ``(True, None)`` -- the row was newly inserted; caller is the
          first to see this delivery.
        * ``(False, existing_doc)`` -- a row with this ``_id`` already
          exists; caller is a duplicate delivery and should NOT fire
          the task. ``existing_doc`` may have ``run_id=None`` if the
          original claim crashed before attaching a run id; the route
          treats that as "fired but no run recorded yet" and surfaces
          a clear status instead of guessing.

        Mirrors the ``DuplicateKeyError`` translation used by
        :meth:`create_task` so callers don't need to import
        pymongo errors directly.
        """
        try:
            await self._trigger_instances().insert_one(doc)
            return True, None
        except Exception as exc:  # noqa: BLE001 -- translated below
            if exc.__class__.__name__ != "DuplicateKeyError":
                raise
            existing = await self._trigger_instances().find_one(
                {"_id": doc["_id"]}
            )
            return False, existing

    async def get_trigger_instance(
        self, dedup_key: str
    ) -> dict[str, Any] | None:
        """Return the stored row for ``dedup_key`` or ``None`` if absent."""
        return await self._trigger_instances().find_one({"_id": dedup_key})

    async def attach_run_to_trigger_instance(
        self, dedup_key: str, run_id: str
    ) -> None:
        """Record the ``run_id`` chosen by the scheduler on the dedup row.

        Best-effort: a missing row (e.g. TTL-expired between claim and
        run completion) is silently ignored. The dedup row's purpose is
        to prevent duplicate execution; whether we successfully back-link
        to the run is purely an audit nicety and must not raise out of
        the scheduler's terminal phase.
        """
        try:
            await self._trigger_instances().update_one(
                {"_id": dedup_key},
                {"$set": {"run_id": run_id}},
            )
        except Exception as exc:  # noqa: BLE001 -- audit-only path
            logger.warning(
                "attach_run_to_trigger_instance(%s -> %s) swallowed: %s",
                dedup_key,
                run_id,
                exc,
            )

    async def lookup_webex_thread(self, message_id: str) -> dict[str, Any] | None:
        """Return the raw thread-map document for ``message_id`` or None.

        Returns the raw dict (rather than a Pydantic model) so the
        caller -- the inbound bridge -- decides how to surface the
        result. Keys: ``message_id``, ``task_id``, ``run_id``,
        ``created_at``, optional ``room_id``.
        """
        doc = await self._webex_threads().find_one({"_id": message_id})
        if doc is None:
            return None
        # Strip the duplicate ``_id`` so consumers aren't tempted to
        # ship it across the wire.
        doc.pop("_id", None)
        return doc

    # ==================================================================
    # Chat history (per-task conversations)
    # ==================================================================

    async def publish_run(
        self,
        run: TaskRun,
        *,
        prompt: str,
        response: str | None,
        error: str | None,
        agent: str | None,
        task_id: str | None = None,
        conversation_id: str | None = None,
    ) -> None:
        """Append run request/response messages to the task conversation.

        Each run adds request and response/error messages to the
        per-task thread. Multiple runs of the same task therefore form a
        chronological history visible in the chat sidebar.
        """
        effective_task_id = task_id or run.task_id
        conv_id = conversation_id or conversation_id_for_task(effective_task_id)
        now = datetime.now(timezone.utc)

        await self._upsert_conversation(
            conv_id,
            task_id=effective_task_id,
            agent=agent,
            title=f"[Autonomous] {run.task_name}",
            now=now,
            run=run,
        )

        # -- user: the prompt the selected execution backend actually saw
        await self._upsert_kind_message(
            conversation_id=conv_id,
            message_id=f"run:{run.run_id}:request",
            role="user",
            kind="run_request",
            content=prompt,
            created_at=now,
            run=run,
            extra_meta={"run_id": run.run_id, "task_id": effective_task_id},
            is_final=True,
        )

        # -- assistant: execution backend response / error
        if run.status == TaskStatus.FAILED:
            kind: MessageKind = "run_error"
            content = f"Run failed: {error or 'unknown error'}"
            is_final = True
        elif run.status == TaskStatus.SUCCESS and response is not None:
            kind = "run_response"
            content = response
            is_final = True
        else:
            kind = "run_response"
            content = "Autonomous task running..."
            is_final = False

        # +1us offset so assistant sorts AFTER user when both writes
        # land on the same wall-clock millisecond. Preserved from the
        # earlier publisher so thread ordering is stable.
        assistant_at = (
            now.replace(microsecond=now.microsecond + 1)
            if now.microsecond < 999_999
            else now
        )
        await self._upsert_kind_message(
            conversation_id=conv_id,
            message_id=f"run:{run.run_id}:response",
            role="assistant",
            kind=kind,
            content=content,
            created_at=assistant_at,
            run=run,
            extra_meta={
                "run_id": run.run_id,
                "task_id": effective_task_id,
                "run_status": run.status.value,
            },
            is_final=is_final,
        )

    async def publish_creation_intent(self, task: TaskDefinition) -> None:
        """Append (or upsert) the initial ``creation_intent`` message."""
        conv_id = conversation_id_for_task(task.id)
        now = datetime.now(timezone.utc)
        await self._upsert_conversation(conv_id, task=task, now=now)

        body_lines = [
            f"Created task '{task.name}' (id: {task.id}).",
            f"Target sub-agent: {task.agent or '(LLM router will choose)'}",
            f"Trigger: {task.trigger.type}",
        ]
        if getattr(task.trigger, "schedule", None):
            body_lines.append(f"Schedule (cron): {task.trigger.schedule}")
        if task.llm_provider:
            body_lines.append(f"LLM provider override: {task.llm_provider}")
        body_lines.extend(["", "Prompt:", task.prompt])

        await self._upsert_kind_message(
            conversation_id=conv_id,
            message_id=f"task:{task.id}:creation_intent",
            role="user",
            kind="creation_intent",
            content="\n".join(body_lines),
            created_at=now,
            task=task,
            extra_meta={"created_via": "form"},
        )

    async def publish_preflight_ack(
        self,
        task: TaskDefinition,
        ack_payload: dict[str, Any],
    ) -> None:
        """Append a ``preflight_ack`` assistant message for the task."""
        conv_id = conversation_id_for_task(task.id)
        now = datetime.now(timezone.utc)
        await self._upsert_conversation(conv_id, task=task, now=now)

        ack_at = ack_payload.get("ack_at") or now.isoformat()
        msg_id = f"task:{task.id}:preflight_ack:{ack_at}"

        status = ack_payload.get("ack_status", "unknown")
        detail = ack_payload.get("ack_detail", "")
        summary = ack_payload.get("dry_run_summary", "")

        body_lines = [f"Pre-flight: {status.upper()}."]
        if detail:
            body_lines.append(detail)
        if summary:
            body_lines.append("")
            body_lines.append(summary)

        await self._upsert_kind_message(
            conversation_id=conv_id,
            message_id=msg_id,
            role="assistant",
            kind="preflight_ack",
            content="\n".join(body_lines),
            created_at=now,
            task=task,
            extra_meta={"ack_payload": ack_payload},
            is_final=True,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _upsert_conversation(
        self,
        conv_id: str,
        *,
        task: TaskDefinition | None = None,
        task_id: str | None = None,
        agent: str | None = None,
        title: str | None = None,
        now: datetime | None = None,
        run: TaskRun | None = None,
    ) -> None:
        now = now or datetime.now(timezone.utc)
        effective_task_id = task.id if task else task_id
        # Routing target precedence: dynamic-agent id > supervisor
        # sub-agent hint > explicit scheduler-resolved agent. This
        # matches task_runner's publish path so every persisted artifact
        # agrees on which agent owns the thread.
        if task is not None:
            effective_agent = task.dynamic_agent_id or task.agent
        else:
            effective_agent = agent
        if effective_task_id is None:
            raise ValueError("task or task_id must be provided")

        effective_title = title or (
            f"[Autonomous] {task.name}"
            if task
            else f"[Autonomous] {effective_task_id}"
        )
        effective_task_name = (
            task.name
            if task is not None
            else run.task_name
            if run is not None
            else effective_task_id
        )

        # Resolve the conversation owner from the most-specific source available:
        #   1. run.owner_id — stamped at run creation from TaskDefinition.owner_id
        #      (present for all runs after the per-user ownership feature landed)
        #   2. task.owner_id — used by publish_creation_intent / publish_preflight_ack
        #      which don't have a run object
        #   3. chat_history_owner_email — system sentinel, fallback for legacy
        #      tasks and runs created before the ownership field was introduced
        effective_owner = (
            (run.owner_id if run is not None else None)
            or (task.owner_id if task is not None else None)
            or self.settings.chat_history_owner_email
        )

        # The UI's routing helpers (``getAgentId`` /
        # ``isDynamicAgentConversation`` in ui/src/types/a2a.ts) read
        # the agent target exclusively from ``participants``. Mirror
        # the UI's manual-chat participant shape so opening an
        # autonomous thread routes follow-up messages back to the same
        # supervisor or dynamic agent that produced the run.
        participants: list[dict[str, str]] = [
            {"type": "user", "id": effective_owner},
        ]
        if effective_agent:
            participants.append({"type": "agent", "id": effective_agent})

        await self._conversations().update_one(
            {"_id": conv_id},
            {
                # Keep ``participants`` under ``$set`` so older
                # autonomous conversations self-heal the next time the
                # publisher touches them; no separate migration needed.
                "$set": {
                    "title": effective_title,
                    "agent_id": effective_agent,
                    "participants": participants,
                    "updated_at": now,
                    "metadata": {
                        "agent_version": "autonomous-agents",
                        "model_used": "autonomous",
                        "task_name": effective_task_name,
                    },
                },
                "$setOnInsert": {
                    "_id": conv_id,
                    "owner_id": effective_owner,
                    "created_at": now,
                    "sharing": {
                        "is_public": False,
                        "shared_with": [],
                        "shared_with_teams": [],
                        "share_link_enabled": False,
                    },
                    "tags": ["autonomous", effective_task_id],
                    "is_archived": False,
                    "is_pinned": False,
                    "source": "autonomous",
                    "task_id": effective_task_id,
                },
            },
            upsert=True,
        )

    async def _upsert_kind_message(
        self,
        *,
        conversation_id: str,
        message_id: str,
        role: str,
        kind: MessageKind,
        content: str,
        created_at: datetime,
        task: TaskDefinition | None = None,
        run: TaskRun | None = None,
        extra_meta: dict[str, Any] | None = None,
        is_final: bool = True,
    ) -> None:
        meta: dict[str, Any] = {
            "kind": kind,
            "source": "autonomous",
            "is_final": is_final,
        }
        if task is not None:
            meta["task_id"] = task.id
            meta["task_name"] = task.name
        if run is not None:
            meta["task_id"] = run.task_id
            meta["task_name"] = run.task_name
        if extra_meta:
            meta.update(extra_meta)

        await self._messages().update_one(
            {"conversation_id": conversation_id, "message_id": message_id},
            {
                "$set": {
                    "role": role,
                    "content": content,
                    "updated_at": created_at,
                    "metadata": meta,
                },
                "$setOnInsert": {
                    "conversation_id": conversation_id,
                    "message_id": message_id,
                    "owner_id": self.settings.chat_history_owner_email,
                    "created_at": created_at,
                },
            },
            upsert=True,
        )

    async def _purge_task_history(self, task_id: str) -> None:
        """Delete persisted history tied to ``task_id`` so the id can be reused.

        Task ids are user-chosen and can be reused after delete.
        Conversation ids are deterministic from task ids, so keeping old
        run/chat artifacts would attach a replacement task to stale
        history. Purge Mongo-side artifacts so a deleted task is gone.
        """
        conv_ids = {conversation_id_for_task(task_id)}

        cursor = self._conversations().find(
            {"$or": [{"_id": {"$in": list(conv_ids)}}, {"task_id": task_id}]},
            {"_id": 1},
        )
        async for doc in cursor:
            conv_id = doc.get("_id")
            if isinstance(conv_id, str) and conv_id:
                conv_ids.add(conv_id)

        await self._runs().delete_many({"task_id": task_id})
        await self._messages().delete_many({"conversation_id": {"$in": list(conv_ids)}})
        await self._conversations().delete_many(
            {"$or": [{"_id": {"$in": list(conv_ids)}}, {"task_id": task_id}]}
        )

    # ------------------------------------------------------------------
    # Model <-> doc conversions
    # ------------------------------------------------------------------

    def _require_secret_protector(self) -> WebhookSecretProtector:
        if self._secret_protector is None:
            raise WebhookSecretEncryptionError(
                "Per-task webhook secrets require CREDENTIAL_KMS_CMK_ID "
                "(and AWS KMS permissions)"
            )
        return self._secret_protector

    async def _task_to_doc(self, task: TaskDefinition) -> dict[str, Any]:
        # mode="json" so enums (TriggerType.CRON, etc.) serialise as
        # strings -- Mongo can't store Python enums and a read-back
        # would raise on validation.
        doc = task.model_dump(mode="json")
        doc["_id"] = task.id
        trigger = doc.get("trigger")
        if isinstance(trigger, dict) and trigger.get("type") == "webhook":
            secret = trigger.pop("secret", None)
            if secret:
                trigger["secret_envelope"] = await self._require_secret_protector().encrypt(
                    task.id, secret
                )
        return doc

    async def _doc_to_task(self, doc: dict[str, Any]) -> TaskDefinition:
        task_id = str(doc.get("_id") or doc.get("id") or "")
        task_doc = dict(doc)
        task_doc.pop("_id", None)
        trigger_value = task_doc.get("trigger")
        if isinstance(trigger_value, dict) and trigger_value.get("type") == "webhook":
            trigger = dict(trigger_value)
            task_doc["trigger"] = trigger
            has_envelope = "secret_envelope" in trigger
            envelope = trigger.pop("secret_envelope", None)

            if has_envelope and not isinstance(envelope, dict):
                raise WebhookSecretEncryptionError(
                    "Webhook secret envelope is malformed"
                )
            if isinstance(envelope, dict):
                trigger["secret"] = await self._require_secret_protector().decrypt(
                    task_id, envelope
                )

        return TaskDefinition.model_validate(task_doc)

    @staticmethod
    def _doc_to_run(doc: dict[str, Any]) -> TaskRun:
        doc.pop("_id", None)
        return TaskRun.model_validate(doc)


# ======================================================================
# Protocol-implementing adapters
# ----------------------------------------------------------------------
# The rest of the codebase depends on small protocols rather than the
# concrete MongoService. These adapters wire production to Mongo while
# leaving tests free to inject protocol-shaped fakes.
# ======================================================================


class MongoTaskStoreAdapter:
    """:class:`TaskStore` facade around :class:`MongoService`."""

    def __init__(self, mongo: MongoService) -> None:
        self._mongo = mongo

    async def list_all(self) -> list[TaskDefinition]:
        return await self._mongo.list_tasks()

    async def list_by_owner(self, owner_id: str) -> list[TaskDefinition]:
        return await self._mongo.list_tasks_by_owner(owner_id)

    async def get(self, task_id: str) -> TaskDefinition | None:
        return await self._mongo.get_task(task_id)

    async def create(self, task: TaskDefinition) -> TaskDefinition:
        return await self._mongo.create_task(task)

    async def update(
        self, task_id: str, task: TaskDefinition
    ) -> TaskDefinition:
        return await self._mongo.update_task(task_id, task)

    async def delete(self, task_id: str) -> None:
        await self._mongo.delete_task(task_id)


class MongoRunStoreAdapter:
    """:class:`RunStore` facade around :class:`MongoService`."""

    def __init__(self, mongo: MongoService) -> None:
        self._mongo = mongo

    async def record(self, run: TaskRun) -> None:
        await self._mongo.record_run(run)

    async def list_all(self, limit: int = 500) -> list[TaskRun]:
        return await self._mongo.list_runs(limit=limit)

    async def list_by_task(
        self, task_id: str, limit: int = 100
    ) -> list[TaskRun]:
        return await self._mongo.list_runs_by_task(task_id, limit=limit)


class MongoWebexThreadMapAdapter:
    """:class:`WebexThreadMap` facade around :class:`MongoService`.

    Kept as a thin shim so the scheduler and Webex inbound route can
    depend on the protocol while production persistence stays in
    :class:`MongoService`.
    """

    def __init__(self, mongo: "MongoService") -> None:
        self._mongo = mongo

    async def record(self, entry: Any) -> None:
        # ``entry`` is a :class:`WebexThreadEntry` but we accept
        # duck-typed objects to keep this module Mongo-only at import
        # time (the WebexThreadMap protocol lives in services.webex_threads
        # which would otherwise create a circular import).
        await self._mongo.record_webex_thread(
            message_id=entry.message_id,
            task_id=entry.task_id,
            run_id=entry.run_id,
            room_id=entry.room_id,
        )

    async def lookup(self, message_id: str) -> Any | None:
        # Deferred import keeps services.mongo independent of
        # services.webex_threads (the inverse import direction is also
        # avoided -- webex_threads only depends on stdlib).
        from autonomous_agents.services.webex_threads import WebexThreadEntry

        doc = await self._mongo.lookup_webex_thread(message_id)
        if doc is None:
            return None
        return WebexThreadEntry(
            message_id=doc["message_id"],
            task_id=doc["task_id"],
            run_id=doc["run_id"],
            room_id=doc.get("room_id"),
            created_at=doc.get("created_at"),
        )


class MongoChatHistoryPublisherAdapter:
    """:class:`ChatHistoryPublisher` facade around :class:`MongoService`."""

    enabled = True

    def __init__(self, mongo: MongoService) -> None:
        self._mongo = mongo

    async def publish_run(
        self,
        run: TaskRun,
        *,
        prompt: str,
        response: str | None,
        error: str | None,
        agent: str | None,
        task_id: str | None = None,
        conversation_id: str | None = None,
    ) -> None:
        await self._mongo.publish_run(
            run,
            prompt=prompt,
            response=response,
            error=error,
            agent=agent,
            task_id=task_id,
            conversation_id=conversation_id,
        )

    async def publish_creation_intent(self, task: TaskDefinition) -> None:
        await self._mongo.publish_creation_intent(task)

    async def publish_preflight_ack(
        self,
        task: TaskDefinition,
        ack_payload: dict[str, Any],
    ) -> None:
        await self._mongo.publish_preflight_ack(task, ack_payload)


# ======================================================================
# Singleton
# ======================================================================

_mongo_service: MongoService | None = None


def get_mongo_service() -> MongoService:
    """Return the process-wide :class:`MongoService` singleton.

    The singleton is *unconnected* on first access -- the FastAPI
    lifespan is responsible for calling :meth:`MongoService.connect`
    before any route handler is invoked. Unit tests that don't go
    through the lifespan can use :meth:`MongoService.connect_with_client`
    to inject a mock client directly.
    """
    global _mongo_service
    if _mongo_service is None:
        _mongo_service = MongoService()
    return _mongo_service


def reset_mongo_service() -> None:
    """Tear down the singleton so a subsequent call rebuilds it.

    Used by the lifespan's connect-retry loop and by tests that need
    to swap configuration between cases.
    """
    global _mongo_service
    if _mongo_service is not None:
        _mongo_service.disconnect()
    _mongo_service = None
