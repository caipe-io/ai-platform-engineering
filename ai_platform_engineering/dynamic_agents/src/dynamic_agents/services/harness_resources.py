"""Current platform tools for an already admitted Harness Engine producer."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import re
from collections.abc import AsyncIterator
from contextlib import aclosing, asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from langchain.agents.middleware.types import ToolCallRequest
from langchain_core.messages import ToolMessage
from pydantic import BaseModel, ValidationError

from dynamic_agents.auth.authz import require_agent_use_permission
from dynamic_agents.models import DynamicAgentConfig, UserContext
from dynamic_agents.services.agent_runtime import AgentPlatformResources, AgentRuntime
from dynamic_agents.services.harness_context import CanonicalContextError, resolve_canonical_conversation
from dynamic_agents.services.harness_policy import execution_policy
from dynamic_agents.services.middleware import InterruptAwareToolRetryMiddleware
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.stream_encoders import get_encoder

MAX_PARAMS_BYTES = 262_144
MAX_RESULT_BYTES = 1_048_576
MAX_ACTIVE_EFFECTS = 1_000


class _ToolLimitReached(Exception):
    def __init__(self, stop: bool) -> None:
        self.stop = stop


class _RetryableToolResult(Exception):
    """A trusted replay-safe tool explicitly returned an unsuccessful result."""


class _ToolPolicyFailed(Exception):
    stop = True


def _deny(message: str, status: int = 409) -> None:
    raise HTTPException(status_code=status, detail=message)


def _bounded(value: Any, limit: int) -> str:
    try:
        encoded = json.dumps(value, default=str, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (ValueError, TypeError):
        _deny("The platform payload is not valid finite JSON")
    if len(encoded.encode()) > limit:
        _deny("The platform tool payload exceeds its supported size")
    return encoded


def _content(value: Any, *, error: bool = False) -> dict[str, Any]:
    if isinstance(value, ToolMessage):
        error = error or value.status == "error"
        value = value.content
    text = value if isinstance(value, str) else _bounded(value, MAX_RESULT_BYTES)
    result = {"content": [{"type": "text", "text": text}], "isError": error}
    _bounded(result, MAX_RESULT_BYTES)
    return result


def _revision(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value)


def _digest(value: Any) -> str:
    _bounded(value, MAX_PARAMS_BYTES)
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()).hexdigest()


def _tool_schema(tool: Any) -> dict[str, Any]:
    return {"name": tool.name, "description": tool.description or "", "inputSchema": tool.get_input_schema().model_json_schema()}


def _task_schema(agent: DynamicAgentConfig) -> dict[str, Any]:
    return {"name": "task", "description": "Delegate a task to a configured specialist using its own private native context.",
            "inputSchema": {"type": "object", "properties": {
                "description": {"type": "string", "minLength": 1},
                "subagent_type": {"type": "string", "enum": [ref.name for ref in agent.subagents]},
            }, "required": ["description", "subagent_type"], "additionalProperties": False}}


def _decision(payload: dict[str, Any], decision: Any) -> dict[str, Any]:
    """Revalidate durable human input independently of the Engine's validator."""
    if not isinstance(decision, dict) or decision.get("interrupt_id") != payload["interrupt_id"]:
        _deny("The human decision belongs to another platform request")
    kind = payload["interrupt_type"]
    if decision.get("type") != kind:
        _deny("The human decision does not match the requested input")
    if kind == "tool_approval":
        approvals = payload.get("tool_approvals") or [{"tool_name": payload.get("tool_name"), "allowed_decisions": payload.get("allowed_decisions", ["approve", "edit", "reject"])}]
        decisions = decision.get("decisions")
        if not isinstance(decisions, list) or len(decisions) != len(approvals):
            _deny("One explicit decision is required for each requested operation")
        for expected, supplied in zip(approvals, decisions, strict=True):
            allowed = expected.get("allowed_decisions", payload.get("allowed_decisions", ["approve", "edit", "reject"]))
            if not isinstance(supplied, dict) or supplied.get("decision") not in allowed:
                _deny("The human decision is not allowed by this tool policy")
            if supplied.get("tool_name", expected.get("tool_name")) != expected.get("tool_name"):
                _deny("The human decision names another operation")
            if supplied["decision"] == "edit" and not isinstance(supplied.get("edited_args"), dict):
                _deny("Edited tool arguments must be an object")
        return decision
    if kind != "form_input":
        _deny("The platform input type is unsupported")
    if decision.get("dismissed") is True:
        return decision
    values = decision.get("values")
    fields = payload.get("fields", [])
    if not isinstance(values, dict) or set(values) - {field["field_name"] for field in fields}:
        _deny("The human form contains unexpected fields")
    for field in fields:
        name, field_type = field["field_name"], field.get("field_type", "text")
        value = values.get(name)
        if value is None or value == "":
            if field.get("required"):
                _deny("A required human input field is missing")
            continue
        if isinstance(value, str):
            text = value.strip()
            if field_type == "boolean" and text.lower() in {"yes", "no", "true", "false"}:
                value = text.lower() in {"yes", "true"}
            elif field_type == "number" and re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
                value = float(text)
            elif field_type == "multiselect":
                value = [item.strip() for item in text.split(",") if item.strip()]
        if field_type == "number":
            valid = type(value) in (int, float) and math.isfinite(value)
        elif field_type == "boolean":
            valid = type(value) is bool
        elif field_type == "multiselect":
            valid = isinstance(value, list) and all(item in field.get("field_values", []) for item in value)
        else:
            valid = isinstance(value, str) and (field_type != "select" or value in field.get("field_values", []))
        if not valid:
            _deny("A human input value does not match its field definition")
    return decision


