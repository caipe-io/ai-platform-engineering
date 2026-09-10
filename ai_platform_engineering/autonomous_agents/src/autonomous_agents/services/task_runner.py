"""Task execution pipeline — invoked by APScheduler and by route handlers.

Split out from ``scheduler.py`` so that module can be a real "APScheduler
wiring only" surface. This file owns the run-store / chat-history /
Webex-thread-map singletons and the :func:`execute_task` pipeline that
both the cron path and the webhook path drive.

NOTE on deferred imports: ``_prompt_for_publish`` defers
``from autonomous_agents.config import get_settings`` and
``_attach_run_to_trigger_safely`` defers
``from autonomous_agents.services.mongo import get_mongo_service``
on purpose. The deferral keeps this module importable in unit-test
contexts that never wire up MongoDB. Do not promote these to top-level
imports.
"""

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from autonomous_agents.models import (
    Acknowledgement,
    FollowUpContext,
    TaskDefinition,
    TaskRun,
    TaskStatus,
    WebhookTrigger,
)
from autonomous_agents.services.chat_history import (
    ChatHistoryPublisher,
    NoopChatHistoryPublisher,
    conversation_id_for_task,
    conversation_id_for_webhook_run,
)
from autonomous_agents.services.dynamic_agents_client import (
    DynamicAgentsAuthorizationRevokedError,
    invoke_dynamic_agent_streaming,
)
from autonomous_agents.services.mongo import RunStore
from autonomous_agents.services.webex_threads import (
    WebexThreadEntry,
    WebexThreadMap,
    extract_webex_message_ids,
)

logger = logging.getLogger("autonomous_agents")

_FOLLOW_UP_PROMPT_RE = re.compile(
    r"\n\nOperator follow-up \((?P<transport>[^,\n)]+)[^\n)]*\):\n(?P<message>[\s\S]*)$"
)

_run_store: RunStore | None = None
_chat_history_publisher: ChatHistoryPublisher | None = None
_webex_thread_map: WebexThreadMap | None = None


def get_run_store() -> RunStore:
    """Return the active :class:`RunStore`.

    The lifespan hook in ``main.py`` injects the MongoDB-backed store
    before any handler runs. Unit tests that exercise scheduler
    functions without going through the lifespan MUST inject a fake
    via :func:`set_run_store` first; we refuse to silently lazy-build
    an in-memory store because that would hide a real misconfiguration
    in production (MongoDB required -- see ``main.lifespan``).
    """
    if _run_store is None:
        raise RuntimeError(
            "RunStore not initialized -- call set_run_store(...) "
            "(the FastAPI lifespan does this automatically after "
            "connecting to MongoDB)"
        )
    return _run_store


def set_run_store(store: RunStore) -> None:
    """Inject the active :class:`RunStore` — called from the FastAPI lifespan."""
    global _run_store
    _run_store = store


def get_chat_history_publisher() -> ChatHistoryPublisher:
    """Return the active :class:`ChatHistoryPublisher`.

    Defaults to a no-op publisher so unit tests that don't care
    about IMP-13 can keep exercising :func:`execute_task` without
    setting anything up. The lifespan hook injects the real one
    when ``CHAT_HISTORY_PUBLISH_ENABLED`` is on.
    """
    global _chat_history_publisher
    if _chat_history_publisher is None:
        _chat_history_publisher = NoopChatHistoryPublisher()
    return _chat_history_publisher


def set_chat_history_publisher(publisher: ChatHistoryPublisher) -> None:
    """Inject the active :class:`ChatHistoryPublisher` — called from the FastAPI lifespan."""
    global _chat_history_publisher
    _chat_history_publisher = publisher


def chat_history_publishing_enabled() -> bool:
    """Return whether autonomous runs are being published to UI chat history."""
    return get_chat_history_publisher().enabled


