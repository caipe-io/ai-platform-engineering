"""Run-scoped MCP access to the same CAIPE resources used by native agents.

The sandbox receives a random capability, never the caller's bearer or provider
credentials. Any API replica may queue a request in the canonical database;
only the admitted producer holding the native lease executes it. A claimed
request is never reclaimed or retried after an uncertain worker failure.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import secrets
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException
from langchain.agents.middleware.types import ToolCallRequest
from langchain_core.messages import ToolMessage
from pydantic import BaseModel, ValidationError
from pymongo import ASCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

from dynamic_agents.auth.authz import require_agent_use_permission
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import ClientContext, DynamicAgentConfig, MCPServerConfig, UserContext
from dynamic_agents.services.agent_runtime import AgentPlatformResources, AgentRuntime
from dynamic_agents.services.harness_acp import HarnessACPDriver, HarnessPendingInput
from dynamic_agents.services.harness_policy import harness_middleware_entries, harness_middleware_params
from dynamic_agents.services.middleware import InterruptAwareToolRetryMiddleware
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.native_run_repository import NativeExecutionRun, NativeRunRepository
from dynamic_agents.services.session_runs import await_session_operation
from dynamic_agents.services.stream_encoders.events import InputRequired

HARNESS_TOOL_REQUESTS_COLLECTION = "native_acp_tool_requests"
CAPABILITY_HEADER = "X-CAIPE-Harness-Capability"
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_TOOL_RESULT_BYTES = MAX_RESPONSE_BYTES - MAX_REQUEST_BYTES - 4096
MAX_RUN_CALLS = 1024
MAX_QUEUED_CALLS = 64
CAPABILITY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,256}$")

ChildInvoker = Callable[[DynamicAgentConfig, str, str | None, str | None], Awaitable[Any]]
ChildAdmission = Callable[[DynamicAgentConfig, str], Awaitable[None]]


class HarnessToolError(RuntimeError):
    """A broker capability, lease or request is no longer usable."""


class HarnessToolExecutionFailed(HarnessToolError):
    """An admitted tool exhausted a policy that requires stopping the turn."""


class _RetryableToolResult(RuntimeError):
    """An admitted replay-safe tool explicitly returned an unsuccessful result."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _encoded(value: Any, maximum: int) -> str:
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(text.encode()) > maximum:
        raise HarnessToolError("Harness tool payload exceeds its configured limit")
    return text


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _tool_schema(tool: Any) -> dict[str, Any]:
    schema = tool.get_input_schema().model_json_schema()
    return {"name": tool.name, "description": tool.description or tool.name, "inputSchema": schema}


def _content(value: Any, *, error: bool = False) -> dict[str, Any]:
    error = error or isinstance(value, ToolMessage) and value.status == "error"
    if hasattr(value, "content"):
        value = value.content
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    text = value if isinstance(value, str) else _encoded(value, MAX_TOOL_RESULT_BYTES)
    result = {"content": [{"type": "text", "text": text}], "isError": error}
    _encoded(result, MAX_TOOL_RESULT_BYTES)
    return result