class HarnessResourceService:
    """One tool service; canonical Engine runs and leases own all admission."""

    def __init__(self, mongo: MongoDBService, run_id: str, subject: str, producer: str, user: UserContext) -> None:
        if mongo._db is None:
            _deny("Canonical platform storage is unavailable", 503)
        self.mongo, self.db = mongo, mongo._db
        self.run_id, self.subject, self.producer, self.user = run_id, subject, producer, user

    async def require(self, *, running: bool = True, check_permission: bool = True) -> tuple[dict[str, Any], DynamicAgentConfig]:
        run = await asyncio.to_thread(self.db.harness_runs.find_one, {"run_id": self.run_id, "owner_subject": self.subject})
        statuses = {"running"} if running else {"running", "awaiting_input"}
        if run is None or run.get("harness_id") != "claude_code_acp" or run.get("status") not in statuses or run.get("cancellation_requested") or run.get("_coding_resources_closed") is True or not run.get("_provider_started") or (running and run.get("pending_interrupt_id") is not None):
            _deny("The Engine producer is no longer admitted")
        token = run.get("_producer_id")
        if not isinstance(token, str) or not hmac.compare_digest(token, self.producer):
            _deny("The Engine producer identity does not match", 403)
        now = datetime.now(timezone.utc)
        session = await asyncio.to_thread(self.db.harness_sessions.find_one, {
            "binding_id": run["binding_id"], "owner_subject": self.subject, "agent_id": run["agent_id"],
            "conversation_id": run["conversation_id"], "harness_id": run["harness_id"], "status": "active",
            "_active_run_id": self.run_id, "_producer_id": self.producer, "_lease_expires_at": {"$gt": now},
        })
        if session is None:
            _deny("The Engine provider session has lost its live binding")
        if await asyncio.to_thread(self.db.harness_deleted_contexts.find_one, {"_id": run["conversation_id"]}, {"_id": 1}):
            _deny("The execution context was permanently deleted")
        try:
            conversation = await asyncio.to_thread(
                resolve_canonical_conversation, self.db, owner_subject=self.subject, agent_id=run["agent_id"],
                conversation_id=run["conversation_id"], visible_conversation_id=run.get("visible_conversation_id"),
            )
        except CanonicalContextError:
            _deny("The canonical visible conversation no longer matches this producer")
        if conversation is None:
            _deny("The canonical visible conversation no longer matches this producer")
        gateway = await asyncio.to_thread(self.db.harness_gateway_bindings.find_one, {
            "owner_subject": self.subject, "agent_id": run["agent_id"], "conversation_id": run["conversation_id"], "harness_id": run["harness_id"],
        })
        if gateway is None:
            _deny("The canonical gateway binding no longer matches this producer")
        if check_permission:
            await require_agent_use_permission(run["agent_id"])
        agent = await asyncio.to_thread(self.mongo.get_agent, run["agent_id"])
        if agent is None or not agent.enabled:
            _deny("The selected agent is unavailable")
        execution_policy(agent)
        return run, agent

    async def _pinned_agent(self, run: dict[str, Any], current: DynamicAgentConfig) -> DynamicAgentConfig:
        version = await asyncio.to_thread(self.db.harness_agent_versions.find_one, {
            "agent_id": run["agent_id"], "version": run["agent_version"],
        })
        prompt = (version or {}).get("blueprint", {}).get("prompt", {})
        system = prompt.get("system")
        if not isinstance(system, str) or not system:
            _deny("The admitted immutable agent prompt is unavailable")
        for name, value in prompt.get("variables", {}).items():
            if not isinstance(name, str) or not isinstance(value, str):
                _deny("The admitted prompt variable is invalid")
            system = system.replace("{{" + name + "}}", value)
        return current.model_copy(update={"system_prompt": system})

    @staticmethod
    def _fingerprint(agent: DynamicAgentConfig, servers: list[Any]) -> str:
        fields = {"allowed_tools", "allowed_remote_agents", "remote_agent_timeouts", "builtin_tools", "subagents", "skills",
                  "datasource_ids", "rag_collection_ids", "features", "interrupt_on"}
        value = {"agent": agent.model_dump(mode="json", include=fields),
                 "servers": sorted((item.id, _revision(item.updated_at)) for item in servers)}
        return _digest(value)

    async def _admit_catalog(self, run: dict[str, Any], agent: DynamicAgentConfig, servers: list[Any], tools: list[dict[str, Any]], children: list[dict[str, Any]]) -> None:
        admission = {"fingerprint": self._fingerprint(agent, servers), "agent_revision": _revision(agent.updated_at),
                     "tool_fingerprints": {tool["name"]: _digest(tool) for tool in tools},
                     "child_revisions": children}
        _bounded(admission, MAX_PARAMS_BYTES)
        _, current = await self.require()
        current_servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, current)
        if self._fingerprint(current, current_servers) != admission["fingerprint"]:
            _deny("The selected resources changed while compiling the admitted catalog")
        await asyncio.to_thread(self.db.harness_runs.update_one, {
            "run_id": self.run_id, "_producer_id": self.producer, "status": "running",
            "_coding_platform_admission": {"$exists": False},
        }, {"$set": {"_coding_platform_admission": admission}})
        stored = await asyncio.to_thread(self.db.harness_runs.find_one, {"run_id": self.run_id}, {"_coding_platform_admission": 1})
        if not stored or stored.get("_coding_platform_admission") != admission:
            _deny("This Engine run already has a different admitted resource catalog")

    @asynccontextmanager
    async def platform(self, agent: DynamicAgentConfig, session_id: str) -> AsyncIterator[tuple[AgentRuntime, AgentPlatformResources, list[Any]]]:
        servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, agent)
        runtime = AgentRuntime(agent, servers, self.mongo.settings, self.mongo, user=self.user, session_id=session_id, ephemeral=True)
        # Keep parent execution state in memory while reading workflow configs
        # through the existing canonical client; never leak a per-call client.
        runtime._mongo_client = self.mongo._client
        try:
            resources = await runtime.prepare_platform_resources()
            yield runtime, resources, servers
        finally:
            await runtime.cleanup()

    async def _children(self, agent: DynamicAgentConfig, visited: set[str] | None = None) -> list[dict[str, Any]]:
        visited = set(visited or ())
        if agent.id in visited or len(visited) >= 32:
            _deny("The configured specialist tree is cyclic or exceeds its supported size")
        visited.add(agent.id)
        revisions: list[dict[str, Any]] = []
        for ref in agent.subagents:
            await require_agent_use_permission(ref.agent_id)
            child = await asyncio.to_thread(self.mongo.get_agent, ref.agent_id)
            raw = await asyncio.to_thread(self.db.dynamic_agents.find_one, {"_id": ref.agent_id}, {"execution_harness_id": 1})
            if child is None or not child.enabled or (raw or {}).get("execution_harness_id", "dynamic_agents") not in (None, "", "dynamic_agents"):
                _deny("The configured specialist is unavailable for native delegation")
            servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, child)
            revisions.append({"id": child.id, "revision": _revision(child.updated_at),
                              "server_revisions": [list(item) for item in sorted((server.id, _revision(server.updated_at)) for server in servers)]})
            revisions.extend(await self._children(child, visited))
        return revisions

    async def catalog(self) -> dict[str, Any]:
        run, agent = await self.require()
        children = await self._children(agent)
        prepared = await self._pinned_agent(run, agent)
        async with self.platform(prepared, run["conversation_id"]) as (_, resources, servers):
            tools = [_tool_schema(tool) for tool in resources.tools]
            if agent.subagents:
                tools.append(_task_schema(agent))
            if len({tool["name"] for tool in tools}) != len(tools):
                _deny("The selected platform tool names conflict")
            result = {"tools": tools, "system_prompt": resources.system_prompt, "skills_files": resources.skills_files,
                      "execution_policy": execution_policy(agent)}
            _bounded(result, 8 * MAX_RESULT_BYTES)
            await self.require()
            await self._admit_catalog(run, agent, servers, tools, children)
            return result

    def _call_scope(self, request_id: str) -> dict[str, Any]:
        return {"_id": request_id, "run_id": self.run_id, "producer_id": self.producer, "status": "claimed"}

    @staticmethod
    def _effect_key(record: dict[str, Any]) -> str:
        request_id = record["_id"]
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id):
            _deny("The platform effect identity is invalid")
        return "_coding_active_effects." + request_id

    async def _reserve_effect(self, record: dict[str, Any], run: dict[str, Any], *, continuing: bool = False) -> None:
        """Serialize effect admission with capability revocation on the same run."""
        key = self._effect_key(record)
        capability = run.get("_coding_capability_hash")
        if not isinstance(capability, str) or not capability:
            _deny("The platform resource capability is no longer active")
        available = {key: "executing"} if continuing else {"$or": [{key: {"$exists": False}}, {key: "paused"}]}
        reserved = await asyncio.to_thread(self.db.harness_runs.update_one, {
            "run_id": self.run_id, "owner_subject": self.subject, "binding_id": record["binding_id"],
            "_producer_id": self.producer, "_producer_expires_at": {"$gt": datetime.now(timezone.utc)},
            "status": "running", "pending_interrupt_id": None, "cancellation_requested": {"$ne": True},
            "_coding_resources_closed": {"$ne": True}, "_coding_capability_hash": capability,
            "$and": [available, {"$or": [
                {key: {"$exists": True}},
                {"$expr": {"$lt": [{"$size": {"$objectToArray": {"$ifNull": ["$_coding_active_effects", {}]}}}, MAX_ACTIVE_EFFECTS]}},
            ]}],
        }, {"$set": {key: "executing"}})
        if reserved.matched_count != 1:
            _deny("The platform effect lost its live resource admission")

    async def _acknowledge_effect(self, record: dict[str, Any], phase: str) -> None:
        key = self._effect_key(record)
        # A close may already be waiting for this exact admitted operation.
        # Acknowledgment is allowed after revoke; it cannot admit another effect.
        await asyncio.to_thread(self.db.harness_runs.update_one, {
            "run_id": self.run_id, "owner_subject": self.subject, "binding_id": record["binding_id"],
            "_producer_id": self.producer, key: "executing",
        }, {"$set": {key: phase}})

    async def _claim(self, record: dict[str, Any], agent: DynamicAgentConfig) -> None:
        _, current = await self.require()
        if current.updated_at != agent.updated_at:
            _deny("The agent changed before platform effect admission")
        changed = await asyncio.to_thread(self.db.harness_tool_requests.update_one, {
            **self._call_scope(record["_id"]), "binding_id": record["binding_id"],
            "platform_phase": record["platform_phase"], "params": record["params"],
        }, {"$set": {"platform_phase": "executing", "platform_started_at": datetime.now(timezone.utc), "platform_budget_counted": True}})
        if changed.modified_count != 1:
            _deny("The platform operation was already claimed; an uncertain effect will not be repeated")
        if not record.get("platform_budget_counted"):
            applicable = [item for item in execution_policy(agent)["tool_call_limits"] if item.get("tool_name") in (None, record["params"]["name"])]
            limits: dict[str, int] = {}
            for item in applicable:
                key = "_coding_platform_tool_counts." + hashlib.sha256(str(item.get("tool_name", "*")).encode()).hexdigest()
                limits[key] = min(limits.get(key, 10000), item["run_limit"])
            if limits:
                query = {"run_id": self.run_id, "_producer_id": self.producer, "status": "running", "cancellation_requested": {"$ne": True},
                         "$and": [{"$or": [{key: {"$exists": False}}, {key: {"$lt": limit}}]} if limit > 0 else {key: {"$lt": 0}} for key, limit in limits.items()]}
                counted = await asyncio.to_thread(self.db.harness_runs.update_one, query, {"$inc": dict.fromkeys(limits, 1)})
                if counted.modified_count != 1:
                    await self.require()
                    raise _ToolLimitReached(any(item["exit_behavior"] in {"error", "end"} for item in applicable))

    async def _complete(self, record: dict[str, Any], result: dict[str, Any], *, stop: bool = False, acknowledge_effect: bool = True) -> dict[str, Any]:
        _bounded(result, MAX_RESULT_BYTES)
        committed = await asyncio.to_thread(self.db.harness_tool_requests.update_one, {
            **self._call_scope(record["_id"]), "platform_phase": "executing",
        }, {"$set": {"platform_phase": "completed", "platform_result": result, "platform_stop_run": stop}})
        if committed.matched_count != 1:
            _deny("The platform result no longer belongs to this admitted call")
        if acknowledge_effect:
            await self._acknowledge_effect(record, "completed")
        return {"result": result, **({"stop_run": True} if stop else {})}

    async def _pending(
        self, record: dict[str, Any], payload: dict[str, Any], agent: DynamicAgentConfig, servers: list[Any], *, child: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        review = {"input_id": payload["interrupt_id"], "payload": payload, "agent_revision": _revision(agent.updated_at),
                  "server_revisions": [list(item) for item in sorted((item.id, _revision(item.updated_at)) for item in servers)], "child": child}
        await self.require()
        changed = await asyncio.to_thread(self.db.harness_tool_requests.update_one, {
            **self._call_scope(record["_id"]), "platform_phase": record["platform_phase"], "params": record["params"],
        }, {"$set": {"platform_phase": "awaiting_input", "platform_input": review}})
        if changed.modified_count != 1:
            _deny("The platform human request lost its admission")
        await self._acknowledge_effect(record, "paused")
        return {"pending_input": payload}

    async def call(self, request_id: str) -> dict[str, Any]:
        try:
            return await self._call(request_id)
        except (_ToolLimitReached, _ToolPolicyFailed) as exc:
            record = await asyncio.to_thread(self.db.harness_tool_requests.find_one, self._call_scope(request_id))
            if record is None:
                _deny("The platform tool budget lost its admitted call")
            message = "The configured platform tool call limit was reached." if isinstance(exc, _ToolLimitReached) else "The platform tool exhausted its configured safe retry policy."
            return await self._complete(record, _content(message, error=True), stop=exc.stop,
                                        acknowledge_effect=not isinstance(exc, _ToolPolicyFailed))

    async def _call(self, request_id: str) -> dict[str, Any]:
        run, agent = await self.require()
        record = await asyncio.to_thread(self.db.harness_tool_requests.find_one, self._call_scope(request_id))
        if record is None or record.get("binding_id") != run["binding_id"]:
            _deny("The platform call does not match this admitted Engine run")
        if record.get("platform_phase") == "completed":
            return {"result": record["platform_result"], **({"stop_run": True} if record.get("platform_stop_run") else {})}
        if record.get("platform_phase") not in {"admitted", "awaiting_input"}:
            _deny("The platform operation has an uncertain outcome and will not be repeated")
        params = record.get("params")
        _bounded(params, MAX_PARAMS_BYTES)
        if not isinstance(params, dict) or not isinstance(params.get("name"), str) or not isinstance(params.get("arguments", {}), dict):
            _deny("The admitted platform parameters are invalid")
        name, arguments = params["name"], params.get("arguments", {})
        if name not in {tool.get("name") for tool in run.get("_coding_tools", [])}:
            _deny("The tool was not selected for this Engine execution")
        review = record.get("platform_input") if record["platform_phase"] == "awaiting_input" else None
        decision = None
        if review:
            pending = run.get("_coding_pending", {})
            if pending.get("interrupt_id") != review["input_id"] or "decision" not in pending:
                _deny("This platform request still requires its bound human decision")
            if review["agent_revision"] != _revision(agent.updated_at):
                _deny("The agent changed while awaiting platform input")
            decision = _decision(review["payload"], pending["decision"])
        admission = run.get("_coding_platform_admission")
        if not isinstance(admission, dict):
            _deny("The Engine run has no admitted platform catalog")
        prepared = await self._pinned_agent(run, agent)
        async with self.platform(prepared, run["conversation_id"]) as (runtime, resources, servers):
            if self._fingerprint(agent, servers) != admission.get("fingerprint"):
                _deny("The selected platform definition changed after catalog admission")
            if review and review["server_revisions"] != [list(item) for item in sorted((item.id, _revision(item.updated_at)) for item in servers)]:
                # BSON stores tuples as arrays; compare canonical arrays.
                _deny("The platform server selection changed while awaiting input")
            tool = next((item for item in resources.tools if item.name == name), None)
            if name == "task" and agent.subagents:
                return await self._task(record, run, agent, arguments, runtime, resources, servers, decision, review)
            if tool is None:
                _deny("The selected platform tool is no longer available")
            if _digest(_tool_schema(tool)) != admission.get("tool_fingerprints", {}).get(name):
                _deny("The selected platform tool schema changed after admission")
            tool.get_input_schema().model_validate(arguments)
            if name == "request_user_input":
                if decision is None:
                    payload = {"interrupt_id": str(uuid5(NAMESPACE_URL, f"platform-input:{self.run_id}:{request_id}")),
                               "interrupt_type": "form_input", "agent": agent.name, "prompt": arguments["prompt"],
                               "fields": [{key: value for key, value in item.items() if key != "value"} for item in arguments["fields"]]}
                    return await self._pending(record, payload, agent, servers)
                await self._claim(record, agent)
                return await self._complete(record, _content("The user dismissed the form." if decision.get("dismissed") else decision["values"]))
            gate = runtime._build_interrupt_config(resources.tools, resources.builtin_tool_names).get(name)
            if gate:
                if isinstance(gate, BaseModel):
                    gate = gate.model_dump()
                if decision is None:
                    payload = {"interrupt_id": str(uuid5(NAMESPACE_URL, f"platform-input:{self.run_id}:{request_id}")),
                               "interrupt_type": "tool_approval", "agent": agent.name, "prompt": "Review the requested tool operation.",
                               "fields": [], "tool_name": name, "tool_args": arguments,
                               "allowed_decisions": gate.get("allowed_decisions", ["approve", "edit", "reject"]) if isinstance(gate, dict) else ["approve", "edit", "reject"]}
                    return await self._pending(record, payload, agent, servers)
                selected = decision["decisions"][0]
                if selected["decision"] == "reject":
                    await self._claim(record, agent)
                    return await self._complete(record, _content("The user rejected this operation.", error=True))
                if selected["decision"] == "edit":
                    arguments = selected["edited_args"]
                    tool.get_input_schema().model_validate(arguments)
            await self._claim(record, agent)
            result, settled = await self._invoke_tool(record, agent, servers, tool, arguments)
            return await self._complete(record, _content(result), acknowledge_effect=settled)

    async def _invoke_tool(self, record: dict[str, Any], agent: DynamicAgentConfig, servers: list[Any], tool: Any, arguments: dict[str, Any]) -> tuple[Any, bool]:
        params = execution_policy(agent)["tool_retry"]
        if params is not None and params.get("tools") is not None and tool.name not in params["tools"]:
            params = None
        metadata = getattr(tool, "metadata", None) or {}
        replay_safe = metadata.get("readOnlyHint") is True or metadata.get("idempotentHint") is True
        reserved = False
        settled = False

        async def invoke(request: ToolCallRequest) -> Any:
            nonlocal reserved, settled
            run, current = await self.require()
            current_servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, current)
            if self._fingerprint(current, current_servers) != self._fingerprint(agent, servers):
                _deny("The current tool selection changed during retry")
            await self._reserve_effect(record, run, continuing=reserved)
            reserved = True
            settled = False
            result = await tool.ainvoke(request.tool_call)
            settled = True
            if params is not None and replay_safe and isinstance(result, ToolMessage) and result.status == "error":
                raise _RetryableToolResult("The replay-safe platform operation returned an unsuccessful result")
            return result

        request = ToolCallRequest(tool_call={"name": tool.name, "args": arguments, "id": record["_id"], "type": "tool_call"}, tool=tool, state={}, runtime=None)
        if params is None:
            result = await invoke(request)
            return result, settled
        options = {**params, "retry_on": lambda exc: replay_safe and not isinstance(exc, (HTTPException, ValidationError, PermissionError)),
                   "on_failure": "error" if params.get("on_failure") in {"error", "raise", "end"} else lambda exc: "The platform operation failed after its configured safe retry attempts."}
        middleware = InterruptAwareToolRetryMiddleware(**options)
        try:
            result = await middleware.awrap_tool_call(request, invoke)
            return result, settled
        except HTTPException:
            raise
        except Exception as exc:
            if params.get("on_failure") in {"error", "raise", "end"}:
                raise _ToolPolicyFailed from exc
            raise

    async def _task(
        self, record: dict[str, Any], run: dict[str, Any], agent: DynamicAgentConfig, arguments: dict[str, Any],
        runtime: AgentRuntime, resources: AgentPlatformResources, servers: list[Any], decision: dict[str, Any] | None,
        review: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if set(arguments) != {"description", "subagent_type"} or not isinstance(arguments["description"], str) or not arguments["description"].strip():
            _deny("Choose a configured specialist and provide its task description")
        reference = next((ref for ref in agent.subagents if ref.name == arguments["subagent_type"]), None)
        if reference is None:
            _deny("The specialist was not selected by this agent")
        revisions = await self._children(agent)
        if revisions != run.get("_coding_platform_admission", {}).get("child_revisions"):
            _deny("The configured specialist definition changed after admission")
        child = await asyncio.to_thread(self.mongo.get_agent, reference.agent_id)
        child_session = str(uuid5(NAMESPACE_URL, f"harness-child:{self.run_id}:{record['_id']}:{child.id}:{self.producer}"))
        child_review = review.get("child") if review else None
        if child_review and (child_review["agent_id"] != child.id or child_review["session_id"] != child_session or child_review["revisions"] != revisions):
            _deny("The configured specialist context changed while awaiting input")
        task_tool = type("TaskIdentity", (), {"name": "task"})()
        gate = runtime._build_interrupt_config([*resources.tools, task_tool], resources.builtin_tool_names | {"task"}).get("task")
        if gate and child_review is None:
            if decision is None:
                allowed = gate.get("allowed_decisions", ["approve", "edit", "reject"]) if isinstance(gate, dict) else ["approve", "edit", "reject"]
                payload = {"interrupt_id": str(uuid5(NAMESPACE_URL, f"platform-input:{self.run_id}:{record['_id']}")),
                           "interrupt_type": "tool_approval", "agent": agent.name, "prompt": "Review the requested specialist delegation.",
                           "fields": [], "tool_name": "task", "tool_args": arguments, "allowed_decisions": allowed}
                return await self._pending(record, payload, agent, servers)
            selected = decision["decisions"][0]
            if selected["decision"] == "reject":
                await self._claim(record, agent)
                return await self._complete(record, _content("The user rejected this delegation.", error=True))
            if selected["decision"] == "edit":
                edited = selected["edited_args"]
                if edited.get("subagent_type") != arguments["subagent_type"] or set(edited) != set(arguments) or not isinstance(edited.get("description"), str) or not edited["description"].strip():
                    _deny("An edited delegation cannot change its selected specialist")
                arguments = edited
        await require_agent_use_permission(child.id)
        await self._claim(record, agent)
        child_servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, child)
        child_runtime = AgentRuntime(child, child_servers, self.mongo.settings, self.mongo, user=self.user,
                                     session_id=child_session, mongo_client=self.mongo._client)
        try:
            live_run, _ = await self.require()
            await self._reserve_effect(record, live_run)
            if child_review:
                await child_runtime.initialize()
                native_pending = await child_runtime.has_pending_interrupt(child_session)
                if not native_pending or native_pending.get("interrupt_id") != child_review["native_interrupt_id"]:
                    _deny("The specialist checkpoint no longer contains this human request")
            encoder = get_encoder("custom")
            stream = child_runtime.resume(child_session, self.subject, _bounded(decision, MAX_PARAMS_BYTES), encoder=encoder) if child_review else child_runtime.stream(
                arguments["description"], child_session, self.subject, encoder=encoder, turn_id=record["_id"],
            )
            async def consume() -> None:
                async with aclosing(stream):
                    async for _ in stream:
                        pass

            operation = asyncio.create_task(consume())

            async def monitor() -> None:
                while not operation.done():
                    await asyncio.sleep(0.1)
                    try:
                        await self.require(check_permission=False)
                    except Exception:
                        child_runtime.cancel()
                        operation.cancel()
                        return

            watcher = asyncio.create_task(monitor())
            try:
                await operation
            finally:
                watcher.cancel()
                with suppress(asyncio.CancelledError):
                    await watcher
            pending = await child_runtime.has_pending_interrupt(child_session)
            if pending:
                payload = {key: pending[key] for key in (
                    "prompt", "fields", "tool_name", "tool_args", "allowed_decisions", "tool_approvals",
                ) if key in pending}
                payload.update(interrupt_type=pending["type"], agent=child.name)
                # Rebind native input to the parent call while retaining the
                # child's own checkpoint identity only in the server-side row.
                payload["interrupt_id"] = str(uuid5(NAMESPACE_URL, f"harness-child-input:{self.run_id}:{record['_id']}:{pending['interrupt_id']}"))
                record = {**record, "platform_phase": "executing"}
                return await self._pending(record, payload, agent, servers, child={
                    "agent_id": child.id, "session_id": child_session, "native_interrupt_id": pending["interrupt_id"], "revisions": revisions,
                })
            return await self._complete(record, _content(encoder.get_accumulated_content()))
        finally:
            await child_runtime.cleanup()