def task_chat_history_publishing_enabled(task: TaskDefinition) -> bool:
    """Return whether this task may create UI chat-history records."""
    return chat_history_publishing_enabled() and not isinstance(
        task.trigger, WebhookTrigger
    )


def get_webex_thread_map() -> WebexThreadMap | None:
    """Return the active :class:`WebexThreadMap`, or None if unconfigured.

    The thread map is **optional** -- deployments without a Webex bot
    have nothing to record and we want their scheduler to skip the
    write entirely instead of erroring or storing rows that nothing
    ever queries. Returning ``None`` here is a deliberate signal to
    :func:`_record_webex_threads` that this responsibility is opt-in.
    """
    return _webex_thread_map


def set_webex_thread_map(thread_map: WebexThreadMap | None) -> None:
    """Inject the active :class:`WebexThreadMap` -- called from the FastAPI lifespan."""
    global _webex_thread_map
    _webex_thread_map = thread_map


async def _record_safely(store: RunStore, run: TaskRun) -> None:
    """Persist ``run`` and swallow store-side exceptions.

    Run-history persistence is observability, not the source of truth
    for whether a task ran. A flaky MongoDB or transient network blip
    must never abort task execution or surface a 500 on the webhook
    that triggered the run. We log loudly so the failure is still
    visible to operators, then return so the scheduler keeps marching.
    """
    try:
        await store.record(run)
    except Exception as exc:
        logger.error(
            f"[{run.task_id}] Failed to persist run {run.run_id} "
            f"(status={run.status}): {exc}"
        )


async def _attach_run_to_trigger_safely(
    trigger_instance_id: str | None, run_id: str
) -> None:
    """Best-effort back-link from a webhook delivery row to its run id.

    The ``trigger_instances`` collection records every webhook delivery
    we accepted (see ``services.trigger_instances``). When the scheduler
    actually starts the run we want the dedup row to point at the
    resulting ``run_id`` so audit tooling can navigate "delivery X ->
    run Y" without join hopping.

    Failures here are *never* allowed to abort the task: the dedup row
    is observability, the task already ran. ``attach_run_to_trigger_instance``
    on :class:`MongoService` already swallows exceptions; we add an
    extra guard here in case the singleton itself isn't connected (unit
    tests, in-memory test setups).
    """
    if not trigger_instance_id:
        return
    try:
        # Deferred import keeps task_runner.py importable in unit tests
        # that never wire up MongoDB at all -- the import alone would
        # otherwise pull in motor. Do NOT hoist to module top.
        from autonomous_agents.services.mongo import get_mongo_service

        mongo = get_mongo_service()
        if not mongo.is_connected:
            return
        await mongo.attach_run_to_trigger_instance(trigger_instance_id, run_id)
    except Exception as exc:  # noqa: BLE001 -- audit-only path
        logger.warning(
            "[%s] attach_run_to_trigger_instance(%s) swallowed: %s",
            run_id,
            trigger_instance_id,
            exc,
        )


async def _record_webex_threads_safely(
    thread_map: WebexThreadMap | None,
    task_id: str,
    run_id: str,
    events: list[dict[str, Any]] | None,
) -> None:
    """Best-effort scan-and-record of Webex messageIds the run produced.

    Walks ``events`` for the ``post_message`` tool descriptor we
    inject in the Webex MCP server, then upserts each
    ``messageId -> (task_id, run_id, room_id)`` into the configured
    :class:`WebexThreadMap`. This is the seam that lets a later
    in-thread reply (Webex delivers it as a webhook with
    ``parentId=<that messageId>``) be routed back to the originating
    task as a follow-up.

    Same contract as :func:`_record_safely` and :func:`_publish_safely`:
    thread-map writes are observability/routing infrastructure, not
    the source of truth for whether a task ran. Failures here MUST
    NEVER abort task execution -- log loudly, return, move on.
    """
    if thread_map is None:
        # No bot deployed -> nothing to do. Common case.
        return
    pairs = extract_webex_message_ids(events)
    if not pairs:
        return
    for message_id, room_id in pairs:
        try:
            await thread_map.record(
                WebexThreadEntry(
                    message_id=message_id,
                    task_id=task_id,
                    run_id=run_id,
                    room_id=room_id,
                )
            )
        except Exception as exc:  # noqa: BLE001 -- best-effort
            logger.error(
                "[%s] Failed to record Webex thread map entry "
                "(message_id=%s, run_id=%s): %s",
                task_id, message_id, run_id, exc,
            )


