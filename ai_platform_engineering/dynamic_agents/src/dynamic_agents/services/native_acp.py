"""ACP v1 boundary for admitted DeepAgents in the existing shared runtime.

The HTTP caller admits the runtime and caller before constructing this bridge.
ACP messages carry prompts, not identities, executable paths or agent configs.
CAIPE's negotiated extension carries typed native events that ACP does not
represent, including checkpointed forms and subagent namespace attribution.
Browser protocol formatting happens only after client-side event delivery.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing, asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from acp import PROTOCOL_VERSION, RequestError, connect_to_agent
from acp.agent import AgentSideConnection
from acp.schema import (
    AgentCapabilities,
    AgentMessageChunk,
    BlobResourceContents,
    ClientCapabilities,
    EmbeddedResourceContentBlock,
    FileSystemCapabilities,
    ImageContentBlock,
    InitializeResponse,
    NewSessionResponse,
    PromptCapabilities,
    PromptResponse,
    ResourceContentBlock,
    TextContentBlock,
    ToolCallProgress,
    ToolCallStart,
)

from dynamic_agents.models import InputFile
from dynamic_agents.services.stream_encoders.events import (
    STREAM_EVENT_ADAPTER,
    StreamEvent,
    TextDelta,
    ToolCompleted,
    ToolStarted,
)
from dynamic_agents.services.stream_encoders.semantic import SemanticStreamEncoder

if TYPE_CHECKING:
    from dynamic_agents.services.agent_runtime import AgentRuntime
    from dynamic_agents.services.stream_encoders import StreamEncoder

logger = logging.getLogger(__name__)
EXTENSION = "caipe.io/native-acp"
# The SDK adds the ACP extension prefix on send and removes it on dispatch.
EVENT_METHOD = "caipe/event"
BUFFER_SIZE = 64
_active_turns: dict[tuple[str, str], _ActiveTurn] = {}
_turn_context: ContextVar[_ActiveTurn | None] = ContextVar("native_acp_turn", default=None)


class _JsonTransport:
    """Paired queues carry JSON bytes, never shared Python request objects."""

    def __init__(self, inbox: asyncio.Queue[bytes | None], outbox: asyncio.Queue[bytes | None]) -> None:
        self.inbox, self.outbox = inbox, outbox
        self.closed = False

    async def send(self, message: dict[str, Any]) -> None:
        if self.closed:
            raise ConnectionError("ACP transport closed")
        await self.outbox.put(json.dumps(message, ensure_ascii=False).encode("utf-8"))

    async def receive(self) -> dict[str, Any] | None:
        encoded = await self.inbox.get()
        return json.loads(encoded) if encoded is not None else None

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            if self.outbox.full():
                # Shutdown discards pending traffic; never block teardown on a
                # peer whose consumer has disconnected.
                self.outbox.get_nowait()
            self.outbox.put_nowait(None)


def _transport_pair() -> tuple[_JsonTransport, _JsonTransport]:
    first: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=BUFFER_SIZE)
    second: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=BUFFER_SIZE)
    return _JsonTransport(first, second), _JsonTransport(second, first)


def _prompt_blocks(message: str, files: list[InputFile] | None) -> list[Any]:
    blocks: list[Any] = [TextContentBlock(type="text", text=message)]
    for index, file in enumerate(files or []):
        metadata = {EXTENSION: {"name": file.name, "uri": file.uri}}
        if not file.data:
            blocks.append(ResourceContentBlock(
                type="resource_link", uri=file.uri, name=file.name or f"attachment-{index}", mime_type=file.mime_type, field_meta=metadata,
            ))
        elif file.mime_type.startswith("image/"):
            blocks.append(ImageContentBlock(
                type="image", data=file.data, mime_type=file.mime_type, uri=file.uri, field_meta=metadata,
            ))
        else:
            blocks.append(EmbeddedResourceContentBlock(
                type="resource",
                resource=BlobResourceContents(
                    blob=file.data, mime_type=file.mime_type, uri=file.uri or f"attachment://{index}",
                ),
                field_meta=metadata,
            ))
    return blocks


def _decode_prompt(prompt: list[Any]) -> tuple[str, list[InputFile] | None]:
    text: list[str] = []
    files: list[InputFile] = []
    for block in prompt:
        metadata = (block.field_meta or {}).get(EXTENSION, {})
        if not isinstance(metadata, dict) or set(metadata) - {"name", "uri"}:
            raise RequestError.invalid_params({"reason": "Unsupported attachment metadata"})
        if isinstance(block, TextContentBlock):
            text.append(block.text)
        elif isinstance(block, ImageContentBlock):
            files.append(InputFile(
                data=block.data, mime_type=block.mime_type, name=metadata.get("name"), uri=block.uri,
            ))
        elif isinstance(block, ResourceContentBlock) and block.mime_type:
            files.append(InputFile(uri=block.uri, mime_type=block.mime_type, name=metadata.get("name", block.name)))
        elif isinstance(block, EmbeddedResourceContentBlock) and isinstance(block.resource, BlobResourceContents):
            files.append(InputFile(
                data=block.resource.blob, mime_type=block.resource.mime_type,
                name=metadata.get("name"), uri=metadata.get("uri"),
            ))
        else:
            raise RequestError.invalid_params({"reason": "Unsupported native prompt content"})
    return "\n".join(text), files or None


class _NativeAgent:
    def __init__(self, runtime: AgentRuntime, session_id: str, user_email: str) -> None:
        self.runtime, self.session_id, self.user_email = runtime, session_id, user_email
        self.encoder = SemanticStreamEncoder()
        self.connection: Any = None
        self.prompt_task: asyncio.Task[Any] | None = None
        self.negotiated = False
        self.session_created = False
        self.cancel_requested = False

    def on_connect(self, connection: Any) -> None:
        self.connection = connection

    async def initialize(self, protocol_version: int, client_capabilities: ClientCapabilities | None = None,
                         client_info: Any = None, **kwargs: Any) -> InitializeResponse:
        del client_info
        if protocol_version != PROTOCOL_VERSION or kwargs:
            raise RequestError.invalid_params({"reason": "Unsupported native ACP initialization"})
        self.negotiated = bool(client_capabilities and (client_capabilities.field_meta or {}).get(EXTENSION) == 1)
        if not self.negotiated:
            raise RequestError.invalid_params({"reason": "CAIPE native ACP extension is required"})
        return InitializeResponse(
            protocol_version=PROTOCOL_VERSION,
            agent_capabilities=AgentCapabilities(
                prompt_capabilities=PromptCapabilities(image=True, embedded_context=True),
                field_meta={EXTENSION: 1},
            ),
            auth_methods=[],
        )

    async def new_session(self, cwd: str, mcp_servers: list[Any] | None = None,
                          additional_directories: list[str] | None = None, **kwargs: Any) -> NewSessionResponse:
        if not self.negotiated or cwd != "/" or mcp_servers or additional_directories or kwargs:
            raise RequestError.invalid_params({"reason": "Native sessions use admitted runtime configuration"})
        self.session_created = True
        return NewSessionResponse(session_id=self.session_id)

    async def prompt(self, session_id: str, prompt: list[Any], **kwargs: Any) -> PromptResponse:
        if not self.session_created or session_id != self.session_id or set(kwargs) - {EXTENSION}:
            raise RequestError.invalid_params({"reason": "Unknown native session or unsupported metadata"})
        metadata = kwargs.get(EXTENSION, {})
        if not isinstance(metadata, dict) or set(metadata) - {"trace_id", "turn_id", "resume_data"}:
            raise RequestError.invalid_params({"reason": "Unsupported native turn metadata"})
        if any(value is not None and not isinstance(value, str) for value in metadata.values()):
            raise RequestError.invalid_params({"reason": "Native turn metadata must contain strings"})
        if self.prompt_task is not None:
            raise RequestError.invalid_params({"reason": "A native turn is already active"})
        if self.cancel_requested:
            return PromptResponse(stop_reason="cancelled")
        message, files = _decode_prompt(prompt)
        self.prompt_task = asyncio.current_task()
        try:
            if metadata.get("resume_data") is not None:
                events = self.runtime.resume(
                    self.session_id, self.user_email, metadata["resume_data"], metadata.get("trace_id"), self.encoder,
                )
            else:
                events = self.runtime.stream(
                    message, self.session_id, self.user_email, metadata.get("trace_id"), self.encoder,
                    files=files, turn_id=metadata.get("turn_id"),
                )
            async with aclosing(events):
                async for event in events:
                    await self._publish(event)
            return PromptResponse(stop_reason="end_turn")
        except asyncio.CancelledError:
            return PromptResponse(stop_reason="cancelled")
        except Exception:
            logger.exception("Native ACP execution failed for session %s", self.session_id)
            raise RequestError.internal_error({"reason": "Native agent execution failed"}) from None
        finally:
            self.prompt_task = None

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        if session_id != self.session_id or kwargs:
            raise RequestError.invalid_params({"reason": "Unknown native session"})
        self.cancel_requested = True
        if self.prompt_task is not None:
            self.runtime.cancel()
            self.prompt_task.cancel()

    async def _publish(self, event: StreamEvent) -> None:
        metadata = {EXTENSION: {"namespace": list(getattr(event, "namespace", ()))}}
        update: Any = None
        if isinstance(event, TextDelta):
            update = AgentMessageChunk(
                session_update="agent_message_chunk", content=TextContentBlock(type="text", text=event.text),
                field_meta=metadata,
            )
        elif isinstance(event, ToolStarted):
            update = ToolCallStart(
                session_update="tool_call", tool_call_id=event.tool_call_id, title=event.tool_name,
                status="in_progress", raw_input=event.args, field_meta=metadata,
            )
        elif isinstance(event, ToolCompleted):
            update = ToolCallProgress(
                session_update="tool_call_update", tool_call_id=event.tool_call_id,
                status="failed" if event.error else "completed", raw_output=event.content or None,
                field_meta=metadata,
            )
        if update is not None:
            await self.connection.session_update(self.session_id, update)
        # Acknowledgement after enqueue provides backpressure. Notifications
        # alone let the SDK create unbounded handlers behind a slow consumer.
        await self.connection.ext_method(EVENT_METHOD, {"sessionId": self.session_id, "event": event.model_dump(mode="json")})


class _EventClient:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.events: asyncio.Queue[StreamEvent | None] = asyncio.Queue(maxsize=BUFFER_SIZE)
        self.closing = asyncio.Event()

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        if session_id != self.session_id:
            raise RequestError.invalid_params({"reason": "Unexpected native session"})

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method != EVENT_METHOD or params.get("sessionId") != self.session_id or set(params) != {"sessionId", "event"}:
            raise RequestError.invalid_params({"reason": "Unexpected native event"})
        try:
            event = STREAM_EVENT_ADAPTER.validate_python(params["event"])
        except ValueError:
            raise RequestError.invalid_params({"reason": "Invalid native event"}) from None
        if not self.closing.is_set():
            await self.events.put(event)
        return {}

    async def finish(self) -> None:
        """Finish delivery, or stop waiting if a full buffer loses its reader."""
        delivery = asyncio.create_task(self.events.put(None))
        closed = asyncio.create_task(self.closing.wait())
        try:
            await asyncio.wait({delivery, closed}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (delivery, closed):
                if not task.done():
                    task.cancel()
            await asyncio.gather(delivery, closed, return_exceptions=True)


@dataclass
class _ActiveTurn:
    session_id: str
    owner_task: asyncio.Task[Any] | None
    connection: Any = None
    cancelled: bool = False
    cancellation: asyncio.Task[Any] | None = None

    def cancel(self) -> bool:
        if self.cancelled:
            return False
        self.cancelled = True
        if self.connection is not None:
            self.cancellation = asyncio.create_task(self.connection.cancel(self.session_id))
        elif self.owner_task is not None:
            self.owner_task.cancel()
        return True


@asynccontextmanager
async def native_acp_turn(agent_id: str, session_id: str) -> AsyncIterator[_ActiveTurn]:
    """Reserve an in-process turn before admission can change its runtime.

    The owning task can nest this guard while entering the bridge. Other tasks
    cannot inherit a lease through context propagation and execute another turn.
    """
    key = (agent_id, session_id)
    existing = _active_turns.get(key)
    if existing is not None:
        if existing is not _turn_context.get() or existing.owner_task is not asyncio.current_task():
            raise RuntimeError("A native ACP turn is already active for this session")
        yield existing
        return
    active = _ActiveTurn(session_id=session_id, owner_task=asyncio.current_task())
    _active_turns[key] = active
    token = _turn_context.set(active)
    try:
        yield active
    finally:
        _active_turns.pop(key, None)
        _turn_context.reset(token)


def cancel_native_acp(agent_id: str, session_id: str) -> bool:
    """Send cancellation to the active ACP turn after HTTP authorization."""
    active = _active_turns.get((agent_id, session_id))
    return active.cancel() if active else False


async def native_acp_stream(
    runtime: AgentRuntime, *, message: str | None, session_id: str, user_email: str,
    encoder: StreamEncoder[str], trace_id: str | None = None, files: list[InputFile] | None = None,
    turn_id: str | None = None, resume_data: str | None = None,
) -> AsyncGenerator[str, None]:
    """Drive native events through ACP, then format the requested UI protocol.

    Connections are turn-scoped so SDK dispatch tasks capture this request's
    verified authentication context. Closing the consumer cancels and awaits
    graph execution before releasing the active-session guard.
    """
    async with native_acp_turn(runtime.config.id, session_id) as active:
        async with aclosing(_stream_admitted_turn(
            runtime, active, message=message, session_id=session_id, user_email=user_email, encoder=encoder,
            trace_id=trace_id, files=files, turn_id=turn_id, resume_data=resume_data,
        )) as frames:
            async for frame in frames:
                yield frame


async def _stream_admitted_turn(
    runtime: AgentRuntime, active: _ActiveTurn, *, message: str | None, session_id: str, user_email: str,
    encoder: StreamEncoder[str], trace_id: str | None, files: list[InputFile] | None,
    turn_id: str | None, resume_data: str | None,
) -> AsyncGenerator[str, None]:
    client_transport, agent_transport = _transport_pair()
    client = _EventClient(session_id)
    agent = _NativeAgent(runtime, session_id, user_email)
    agent_connection = AgentSideConnection(agent, agent_transport)
    connection = connect_to_agent(client, client_transport)
    active.connection = connection
    prompt_task: asyncio.Task[Any] | None = None
    try:
        initialized = await connection.initialize(
            PROTOCOL_VERSION,
            client_capabilities=ClientCapabilities(
                fs=FileSystemCapabilities(read_text_file=False, write_text_file=False), terminal=False,
                field_meta={EXTENSION: 1},
            ),
        )
        if initialized.protocol_version != PROTOCOL_VERSION or (initialized.agent_capabilities.field_meta or {}).get(EXTENSION) != 1:
            raise RuntimeError("Native ACP capabilities were not negotiated")
        session = await connection.new_session(cwd="/", mcp_servers=[])
        if session.session_id != session_id:
            raise RuntimeError("Native ACP session binding changed")
        if active.cancelled:
            raise asyncio.CancelledError

        async def run_prompt() -> None:
            try:
                await connection.prompt(session_id, _prompt_blocks(message or "", files), **{
                    EXTENSION: {"trace_id": trace_id, "turn_id": turn_id, "resume_data": resume_data},
                })
            finally:
                await client.finish()

        prompt_task = asyncio.create_task(run_prompt())
        while (event := await client.events.get()) is not None:
            for frame in encoder.encode_event(event):
                yield frame
        await prompt_task
    finally:
        client.closing.set()
        try:
            if prompt_task is not None and not prompt_task.done():
                active.cancel()
            if active.cancellation is not None:
                await active.cancellation
            if prompt_task is not None and not prompt_task.done():
                await asyncio.wait_for(asyncio.shield(prompt_task), timeout=5)
        finally:
            await agent_connection.close()
            await connection.close()
            if prompt_task is not None:
                if not prompt_task.done():
                    prompt_task.cancel()
                await asyncio.gather(prompt_task, return_exceptions=True)
            active.connection = None
