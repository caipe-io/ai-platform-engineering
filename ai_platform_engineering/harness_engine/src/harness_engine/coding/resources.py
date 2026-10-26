"""Run-scoped MCP bridge to existing CAIPE tools, skills and specialists.

Requests are queued durably beside the Engine run. Only its existing producer
may claim a request, and uncertain claimed effects are never reclaimed. The
sandbox sees an expiring run capability, never user/provider credentials.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from harness_engine.coding.acp_client import HarnessACPDriver, HarnessPendingInput, InputRequired
from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.coding.authorization import AuthorizedRunCredentials
from harness_engine.coding.config import service_url
from harness_engine.config import Settings

CAPABILITY_HEADER = "X-CAIPE-Harness-Capability"
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_QUEUED_CALLS = 64
REQUESTS = "harness_tool_requests"


def encoded(value: Any, maximum: int) -> bytes:
    try:
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()
    except (TypeError, ValueError):
        raise CodingAdmissionError("The platform tool payload is invalid") from None
    if len(raw) > maximum:
        raise CodingAdmissionError("The platform tool payload exceeds its supported size")
    return raw


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class PlatformResourceBroker:
    def __init__(self, settings: Settings, fence: RunFence, credentials: AuthorizedRunCredentials) -> None:
        self.settings, self.fence, self.credentials = settings, fence, credentials
        self.requests = fence.db[REQUESTS]
        self.driver: HarnessACPDriver | None = None
        self.mcp_servers: list[dict[str, Any]] = []
        self.files: dict[str, str] = {}
        self.system_prompt = ""
        self.execution_policy: dict[str, Any] = {}
        self.tools: list[dict[str, Any]] = []
        self._worker: asyncio.Task[None] | None = None
        self._close_lock = asyncio.Lock()
        self._closed = False
        self._closing = False
        self.unsettled = False
        self._capability = secrets.token_urlsafe(32)
        self._platform = service_url(settings.coding_resources_url)
        self._public = service_url(settings.coding_tools_public_url)

    async def _platform_request(self, method: str, suffix: str = "") -> dict[str, Any]:
        token = await self.credentials.token()
        path = f"/api/v1/harness-resources/{quote(self.fence.context.turn.run_id, safe='')}{suffix}"
        async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10), follow_redirects=False) as client:
            async with client.stream(
                method,
                self._platform + path,
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Harness-Producer": self.fence.context.producer_token or "",
                },
            ) as response:
                if response.status_code != 200:
                    raise CodingAdmissionError(
                        "The admitted CAIPE resources are unavailable under current authorization"
                    )
                chunks, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise CodingAdmissionError("The platform resource response exceeds its supported size")
                    chunks.append(chunk)
        try:
            payload = json.loads(b"".join(chunks))
            data = payload.get("data", payload)
            if not isinstance(data, dict):
                raise ValueError
            return data
        except (ValueError, TypeError):
            raise CodingAdmissionError("The platform resource response is invalid") from None

    async def _call_platform(self, identifier: str) -> dict[str, Any]:
        try:
            return await self._platform_request("POST", f"/calls/{identifier}")
        except httpx.HTTPError:
            # The DA tool service owns no separate run: it publishes acceptance,
            # input and effect acknowledgements on this existing claimed request.
            # Losing an HTTP observer is not proof that the tool failed. Observe
            # that exact record; never send an accepted operation again.
            deadline = asyncio.get_running_loop().time() + self.fence.context.blueprint.limits.max_run_seconds
            while asyncio.get_running_loop().time() < deadline:
                await self.fence.require()
                record = await asyncio.to_thread(
                    self.requests.find_one,
                    {
                        "_id": identifier,
                        "run_id": self.fence.context.turn.run_id,
                        "producer_id": self.fence.context.producer_token,
                        "status": "claimed",
                    },
                )
                if record is None:
                    raise CodingAdmissionError("The accepted platform request lost its ownership")
                if record.get("platform_phase") == "completed":
                    return {"result": record["platform_result"], "stop_run": record.get("platform_stop_run", False)}
                if record.get("platform_phase") == "awaiting_input" and record.get("platform_input", {}).get("payload"):
                    return {"pending_input": record["platform_input"]["payload"]}
                await asyncio.sleep(0.2)
            raise CodingAdmissionError("The accepted platform effect has not acknowledged its outcome")

    async def open(self) -> None:
        await self.fence.require()
        data = await self._platform_request("GET")
        tools, prompt, files = data.get("tools"), data.get("system_prompt"), data.get("skills_files", {})
        if (
            not isinstance(tools, list)
            or len(tools) > 512
            or not isinstance(prompt, str)
            or not isinstance(files, dict)
            or len(files) > 512
            or any(
                not isinstance(tool, dict)
                or not isinstance(tool.get("name"), str)
                or not isinstance(tool.get("inputSchema"), dict)
                for tool in tools
            )
            or len({tool["name"] for tool in tools}) != len(tools)
        ):
            raise CodingAdmissionError("The admitted platform resource catalog is invalid")
        encoded(data, MAX_RESPONSE_BYTES)
        execution_policy = data.get("execution_policy")
        if not isinstance(execution_policy, dict) or execution_policy.get("context_management") != "provider_native":
            raise CodingAdmissionError("The platform did not admit an execution policy")
        self.execution_policy = execution_policy
        self.tools, self.system_prompt, self.files = tools, prompt, files
        context = self.fence.context
        result = await asyncio.to_thread(
            self.fence.db.harness_runs.update_one,
            {
                "run_id": context.turn.run_id,
                "_producer_id": context.producer_token,
                "status": "running",
                "_coding_capability_hash": {"$exists": False},
            },
            {
                "$set": {
                    "_coding_capability_hash": digest(self._capability),
                    "_coding_tools": tools,
                    "_coding_call_count": 0,
                }
            },
        )
        if result.modified_count != 1:
            raise CodingAdmissionError("This execution already has a platform resource admission")
        self.mcp_servers = [
            {
                "type": "http",
                "name": "caipe",
                "url": f"{self._public}/api/v1/runs/{context.turn.run_id}/mcp",
                "headers": [{"name": CAPABILITY_HEADER, "value": self._capability}],
            }
        ]

    @property
    def run_capability(self) -> str:
        return self._capability

    async def start(self, driver: HarnessACPDriver) -> None:
        self.driver = driver
        self._worker = asyncio.create_task(self._serve())

    async def close(self) -> None:
        async with self._close_lock:
            if self._closed:
                return
            context = self.fence.context
            self._closing = True
            try:
                await asyncio.to_thread(
                    self.fence.db.harness_runs.update_one,
                    {
                        "run_id": context.turn.run_id,
                        "_producer_id": context.producer_token,
                    },
                    {
                        "$set": {"_coding_resources_closed": True},
                        "$unset": {
                            "_coding_capability_hash": "",
                            "_coding_tools": "",
                            "_coding_git_capabilities": "",
                        },
                    },
                )
            finally:
                if self._worker is not None:
                    try:
                        async with asyncio.timeout(10):
                            await asyncio.shield(self._worker)
                    except (TimeoutError, asyncio.CancelledError):
                        self._worker.cancel()
                    await asyncio.gather(self._worker, return_exceptions=True)
            # Effects reserve their entry on this same document before IO.
            # Once the close update commits, no late callback can acquire one.
            deadline = asyncio.get_running_loop().time() + 10
            while True:
                run = await asyncio.to_thread(
                    self.fence.db.harness_runs.find_one,
                    {"run_id": context.turn.run_id, "_producer_id": context.producer_token},
                    {"_coding_active_effects": 1, "_coding_git_dispatches": 1},
                )
                active = run is None or any(
                    state == "executing"
                    for key in ("_coding_active_effects", "_coding_git_dispatches")
                    for state in (run or {}).get(key, {}).values()
                )
                if not active or asyncio.get_running_loop().time() >= deadline:
                    break
                await asyncio.sleep(0.05)
            self.unsettled = active or bool(
                await asyncio.to_thread(
                    self.requests.find_one,
                    {
                        "run_id": context.turn.run_id,
                        "$or": [{"status": "claimed", "platform_phase": "executing"}, {"git_phase": "executing"}],
                    },
                    {"_id": 1},
                )
            )
            await asyncio.to_thread(
                self.requests.update_many,
                {
                    "run_id": context.turn.run_id,
                    "status": {"$in": ["queued", "claimed"]},
                },
                {"$set": {"status": "interrupted"}},
            )
            self._closed = True

    async def _serve(self) -> None:
        try:
            while not self._closing:
                await self.fence.require()
                call = await asyncio.to_thread(
                    self.requests.find_one_and_update,
                    {
                        "run_id": self.fence.context.turn.run_id,
                        "status": "queued",
                    },
                    {
                        "$set": {
                            "status": "claimed",
                            "producer_id": self.fence.context.producer_token,
                            "platform_phase": "admitted",
                        }
                    },
                    return_document=ReturnDocument.AFTER,
                )
                if call is None:
                    await asyncio.sleep(0.05)
                    continue
                stop_run = False
                try:
                    if call.get("kind") == "git_approval":
                        if self.driver is None or self.driver.session_id is None:
                            raise CodingAdmissionError("The harness approval channel is unavailable")
                        event = InputRequired(
                            interrupt_id=str(uuid4()),
                            interrupt_type="tool_approval",
                            agent=self.fence.context.blueprint.name,
                            prompt="Review the requested Git operation.",
                            fields=[],
                            tool_name=call["params"]["name"],
                            tool_args=call["params"]["arguments"],
                            allowed_decisions=["approve", "reject"],
                        )
                        decision = await self.driver.request_platform_input(
                            HarnessPendingInput(
                                interrupt_id=event.interrupt_id,
                                session_id=self.driver.session_id,
                                method="caipe/tool_input",
                                request={"request_id": call["_id"]},
                                event=event,
                            )
                        )
                        while True:
                            run, _ = await self.fence.require()
                            if run.get("status") == "running" and run.get("pending_interrupt_id") is None:
                                break
                            await asyncio.sleep(0.05)
                        approved = decision["decisions"][0]["decision"] == "approve"
                        result = {"result": {"approved": approved}}
                    else:
                        result = await self._call_platform(call["_id"])
                        while result.get("pending_input") is not None:
                            if self.driver is None or self.driver.session_id is None:
                                raise CodingAdmissionError("The harness input channel is unavailable")
                            event = InputRequired.model_validate(result["pending_input"])
                            await self.driver.request_platform_input(
                                HarnessPendingInput(
                                    interrupt_id=event.interrupt_id,
                                    session_id=self.driver.session_id,
                                    method="caipe/tool_input",
                                    request={"request_id": call["_id"]},
                                    event=event,
                                )
                            )
                            while True:
                                run, _ = await self.fence.require()
                                if run.get("status") == "running" and run.get("pending_interrupt_id") is None:
                                    break
                                await asyncio.sleep(0.05)
                            result = await self._call_platform(call["_id"])
                    if "result" not in result or not isinstance(result["result"], dict):
                        raise CodingAdmissionError("The platform tool returned an invalid result")
                    stop_run = result.get("stop_run") is True
                    payload = result["result"]
                    encoded(payload, MAX_RESPONSE_BYTES)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Never replay a claimed call after an uncertain HTTP error.
                    payload = {
                        "content": [
                            {
                                "type": "text",
                                "text": "The platform tool could not complete under its current authorization or configuration. An uncertain operation was not retried.",
                            }
                        ],
                        "isError": True,
                    }
                await self.fence.require()
                await asyncio.to_thread(
                    self.requests.update_one,
                    {
                        "_id": call["_id"],
                        "run_id": self.fence.context.turn.run_id,
                        "status": "claimed",
                        "producer_id": self.fence.context.producer_token,
                    },
                    {"$set": {"status": "complete", "result": payload}},
                )
                if stop_run:
                    if self.driver is not None:
                        self.driver.fail()
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            if self.driver is not None:
                self.driver.fail()
            raise

    @classmethod
    async def approve_git(
        cls,
        fence: RunFence,
        *,
        repository: str,
        refs: list[str],
        pack_sha256: str,
        action: str = "push",
        require_review: bool = True,
    ) -> str:
        await fence.require()
        params = {
            "name": "git_push" if action == "push" else "git_fetch",
            "arguments": {"repository": repository, "action": action, "refs": refs, "pack_sha256": pack_sha256},
        }
        fingerprint = hashlib.sha256(encoded(params, MAX_REQUEST_BYTES)).hexdigest()
        identifier = digest(fence.context.turn.run_id + "\0git\0" + fingerprint)
        calls = fence.db[REQUESTS]
        try:
            await asyncio.to_thread(
                calls.insert_one,
                {
                    "_id": identifier,
                    "run_id": fence.context.turn.run_id,
                    "binding_id": fence.context.binding.binding_id,
                    "kind": "git_approval",
                    "params": params,
                    "fingerprint": fingerprint,
                    "request_key": identifier,
                    "status": "queued" if require_review else "complete",
                    **({} if require_review else {"result": {"approved": True}}),
                },
            )
        except DuplicateKeyError:
            pass
        while True:
            await fence.require()
            call = await asyncio.to_thread(calls.find_one, {"_id": identifier})
            if not call or call.get("fingerprint") != fingerprint:
                raise CodingAdmissionError("The Git approval identity changed")
            if call["status"] == "complete":
                if call.get("result", {}).get("approved") is not True:
                    raise CodingAdmissionError("The user did not approve this Git operation")
                return identifier
            if call["status"] == "interrupted":
                raise CodingAdmissionError("The Git approval was interrupted")
            await asyncio.sleep(0.1)

    @staticmethod
    async def authorize(fence: RunFence, capability: str) -> dict[str, Any]:
        run, _ = await fence.require()
        if not 32 <= len(capability) <= 256 or not hmac.compare_digest(
            run.get("_coding_capability_hash", ""), digest(capability)
        ):
            raise CodingAdmissionError("Invalid or inactive harness capability")
        return run

    @classmethod
    async def call(cls, fence: RunFence, capability: str, request: dict[str, Any]) -> dict[str, Any]:
        run = await cls.authorize(fence, capability)
        params = request.get("params")
        if (
            not isinstance(params, dict)
            or not isinstance(params.get("name"), str)
            or not isinstance(params.get("arguments", {}), dict)
            or params["name"] not in {tool["name"] for tool in run.get("_coding_tools", [])}
        ):
            raise CodingAdmissionError("This tool was not admitted for the harness run")
        request_key = encoded(request["id"], MAX_REQUEST_BYTES).decode()
        fingerprint = hashlib.sha256(encoded(params, MAX_REQUEST_BYTES)).hexdigest()
        identifier = digest(fence.context.turn.run_id + "\0" + request_key)
        calls = fence.db[REQUESTS]
        existing = await asyncio.to_thread(calls.find_one, {"_id": identifier})
        if existing is None:
            count = await asyncio.to_thread(
                calls.count_documents,
                {"run_id": fence.context.turn.run_id, "status": {"$in": ["queued", "claimed"]}},
                limit=MAX_QUEUED_CALLS,
            )
            if count >= MAX_QUEUED_CALLS:
                raise CodingAdmissionError("The harness tool queue is full")
            limit = fence.context.blueprint.limits.max_tool_calls
            admitted = await asyncio.to_thread(
                fence.db.harness_runs.update_one,
                {
                    "run_id": fence.context.turn.run_id,
                    "_producer_id": fence.context.producer_token,
                    "_coding_capability_hash": digest(capability),
                    "cancellation_requested": False,
                    "_coding_call_count": {"$lt": limit},
                    "status": {"$in": ["running", "awaiting_input"]},
                },
                {"$inc": {"_coding_call_count": 1}},
            )
            if admitted.modified_count != 1:
                raise CodingAdmissionError("The admitted run's tool-call budget is exhausted")
            try:
                await asyncio.to_thread(
                    calls.insert_one,
                    {
                        "_id": identifier,
                        "run_id": fence.context.turn.run_id,
                        "binding_id": fence.context.binding.binding_id,
                        "request_key": request_key,
                        "fingerprint": fingerprint,
                        "params": params,
                        "status": "queued",
                    },
                )
            except DuplicateKeyError:
                await asyncio.to_thread(
                    fence.db.harness_runs.update_one,
                    {"run_id": fence.context.turn.run_id, "_producer_id": fence.context.producer_token},
                    {"$inc": {"_coding_call_count": -1}},
                )
        while True:
            await cls.authorize(fence, capability)
            existing = await asyncio.to_thread(calls.find_one, {"_id": identifier})
            if not existing or existing["fingerprint"] != fingerprint:
                raise CodingAdmissionError("This request identity belongs to different tool arguments")
            if existing["status"] == "complete":
                return existing["result"]
            if existing["status"] == "interrupted":
                raise CodingAdmissionError("The tool outcome is uncertain and cannot be retried automatically")
            await asyncio.sleep(0.1)


@asynccontextmanager
async def platform_resources(
    settings: Settings, fence: RunFence, credentials: AuthorizedRunCredentials
) -> AsyncIterator[PlatformResourceBroker]:
    broker = PlatformResourceBroker(settings, fence, credentials)
    try:
        await broker.open()
        yield broker
    finally:
        await broker.close()
