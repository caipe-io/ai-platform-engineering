"""Supervised ACP data plane into an admitted, already provisioned sandbox."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from acp import connect_to_agent
from acp.core import ClientSideConnection
from acp.schema import HttpMcpServer
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from harness_engine.adapters.base import ExecutionRejectedError, ExecutionUnconfirmedError
from harness_engine.claude_acp_tools import ClaudeACPToolBridge
from harness_engine.config import SandboxConnection
from harness_engine.models import RunContext

MAX_FRAME = 1024 * 1024
MAX_BODY = 512 * 1024
MCP_HEADERS = {"accept", "content-type", "mcp-session-id", "mcp-protocol-version", "authorization"}
ADMISSION_MESSAGES = {
    "sandbox_bound": "This sandbox is connected to another conversation. Open its existing chat or create another sandbox.",
    "sandbox_unavailable": "This sandbox is unavailable. Open its management page, start it, then retry.",
    "identity_mismatch": "Sandbox configuration changed. Reconnect its approved profile before starting a new chat.",
}


def decode_bytes(value: Any) -> bytes:
    if not isinstance(value, str) or len(value) > MAX_FRAME:
        raise ValueError("Invalid sandbox byte frame")
    try:
        result = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Invalid sandbox byte frame") from exc
    if len(result) > MAX_BODY:
        raise ValueError("Sandbox byte frame exceeds its bound")
    return result


def within(path: Any, root: str) -> str:
    if not isinstance(path, str) or len(path) > 2048 or "\x00" in path:
        raise ValueError("Invalid sandbox workspace path")
    value = PurePosixPath(path)
    if not value.is_absolute() or ".." in value.parts or not value.is_relative_to(root):
        raise ValueError("Sandbox workspace does not match the admitted placement")
    return str(value)


@dataclass
class SandboxProcess:
    connection: ClientSideConnection
    cwd: str
    config_dir: str
    mcp_servers: list[HttpMcpServer]
    drained: bool = False


class SandboxTransport:
    """ACP's existing message transport seam, with separate remote drain proof."""

    def __init__(
        self,
        websocket: ClientConnection,
        context: RunContext,
        ready: dict[str, Any],
        bridge: ClaudeACPToolBridge | None,
    ) -> None:
        self.websocket = websocket
        self.context = context
        self.ready = ready
        self.bridge = bridge
        self.inbox: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=64)
        self.exited = asyncio.Event()
        self.drained = False
        self.cancelled = False
        self.error: BaseException | None = None
        self.buffer = bytearray()
        self.requests: set[str] = set()
        self.tools: set[asyncio.Task[None]] = set()

    async def frame(self, value: dict[str, Any]) -> None:
        payload = json.dumps(value, separators=(",", ":"))
        if len(payload.encode()) > MAX_FRAME:
            raise ValueError("Sandbox transport frame exceeds its bound")
        await self.websocket.send(payload)

    async def send(self, message: dict[str, Any]) -> None:
        if self.exited.is_set():
            raise ConnectionError("Sandbox ACP process is unavailable")
        value = (json.dumps(message, separators=(",", ":")) + "\n").encode()
        if len(value) > MAX_BODY:
            raise ValueError("ACP message exceeds the sandbox frame bound")
        await self.frame({"type": "stdin", "data": base64.b64encode(value).decode()})

    async def receive(self) -> dict[str, Any] | None:
        if self.exited.is_set() and self.inbox.empty():
            return None
        return await self.inbox.get()

    async def close(self) -> None:
        if not self.cancelled and not self.drained:
            self.cancelled = True
            await self.frame({"type": "cancel"})

    async def tool_request(self, frame: dict[str, Any]) -> None:
        request_id = frame.get("id")
        if (
            not isinstance(request_id, str) or not request_id or len(request_id) > 128
            or request_id in self.requests or len(self.requests) >= 4096
            or len(self.tools) >= 8 or frame.get("method") != "POST"
            or self.bridge is None or not self.context.blueprint.tools.bindings
        ):
            raise ValueError("Invalid or duplicate sandbox MCP request")
        headers = frame.get("headers")
        if not isinstance(headers, dict) or len(headers) > len(MCP_HEADERS):
            raise ValueError("Invalid sandbox MCP headers")
        if any(
            not isinstance(key, str) or key.lower() not in MCP_HEADERS
            or not isinstance(value, str) or len(value) > 8192 or "\r" in value or "\n" in value
            for key, value in headers.items()
        ) or len({key.lower() for key in headers}) != len(headers):
            raise ValueError("Invalid sandbox MCP headers")
        body = decode_bytes(frame.get("body"))
        self.requests.add(request_id)
        if self.cancelled or self.exited.is_set():
            await self.frame({
                "type": "mcp_response", "id": request_id, "status": 409,
                "headers": {"content-type": "application/json"},
                "body": base64.b64encode(b'{"error":"The run is stopping"}').decode(),
            })
            return

        async def dispatch() -> None:
            # This fixed run target never accepts a sandbox-supplied URL, caller
            # bearer or service identity. The bridge validates its random capability.
            status, response_headers, response_body = await self.bridge.forward(
                self.context.turn.run_id, headers, body, max_body=MAX_BODY
            )
            await self.frame({
                "type": "mcp_response", "id": request_id, "status": status,
                "headers": response_headers, "body": base64.b64encode(response_body).decode(),
            })

        task = asyncio.create_task(dispatch())
        self.tools.add(task)

        def done(completed: asyncio.Task[None]) -> None:
            self.tools.discard(completed)
            if not completed.cancelled() and completed.exception() is not None:
                self.error = completed.exception()
                # A failed bridge must stop the native prompt rather than leave
                # it waiting for an MCP response until its provider timeout.
                cancel = asyncio.create_task(self.close())
                cancel.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)

        task.add_done_callback(done)

    async def pump(self) -> None:
        try:
            async for raw in self.websocket:
                if not isinstance(raw, str) or len(raw.encode()) > MAX_FRAME:
                    raise ValueError("Invalid sandbox transport frame")
                frame = json.loads(raw)
                if not isinstance(frame, dict):
                    raise ValueError("Invalid sandbox transport frame")
                kind = frame.get("type")
                if kind == "stdout":
                    self.buffer.extend(decode_bytes(frame.get("data")))
                    if len(self.buffer) > MAX_BODY:
                        raise ValueError("Sandbox ACP line exceeds its bound")
                    while b"\n" in self.buffer:
                        line, _, tail = self.buffer.partition(b"\n")
                        self.buffer = bytearray(tail)
                        if line.strip():
                            message = json.loads(line)
                            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                                raise ValueError("Invalid sandbox ACP message")
                            await self.inbox.put(message)
                elif kind == "stderr":
                    # Provider stderr may contain sensitive tool/model output.
                    decode_bytes(frame.get("data"))
                elif kind == "mcp_request":
                    await self.tool_request(frame)
                elif kind == "exit":
                    if frame.get("run_id") != self.context.turn.run_id or frame.get("process_id") != self.ready["process_id"]:
                        raise ValueError("Sandbox drain receipt does not match its process")
                    self.drained = frame.get("drained") is True and type(frame.get("returncode")) is int
                    return
                else:
                    raise ValueError("Unknown sandbox transport frame")
        except Exception as exc:
            # A parser, transport or library failure is never a process-drain
            # receipt. Preserve uncertainty even for an unexpected failure.
            self.error = exc
        finally:
            self.exited.set()
            # Stop the ACP listener even if the remote connection disappeared.
            # EOF is deliberately distinct from a validated drain receipt.
            if not self.inbox.full():
                self.inbox.put_nowait(None)

    async def settle(self) -> None:
        try:
            await self.close()
            await asyncio.wait_for(self.exited.wait(), timeout=20)
            if self.tools:
                await asyncio.wait_for(asyncio.shield(asyncio.gather(*self.tools)), timeout=960)
        except Exception as exc:
            raise ExecutionUnconfirmedError("Sandbox process/tool drain could not be confirmed") from exc
        if not self.drained or self.error is not None:
            raise ExecutionUnconfirmedError("Sandbox process did not confirm drain; retain the session reservation")


