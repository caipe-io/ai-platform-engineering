"""Canonical admission and lifetime for native agent execution.

HTTP routes authorize callers and validate overrides before entering this
service. Every turn uses ACP; session storage, runtime caching and cancellation
are owned here rather than by the transport or HTTP routes.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from contextlib import AsyncExitStack, aclosing, asynccontextmanager
from dataclasses import dataclass
from enum import Enum
from typing import Any

from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import ClientContext, DynamicAgentConfig, InputFile, UserContext
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.native_acp import cancel_native_acp, native_acp_stream, native_acp_turn
from dynamic_agents.services.runtime_cache import AgentRuntimeCache, get_runtime_cache
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.session_bindings import get_native_binding, resolve_native_binding
from dynamic_agents.services.session_runs import (
    await_session_operation,
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

    async def _saved_agent(self, agent_id: str, session_id: str) -> DynamicAgentConfig | None:
        if self.mongo is None or not agent_id:
            return None
        return await asyncio.to_thread(get_native_binding, self.mongo, agent_id, session_id)

    @asynccontextmanager
    async def _session(
        self, agent_id: str, session_id: str, *, execute: bool = False,
    ) -> AsyncGenerator[DynamicAgentConfig | None, None]:
        """Guard execution and state mutations before resolving their binding."""
        async with AsyncExitStack() as stack:
            if self.mongo is not None and agent_id:
                await stack.enter_async_context(native_session_run(self.mongo, agent_id, session_id))
            if execute:
                await stack.enter_async_context(native_acp_turn(agent_id, session_id))
            # Reads follow the lease so another worker cannot update the snapshot
            # between resolving storage coordinates and mutating its state.
            saved = await self._saved_agent(agent_id, session_id) if not execute else None
            yield saved

    @asynccontextmanager
    async def _runtime(
        self, turn: ExecutionTurn, mode: _RuntimeMode,
    ) -> AsyncGenerator[AgentRuntime, None]:
        async with self._session(turn.agent.id, turn.session_id, execute=True):
            agent = turn.agent
            if self.mongo is not None and mode is not _RuntimeMode.EPHEMERAL:
                agent = await await_session_operation(
                    resolve_native_binding, self.mongo, agent, turn.session_id,
                    resume=turn.resume_data is not None,
                )
            servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, agent) if self.mongo is not None else []
            arguments = (agent, servers, turn.session_id)
            context = {"user": turn.user, "client_context": turn.client_context}
            async with AsyncExitStack() as stack:
                if mode is _RuntimeMode.CACHED:
                    runtime = await stack.enter_async_context(self.cache.borrow(*arguments, **context))
                elif mode is _RuntimeMode.PERSISTENT:
                    runtime = await stack.enter_async_context(self.cache.persistent(*arguments, **context))
                else:
                    runtime = await stack.enter_async_context(self.cache.ephemeral(*arguments, **context))
                yield runtime

    async def _dispatch(
        self, runtime: AgentRuntime, turn: ExecutionTurn, encoder: StreamEncoder[str],
    ) -> AsyncGenerator[str, None]:
        async with aclosing(native_acp_stream(
            runtime, message=turn.message, session_id=turn.session_id, user_email=turn.user.email,
            encoder=encoder, trace_id=turn.trace_id, files=turn.files, turn_id=turn.turn_id,
            resume_data=turn.resume_data,
        )) as frames:
            async for frame in frames:
                yield frame

    async def stream(self, turn: ExecutionTurn, encoder: StreamEncoder[str]) -> AsyncGenerator[str, None]:
        async with self._runtime(turn, _RuntimeMode.CACHED) as runtime:
            async with aclosing(self._dispatch(runtime, turn, encoder)) as frames:
                async for frame in frames:
                    yield frame

    async def invoke(self, turn: ExecutionTurn) -> InvocationResult:
        scheduler = turn.client_context is not None and turn.client_context.source == "scheduler"
        mode = (
            _RuntimeMode.PERSISTENT if scheduler else
            _RuntimeMode.CACHED if self.settings.invoke_persist_history else
            _RuntimeMode.EPHEMERAL
        )
        encoder = get_encoder("custom")
        async with self._runtime(turn, mode) as runtime:
            async with aclosing(self._dispatch(runtime, turn, encoder)) as frames:
                async for _frame in frames:
                    pass
            interrupt = await runtime.has_pending_interrupt(turn.session_id)
        return InvocationResult(
            content=encoder.get_accumulated_content(), thinking=encoder.get_thinking_content() or None,
            interrupt=interrupt,
        )

    @asynccontextmanager
    async def _state_runtime(
        self, agent: DynamicAgentConfig, session_id: str, user: UserContext,
        *, read_only: bool = False,
    ) -> AsyncGenerator[AgentRuntime, None]:
        servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, agent) if self.mongo is not None else []
        async with self.cache.borrow(agent, servers, session_id, user=user, read_only=read_only) as runtime:
            yield runtime

    async def interrupt_state(
        self, agent: DynamicAgentConfig, session_id: str, user: UserContext,
    ) -> dict[str, Any] | None:
        saved = await self._saved_agent(agent.id, session_id)
        async with self._state_runtime(saved or agent, session_id, user, read_only=True) as runtime:
            return await runtime.has_pending_interrupt(session_id) if runtime._graph else None

    async def rewind(
        self, agent: DynamicAgentConfig, session_id: str, user: UserContext,
        *, turn_id: str, message_content: str, content_occurrence: int,
    ) -> str:
        async with self._session(agent.id, session_id) as saved:
            async with self._state_runtime(saved or agent, session_id, user) as runtime:
                return await runtime.rewind_before_turn(session_id, turn_id, message_content, content_occurrence)

    async def clear(self, agent_id: str, session_id: str) -> ClearResult:
        if self.mongo is None or self.mongo._db is None:
            raise RuntimeError("Database not connected")
        async with self._session(agent_id, session_id) as saved:
            storage = resolve_runtime_storage(saved, session_id, self.settings, agent_id=agent_id)
            db = self.mongo._db
            checkpoints = await await_session_operation(db[storage.checkpoint_collection].delete_many, {"thread_id": session_id})
            writes = await await_session_operation(db[storage.checkpoint_writes_collection].delete_many, {"thread_id": session_id})
            store = MongoDBGridFSStore(db=db, bucket_name=storage.gridfs_bucket_name)
            files = await await_session_operation(store.delete_by_namespace, storage.fs_namespace) if agent_id else 0
        return ClearResult(checkpoints.deleted_count, writes.deleted_count, files)

    async def restart(self, agent_id: str, session_id: str) -> bool:
        async with self._session(agent_id, session_id):
            return await self.cache.invalidate(agent_id, session_id)

    async def cancel(self, agent_id: str, session_id: str) -> bool:
        cancelled = cancel_native_acp(agent_id, session_id)
        if self.mongo is not None:
            cancelled = await asyncio.to_thread(request_native_session_cancel, self.mongo, agent_id, session_id) or cancelled
        return cancelled or self.cache.cancel_stream(agent_id, session_id)