class HarnessToolRepository:
    """Capability checking and durable requests, sharing the existing run lease."""

    def __init__(self, mongo: MongoDBService) -> None:
        self.mongo, self.repository = mongo, NativeRunRepository(mongo)
        self.requests = mongo._db[HARNESS_TOOL_REQUESTS_COLLECTION]

    def initialize(self) -> None:
        self.requests.create_index([("run_id", ASCENDING), ("request_key", ASCENDING)], unique=True)
        self.requests.create_index([("run_id", ASCENDING), ("status", ASCENDING), ("created_at", ASCENDING)])
        self.requests.create_index("session_id")
        # No TTL: these records follow the owning conversation's retention.

    def _active(self, run_id: str, capability: str | None = None, lease_id: str | None = None) -> dict:
        run = self.repository.runs.find_one({"run_id": run_id})
        if not run or not run.get("active") or run.get("finishing") or run.get("retired") or run.get("cancel_requested"):
            raise HarnessToolError("The harness execution is no longer active")
        if run.get("harness_tool_limit_failed"):
            raise HarnessToolExecutionFailed("The CAIPE tool-call limit stopped this turn")
        if run.get("status") not in {"running", "awaiting_input"} or self.repository._is_deleted(run["session_id"]):
            raise HarnessToolError("The harness execution is no longer active")
        if capability is not None and (
            not CAPABILITY_PATTERN.fullmatch(capability) or not hmac.compare_digest(
                run.get("harness_capability_hash", ""), _digest(capability),
            )
        ):
            raise HarnessToolError("Invalid harness capability")
        if lease_id is not None and run.get("lease_id") != lease_id:
            raise HarnessToolError("The harness producer lost its admission")
        lease = self.mongo.get_session_runs_collection().find_one({
            "agent_id": run["agent_id"], "session_id": run["session_id"], "lease_id": run.get("lease_id"),
            "lease_expires_at": {"$gt": _now()}, "cancel_requested": {"$ne": True},
        })
        if lease is None or not run.get("lease_id"):
            raise HarnessToolError("The harness producer lost its admission")
        return run

    def register(self, run: NativeExecutionRun, capability: str, tools: list[dict]) -> str:
        current = self._active(run.run_id)
        lease_id = current["lease_id"]
        _encoded(tools, MAX_RESPONSE_BYTES)
        agent = self.mongo.get_agent(run.agent_id)
        limits = []
        for policy in harness_middleware_entries(agent, "tool_call_limit") if agent is not None else []:
            if policy.get("thread_limit") is not None:
                raise HarnessToolError("Sandbox tool-call limits currently support per-run limits; a thread limit requires a supported policy")
            limit = policy.get("run_limit")
            if type(limit) is not int or limit < 0:
                raise HarnessToolError("Tool-call run_limit must be a nonnegative integer")
            if policy.get("exit_behavior", "continue") not in {"continue", "error", "end"}:
                raise HarnessToolError("Tool-call exit_behavior must be continue, error or end")
            if policy.get("tool_name") is not None and policy["tool_name"] not in {tool["name"] for tool in tools}:
                continue
            limits.append({"run_limit": limit, "tool_name": policy.get("tool_name"),
                           "exit_behavior": policy.get("exit_behavior", "continue")})
        result = self.repository.runs.update_one({
            "run_id": run.run_id, "lease_id": lease_id, "active": True,
            "harness_capability_hash": {"$exists": False},
        }, {"$set": {"harness_capability_hash": _digest(capability), "harness_tools": tools, "harness_call_count": 0,
                     "harness_tool_call_limits": limits,
                     "harness_tool_counts": {_digest(tool["name"]): 0 for tool in tools}}})
        if result.modified_count != 1:
            raise HarnessToolError("This execution already has a registered harness broker")
        return lease_id

    def revoke(self, run_id: str, lease_id: str) -> None:
        self.repository.runs.update_one({"run_id": run_id, "lease_id": lease_id}, {
            "$unset": {"harness_capability_hash": "", "harness_tools": ""},
        })
        self.requests.update_many({"run_id": run_id, "status": {"$in": ["queued", "claimed"]}}, {
            "$set": {"status": "interrupted", "updated_at": _now()},
        })

    def enqueue(self, run_id: str, capability: str, request: dict) -> str:
        run = self._active(run_id, capability)
        params = request.get("params")
        if not isinstance(params, dict) or not isinstance(params.get("name"), str) or not isinstance(params.get("arguments", {}), dict):
            raise HarnessToolError("Invalid tools/call parameters")
        if params["name"] not in {tool["name"] for tool in run.get("harness_tools", [])}:
            raise HarnessToolError("This tool was not admitted for the execution")
        request_key = _encoded(request["id"], MAX_REQUEST_BYTES)
        fingerprint = _digest(_encoded(params, MAX_REQUEST_BYTES))
        existing = self.requests.find_one({"run_id": run_id, "request_key": request_key})
        if existing:
            if existing["fingerprint"] != fingerprint:
                raise HarnessToolError("The request ID was already used with different arguments")
            return existing["_id"]
        if self.requests.count_documents({"run_id": run_id, "status": {"$in": ["queued", "claimed"]}}, limit=MAX_QUEUED_CALLS) >= MAX_QUEUED_CALLS:
            raise HarnessToolError("The harness tool queue is full")
        applicable = [limit for limit in run.get("harness_tool_call_limits", [])
                      if limit["tool_name"] in {None, params["name"]}]
        counter = f"harness_tool_counts.{_digest(params['name'])}"
        filters: dict[str, Any] = {
            "run_id": run_id, "harness_capability_hash": _digest(capability), "active": True,
            "harness_call_count": {"$lt": MAX_RUN_CALLS},
        }
        for limit in applicable:
            key = counter if limit["tool_name"] else "harness_call_count"
            filters[key] = {"$lt": min(filters.get(key, {}).get("$lt", MAX_RUN_CALLS), limit["run_limit"])}
        if self.repository.runs.update_one(filters, {"$inc": {"harness_call_count": 1, counter: 1}}).modified_count != 1:
            # The same run document owns admission, counters and terminal policy.
            # No observer may reclaim a request or launch a second executor.
            if any(limit["exit_behavior"] in {"error", "end"} for limit in applicable):
                self.repository.runs.update_one({"run_id": run_id, "lease_id": run["lease_id"], "active": True},
                                               {"$set": {"harness_tool_limit_failed": True}})
            raise HarnessToolError("The harness tool-call limit was reached")
        identifier = str(uuid4())
        try:
            self.requests.insert_one({
                "_id": identifier, "run_id": run_id, "session_id": run["session_id"],
                "request_key": request_key, "fingerprint": fingerprint, "params": params,
                "status": "queued", "created_at": _now(), "updated_at": _now(),
            })
        except DuplicateKeyError:
            self.repository.runs.update_one({"run_id": run_id, "lease_id": run["lease_id"]},
                                            {"$inc": {"harness_call_count": -1, counter: -1}})
            return self.enqueue(run_id, capability, request)
        return identifier

    def claim(self, run_id: str, lease_id: str) -> dict | None:
        self._active(run_id, lease_id=lease_id)
        return self.requests.find_one_and_update({"run_id": run_id, "status": "queued"}, {
            "$set": {"status": "claimed", "lease_id": lease_id, "updated_at": _now()},
        }, sort=[("created_at", ASCENDING)], return_document=ReturnDocument.AFTER)

    def complete(self, identifier: str, run_id: str, lease_id: str, result: dict) -> None:
        self._active(run_id, lease_id=lease_id)
        _encoded(result, MAX_TOOL_RESULT_BYTES)
        if self.requests.update_one({"_id": identifier, "run_id": run_id, "status": "claimed", "lease_id": lease_id}, {
            "$set": {"status": "completed", "result": result, "updated_at": _now()}, "$unset": {"params": ""},
        }).modified_count != 1:
            raise HarnessToolError("The harness tool result lost its admission")

    async def call(self, run_id: str, capability: str, request: dict) -> dict:
        identifier = await await_session_operation(self.enqueue, run_id, capability, request)
        while True:
            await await_session_operation(self._active, run_id, capability)
            record = await await_session_operation(self.requests.find_one, {"_id": identifier})
            if record is None or record["status"] == "interrupted":
                raise HarnessToolError("The harness tool request was interrupted; it will not be replayed")
            if record["status"] == "completed":
                return record["result"]
            # This is an observer, not the executor. A human decision may take
            # time; the admitted run/provider lifetime, not an HTTP timeout,
            # bounds execution. Disconnecting this wait never reclaims a call.
            await asyncio.sleep(0.1)