@asynccontextmanager
async def managed_sandbox_process(
    client: object,
    profile: SandboxConnection,
    context: RunContext,
    *,
    bridge: ClaudeACPToolBridge | None,
    mcp_servers: list[HttpMcpServer],
) -> AsyncIterator[SandboxProcess]:
    if context.binding.owner_subject != profile.owner_subject:
        raise PermissionError("Sandbox connection belongs to another execution owner")
    identity = {
        "sandbox_uid": profile.instance_id, "policy_revision": profile.policy_revision,
        "owner_subject": context.binding.owner_subject, "binding_id": context.binding.binding_id,
        "conversation_id": context.binding.conversation_id, "run_id": context.turn.run_id,
    }
    # The service credential remains on the trusted relay connection. No caller,
    # model, database or worker credential is passed into the agent process.
    async with connect(
        profile.url, additional_headers={
            "Authorization": f"Bearer {profile.token.get_secret_value()}",
            "X-Harness-Engine-Subject": profile.owner_subject,
        }, max_size=MAX_FRAME, max_queue=16, open_timeout=10, close_timeout=2,
    ) as websocket:
        try:
            await websocket.send(json.dumps({"type": "open", "protocol": 1, **identity}))
            ready = json.loads(await asyncio.wait_for(websocket.recv(), timeout=20))
            if (isinstance(ready, dict) and ready.get("type") == "error" and ready.get("admitted") is False
                    and ready.get("code") in ADMISSION_MESSAGES
                    and all(ready.get(key) == value for key, value in identity.items())):
                raise ExecutionRejectedError(ready["code"], ADMISSION_MESSAGES[ready["code"]])
            if not isinstance(ready, dict) or ready.get("type") != "ready" or ready.get("protocol") != 1 or any(ready.get(key) != value for key, value in identity.items()):
                raise ValueError("Sandbox connection does not match the admitted identity")
            if not isinstance(ready.get("process_id"), str) or not 16 <= len(ready["process_id"]) <= 128:
                raise ValueError("Sandbox did not identify its supervised process")
            if ready.get("workspace") != profile.workspace_root:
                raise ValueError("Sandbox workspace root changed")
            cwd = within(ready.get("cwd"), profile.workspace_root)
            config_dir = within(ready.get("config_dir"), profile.workspace_root)
            expected_cwd = str(PurePosixPath(profile.workspace_root) / hashlib.sha256(context.binding.binding_id.encode()).hexdigest())
            if cwd != expected_cwd or config_dir != f"{expected_cwd}/.claude":
                raise ValueError("Sandbox native paths do not match the retained binding")
            remote_mcp = []
            if mcp_servers:
                if not isinstance(ready.get("mcp_url"), str):
                    raise ValueError("Sandbox MCP capability requires a loopback endpoint")
                endpoint = urlsplit(ready.get("mcp_url", ""))
                if endpoint.scheme != "http" or endpoint.hostname not in {"127.0.0.1", "::1"} or not endpoint.port or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
                    raise ValueError("Sandbox MCP capability requires a private loopback endpoint")
                remote_mcp = [server.model_copy(update={"url": ready["mcp_url"]}) for server in mcp_servers]
        except (ValueError, TypeError, TimeoutError, ConnectionClosed) as exc:
            # Opening may already have launched a process. An invalid receipt or
            # lost handshake must not release the execution reservation.
            with suppress(ConnectionClosed):
                await websocket.send(json.dumps({"type": "cancel"}))
            raise ExecutionUnconfirmedError("Sandbox process admission could not be confirmed") from exc
        transport = SandboxTransport(websocket, context, ready, bridge)
        pump = asyncio.create_task(transport.pump())
        connection = connect_to_agent(client, transport)
        process = SandboxProcess(connection, cwd, config_dir, remote_mcp)
        try:
            yield process
        finally:
            try:
                try:
                    with suppress(TimeoutError, ConnectionError):
                        await asyncio.wait_for(connection.close(), timeout=2)
                finally:
                    await transport.settle()
                    process.drained = True
            except asyncio.CancelledError:
                # A second Stop/shutdown cancellation must not masquerade as a
                # confirmed remote stop and release the producer reservation.
                raise ExecutionUnconfirmedError("Sandbox teardown was interrupted before drain confirmation") from None
            finally:
                if not pump.done():
                    pump.cancel()
                with suppress(asyncio.CancelledError):
                    await pump
