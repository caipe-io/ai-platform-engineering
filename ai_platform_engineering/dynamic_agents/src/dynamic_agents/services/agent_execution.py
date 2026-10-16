"""Canonical admission and lifetime for native agent execution.

HTTP routes authorize callers and validate overrides before entering this
service. Every turn uses ACP; session storage, runtime caching and cancellation
are owned here rather than by the transport or HTTP routes.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from contextlib import AsyncExitStack, aclosing, asynccontextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from dynamic_agents.auth.authz import (
    current_subject_reference,
    require_agent_use_permission,
    require_conversation_read_permission,
)
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import ClientContext, DynamicAgentConfig, InputFile, UserContext
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.harness_admission import inline_harness_admission, require_harness_workspace
from dynamic_agents.services.harness_checkpoints import CheckpointIdentity, CheckpointStore
from dynamic_agents.services.harness_inputs import HarnessInputs
from dynamic_agents.services.harness_tools import HARNESS_TOOL_REQUESTS_COLLECTION, harness_resources
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.native_acp import cancel_native_acp, native_acp_stream, native_acp_turn
from dynamic_agents.services.native_run_coordinator import (
    NativeRunCoordinator,
    current_native_execution_run,
    mark_native_run_admitted,
    mark_native_run_released,
    native_child_execution,
)
from dynamic_agents.services.native_run_repository import (
    EXECUTION_EVENTS_COLLECTION,
    EXECUTION_RUNS_COLLECTION,
    NativeExecutionRun,
    NativeRunBusyError,
    NativeRunRepository,
    NativeRunStorageError,
)
from dynamic_agents.services.runtime_cache import AgentRuntimeCache, get_runtime_cache
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.sandbox_client import SandboxError
from dynamic_agents.services.sandbox_lifecycle import clear_sandbox_session, restart_sandbox_session
from dynamic_agents.services.sandbox_runtime import SandboxRuntime, sandbox_runtime
from dynamic_agents.services.session_bindings import (
    clear_delegated_sessions,
    get_delegated_sessions,
    get_native_binding,
    get_sandbox_binding,
    link_delegated_session,
    resolve_native_binding,
)
from dynamic_agents.services.session_runs import (
    SessionRunBusyError,
    await_session_operation,
    current_native_session_lease,
    native_session_run,
    request_native_session_cancel,
)
from dynamic_agents.services.stream_encoders import StreamEncoder, get_encoder


@dataclass(frozen=True)
class ExecutionTurn:
    """An authorized caller's validated request, ready for session admission."""

    agent: DynamicAgentConfig
    session_id: str
    user: UserContext
    message: str | None = None
    client_context: ClientContext | None = None
    trace_id: str | None = None
    files: list[InputFile] | None = None
    turn_id: str | None = None
    resume_data: str | None = None


@dataclass(frozen=True)
class InvocationResult:
    content: str
    thinking: str | None
    interrupt: dict[str, Any] | None


@dataclass(frozen=True)
class ClearResult:
    checkpoints_deleted: int
    writes_deleted: int
    files_deleted: int


class _RuntimeMode(Enum):
    CACHED = "cached"
    PERSISTENT = "persistent"
    EPHEMERAL = "ephemeral"


