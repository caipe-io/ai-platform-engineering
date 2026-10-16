"""Client for an operator-configured sandbox control plane.

The control plane authenticates the same verified caller independently. Agent
definitions cannot supply URLs, images, commands, environment or credentials.
Only the selected profile and an idempotent conversation reference cross the
provisioning boundary; ACP remains an unmodified JSON-RPC stream.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing, asynccontextmanager
from typing import Any, Literal
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from uuid import NAMESPACE_URL, uuid5

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from websockets.asyncio.client import connect

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.config import Settings
from dynamic_agents.services.native_state_protocol import (
    MAX_STATE_BYTES,
    MAX_STATE_CHUNK,
    STATE_CONTRACT,
    NativeStateExport,
    NativeStateProtocolError,
    state_frames,
    state_line,
    validate_checkpoint_id,
    validate_state_header,
)

MAX_CONTROL_BYTES = 1024 * 1024
MAX_ACP_BYTES = 8 * 1024 * 1024
logger = logging.getLogger(__name__)


class SandboxError(RuntimeError):
    """A sanitized failure at the qualified sandbox boundary."""


class SandboxNotFound(SandboxError):
    """The authenticated control plane no longer has this allocation."""


class SandboxIdentityChanged(SandboxError):
    """The pinned cache generation was replaced; canonical restore is required."""


class _BoundConnection(connect):
    def process_redirect(self, exc: Exception) -> Exception:
        # Never forward a user's bearer to a location supplied by a redirect.
        return SandboxError("The sandbox ACP connection cannot be redirected")


class SandboxProfileReference(BaseModel):
    """Pinned identity for cleanup, independent of current execution admission."""

    model_config = ConfigDict(extra="ignore")
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    revision: str = Field(min_length=1, max_length=256)


class SandboxProfile(SandboxProfileReference):
    name: str = Field(min_length=1, max_length=200)
    harness: Literal["claude-code"]
    capabilities: dict[str, bool] = Field(default_factory=dict)
    state_contract: dict[str, Any]

    @field_validator("state_contract")
    @classmethod
    def supported_state_contract(cls, value: dict[str, Any]) -> dict[str, Any]:
        if any(type(value.get(key)) is not type(expected) or value.get(key) != expected for key, expected in STATE_CONTRACT.items()):
            raise ValueError("The native state contract is not supported")
        return value


class SandboxAllocation(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    uid: str
    namespace: str
    conversation_id: str
    profile_id: str
    revision: str
    cwd: str
    state: str
    resource_version: str = ""


class SandboxACPTransport:
    """Bounded, non-TTY ACP messages over an authenticated remote stream."""

    def __init__(self, websocket: Any) -> None:
        self.websocket = websocket

    async def send(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        if len(payload.encode()) > MAX_ACP_BYTES:
            raise SandboxError("ACP message exceeds the supported size")
        await self.websocket.send(payload + "\n")

    async def receive(self) -> dict[str, Any] | None:
        # The control plane emits exactly one JSON-RPC line per WS message;
        # terminal escape sequences, stderr and control messages are excluded.
        raw = await self.websocket.recv()
        if not isinstance(raw, str) or len(raw.encode()) > MAX_ACP_BYTES:
            raise SandboxError("Sandbox returned an invalid ACP message")
        try:
            message = json.loads(raw)
        except (json.JSONDecodeError, UnicodeError):
            raise SandboxError("Sandbox returned an invalid ACP message") from None
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            raise SandboxError("Sandbox returned an invalid ACP message")
        return message

    async def close(self) -> None:
        await self.websocket.close()


class SandboxClient:
    def __init__(self, settings: Settings, *, bearer: str | None = None) -> None:
        self.settings = settings
        self.base = settings.sandbox_service_url.rstrip("/")
        parsed = urlsplit(self.base)
        if not self.base or parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
            raise SandboxError("Sandbox execution is not configured")
        self.bearer = bearer or current_user_token.get()
        if not self.bearer:
            raise SandboxError("Sandbox execution requires an authenticated CAIPE caller")
        self._execution: tuple[str, str] | None = None

    def _headers(self, method: str, path: str) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.bearer}"}
        if self._execution is not None:
            allocation_id, token = self._execution
            prefix = f"/api/caipe/sandboxes/{quote(allocation_id, safe='')}"
            target = path.split("?", 1)[0]
            allowed = {("GET", prefix + "/workspace/files"), ("GET", prefix + "/workspace/content"),
                       ("PUT", prefix + "/workspace/content"), ("POST", prefix + "/state/export"),
                       ("DELETE", prefix + "/execution-grant")}
            if (method, target) in allowed:
                headers["X-CAIPE-Execution-Grant"] = token
        return headers

    @asynccontextmanager
    async def execution(self, allocation: SandboxAllocation, run_id: str) -> AsyncIterator[None]:
        """Keep only the admitted turn's capture credential beyond user-token expiry."""
        if self._execution is not None:
            raise SandboxError("The sandbox client already owns an execution grant")
        body = {"conversation_id": allocation.conversation_id, "uid": allocation.uid, "run_id": run_id}
        path = f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/execution-grant"
        result = await self._request("POST", path, body)
        token, expires = result.get("token"), result.get("expires_at")
        if (not isinstance(token, str) or not re.fullmatch(r"caiperun\.[A-Za-z0-9_.-]{40,192}", token)
                or type(expires) is not int or not time.time() < expires <= time.time() + 86520
                or any(result.get(key) != value for key, value in body.items())):
            raise SandboxError("The admitted sandbox execution grant is invalid")
        self._execution = (allocation.id, token)
        try:
            yield
        finally:
            try:
                async with asyncio.timeout(5):
                    await self._request("DELETE", path, body)
            except (SandboxError, TimeoutError):
                # Rotation/deadline also revoke this grant. Cleanup uncertainty
                # must not discard an already verified canonical checkpoint.
                logger.warning("Sandbox capture grant revocation was not acknowledged")
            finally:
                self._execution = None

    async def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        try:
            async with httpx.AsyncClient(follow_redirects=False, timeout=30) as client:
                async with client.stream(method, self.base + path, headers=self._headers(method, path), json=body) as response:
                    if response.status_code in {401, 403}:
                        raise SandboxError("This caller is not authorized to use the sandbox execution profile")
                    if response.status_code == 404:
                        raise SandboxNotFound("The bound sandbox allocation is no longer available")
                    if response.status_code == 409:
                        raise SandboxError("The existing sandbox binding changed; start a new conversation")
                    if response.status_code >= 300:
                        raise SandboxError("The sandbox control plane is unavailable")
                    if response.status_code == 204:
                        return {}
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_CONTROL_BYTES:
                            raise SandboxError("Sandbox control response exceeds the supported size")
                        chunks.append(chunk)
            data = json.loads(b"".join(chunks))
            if not isinstance(data, dict):
                raise ValueError
            return data
        except (httpx.HTTPError, json.JSONDecodeError, ValueError):
            raise SandboxError("The sandbox control plane returned an invalid response") from None

    async def profiles(self) -> list[SandboxProfile]:
        data = await self._request("GET", "/api/caipe/profiles")
        try:
            if not isinstance(data["profiles"], list) or len(data["profiles"]) > 100:
                raise ValueError
            profiles = [SandboxProfile.model_validate(item) for item in data["profiles"]]
            if len({profile.id for profile in profiles}) != len(profiles):
                raise ValueError
            return profiles
        except (KeyError, TypeError, ValueError, ValidationError):
            raise SandboxError("The sandbox profile catalog is invalid") from None

    @staticmethod
    def conversation_reference(agent_id: str, session_id: str) -> str:
        return str(uuid5(NAMESPACE_URL, json.dumps([agent_id, session_id], separators=(",", ":"))))

    async def provision(self, agent_id: str, session_id: str, profile: SandboxProfile) -> SandboxAllocation:
        reference = self.conversation_reference(agent_id, session_id)
        data = await self._request("POST", "/api/caipe/sandboxes", {
            "conversation_id": reference, "profile_id": profile.id, "revision": profile.revision,
        })
        allocation = self._allocation(data, reference, profile)
        return await self._wait_ready(allocation, reference, profile)

    async def lookup(self, agent_id: str, session_id: str, profile: SandboxProfileReference) -> SandboxAllocation | None:
        """Recover allocation identity after an accepted provisioning request.

        This read never creates an environment. Cleanup and head-bound cache
        recovery use it after a provisioning acknowledgement was lost.
        """
        reference = self.conversation_reference(agent_id, session_id)
        query = urlencode({"conversation_id": reference, "profile_id": profile.id})
        try:
            data = await self._request("GET", f"/api/caipe/sandboxes?{query}")
        except SandboxNotFound:
            return None
        return self._allocation(data, reference, profile)

    async def restore(self, saved: SandboxAllocation, profile: SandboxProfile) -> SandboxAllocation:
        data = await self._request("GET", f"/api/caipe/sandboxes/{quote(saved.id, safe='')}")
        current = self._allocation(data, saved.conversation_id, profile)
        if (current.id, current.uid, current.namespace, current.cwd) != (saved.id, saved.uid, saved.namespace, saved.cwd):
            raise SandboxIdentityChanged("The bound sandbox no longer exists; recovery requires an explicit migration")
        if current.state.lower() == "suspended":
            data = await self._request("POST", f"/api/caipe/sandboxes/{quote(saved.id, safe='')}/resume", {
                "conversation_id": saved.conversation_id, "uid": saved.uid, "resource_version": current.resource_version,
            })
            current = self._allocation(data, saved.conversation_id, profile)
        return await self._wait_ready(current, saved.conversation_id, profile, expected=saved)

    async def _wait_ready(self, allocation: SandboxAllocation, reference: str, profile: SandboxProfile,
                          *, expected: SandboxAllocation | None = None) -> SandboxAllocation:
        expected = expected or allocation

        def check_identity(value: SandboxAllocation) -> None:
            if (value.id, value.uid, value.namespace, value.cwd) != (expected.id, expected.uid, expected.namespace, expected.cwd):
                raise SandboxIdentityChanged("The sandbox identity changed; recovery requires an explicit migration")

        check_identity(allocation)
        deadline = asyncio.get_running_loop().time() + self.settings.sandbox_provision_timeout_seconds
        while allocation.state.lower() not in {"ready", "running"}:
            if allocation.state.lower() in {"error", "failed", "disabled"}:
                raise SandboxError("The sandbox cannot start; check its approved execution profile")
            if asyncio.get_running_loop().time() >= deadline:
                raise SandboxError("Sandbox provisioning is still pending; retry this conversation after it becomes ready")
            await asyncio.sleep(2)
            data = await self._request("GET", f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}")
            refreshed = self._allocation(data, reference, profile)
            check_identity(refreshed)
            allocation = refreshed
        return allocation

    async def prepare(self, allocation: SandboxAllocation, files: dict[str, str | dict[str, str]]) -> None:
        await self._request("PUT", f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/workspace", {
            "conversation_id": allocation.conversation_id, "uid": allocation.uid, "files": files,
        })

    async def workspace_files(self, allocation: SandboxAllocation) -> dict:
        query = urlencode({"conversation_id": allocation.conversation_id, "uid": allocation.uid})
        return await self._request("GET", f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/workspace/files?{query}")

    async def workspace_content(self, allocation: SandboxAllocation, path: str) -> dict:
        query = urlencode({"conversation_id": allocation.conversation_id, "uid": allocation.uid, "path": path})
        return await self._request("GET", f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/workspace/content?{query}")

    async def write_workspace_content(self, allocation: SandboxAllocation, path: str, content: str) -> None:
        await self._request("PUT", f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/workspace/content", {
            "conversation_id": allocation.conversation_id, "uid": allocation.uid, "path": path, "content": content,
        })

    async def delete(self, allocation: SandboxAllocation, profile: SandboxProfileReference) -> None:
        try:
            data = await self._request("GET", f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}")
        except SandboxNotFound:
            return  # An explicit deletion can be retried after storage failure.
        current = self._allocation(data, allocation.conversation_id, profile)
        if ((current.id, current.uid, current.namespace, current.cwd) !=
                (allocation.id, allocation.uid, allocation.namespace, allocation.cwd) or not current.resource_version):
            raise SandboxIdentityChanged("The sandbox identity changed; deletion requires operator recovery")
        try:
            await self._request("DELETE", f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}", {
                "conversation_id": allocation.conversation_id, "uid": allocation.uid, "resource_version": current.resource_version,
            })
        except SandboxNotFound:
            pass  # A concurrent authorized deletion already removed it.

    @asynccontextmanager
    async def export_state(
        self, allocation: SandboxAllocation, profile: SandboxProfile, *, checkpoint_id: str, provider_session_id: str,
    ) -> AsyncIterator[NativeStateExport]:
        """Stream a quiescent native archive without buffering it in CAIPE."""
        validate_checkpoint_id(checkpoint_id)
        expected = {"checkpoint_id": checkpoint_id, "profile_id": profile.id, "profile_revision": profile.revision,
                    "harness": profile.harness, "provider_session_id": provider_session_id, "cwd": allocation.cwd}
        body = {"conversation_id": allocation.conversation_id, "uid": allocation.uid,
                "checkpoint_id": checkpoint_id, "provider_session_id": provider_session_id}
        deadline = asyncio.get_running_loop().time() + 30
        try:
            async with asyncio.timeout(600), httpx.AsyncClient(follow_redirects=False, timeout=httpx.Timeout(600, connect=10)) as client:
                while True:
                    retry = False
                    export_path = f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/state/export"
                    async with client.stream("POST", self.base + export_path,
                            headers={**self._headers("POST", export_path), "Accept": "application/x-ndjson"}, json=body) as response:
                        if response.status_code == 409 and asyncio.get_running_loop().time() < deadline:
                            retry = True  # ACP close can precede the provider's process lock release.
                        else:
                            self._state_status(response)
                            if response.headers.get("content-type", "").split(";", 1)[0] not in {"application/x-ndjson", "application/ndjson"}:
                                raise SandboxError("The sandbox returned an unsupported native-state stream")
                            async with aclosing(state_frames(response.aiter_bytes())) as frames:
                                try:
                                    header = await anext(frames)
                                except StopAsyncIteration:
                                    raise SandboxError("The sandbox returned an empty native-state archive") from None
                                exported = NativeStateExport(validate_state_header(header, expected), frames)
                                yield exported
                                if exported.complete is None:
                                    raise SandboxError("The native-state archive was not fully consumed")
                                return
                    if retry:
                        await asyncio.sleep(0.25)
        except (httpx.HTTPError, TimeoutError, NativeStateProtocolError):
            raise SandboxError("The sandbox native-state export was interrupted or failed integrity verification") from None

    @staticmethod
    def _state_status(response: httpx.Response) -> None:
        if response.status_code == 404:
            raise SandboxNotFound("The native-state allocation is no longer available")
        if response.status_code in {401, 403}:
            raise SandboxError("This caller is not authorized to access the native-state archive")
        if response.status_code >= 300:
            raise SandboxError("The sandbox native-state operation is unavailable")

    async def _state_json(self, response: httpx.Response) -> dict[str, Any]:
        self._state_status(response)
        raw = bytearray()
        async for chunk in response.aiter_bytes():
            raw.extend(chunk)
            if len(raw) > MAX_CONTROL_BYTES:
                raise SandboxError("The native-state receipt exceeds its supported size")
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError
            return value
        except (ValueError, UnicodeError):
            raise SandboxError("The native-state receipt is invalid") from None

    @staticmethod
    def _verify_receipt(receipt: dict[str, Any], header: dict[str, Any], complete: dict[str, Any], restore_id: str) -> None:
        expected = {key: header[key] for key in ("format", "archive", "checkpoint_id", "sha256", "bytes", "profile_id", "profile_revision", "harness", "cwd", "provider_session_id", "runtime_versions")}
        expected.update({key: complete[key] for key in ("members", "expanded_bytes")})
        expected.update(restore_id=restore_id, status="restored")
        if any(receipt.get(key) != value for key, value in expected.items()):
            raise SandboxError("The native-state restore receipt does not match its committed checkpoint")

    async def restore_state(
        self, allocation: SandboxAllocation, profile: SandboxProfile, *, header: dict[str, Any], complete: dict[str, Any],
        chunks: Callable[[], AsyncIterator[bytes]], restore_id: str,
    ) -> dict[str, Any]:
        """Hydrate an owned cache from one committed snapshot, never replay a prompt."""
        validate_checkpoint_id(restore_id)
        validate_state_header(header, {"profile_id": profile.id, "profile_revision": profile.revision,
                                     "harness": profile.harness, "cwd": allocation.cwd})
        bound_header = {**header, "conversation_id": allocation.conversation_id, "uid": allocation.uid, "restore_id": restore_id}

        async def upload() -> AsyncIterator[bytes]:
            digest, size = hashlib.sha256(), 0
            yield state_line(bound_header)
            async for value in chunks():
                if not isinstance(value, bytes) or not value or len(value) > MAX_STATE_CHUNK:
                    raise SandboxError("The stored native-state stream contains an invalid chunk")
                size += len(value)
                if size > MAX_STATE_BYTES or size > header["bytes"]:
                    raise SandboxError("The stored native-state stream exceeds its declared size")
                digest.update(value)
                yield state_line({"type": "chunk", "data": base64.b64encode(value).decode("ascii")})
            if size != header["bytes"] or digest.hexdigest() != header["sha256"]:
                raise SandboxError("The stored native-state archive failed integrity verification")
            yield state_line({**complete, "type": "complete", "restore_id": restore_id})

        path = self.base + f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/state"
        authority = {"Authorization": f"Bearer {self.bearer}"}
        receipt_query = urlencode({"conversation_id": allocation.conversation_id, "uid": allocation.uid,
            "checkpoint_id": header["checkpoint_id"], "sha256": header["sha256"], "restore_id": restore_id})
        try:
            async with asyncio.timeout(600), httpx.AsyncClient(follow_redirects=False, timeout=httpx.Timeout(600, connect=10)) as client:
                for attempt in range(2):
                    uncertain = False
                    try:
                        async with client.stream("POST", path + "/restore", headers={**authority, "Content-Type": "application/x-ndjson"}, content=upload()) as response:
                            if response.status_code >= 500 or response.status_code == 409:
                                uncertain = True
                            else:
                                receipt = await self._state_json(response)
                                self._verify_receipt(receipt, header, complete, restore_id)
                                return receipt
                    except httpx.HTTPError:
                        uncertain = True
                    if uncertain:
                        try:
                            async with client.stream("GET", path + "/receipt?" + receipt_query, headers=authority) as response:
                                if response.status_code not in {404, 409}:
                                    receipt = await self._state_json(response)
                                    self._verify_receipt(receipt, header, complete, restore_id)
                                    return receipt
                        except httpx.HTTPError:
                            pass  # Retry the exact immutable restore ID, never a live agent operation.
                    if attempt == 0:
                        await asyncio.sleep(0.25)
        except (httpx.HTTPError, TimeoutError, NativeStateProtocolError):
            raise SandboxError("The sandbox native-state restore could not be verified") from None
        raise SandboxError("The sandbox native-state restore acknowledgement is unresolved; the agent was not started")

    @staticmethod
    def _allocation(data: dict, reference: str, profile: SandboxProfileReference) -> SandboxAllocation:
        try:
            value = SandboxAllocation.model_validate(data)
        except ValidationError:
            raise SandboxError("The sandbox allocation is invalid") from None
        if (value.conversation_id, value.profile_id, value.revision) != (reference, profile.id, profile.revision):
            raise SandboxError("The sandbox profile or conversation binding changed")
        if not value.cwd.startswith("/") or "\x00" in value.cwd or ".." in value.cwd.split("/"):
            raise SandboxError("The sandbox workspace is invalid")
        return value

    @asynccontextmanager
    async def acp(self, allocation: SandboxAllocation) -> AsyncIterator[SandboxACPTransport]:
        parsed = urlsplit(self.base)
        path = parsed.path + f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/acp"
        query = urlencode({"conversation_id": allocation.conversation_id, "uid": allocation.uid})
        url = urlunsplit(("wss" if parsed.scheme == "https" else "ws", parsed.netloc, path, query, ""))
        try:
            async with _BoundConnection(url, additional_headers={"Authorization": f"Bearer {self.bearer}"},
                               max_size=MAX_ACP_BYTES, max_queue=32, open_timeout=30, close_timeout=10) as websocket:
                yield SandboxACPTransport(websocket)
        except (OSError, TimeoutError) as exc:
            raise SandboxError("The sandbox ACP connection was interrupted; saved progress is retained") from exc