class HarnessResources:
    def __init__(
        self, repository: HarnessToolRepository, run: NativeExecutionRun, runtime: AgentRuntime,
        resources: AgentPlatformResources, *, invoke_child: ChildInvoker | None, admit_child: ChildAdmission | None,
        admit_parent: ChildAdmission | None = None,
    ) -> None:
        self.repository, self.run, self.runtime = repository, run, runtime
        self.system_prompt, self.skills_files = resources.system_prompt, resources.skills_files
        self.mcp_servers: list[dict[str, Any]] = []
        self.driver: HarnessACPDriver | None = None
        self.invoke_child, self.admit_child = invoke_child, admit_child
        self.admit_parent = admit_parent
        self.admitted_names = {tool.name for tool in resources.tools}
        self.children = {ref.name: ref.agent_id for ref in runtime.config.subagents}
        self.lease_id: str | None = None
        self.failed = False
        self.before_tool: Callable[[str, dict], Awaitable[None]] | None = None
        self.after_tool: Callable[[str, dict, Any], Awaitable[None]] | None = None

    def bind_driver(self, driver: HarnessACPDriver) -> None:
        self.driver = driver
        if self.failed:
            driver.fail()

    def bind_workspace(self, workspace: Any) -> None:
        self.before_tool, self.after_tool = workspace.before_tool, workspace.after_tool

    async def _input(self, event: InputRequired, *, child: dict | None = None) -> dict:
        if self.driver is None or self.driver.session_id is None:
            raise HarnessToolError("The harness input bridge is unavailable")
        return await self.driver.request_platform_input(HarnessPendingInput(
            interrupt_id=event.interrupt_id, session_id=self.driver.session_id,
            method="caipe/child_input" if child else "caipe/tool_input", request=child or {}, event=event,
        ))

    async def _child(self, current: DynamicAgentConfig, arguments: dict) -> str:
        name, message = arguments.get("subagent_type"), arguments.get("description")
        if name not in self.children or not isinstance(message, str) or not message.strip():
            raise HarnessToolError("Choose a configured subagent and provide its task description")
        if not any(ref.name == name and ref.agent_id == self.children[name] for ref in current.subagents):
            raise HarnessToolError("The configured subagent was revoked")
        child = await await_session_operation(self.repository.mongo.get_agent, self.children[name])
        if child is None or not child.enabled or child.id == current.id:
            raise HarnessToolError("The configured subagent is unavailable")
        child_session = str(uuid5(NAMESPACE_URL, f"caipe-child:{self.run.session_id}:{child.id}"))
        resume_data = None
        while True:
            await require_agent_use_permission(child.id)
            await self.admit_child(child, child_session)
            result = await self.invoke_child(child, child_session, message, resume_data)
            if not result.interrupt:
                return result.content
            interrupt = result.interrupt
            event = InputRequired(
                interrupt_id=interrupt["interrupt_id"], interrupt_type=interrupt["type"], agent=child.name,
                prompt=interrupt.get("prompt", "A delegated agent requires your decision."), fields=interrupt.get("fields", []),
                **{key: interrupt[key] for key in ("tool_name", "tool_args", "allowed_decisions", "tool_approvals") if key in interrupt},
            )
            decision = await self._input(event, child={"agent_id": child.id, "session_id": child_session, "interrupt": interrupt})
            resume_data, message = _encoded(decision, MAX_REQUEST_BYTES), None
            # Re-read on every resume: a pending human decision cannot restore
            # a revoked reference, disabled child or changed privacy admission.
            current = await await_session_operation(self.repository.mongo.get_agent, self.run.agent_id)
            if current is None or not any(ref.name == name and ref.agent_id == child.id for ref in current.subagents):
                raise HarnessToolError("The configured subagent was revoked")
            child = await await_session_operation(self.repository.mongo.get_agent, child.id)
            if child is None or not child.enabled:
                raise HarnessToolError("The configured subagent is unavailable")

    async def execute(self, name: str, arguments: dict) -> dict:
        await require_agent_use_permission(self.run.agent_id)
        current = await await_session_operation(self.repository.mongo.get_agent, self.run.agent_id)
        if current is None or not current.enabled:
            raise HarnessToolError("The agent is no longer available")
        if self.admit_parent is not None:
            await self.admit_parent(current, self.run.session_id)
        # Current tool grants can narrow an admitted run. Mutable metadata must
        # never redirect its already-bound workspace or execution environment.
        current = current.model_copy(update={
            "backend": self.runtime.config.backend, "execution": self.runtime.config.execution,
        })
        if name == "task" and self.children:
            gate = (current.interrupt_on or {}).get("builtin", {}).get("task")
            if gate:
                if isinstance(gate, BaseModel):
                    gate = gate.model_dump()
                allowed = gate.get("allowed_decisions", ["approve", "edit", "reject"]) if isinstance(gate, dict) else ["approve", "edit", "reject"]
                event = InputRequired(interrupt_id=str(uuid4()), interrupt_type="tool_approval", agent=current.name,
                    prompt="Review the requested delegation.", fields=[], tool_name="task", tool_args=arguments,
                    allowed_decisions=allowed)
                decision = (await self._input(event))["decisions"][0]
                if decision["decision"] == "reject":
                    return _content("The user rejected this delegation.", error=True)
                if decision["decision"] == "edit":
                    arguments = decision["edited_args"]
                await require_agent_use_permission(self.run.agent_id)
                latest = await await_session_operation(self.repository.mongo.get_agent, self.run.agent_id)
                if latest is None or latest.updated_at != current.updated_at or not latest.enabled:
                    raise HarnessToolError("The agent changed while awaiting delegation approval")
                if self.admit_parent is not None:
                    await self.admit_parent(latest, self.run.session_id)
            return _content(await self._child(current, arguments))
        if name not in self.admitted_names:
            raise HarnessToolError("The tool was not admitted for this execution")
        servers = await await_session_operation(self.repository.mongo.get_agent_mcp_servers, current)
        fresh = AgentRuntime(current, servers, self.runtime.settings, self.repository.mongo,
            user=self.runtime._user, client_context=self.runtime._client_context, session_id=self.run.session_id,
            mongo_client=self.repository.mongo._client)
        try:
            resources = await fresh.prepare_platform_resources()
            tool = next((tool for tool in resources.tools if tool.name == name), None)
            if tool is None:
                raise HarnessToolError("The tool was revoked or is no longer available")
            # Validate before exposing a form or approval; an agent cannot use
            # pre-populated form values as evidence of a human decision.
            tool.get_input_schema().model_validate(arguments)
            if name == "request_user_input":
                event = InputRequired(interrupt_id=str(uuid4()), interrupt_type="form_input", agent=current.name,
                    prompt=arguments["prompt"], fields=[{key: value for key, value in field.items() if key != "value"}
                        for field in arguments["fields"]])
                decision = await self._input(event)
                return _content("The user dismissed the form." if decision.get("dismissed") else decision["values"])
            gates = fresh._build_interrupt_config(resources.tools, resources.builtin_tool_names)
            gate = gates.get(name)
            if gate:
                allowed = gate.get("allowed_decisions", ["approve", "edit", "reject"]) if isinstance(gate, dict) else ["approve", "edit", "reject"]
                event = InputRequired(interrupt_id=str(uuid4()), interrupt_type="tool_approval", agent=current.name,
                    prompt="Review the requested tool operation.", fields=[], tool_name=name, tool_args=arguments,
                    allowed_decisions=allowed)
                decision = (await self._input(event))["decisions"][0]
                if decision["decision"] == "reject":
                    return _content("The user rejected this tool operation.", error=True)
                if decision["decision"] == "edit":
                    arguments = decision["edited_args"]
                    tool.get_input_schema().model_validate(arguments)
                # Human wait can be long; repeat current use authorization.
                await require_agent_use_permission(self.run.agent_id)
                latest = await await_session_operation(self.repository.mongo.get_agent, self.run.agent_id)
                if latest is None or latest.updated_at != current.updated_at or not latest.enabled:
                    raise HarnessToolError("The agent changed while awaiting approval; retry the tool under its current policy")
                if self.admit_parent is not None:
                    await self.admit_parent(latest, self.run.session_id)
                latest_servers = await await_session_operation(self.repository.mongo.get_agent_mcp_servers, latest)
                if {(server.id, server.updated_at) for server in servers} != {(server.id, server.updated_at) for server in latest_servers}:
                    raise HarnessToolError("The tool configuration changed while awaiting approval")
            if self.before_tool is not None:
                await self.before_tool(name, arguments)
                tool.get_input_schema().model_validate(arguments)
            result = await self._invoke_tool(current, servers, tool, arguments)
            if self.after_tool is not None and not (isinstance(result, ToolMessage) and result.status == "error"):
                await self.after_tool(name, arguments, result)
            return _content(result)
        finally:
            await fresh.cleanup()

    async def _invoke_tool(self, current: DynamicAgentConfig, servers: list[MCPServerConfig], tool: Any,
                           arguments: dict[str, Any]) -> Any:
        params = harness_middleware_params(current, "tool_retry")
        if params is not None and params.get("tools") is not None and tool.name not in params["tools"]:
            params = None
        metadata = tool.metadata or {}
        # Only annotations loaded from the admitted server count. Agent-authored
        # arguments, names and natural-language claims cannot authorize replay.
        replay_safe = metadata.get("readOnlyHint") is True or metadata.get("idempotentHint") is True
        failure = (params or {}).get("on_failure", "continue")
        stop = failure in {"error", "raise", "end"}

        async def invoke(request: ToolCallRequest) -> Any:
            # Repeat authorization and lease fencing after every backoff. A tool
            # grant, definition or server change requires fresh run admission.
            await require_agent_use_permission(self.run.agent_id)
            if self.lease_id is not None:
                await await_session_operation(self.repository._active, self.run.run_id, lease_id=self.lease_id)
            latest = await await_session_operation(self.repository.mongo.get_agent, self.run.agent_id)
            if latest is None or not latest.enabled or latest.updated_at != current.updated_at:
                raise HarnessToolError("The agent changed during tool execution")
            if self.admit_parent is not None:
                await self.admit_parent(latest, self.run.session_id)
            latest_servers = await await_session_operation(self.repository.mongo.get_agent_mcp_servers, latest)
            if {(server.id, server.updated_at) for server in servers} != {(server.id, server.updated_at) for server in latest_servers}:
                raise HarnessToolError("The tool configuration changed during execution")
            result = await tool.ainvoke(request.tool_call)
            if params is not None and (replay_safe or stop) and isinstance(result, ToolMessage) and result.status == "error":
                raise _RetryableToolResult("The admitted CAIPE tool returned an unsuccessful result")
            return result

        request = ToolCallRequest(tool_call={"name": tool.name, "args": arguments, "id": str(uuid4()), "type": "tool_call"},
                                  tool=tool, state={}, runtime=None)
        try:
            if params is None:
                return await invoke(request)
            params = {**params, "retry_on": lambda exc: replay_safe and not isinstance(
                exc, (HarnessToolError, HTTPException, ValidationError, PermissionError))}
            # Remote exception messages can include credentials or response
            # bodies. Retain the native retry implementation, sanitize only its
            # final presentation and preserve its configured stop/continue mode.
            params["on_failure"] = "error" if stop else lambda _exc: "The CAIPE tool failed after its configured retry attempts."
            middleware = InterruptAwareToolRetryMiddleware(**params)
            return await middleware.awrap_tool_call(request, invoke)
        except HarnessToolError:
            raise
        except Exception as exc:
            if stop:
                raise HarnessToolExecutionFailed("The CAIPE tool exhausted its configured retry policy") from exc
            raise

    async def serve(self) -> None:
        try:
            await self._serve()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Stop revokes the broker before the coordinator's cancellation
            # watcher necessarily runs. Let that owner cancel the prompt;
            # reporting a resource failure here would race the user's Stop.
            current = await self.repository.repository.get(
                self.run.run_id, owner_subject=self.run.owner_subject, reconcile=False,
            )
            if current is not None and current.cancel_requested:
                return
            self.failed = True
            if self.driver is not None:
                self.driver.fail()
            raise

    async def _serve(self) -> None:
        while True:
            record = await await_session_operation(self.repository.claim, self.run.run_id, self.lease_id)
            if record is None:
                await asyncio.sleep(0.05)
                continue
            try:
                result = await self.execute(record["params"]["name"], record["params"].get("arguments", {}))
            except asyncio.CancelledError:
                raise
            except HarnessToolExecutionFailed:
                await await_session_operation(self.repository.complete, record["_id"], self.run.run_id, self.lease_id,
                    _content("The CAIPE tool exhausted its configured retry policy; this turn was stopped.", error=True))
                raise
            except Exception:
                # Tool/provider exceptions may contain credentials or remote
                # response bodies. Their details remain in the owning service.
                result = _content("The CAIPE tool could not complete under its current authorization or configuration.", error=True)
            await await_session_operation(self.repository.complete, record["_id"], self.run.run_id, self.lease_id, result)