async def _publish_safely(
    publisher: ChatHistoryPublisher,
    run: TaskRun,
    task: TaskDefinition,
    context: dict[str, Any] | None,
    *,
    response: str | None,
    error: str | None,
    agent: str | None,
) -> None:
    """Surface the run in the UI chat history -- best effort.

    Same contract as :func:`_record_safely`: chat-history publishing
    is an observability feature, not part of the source of truth.
    A misconfigured or unavailable chat database must never propagate
    out and either abort the task or 500 the webhook that fired it.
    Log loudly, swallow the exception, return.

    Note: prompt construction lives *inside* the try block on purpose
    -- a non-JSON-serialisable webhook context would otherwise raise
    out of ``execute_task``'s finally clause, contradicting the "chat
    publishing must never abort a task" goal (Copilot review on PR
    #10).
    """
    try:
        prompt = _prompt_for_publish(task, context)
        await publisher.publish_run(
            run,
            prompt=prompt,
            response=response,
            error=error,
            agent=agent,
            conversation_id=run.conversation_id,
        )
    except Exception as exc:
        logger.error(
            f"[{run.task_id}] Failed to publish run {run.run_id} to chat history "
            f"(status={run.status}): {exc}"
        )


async def execute_task(
    task: TaskDefinition,
    context: dict[str, Any] | None = None,
    follow_up: FollowUpContext | None = None,
    *,
    run_id: str | None = None,
    trigger_instance_id: str | None = None,
) -> TaskRun:
    """Run a single task, record the result, and return the TaskRun.

    Public entry point used both by APScheduler (cron/interval) and by
    the routes layer (manual trigger, webhook). Keeping this public is
    intentional — it's part of the contract with the FastAPI handlers
    that drive ad-hoc execution. Don't add a leading underscore back.

    ``follow_up`` is set when an inbound bridge (e.g. the Webex bot)
    re-fires this task with operator feedback in response to a prior
    run. The follow-up text is appended to the task prompt under a
    clearly-labelled section, and ``TaskRun.parent_run_id`` is
    populated so the chat-thread synthesiser can render a single
    threaded timeline.

    ``run_id`` is normally generated here, but the webhook handler
    pre-allocates one before spawning the background task so it can
    return the id to the sender in the 202 response without waiting
    for the task to finish. If supplied it is used verbatim; otherwise
    a fresh UUIDv4 is minted.

    ``trigger_instance_id`` is the ``_id`` of the row in
    ``trigger_instances`` that recorded the originating webhook
    delivery. When set we back-link the run id onto that row in the
    finally block so audit tooling can navigate delivery -> run.
    """
    run_id = run_id or str(uuid.uuid4())
    root_run_id: str | None = None
    if isinstance(task.trigger, WebhookTrigger):
        if follow_up is None:
            # Every initial delivery gets a separate Dynamic Agents context.
            # The UI groups these by task, but the model/checkpointer must not
            # inherit state from an unrelated webhook payload.
            root_run_id = run_id
            execution_context_id = conversation_id_for_webhook_run(task.id, root_run_id)
        else:
            # Follow-ups inherit only the selected parent run's context. Routes
            # validate parent ownership before enqueueing; this lookup carries
            # the durable context id through the asynchronous worker boundary.
            recent_runs = await get_run_store().list_by_task(task.id, limit=500)
            parent = next(
                (candidate for candidate in recent_runs if candidate.run_id == follow_up.parent_run_id),
                None,
            )
            if parent is not None and parent.execution_context_id:
                root_run_id = parent.root_run_id or parent.run_id
                execution_context_id = parent.execution_context_id
            else:
                # Legacy webhook runs used the per-task context and have no
                # execution_context_id. Preserve that context for continuations
                # instead of silently losing the prior conversation state.
                root_run_id = (
                    (parent.root_run_id or parent.run_id)
                    if parent
                    else follow_up.parent_run_id
                )
                execution_context_id = conversation_id_for_task(task.id)
    else:
        # Scheduled tasks intentionally keep one continuing context per task.
        execution_context_id = conversation_id_for_task(task.id)

    publish_to_chat = task_chat_history_publishing_enabled(task)
    published_conversation_id = execution_context_id if publish_to_chat else None
    # Materialise the prompt the agent will actually see. For follow-up
    # runs we splice the operator reply into a clearly-labelled section
    # so the LLM treats it as new instructions rather than confusing it
    # with the original webhook payload context. The original task
    # definition is left untouched (we work off a model_copy) so this
    # has no persistence side-effects.
    effective_task = (
        task.model_copy(update={"prompt": _augment_prompt_for_followup(task.prompt, follow_up)})
        if follow_up is not None
        else task
    )
    # Use the task owner's email as the identity for this invocation so the
    # dynamic-agents service creates the conversation under the correct user.
    # Fall back to the configured system email for tasks created before the
    # owner_id field was introduced (backward compat).
    from autonomous_agents.config import get_settings as _get_settings
    _owner_email = task.owner_id or _get_settings().dynamic_agents_system_email
    # Keycloak subject (UUID) of the owner — the identifier OpenFGA/CAS key
    # subjects by. The dynamic-agents runtime authorizes the run against this
    # (not the email) so agent-use is decided as the owner, respecting group
    # sharing and revocation. None for legacy tasks; dynamic-agents then falls
    # back to the service-principal decision (which will deny unless separately
    # granted), so such tasks must be recreated to be authorized per-owner.
    _owner_sub = task.owner_sub

    run = TaskRun(
        run_id=run_id,
        task_id=task.id,
        task_name=task.name,
        status=TaskStatus.RUNNING,
        conversation_id=published_conversation_id,
        parent_run_id=follow_up.parent_run_id if follow_up else None,
        root_run_id=root_run_id,
        execution_context_id=execution_context_id,
        follow_up_text=follow_up.user_text if follow_up else None,
        follow_up_transport=follow_up.transport if follow_up else None,
        request_prompt=effective_task.prompt,
        trigger_instance_id=trigger_instance_id,
        owner_id=_owner_email,
    )

    store = get_run_store()
    # Persist the RUNNING state so observers (UI, CLI) can see in-flight
    # work, not only completed runs. Failure here MUST NOT abort the
    # task — see _record_safely.
    await _record_safely(store, run)

    logger.info(
        "[%s] Starting run %s%s",
        task.id,
        run_id,
        f" (follow-up to {follow_up.parent_run_id})" if follow_up else "",
    )
    response_text: str | None = None
    error_text: str | None = None
    try:
        if not effective_task.dynamic_agent_id:
            # Every autonomous task runs against a dynamic agent. A task
            # without a dynamic_agent_id predates the dynamic-only routing
            # model (or targeted the now-removed supervisor) and has no
            # execution backend -- fail fast with an actionable message
            # rather than silently doing nothing.
            raise ValueError(
                "Task has no dynamic_agent_id; autonomous tasks must target a "
                "dynamic agent. Edit the task and select a custom agent."
            )
        # Dynamic-agent execution: invoke the dynamic-agents service via SSE
        # streaming so we capture per-step events (tool_start / tool_end /
        # accumulated content). Persisting these on TaskRun.events lets the
        # autonomous-task chat thread replay the Tools / Final-answer
        # breakdown instead of a bare text bubble.
        response, events = await invoke_dynamic_agent_streaming(
            prompt=effective_task.prompt,
            task_id=effective_task.id,
            agent_id=effective_task.dynamic_agent_id,
            owner_email=_owner_email,
            owner_sub=_owner_sub,
            conversation_id=execution_context_id,
            context=context,
        )
        response_text = response
        run.status = TaskStatus.SUCCESS
        run.response_preview = response[:500]
        run.response_full = response
        run.events = events
        logger.info(
            f"[{task.id}] Run {run_id} succeeded "
            f"({len(events)} events, {len(response)} chars). "
            f"Preview: {response[:120]}..."
        )
    except DynamicAgentsAuthorizationRevokedError as exc:
        # The owner lost team entitlement or access to the selected agent. Fail
        # this run and auto-pause the task so it stops firing until access is
        # restored and the owner explicitly re-enables it.
        error_text = (
            f"{exc} — autonomous execution was disabled for this task. "
            "Ask a platform admin to enable Autonomous for one of your teams, "
            "or restore your access to this agent."
        )
        run.status = TaskStatus.FAILED
        run.error = error_text
        logger.warning("[%s] Run %s denied (authorization revoked); auto-pausing task", task.id, run_id)
        try:
            # Lazy import avoids a circular import (task_lifecycle imports task_runner).
            from autonomous_agents.services.task_lifecycle import get_task_store

            paused = task.model_copy(
                update={
                    "enabled": False,
                    "last_ack": Acknowledgement.application_failure(str(exc)),
                }
            )
            await get_task_store().update(task.id, paused)
        except Exception:
            logger.exception("[%s] Failed to auto-pause task after schedule revoke", task.id)
    except Exception as e:
        error_text = str(e)
        run.status = TaskStatus.FAILED
        run.error = error_text
        logger.error(f"[{task.id}] Run {run_id} failed: {e}")
    finally:
        run.finished_at = datetime.now(timezone.utc)
        # Persist the terminal state — RunStore.record is upsert by
        # run_id, so this updates the same document/entry rather than
        # appending a duplicate. Again wrapped to keep store outages
        # from masking the real task outcome.
        await _record_safely(store, run)
        # IMP-13: surface the run in the UI chat sidebar. Done after
        # the RunStore write so a slow/flaky chat database can never
        # delay the authoritative run-history record. The publisher
        # is a no-op when ``CHAT_HISTORY_PUBLISH_ENABLED`` is off so
        # this is essentially free in the default config.
        if publish_to_chat:
            await _publish_safely(
                get_chat_history_publisher(),
                run,
                effective_task,
                context,
                response=response_text,
                error=error_text,
                # Surface the dynamic agent id as the routing label so the chat
                # sidebar shows the same routing target as the autonomous tab.
                agent=task.dynamic_agent_id,
            )
        # Webex thread map: only worth scanning on a successful run --
        # a FAILED run usually didn't get far enough to call any
        # tools, and even when it did the message we'd record points
        # to a half-completed conversation that the bot wouldn't want
        # to continue. The helper is a no-op when no thread map has
        # been injected (i.e. no Webex bot deployed).
        if run.status == TaskStatus.SUCCESS:
            await _record_webex_threads_safely(
                get_webex_thread_map(),
                task_id=task.id,
                run_id=run_id,
                events=run.events,
            )
        # Back-link the dedup row to its run id (best-effort, no-op
        # for cron / interval / manual fires that have no
        # trigger_instance_id). Done last so a flaky update never
        # masks a successful run; the helper is itself no-raise.
        await _attach_run_to_trigger_safely(trigger_instance_id, run_id)

    return run