class AgentExecutionService:
    """Own session admission, runtime selection, dispatch and state operations."""

    def __init__(
        self,
        mongo: MongoDBService | None,
        *,
        settings: Settings | None = None,
        cache: AgentRuntimeCache | None = None,
    ) -> None:
        self.mongo = mongo
        self.settings = settings or get_settings()
        self.cache = cache or get_runtime_cache()
        if mongo is not None:
            self.cache.set_mongo_service(mongo)

    @property
    def coordinator(self) -> NativeRunCoordinator:
        """One task owner per process/database, never one owner per HTTP caller."""
        if self.mongo is None:
            raise NativeRunStorageError("Durable streaming requires the canonical database")
        return get_native_run_coordinator(self.mongo)

    @staticmethod
    def _owner(user: UserContext) -> str:
        return current_subject_reference() or f"email:{user.email.strip().lower()}"

    async def start_run(
        self,
        turn: ExecutionTurn,
        protocol: str,
        *,
        producer: Callable[[ExecutionTurn, StreamEncoder[str]], AsyncIterator[str]] | None = None,
        retain_result: bool = False,
    ) -> NativeExecutionRun:
        """Admit one durable request; a retry attaches instead of repeating tools."""
        turn = replace(turn, turn_id=turn.turn_id or str(uuid4()))
        saved = await self._saved_agent(turn.agent.id, turn.session_id)
        if (saved or turn.agent).execution.kind == "sandbox":
            await self._require_completed_sandbox_edit(turn.agent.id, turn.session_id)
        if turn.resume_data is not None and saved is not None and (saved.execution.kind == "sandbox"):
            return await HarnessInputs(self.coordinator.repository).submit(
                agent_id=turn.agent.id,
                session_id=turn.session_id,
                owner=self._owner(turn.user),
                turn_id=turn.turn_id,
                resume_data=turn.resume_data,
                protocol=protocol,
            )
        encoder = get_encoder(protocol)
        payload = {
            "agent": turn.agent.model_dump(mode="json", by_alias=True),
            "message": turn.message,
            "resume_data": turn.resume_data,
            "files": [file.model_dump(mode="json") for file in turn.files or []],
            "client_context": turn.client_context.model_dump(mode="json") if turn.client_context else None,
            "protocol": protocol,
        }
        if retain_result:
            payload["retain_result"] = True
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        dispatch = producer or self.stream

        def result() -> dict:
            return {"content": encoder.get_accumulated_content(), "thinking": encoder.get_thinking_content() or None}

        return await self.coordinator.start(
            owner_subject=self._owner(turn.user),
            agent_id=turn.agent.id,
            session_id=turn.session_id,
            turn_id=turn.turn_id,
            fingerprint=fingerprint,
            protocol=protocol,
            producer=lambda: dispatch(turn, encoder),
            outcome=encoder.get_outcome,
            **{"result": result} if retain_result else {},
        )

    async def get_run_status(
        self,
        agent_id: str,
        session_id: str,
        user: UserContext,
        *,
        run_id: str | None = None,
    ) -> NativeExecutionRun | None:
        """Authorize the original owner or a CAS-authorized conversation reader."""
        repository = self.coordinator.repository
        if run_id is None:
            run = await repository.latest(owner_subject=None, agent_id=agent_id, session_id=session_id)
        else:
            run = await repository.get(run_id, owner_subject=None, agent_id=agent_id, session_id=session_id)
        if run is not None and run.owner_subject != self._owner(user):
            await require_conversation_read_permission(session_id)
        return run

    async def run_events(
        self,
        run: NativeExecutionRun,
        after: int = 0,
    ) -> AsyncGenerator[str, None]:
        """Subscribe only after get_run_status has authorized the run resource."""
        async with aclosing(self.coordinator.subscribe(run, after)) as frames:
            async for frame in frames:
                yield frame

    async def _saved_agent(self, agent_id: str, session_id: str) -> DynamicAgentConfig | None:
        if self.mongo is None or not agent_id:
            return None
        return await asyncio.to_thread(get_native_binding, self.mongo, agent_id, session_id)

    @asynccontextmanager
    async def _session(
        self,
        agent_id: str,
        session_id: str,
        *,
        execute: bool = False,
    ) -> AsyncGenerator[DynamicAgentConfig | None, None]:
        """Guard execution and state mutations before resolving their binding."""
        async with AsyncExitStack() as stack:
            lease_id = None
            if self.mongo is not None and agent_id:
                lease_id = await stack.enter_async_context(native_session_run(self.mongo, agent_id, session_id))
            try:
                if execute:
                    if lease_id is not None:
                        await mark_native_run_admitted(lease_id)
                    await stack.enter_async_context(native_acp_turn(agent_id, session_id))
                # Reads follow the lease so another worker cannot update the snapshot
                # between resolving storage coordinates and mutating its state.
                saved = await self._saved_agent(agent_id, session_id) if not execute else None
                yield saved
            finally:
                if execute:
                    await mark_native_run_released()

    @asynccontextmanager
    async def _runtime(
        self, turn: ExecutionTurn, mode: _RuntimeMode
    ) -> AsyncGenerator[AgentRuntime | SandboxRuntime, None]:
        async with self._session(turn.agent.id, turn.session_id, execute=True):
            external_child = inline_harness_admission.get() is not None
            agent = turn.agent
            if self.mongo is not None and mode is not _RuntimeMode.EPHEMERAL:
                agent = await await_session_operation(
                    resolve_native_binding, self.mongo, agent, turn.session_id, resume=turn.resume_data is not None
                )
            if external_child:
                # Recheck the actual retained definition under the child lease.
                await self._admit_harness_child(agent, turn.session_id)
            servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, agent) if self.mongo is not None else []
            if agent.execution.kind == "sandbox":
                await self._require_harness_boundary(agent, turn.session_id)
                if self.mongo is None or current_native_execution_run.get() is None:
                    raise SandboxError("Sandbox execution requires the canonical database and a durable admitted run")
                await self._require_completed_sandbox_edit(agent.id, turn.session_id)
                async with harness_resources(
                    self.mongo,
                    agent,
                    servers,
                    turn.session_id,
                    turn.user,
                    turn.client_context,
                    current_native_execution_run.get(),
                    settings=self.settings,
                    invoke_child=lambda child, child_session, message, resume: self._invoke_harness_child(
                        turn, child, child_session, message, resume
                    ),
                    admit_child=self._admit_harness_child,
                    admit_parent=self._require_harness_boundary,
                ) as resources:
                    async with sandbox_runtime(
                        self.mongo,
                        agent,
                        turn.session_id,
                        self.settings,
                        system_prompt=resources.system_prompt,
                        skills_files=resources.skills_files,
                        mcp_servers=resources.mcp_servers,
                        bind_driver=resources.bind_driver,
                        bind_workspace=resources.bind_workspace,
                    ) as runtime:
                        yield runtime
                return
            arguments = (agent, servers, turn.session_id)
            context = {"user": turn.user, "client_context": turn.client_context}
            async with AsyncExitStack() as stack:
                if mode is _RuntimeMode.CACHED:
                    runtime = await stack.enter_async_context(self.cache.borrow(*arguments, **context))
                elif mode is _RuntimeMode.PERSISTENT:
                    runtime = await stack.enter_async_context(self.cache.persistent(*arguments, **context))
                else:
                    runtime = await stack.enter_async_context(self.cache.ephemeral(*arguments, **context))
                if external_child:
                    await self._admit_harness_child(runtime.config, turn.session_id)
                yield runtime
                if external_child:
                    await self._admit_harness_child(runtime.config, turn.session_id)

    async def _dispatch(
        self, runtime: AgentRuntime | SandboxRuntime, turn: ExecutionTurn, encoder: StreamEncoder[str]
    ) -> AsyncGenerator[str, None]:
        if isinstance(runtime, SandboxRuntime):
            if turn.resume_data is not None:
                raise SandboxError("Resume the existing harness request instead of sending another prompt")
            state = await await_session_operation(get_sandbox_binding, self.mongo, turn.agent.id, turn.session_id)
            identity = self._checkpoint_identity(turn.agent.id, turn.session_id, state)
            lease_id = current_native_session_lease.get()
            if lease_id is None:
                raise SandboxError("Native prompt history requires its admitted session lease")
            store = await asyncio.to_thread(CheckpointStore, self.mongo)
            delegated_states = await self._delegated_checkpoint_states(turn.agent.id, turn.session_id, turn.user)
            await store.record_turn(
                identity, run_id=runtime.run_id, message=turn.message or "", lease_id=lease_id,
                delegated_states=delegated_states,
            )
            async with aclosing(runtime.dispatch(turn.message or "", encoder, turn.files)) as frames:
                async for frame in frames:
                    yield frame
            return
        async with aclosing(
            native_acp_stream(
                runtime,
                message=turn.message,
                session_id=turn.session_id,
                user_email=turn.user.email,
                encoder=encoder,
                trace_id=turn.trace_id,
                files=turn.files,
                turn_id=turn.turn_id,
                resume_data=turn.resume_data,
            )
        ) as frames:
            async for frame in frames:
                yield frame

    async def stream(self, turn: ExecutionTurn, encoder: StreamEncoder[str]) -> AsyncGenerator[str, None]:
        async with self._runtime(turn, _RuntimeMode.CACHED) as runtime:
            async with aclosing(self._dispatch(runtime, turn, encoder)) as frames:
                async for frame in frames:
                    yield frame

    async def _require_harness_boundary(self, agent: DynamicAgentConfig, session_id: str) -> None:
        """Keep external placement within the current agent and storage grants."""
        await require_agent_use_permission(agent.id)
        saved = await self._saved_agent(agent.id, session_id)
        for candidate in (agent, saved):
            if candidate is None:
                continue
            if not candidate.enabled:
                raise SandboxError("The admitted agent is no longer available")
            await require_harness_workspace(self.mongo, candidate, session_id, self.settings)

    async def _admit_harness_child(
        self,
        child: DynamicAgentConfig,
        session_id: str,
        *,
        _inline: bool = False,
        _ancestors: frozenset[str] = frozenset(),
    ) -> None:
        if self.mongo is None or child.id in _ancestors:
            raise SandboxError("Native child admission requires a canonical, acyclic agent reference")
        await require_agent_use_permission(child.id)
        current = await await_session_operation(self.mongo.get_agent, child.id)
        saved = None if _inline else await self._saved_agent(child.id, session_id)
        if current is None:
            raise SandboxError("The configured native child is unavailable")
        candidates = [child, current, *([saved] if saved is not None else [])]
        for candidate in candidates:
            if not candidate.enabled or candidate.execution.kind != "native" or candidate.model is None:
                raise SandboxError("External delegation requires an enabled native child with its configured model")
            if _inline and candidate.subagents:
                raise SandboxError("Nested inline child definitions are not supported by the native runtime")
            await self._require_harness_boundary(candidate, session_id)
        current_refs = {(ref.agent_id, ref.name) for ref in current.subagents}
        for candidate in candidates:
            if any(((ref.agent_id, ref.name) not in current_refs for ref in candidate.subagents)):
                raise SandboxError("A retained inline child reference was revoked; use a new conversation")
        refs = {ref.agent_id for candidate in candidates for ref in candidate.subagents}
        if len(refs) > 64:
            raise SandboxError("The inline child admission exceeds its supported agent limit")
        for agent_id in refs:
            inline = await await_session_operation(self.mongo.get_agent, agent_id)
            if inline is None:
                raise SandboxError("A configured inline child is unavailable")
            await self._admit_harness_child(inline, session_id, _inline=True, _ancestors=_ancestors | {child.id})

    async def _invoke_harness_child(
        self,
        parent: ExecutionTurn,
        child: DynamicAgentConfig,
        session_id: str,
        message: str | None,
        resume_data: str | None,
    ) -> InvocationResult:
        await self._admit_harness_child(child, session_id)
        await await_session_operation(
            link_delegated_session, self.mongo, parent.agent.id, parent.session_id,
            child.id, session_id, self._owner(parent.user),
        )
        permitted_inline = {ref.agent_id for ref in child.subagents}

        async def admit_actual_inline(actual: DynamicAgentConfig | None, agent_id: str) -> None:
            if actual is None or actual.id != agent_id or agent_id not in permitted_inline:
                raise SandboxError("The actual inline child does not match the admitted native delegation")
            await self._admit_harness_child(actual, session_id, _inline=True, _ancestors=frozenset({child.id}))

        admission = inline_harness_admission.set(admit_actual_inline)
        try:
            with native_child_execution():
                result = await self.invoke(
                    ExecutionTurn(
                        agent=child,
                        session_id=session_id,
                        user=parent.user,
                        message=message,
                        resume_data=resume_data,
                        client_context=parent.client_context,
                        trace_id=parent.trace_id,
                    ),
                    persistent=True,
                )
            # Grants may narrow during a child turn or human wait.
            await self._admit_harness_child(child, session_id)
            return result
        finally:
            inline_harness_admission.reset(admission)

    async def invoke(self, turn: ExecutionTurn, *, persistent: bool = False) -> InvocationResult:
        saved = await self._saved_agent(turn.agent.id, turn.session_id)
        if (saved or turn.agent).execution.kind == "sandbox":
            run = await self.start_run(turn, "custom", retain_result=True)
            async with aclosing(self.run_events(run, run.first_sequence)) as frames:
                async for _frame in frames:
                    pass
            completed = await self.coordinator.repository.get(run.run_id, owner_subject=self._owner(turn.user))
            if completed is not None and completed.status == "awaiting_input":
                interrupt = await HarnessInputs(self.coordinator.repository).current(turn.agent.id, turn.session_id)
                return InvocationResult(content="", thinking=None, interrupt=interrupt)
            if completed is None or completed.status != "completed" or completed.result is None:
                raise SandboxError("The harness invocation was interrupted; saved progress is retained")
            return InvocationResult(
                content=completed.result["content"], thinking=completed.result.get("thinking"), interrupt=None
            )
        scheduler = turn.client_context is not None and turn.client_context.source == "scheduler"
        mode = (
            _RuntimeMode.PERSISTENT
            if persistent or scheduler
            else _RuntimeMode.CACHED
            if self.settings.invoke_persist_history
            else _RuntimeMode.EPHEMERAL
        )
        encoder = get_encoder("custom")
        async with self._runtime(turn, mode) as runtime:
            async with aclosing(self._dispatch(runtime, turn, encoder)) as frames:
                async for _frame in frames:
                    pass
            interrupt = await runtime.has_pending_interrupt(turn.session_id)
        return InvocationResult(
            content=encoder.get_accumulated_content(),
            thinking=encoder.get_thinking_content() or None,
            interrupt=interrupt,
        )

    @asynccontextmanager
    async def _state_runtime(
        self,
        agent: DynamicAgentConfig,
        session_id: str,
        user: UserContext,
        *,
        read_only: bool = False,
    ) -> AsyncGenerator[AgentRuntime, None]:
        servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, agent) if self.mongo is not None else []
        async with self.cache.borrow(agent, servers, session_id, user=user, read_only=read_only) as runtime:
            yield runtime

    async def interrupt_state(
        self, agent: DynamicAgentConfig, session_id: str, user: UserContext
    ) -> dict[str, Any] | None:
        saved = await self._saved_agent(agent.id, session_id)
        if saved is not None and saved.execution.kind == "sandbox":
            return await HarnessInputs(self.coordinator.repository).current(agent.id, session_id)
        async with self._state_runtime(saved or agent, session_id, user, read_only=True) as runtime:
            interrupt = await runtime.has_pending_interrupt(session_id) if runtime._graph else None
        return interrupt

    async def rewind(
        self,
        agent: DynamicAgentConfig,
        session_id: str,
        user: UserContext,
        *,
        turn_id: str,
        message_content: str,
        content_occurrence: int,
    ) -> str:
        async with self._session(agent.id, session_id) as saved:
            if (saved or agent).execution.kind == "sandbox":
                lease_id = current_native_session_lease.get()
                if lease_id is None:
                    raise SandboxError("Native rewind requires its admitted session lease")
                store = await asyncio.to_thread(CheckpointStore, self.mongo)
                pending = await store.pending_rewind(
                    agent.id, session_id, owner_subject=self._owner(user), lease_id=lease_id,
                )
                if pending is not None:
                    selected = pending["boundary"]
                    if (pending["requested_turn_id"] != turn_id or pending["requested_occurrence"] != content_occurrence
                            or selected["message_sha256"] != hashlib.sha256(message_content.encode()).hexdigest()):
                        raise SandboxError("Finish the pending conversation edit before selecting another message")
                    return await self._complete_sandbox_rewind(store, pending, user, lease_id)
                completed = await store.completed_rewind(
                    agent.id, session_id, owner_subject=self._owner(user), lease_id=lease_id,
                    turn_id=turn_id, message=message_content, occurrence=content_occurrence,
                )
                if completed is not None:
                    return completed
                state = await await_session_operation(get_sandbox_binding, self.mongo, agent.id, session_id)
                identity = self._checkpoint_identity(agent.id, session_id, state)
                if identity.owner_subject != self._owner(user):
                    raise SandboxError("Only the sandbox's original caller can edit its native session")
                boundary = await store.rewind_boundary(
                    identity, turn_id=turn_id, message=message_content, occurrence=content_occurrence, lease_id=lease_id,
                )
                await self._retire_replay(agent.id, session_id)
                intent = await store.begin_rewind(
                    identity, boundary=boundary, lease_id=lease_id,
                    requested_turn_id=turn_id, requested_occurrence=content_occurrence,
                )
                return await self._complete_sandbox_rewind(store, intent, user, lease_id)
            async with self._state_runtime(saved or agent, session_id, user) as runtime:
                return await runtime.rewind_before_turn(
                    session_id,
                    turn_id,
                    message_content,
                    content_occurrence,
                    before_mutation=lambda: self._retire_replay(agent.id, session_id),
                )

    async def _delegated_checkpoint_states(
        self, agent_id: str, session_id: str, user: UserContext,
    ) -> list[dict[str, Any]]:
        """Retain exact native child graph coordinates with the parent boundary."""
        children = await await_session_operation(
            get_delegated_sessions, self.mongo, agent_id, session_id, self._owner(user),
        )
        snapshots = []
        for child in children:
            async with self._session(child["agent_id"], child["session_id"]) as saved:
                if saved is None or saved.execution.kind != "native":
                    raise SandboxError("The delegated native session has no retained execution binding")
                async with self._state_runtime(saved, child["session_id"], user, read_only=True) as runtime:
                    snapshot = await runtime._graph.aget_state({"configurable": {"thread_id": child["session_id"]}})
                    checkpoint_id = snapshot.config.get("configurable", {}).get("checkpoint_id")
                    snapshots.append({"agent_id": child["agent_id"], "session_id": child["session_id"],
                        "checkpoint_id": checkpoint_id,
                        "checkpoint_ns": snapshot.config.get("configurable", {}).get("checkpoint_ns", "")})
        return snapshots

    async def _require_completed_sandbox_edit(self, agent_id: str, session_id: str) -> None:
        if self.mongo is None:
            return
        authority = await await_session_operation(
            self.mongo.get_session_runs_collection().find_one,
            {"agent_id": agent_id, "session_id": session_id},
            {"checkpoint_rewind": 1, "checkpoint_rewind_confirmation_required": 1},
        )
        if authority and (authority.get("checkpoint_rewind") or authority.get("checkpoint_rewind_confirmation_required")):
            raise SandboxError("A conversation edit is unfinished. Retry editing that message before sending another prompt.")

    async def requires_rewind_confirmation(self, agent_id: str, session_id: str) -> bool:
        saved = await self._saved_agent(agent_id, session_id)
        return saved is not None and saved.execution.kind == "sandbox"

    async def confirm_rewind(
        self, agent_id: str, session_id: str, user: UserContext, *, checkpoint_id: str,
        turn_id: str, message_content: str, content_occurrence: int,
    ) -> None:
        async with self._session(agent_id, session_id) as saved:
            if saved is None or saved.execution.kind != "sandbox":
                return
            lease_id = current_native_session_lease.get()
            if lease_id is None:
                raise SandboxError("Native edit confirmation requires its admitted session lease")
            store = await asyncio.to_thread(CheckpointStore, self.mongo)
            await store.confirm_rewind(
                agent_id, session_id, owner_subject=self._owner(user), lease_id=lease_id,
                checkpoint_id=checkpoint_id, turn_id=turn_id, message=message_content, occurrence=content_occurrence,
            )

    async def _complete_sandbox_rewind(
        self, store: CheckpointStore, intent: dict[str, Any], user: UserContext, lease_id: str,
    ) -> str:
        """Retry exact snapshot forks while the durable intent gates all prompts.

        Graph copies have no model/tool side effects. Repeating an unacknowledged
        copy selects the same original state, including pending interrupts. Hold
        existing child leases through the parent's atomic head publication.
        """
        identity = CheckpointIdentity.model_validate(intent["identity"])
        boundary = intent["boundary"]
        targets = boundary["delegated_states"]
        children = await await_session_operation(
            get_delegated_sessions, self.mongo, identity.agent_id, identity.session_id, self._owner(user),
        )
        target_keys = {(target["agent_id"], target["session_id"]) for target in targets if target["checkpoint_id"]}
        removed = [child for child in children if (child["agent_id"], child["session_id"]) not in target_keys]
        for child in removed:
            if await self._saved_agent(child["agent_id"], child["session_id"]) is not None:
                await self.clear(child["agent_id"], child["session_id"], _delegated=True)
        if removed:
            await await_session_operation(
                clear_delegated_sessions, self.mongo, identity.agent_id, identity.session_id, self._owner(user), children,
                remove=removed,
            )
        async with AsyncExitStack() as stack:
            for target in targets:
                if not target["checkpoint_id"]:
                    continue
                saved = await stack.enter_async_context(self._session(target["agent_id"], target["session_id"]))
                if saved is None or saved.execution.kind != "native":
                    raise SandboxError("The retained child checkpoint cannot be restored without its native binding")
                runtime = await stack.enter_async_context(self._state_runtime(saved, target["session_id"], user))
                snapshot = await runtime._graph.aget_state({"configurable": {
                    "thread_id": target["session_id"], "checkpoint_id": target["checkpoint_id"],
                    "checkpoint_ns": target["checkpoint_ns"],
                }})
                if (snapshot.config.get("configurable", {}).get("checkpoint_id") != target["checkpoint_id"]
                        or snapshot.metadata is None or snapshot.created_at is None):
                    raise SandboxError("The retained child checkpoint is unavailable; native rewind remains pending")
                await self._retire_replay(target["agent_id"], target["session_id"])
                await runtime._graph.aupdate_state(snapshot.config, None, as_node="__copy__")
            if boundary["checkpoint_id"] is None:
                # No provider transcript existed before the first prompt. A
                # fresh environment is the exact empty native-session boundary.
                await clear_sandbox_session(
                    self.mongo, identity.agent_id, identity.session_id, self.settings, preserve_rewind=True,
                )
            return await store.finish_rewind(intent, lease_id=lease_id)

    async def clear(
        self, agent_id: str, session_id: str, *, permanent: bool = False, _delegated: bool = False,
    ) -> ClearResult:
        if self.mongo is None or self.mongo._db is None:
            raise RuntimeError("Database not connected")
        async with self._session(agent_id, session_id) as saved:
            storage = resolve_runtime_storage(saved, session_id, self.settings, agent_id=agent_id)
            if _delegated and saved is not None and (
                saved.execution.kind != "native" or storage.fs_namespace != (agent_id, session_id, "filesystem")
            ):
                raise SandboxError("A delegated cleanup requires its own native session and workspace")
            children = await await_session_operation(
                get_delegated_sessions, self.mongo, agent_id, session_id, current_subject_reference(),
            ) if saved is not None and saved.execution.kind == "sandbox" else []
            deleted_children = ClearResult(0, 0, 0)
            await self._retire_replay(agent_id, session_id)
            db = self.mongo._db
            if permanent:
                # Fence late admissions before remote cleanup releases the lease.
                await await_session_operation(
                    db["native_acp_deleted_sessions"].update_one,
                    {"_id": session_id},
                    {"$setOnInsert": {"deleted_at": datetime.now(timezone.utc)}},
                    upsert=True,
                )
            for child in children:
                deleted = await self.clear(child["agent_id"], child["session_id"], permanent=permanent, _delegated=True)
                deleted_children = ClearResult(
                    deleted_children.checkpoints_deleted + deleted.checkpoints_deleted,
                    deleted_children.writes_deleted + deleted.writes_deleted,
                    deleted_children.files_deleted + deleted.files_deleted,
                )
            if children:
                await await_session_operation(
                    clear_delegated_sessions, self.mongo, agent_id, session_id, current_subject_reference(), children,
                )
            if saved is not None and saved.execution.kind == "sandbox":
                # Remote cleanup must succeed before canonical state is erased.
                await clear_sandbox_session(self.mongo, agent_id, session_id, self.settings)
            checkpoints = await await_session_operation(
                db[storage.checkpoint_collection].delete_many, {"thread_id": session_id}
            )
            writes = await await_session_operation(
                db[storage.checkpoint_writes_collection].delete_many, {"thread_id": session_id}
            )
            store = MongoDBGridFSStore(db=db, bucket_name=storage.gridfs_bucket_name)
            # One workflow step does not own the shared workflow file lifecycle.
            owns_files = saved is None or saved.execution.kind != "sandbox" or storage.fs_namespace[1] == session_id
            files = (
                await await_session_operation(store.delete_by_namespace, storage.fs_namespace)
                if agent_id and owns_files
                else 0
            )
            if _delegated:
                await self._purge_delegated_state(agent_id, session_id)
            # Fence delayed UI edit responses before releasing native admission.
            # A failed cleanup leaves its receipt/epoch intact for retry; only
            # confirmed cleanup may invalidate pending canonical history edits.
            await await_session_operation(
                db["conversations"].update_one, {"_id": session_id},
                {"$inc": {"native_rewind_epoch": 1}, "$unset": {"native_rewind": ""}},
            )
        return ClearResult(
            checkpoints.deleted_count + deleted_children.checkpoints_deleted,
            writes.deleted_count + deleted_children.writes_deleted,
            files + deleted_children.files_deleted,
        )

    async def _purge_delegated_state(self, agent_id: str, session_id: str) -> None:
        """Purge a confirmed child while its own session lease is still held."""
        db = self.mongo._db
        scope = {"agent_id": agent_id, "session_id": session_id}
        runs = await await_session_operation(lambda: list(db[EXECUTION_RUNS_COLLECTION].find(scope, {"run_id": 1})))
        await await_session_operation(db[EXECUTION_RUNS_COLLECTION].delete_many, scope)
        event_scope = [{"session_id": session_id}]
        if runs:
            event_scope.append({"run_id": {"$in": [run["run_id"] for run in runs]}})
        await await_session_operation(db[EXECUTION_EVENTS_COLLECTION].delete_many, {"$or": event_scope})
        await await_session_operation(db[HARNESS_TOOL_REQUESTS_COLLECTION].delete_many, {"session_id": session_id})
        await await_session_operation(self.mongo.get_session_bindings_collection().delete_one, scope)

    async def _retire_replay(self, agent_id: str, session_id: str) -> None:
        if self.mongo is None or not agent_id:
            return
        try:
            await self.coordinator.repository.retire_session(agent_id, session_id)
        except NativeRunBusyError as exc:
            raise SessionRunBusyError(str(exc)) from exc

    async def restart(self, agent_id: str, session_id: str) -> bool:
        async with self._session(agent_id, session_id) as saved:
            if saved is not None and saved.execution.kind == "sandbox":
                return await restart_sandbox_session(self.mongo, agent_id, session_id, self.settings)
            return await self.cache.invalidate(agent_id, session_id)

    @staticmethod
    def _checkpoint_identity(agent_id: str, session_id: str, state: dict[str, Any] | None) -> CheckpointIdentity:
        if state is None or not state.get("provider_session_id"):
            raise SandboxError("This conversation has no admitted native harness session")
        return CheckpointIdentity(
            agent_id=agent_id, session_id=session_id, owner_subject=state["owner_subject"],
            profile_id=state["profile"]["id"], profile_revision=state["profile"]["revision"],
            harness=state["profile"]["harness"], provider_session_id=state["provider_session_id"],
            connection_version=state["connection_version"],
        )

    async def cancel(self, agent_id: str, session_id: str, *, turn_id: str | None = None) -> bool:
        if turn_id is not None:
            # A delayed browser Stop must target its submitted turn, even if a
            # newer request has since acquired this conversation's native lease.
            return await self.coordinator.cancel(agent_id, session_id, turn_id=turn_id)
        cancelled = False
        if self.mongo is not None and self.mongo._db is not None:
            cancelled = await self.coordinator.cancel(agent_id, session_id)
        cancelled = cancel_native_acp(agent_id, session_id) or cancelled
        if self.mongo is not None:
            cancelled = (
                await asyncio.to_thread(request_native_session_cancel, self.mongo, agent_id, session_id) or cancelled
            )
        return cancelled or self.cache.cancel_stream(agent_id, session_id)


def get_native_run_coordinator(mongo: MongoDBService) -> NativeRunCoordinator:
    """Retain detached workers with the canonical Mongo service's lifetime."""
    coordinator = getattr(mongo, "_native_run_coordinator", None)
    if coordinator is None:
        coordinator = NativeRunCoordinator(NativeRunRepository(mongo))
        mongo._native_run_coordinator = coordinator
    return coordinator