@asynccontextmanager
async def harness_resources(
    mongo: MongoDBService, agent: DynamicAgentConfig, servers: list[MCPServerConfig], session_id: str,
    user: UserContext, client_context: ClientContext | None, run: NativeExecutionRun,
    *, settings: Settings | None = None, invoke_child: ChildInvoker | None = None, admit_child: ChildAdmission | None = None,
    admit_parent: ChildAdmission | None = None,
) -> AsyncGenerator[HarnessResources, None]:
    settings = settings or get_settings()
    if run is None or run.agent_id != agent.id or run.session_id != session_id:
        raise HarnessToolError("The resource context must match its admitted execution")
    base = settings.harness_tools_public_url.rstrip("/")
    parsed = urlsplit(base)
    allowed_scheme = parsed.scheme == "https" or (parsed.scheme == "http" and settings.harness_tools_allow_http)
    if not allowed_scheme or not parsed.netloc or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise HarnessToolError("The operator must configure a valid public harness tool endpoint")
    if agent.subagents and (invoke_child is None or admit_child is None):
        raise HarnessToolError("Configured subagents require canonical execution and privacy admission")
    if admit_parent is not None:
        await admit_parent(agent, session_id)
    runtime = AgentRuntime(agent, servers, settings, mongo, user=user, client_context=client_context,
        session_id=session_id, mongo_client=mongo._client)
    repository = HarnessToolRepository(mongo)
    worker = None
    resources = None
    try:
        platform = await runtime.prepare_platform_resources()
        resources = HarnessResources(repository, run, runtime, platform, invoke_child=invoke_child,
            admit_child=admit_child, admit_parent=admit_parent)
        tools = [_tool_schema(tool) for tool in platform.tools]
        if resources.children:
            for child_id in resources.children.values():
                child = await await_session_operation(mongo.get_agent, child_id)
                if child is None or not child.enabled:
                    raise HarnessToolError("A configured subagent is unavailable")
                await require_agent_use_permission(child.id)
                await admit_child(child, str(uuid5(NAMESPACE_URL, f"caipe-child:{session_id}:{child.id}")))
            tools.append({"name": "task", "description": "Delegate to a configured CAIPE subagent. Each child retains its own native conversation and workflow state.",
                "inputSchema": {"type": "object", "properties": {
                    "description": {"type": "string", "description": "The task to delegate"},
                    "subagent_type": {"type": "string", "enum": list(resources.children)},
                }, "required": ["description", "subagent_type"], "additionalProperties": False}})
        if len({tool["name"] for tool in tools}) != len(tools):
            raise HarnessToolError("The admitted tool names conflict")
        capability = secrets.token_urlsafe(32)
        await await_session_operation(repository.initialize)
        resources.lease_id = await await_session_operation(repository.register, run, capability, tools)
        resources.mcp_servers = [{"type": "http", "name": "caipe", "url": f"{base}/{run.run_id}/mcp",
            "headers": [{"name": CAPABILITY_HEADER, "value": capability}]}]
        worker = asyncio.create_task(resources.serve())
        yield resources
    finally:
        if worker is not None:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
        if resources is not None and resources.lease_id is not None:
            await await_session_operation(repository.revoke, run.run_id, resources.lease_id)
        await runtime.cleanup()