def _augment_prompt_for_followup(
    base_prompt: str, follow_up: FollowUpContext | None
) -> str:
    """Splice an operator follow-up reply into the task prompt.

    The follow-up is rendered as a clearly-labelled trailing section
    so the task-runtime LLM treats it as new instructions rather than
    blending it into the original webhook context. We deliberately do
    NOT rewrite or summarise the operator's text -- the LLM is the
    judge of what the feedback means.
    """
    if follow_up is None:
        return base_prompt

    who = follow_up.user_ref or "operator"
    transport = follow_up.transport or "follow-up"
    return (
        f"{base_prompt}\n\n"
        f"Operator follow-up ({transport}, from {who}, "
        f"in reply to run {follow_up.parent_run_id}):\n"
        f"{follow_up.user_text}"
    )


def _prompt_for_publish(
    task: TaskDefinition,
    context: dict[str, Any] | None,
) -> str:
    """Reconstruct the user-visible prompt for chat-history publishing.

    Mirrors the augmentation that ``dynamic_agents_client`` applies before
    dispatching to the dynamic-agents runtime: when a webhook supplies
    a context payload, the actual prompt the agent saw is
    ``f"{prompt}\n\nContext:\n{json}"``. Showing the same string in
    chat keeps the conversation honest — otherwise a webhook-triggered
    run would look like the bare prompt fired with no context, and
    debugging "why did the agent do X?" becomes much harder.

    Webhook payloads frequently contain internal/customer data
    (incident bodies, PR descriptions, customer ids). The chat
    history is read-accessible to *any* authenticated UI user via
    ``requireConversationAccess`` (PR #10 Codex P1 review), so
    inlining the raw context into the published prompt would be a
    data-exposure regression. We default to a redacted marker
    (``Context: <redacted N keys>``) and only inline the payload
    when the operator explicitly opts in via
    ``CHAT_HISTORY_INCLUDE_CONTEXT=true``.
    """
    display_prompt = _display_prompt_for_chat(task.prompt)

    if not context:
        return display_prompt

    # Deferred import keeps task_runner.py importable in unit tests
    # that never wire up Settings. Do NOT hoist to module top.
    from autonomous_agents.config import get_settings

    if not get_settings().chat_history_include_context:
        return f"{display_prompt}\n\nContext: <redacted {len(context)} keys>"

    import json as _json

    try:
        rendered = _json.dumps(context, indent=2, default=str)
    except (TypeError, ValueError):
        rendered = f"<unserialisable context: {len(context)} keys>"
    return f"{display_prompt}\n\nContext:\n{rendered}"


def _display_prompt_for_chat(prompt: str) -> str:
    """Render follow-up prompts tersely for the user-side chat bubble."""
    match = _FOLLOW_UP_PROMPT_RE.search(prompt)
    if match is None:
        return prompt

    transport = match.group("transport") or "follow-up"
    message = (match.group("message") or "").strip()
    if not message:
        return prompt

    label = f"{transport[:1].upper()}{transport[1:]}" if transport else "Follow-up"
    return f"{label} Follow-up: {message}"


async def fire_webhook_task(
    task: TaskDefinition,
    context: dict[str, Any],
    follow_up: FollowUpContext | None = None,
    *,
    run_id: str | None = None,
    trigger_instance_id: str | None = None,
) -> TaskRun:
    """Immediately execute a webhook-triggered task and return the completed run.

    ``follow_up`` is forwarded to :func:`execute_task` so the inbound
    bridge can re-fire the same task with operator feedback. ``None``
    for the original webhook fire and for the test-trigger button.

    ``run_id`` / ``trigger_instance_id`` are forwarded so the webhook
    route can pre-allocate a run id (returned in the 202 response) and
    link the resulting run back to its dedup row.

    .. deprecated::
        After the PR2 webhook-dispatch extraction, ``_fire_and_log`` in
        ``services.webhook_runtime`` calls :func:`execute_task` directly
        and this wrapper exists only for backwards-compat with the
        ``test_scheduler.py`` import. Slated for removal in a follow-up
        once that test is updated.
    """
    return await execute_task(
        task,
        context=context,
        follow_up=follow_up,
        run_id=run_id,
        trigger_instance_id=trigger_instance_id,
    )
