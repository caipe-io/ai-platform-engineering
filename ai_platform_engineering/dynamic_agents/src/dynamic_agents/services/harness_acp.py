"""ACP v1 client for qualified external harnesses behind CAIPE execution.

The owning execution service supplies the transport and trusted session options.
It also persists pending input and polls durable decisions; a browser connection
never owns the prompt or answers a permission request. Provider session loading
is strict: failure must not silently create a fresh conversation.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import suppress
from typing import Any, Literal, Protocol
from uuid import uuid4

from acp import PROTOCOL_VERSION, RequestError, connect_to_agent
from acp.schema import (
    BlobResourceContents,
    ClientCapabilities,
    ElicitationCapabilities,
    ElicitationFormCapabilities,
    EmbeddedResourceContentBlock,
    ImageContentBlock,
    RequestPermissionRequest,
    ResourceContentBlock,
    SessionNotification,
    TextContentBlock,
)
from pydantic import BaseModel, ConfigDict

from dynamic_agents.models import InputFile
from dynamic_agents.services.stream_encoders import StreamEncoder
from dynamic_agents.services.stream_encoders.events import (
    ContextUsage,
    InputRequired,
    ReasoningDelta,
    RunError,
    RunFinished,
    RunStarted,
    StreamEnded,
    StreamEvent,
    TextDelta,
    ToolCompleted,
    ToolOutput,
    ToolStarted,
    UpdatesBoundary,
    WarningEvent,
)

MAX_MESSAGE_BYTES = 2 * 1024 * 1024
MAX_PENDING_EVENTS = 64
MAX_TOOL_CALLS = 1024


class HarnessACPError(RuntimeError):
    """The qualified harness connection cannot safely continue this turn."""


class AsyncJSONTransport(Protocol):
    async def send(self, message: dict[str, Any]) -> None: ...
    async def receive(self) -> dict[str, Any] | None: ...
    async def close(self) -> None: ...


class HarnessPendingInput(BaseModel):
    """Serializable pending request; stores no transport, future or credentials."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    interrupt_id: str
    session_id: str
    method: Literal["session/request_permission", "elicitation/create", "caipe/child_input", "caipe/tool_input"]
    request: dict[str, Any]
    event: InputRequired


def _json(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    return value


def _bounded(value: Any) -> None:
    if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_MESSAGE_BYTES:
        raise HarnessACPError("Harness ACP message exceeds the configured limit")


def _action_field(schema: dict[str, Any]) -> str:
    name = "__acp_action"
    while name in schema.get("properties", {}):
        name += "_"
    return name


def _validate_form(schema: dict[str, Any], values: Any) -> dict[str, Any]:
    if not isinstance(values, dict):
        raise ValueError("Form input must be an object")
    properties = schema.get("properties", {})
    if set(values) - set(properties) or set(schema.get("required", [])) - set(values):
        raise ValueError("Form input has unknown or missing required fields")
    for key, value in values.items():
        prop = properties[key]
        kind = prop.get("type", "string")
        valid = (
            isinstance(value, str) if kind == "string" else
            type(value) is bool if kind == "boolean" else
            type(value) is int if kind == "integer" else
            type(value) in {int, float} if kind == "number" else
            isinstance(value, list) and all(isinstance(item, str) for item in value) if kind == "array" else False
        )
        if not valid:
            raise ValueError(f"Invalid form field type: {key}")
        if kind == "number" and not math.isfinite(value):
            raise ValueError(f"Invalid form field value: {key}")
        choices = prop.get("enum") or [item["const"] for item in prop.get("oneOf", [])]
        if choices and value not in choices:
            raise ValueError(f"Invalid form field choice: {key}")
        if kind == "array":
            allowed = prop.get("items", {}).get("enum", [])
            if not allowed or any(item not in allowed for item in value) or len(set(value)) != len(value):
                raise ValueError(f"Invalid form field choices: {key}")
            if len(value) < prop.get("minItems", 0) or len(value) > prop.get("maxItems", MAX_MESSAGE_BYTES):
                raise ValueError(f"Form field choices are outside their bounds: {key}")
        if kind == "string" and (len(value) < prop.get("minLength", 0) or len(value) > prop.get("maxLength", MAX_MESSAGE_BYTES)):
            raise ValueError(f"Form field length is outside its bounds: {key}")
        if kind in {"integer", "number"} and (value < prop.get("minimum", float("-inf")) or value > prop.get("maximum", float("inf"))):
            raise ValueError(f"Form field value is outside its bounds: {key}")
    _bounded(values)
    return values


def _legacy_form_values(schema: dict[str, Any], values: Any) -> dict[str, Any]:
    """Decode the existing rendered form's string wire format, never raw ACP.

    Conversion follows the stored approved schema; it cannot introduce fields,
    relax enum/type constraints or turn an absent boolean into an approval.
    """
    if not isinstance(values, dict):
        raise ValueError("Form input must be an object")
    result = {}
    required = set(schema.get("required", []))
    for name, value in values.items():
        kind = schema.get("properties", {}).get(name, {}).get("type", "string")
        if isinstance(value, str):
            text = value.strip()
            if not text and name in schema.get("properties", {}) and name not in required:
                continue
            if kind == "boolean":
                if text.lower() not in {"yes", "no", "true", "false"}:
                    raise ValueError(f"Invalid form boolean: {name}")
                value = text.lower() in {"yes", "true"}
            elif kind == "integer":
                if not re.fullmatch(r"[+-]?[0-9]+", text):
                    raise ValueError(f"Invalid form integer: {name}")
                value = int(text)
            elif kind == "number":
                if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
                    raise ValueError(f"Invalid form number: {name}")
                value = float(text)
            elif kind == "array":
                value = [item.strip() for item in text.split(",") if item.strip()]
        result[name] = value
    return result


def validate_harness_decision(pending: HarnessPendingInput, decision: dict[str, Any]) -> dict[str, Any]:
    """Validate a durable reply, including the existing CAIPE form resume shape.

    Call this before accepting a decision into canonical storage. The driver
    validates again before replying to the actual ACP request.
    """
    if not isinstance(decision, dict):
        raise ValueError("Harness decision must be an object")
    if pending.method in {"caipe/child_input", "caipe/tool_input"}:
        return _validate_platform_decision(pending, decision)
    if decision.get("type") == "form_input":
        if decision.get("dismissed"):
            decision = {"outcome": {"outcome": "cancelled"}} if pending.method == "session/request_permission" else {"action": "cancel"}
        elif pending.method == "session/request_permission":
            decision = {"outcome": {"outcome": "selected", "optionId": (decision.get("values") or {}).get("option_id")}}
        else:
            values = dict(decision.get("values") or {})
            action = values.pop(_action_field(pending.request["requestedSchema"]), None)
            decision = {"action": action, "content": _legacy_form_values(pending.request["requestedSchema"], values) if action == "accept" else {}}
    if pending.method == "session/request_permission":
        outcome = decision.get("outcome")
        if not isinstance(outcome, dict):
            raise ValueError("Permission response requires an outcome")
        if outcome == {"outcome": "cancelled"}:
            return {"outcome": {"outcome": "cancelled"}}
        options = {option["optionId"] for option in pending.request["options"]}
        if outcome.get("outcome") != "selected" or outcome.get("optionId") not in options:
            raise ValueError("Permission response must select an offered option")
        return {"outcome": {"outcome": "selected", "optionId": outcome["optionId"]}}
    action = decision.get("action")
    if action in {"decline", "cancel"}:
        return {"action": action}
    if action != "accept":
        raise ValueError("Elicitation response requires accept, decline or cancel")
    return {"action": "accept", "content": _validate_form(pending.request["requestedSchema"], decision.get("content"))}


def _validate_platform_decision(pending: HarnessPendingInput, decision: dict[str, Any]) -> dict[str, Any]:
    """Only a human reply bound to the actual stored native interrupt resumes it."""
    event = pending.event
    if decision.get("interrupt_id") != pending.interrupt_id or decision.get("type") != event.interrupt_type:
        raise ValueError("The decision does not match the pending native interrupt")
    base = {"type": event.interrupt_type, "interrupt_id": pending.interrupt_id}
    if event.interrupt_type == "form_input":
        if decision.get("dismissed") is True:
            return {**base, "dismissed": True}
        properties, required = {}, []
        for field in event.fields:
            name, kind = field["field_name"], field.get("field_type", "text")
            if not isinstance(name, str) or not name or name in properties or kind not in {
                "text", "select", "multiselect", "boolean", "number", "url", "email",
            }:
                raise ValueError("The native input field definition is invalid")
            prop: dict[str, Any] = {"type": "array" if kind == "multiselect" else
                "boolean" if kind == "boolean" else "number" if kind == "number" else "string"}
            if kind == "select":
                prop["enum"] = field.get("field_values", [])
            if kind == "multiselect":
                prop["items"] = {"type": "string", "enum": field.get("field_values", [])}
            if kind in {"select", "multiselect"} and (
                not field.get("field_values") or not all(isinstance(value, str) for value in field["field_values"])
            ):
                raise ValueError("The native input choices are invalid")
            properties[name] = prop
            if field.get("required"):
                required.append(name)
        schema = {"properties": properties, "required": required}
        _validate_form(schema, _legacy_form_values(schema, decision.get("values")))
        # Native request_user_input currently consumes string-valued fields.
        # Preserve its existing resume representation after validating it.
        return {**base, "values": decision["values"]}
    if event.interrupt_type != "tool_approval":
        raise ValueError("Unsupported native interrupt type")
    approvals = event.tool_approvals or [{"tool_name": event.tool_name, "allowed_decisions": event.allowed_decisions}]
    decisions = decision.get("decisions")
    if decisions is None and len(approvals) == 1:
        decisions = [decision]
    if not isinstance(decisions, list) or len(decisions) != len(approvals):
        raise ValueError("A decision is required for each pending tool")
    validated = []
    for value, approval in zip(decisions, approvals, strict=True):
        if not isinstance(value, dict) or value.get("decision") not in (approval.get("allowed_decisions") or []):
            raise ValueError("The tool decision is not an offered choice")
        if value.get("tool_name", approval["tool_name"]) != approval["tool_name"]:
            raise ValueError("The decision cannot substitute another tool")
        item = {"decision": value["decision"], "tool_name": approval["tool_name"]}
        if value["decision"] == "edit":
            if not isinstance(value.get("edited_args"), dict):
                raise ValueError("An edited tool decision requires an argument object")
            item["edited_args"] = value["edited_args"]
        validated.append(item)
    result = {**base, "decisions": validated}
    _bounded(result)
    return result


def _form_fields(schema: dict[str, Any]) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = [{
        "field_name": _action_field(schema), "field_label": "Response",
        "field_type": "select", "field_values": ["accept", "decline", "cancel"], "required": True,
    }]
    for name, prop in schema.get("properties", {}).items():
        kind = prop.get("type", "string")
        choices = prop.get("enum") or [item["const"] for item in prop.get("oneOf", [])]
        if kind not in {"string", "boolean", "integer", "number", "array"}:
            raise ValueError("Unsupported elicitation property")
        if kind == "array":
            choices = prop.get("items", {}).get("enum")
            if not choices:
                raise ValueError("Only enumerated string arrays are supported")
            if any(not isinstance(choice, str) or not choice or "," in choice or choice != choice.strip() for choice in choices):
                raise ValueError("These choices require a typed multiselect client")
        field = {
            "field_name": name, "field_label": prop.get("title", name),
            "field_description": prop.get("description", ""),
            "field_type": "multiselect" if kind == "array" else "select" if choices else
            "boolean" if kind == "boolean" else "number" if kind in {"integer", "number"} else "text",
            # Decline/cancel must not require answering the requested questions.
            # Required values are validated server-side only for accept.
            "required": False,
        }
        if choices:
            field["field_values"] = choices
        if "default" in prop:
            default = prop["default"]
            field["default_value"] = ", ".join(default) if kind == "array" else (
                "Yes" if default else "No") if kind == "boolean" else str(default)
        fields.append(field)
    return fields


class _BoundedTransport:
    """Bound SDK notification tasks as well as the consumer's event queue."""

    def __init__(self, owner: HarnessACPDriver, transport: AsyncJSONTransport) -> None:
        self.owner, self.transport = owner, transport
        self.callbacks = asyncio.Semaphore(MAX_PENDING_EVENTS)
        self.elicitations: set[asyncio.Task[None]] = set()

    async def send(self, message: dict[str, Any]) -> None:
        _bounded(message)
        await self.transport.send(message)

    async def receive(self) -> dict[str, Any] | None:
        while (message := await self.transport.receive()) is not None:
            _bounded(message)
            if message.get("method") == "session/update":
                SessionNotification.model_validate(message.get("params"))
            elif message.get("method") == "session/request_permission":
                RequestPermissionRequest.model_validate(message.get("params"))
            if message.get("method") in {"session/request_permission", "elicitation/create"} and "id" not in message:
                raise HarnessACPError("A harness input request must have a JSON-RPC request ID")
            if message.get("method") in {"session/update", "session/request_permission", "elicitation/create"}:
                await self.callbacks.acquire()
            if message.get("method") == "elicitation/create" and "id" in message:
                # SDK 0.12.1 predates stabilization of this now-released v1
                # method. Adapt only form elicitation; keep global unstable
                # protocol support disabled for every other SDK route.
                task = asyncio.create_task(self._form_request(message))
                self.elicitations.add(task)
                task.add_done_callback(self._elicitation_done)
                continue
            return message
        return None

    def _elicitation_done(self, task: asyncio.Task[None]) -> None:
        self.elicitations.discard(task)
        if not task.cancelled() and (error := task.exception()) is not None and not self.owner._failure.done():
            self.owner._failure.set_exception(error)

    async def _form_request(self, message: dict[str, Any]) -> None:
        delegated = False
        try:
            params = dict(message.get("params") or {})
            text = params.pop("message")
            if not isinstance(text, str):
                raise RequestError.invalid_params({"reason": "Elicitation message must be text"})
            delegated = True
            result = await self.owner.create_elicitation(text, params)
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": result}
        except RequestError as exc:
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": exc.to_error_obj()}
        except Exception as exc:
            if not self.owner._failure.done():
                self.owner._failure.set_exception(exc)
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": {
                "code": -32603, "message": "Elicitation could not be completed",
            }}
        finally:
            if not delegated:
                self.callbacks.release()
        await self.send(reply)

    async def close(self) -> None:
        tasks = list(self.elicitations)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.transport.close()


class HarnessACPDriver:
    """One service-owned ACP connection and immutable provider session binding."""

    def __init__(
        self, transport: AsyncJSONTransport, *, agent_name: str, canonical_session_id: str,
        persist_session: Callable[[str], Awaitable[None]],
        persist_input: Callable[[HarnessPendingInput], Awaitable[None]],
        wait_for_decision: Callable[[HarnessPendingInput], Awaitable[dict[str, Any]]],
    ) -> None:
        self.agent_name, self.canonical_session_id = agent_name, canonical_session_id
        self.persist_session, self.persist_input, self.wait_for_decision = persist_session, persist_input, wait_for_decision
        self._transport = _BoundedTransport(self, transport)
        self.connection = connect_to_agent(self, self._transport)
        self.session_id: str | None = None
        self.capabilities: dict[str, Any] = {}
        self._events: asyncio.Queue[StreamEvent] = asyncio.Queue(maxsize=MAX_PENDING_EVENTS)
        self._failure: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._cancelled = asyncio.Event()
        self._input_lock = asyncio.Lock()
        self._stream_lock = asyncio.Lock()
        self._loading = False
        self._ready = False
        self._run_id: str | None = None
        self._input_tasks: set[asyncio.Task[Any]] = set()
        self._tools: dict[str, dict[str, Any]] = {}

    async def open(
        self, cwd: str, mcp_servers: list[Any] | None = None, *, existing_session_id: str | None = None,
        session_meta: dict[str, Any] | None = None,
    ) -> str:
        """Persist new identity before use; never replace a failed loaded session.

        session_meta is server-approved vendor metadata, not user prompt text.
        The same metadata/policy is supplied on new and load.
        """
        if self.session_id is not None:
            raise HarnessACPError("Harness ACP session is already open")
        initialized = await self.connection.initialize(PROTOCOL_VERSION, client_capabilities=ClientCapabilities(
            terminal=False, elicitation=ElicitationCapabilities(form=ElicitationFormCapabilities()),
        ))
        if initialized.protocol_version != PROTOCOL_VERSION:
            raise HarnessACPError("Harness ACP protocol version is unsupported")
        self.capabilities = _json(initialized.agent_capabilities)
        transports = self.capabilities.get("mcpCapabilities", {})
        for server in mcp_servers or []:
            server = _json(server)
            if not isinstance(server, dict):
                raise HarnessACPError("The platform MCP server declaration is invalid")
            transport = server.get("type")
            if transport in {"http", "sse"} and transports.get(transport) is not True:
                raise HarnessACPError(f"The harness has not negotiated platform MCP {transport} support")
            if transport not in {None, "http", "sse"} or (transport is None and "command" not in server):
                raise HarnessACPError("The platform MCP transport is unsupported")
        if existing_session_id:
            if not self.capabilities.get("loadSession"):
                raise HarnessACPError("The bound harness cannot load its saved session")
            self.session_id, self._loading = existing_session_id, True
            try:
                await self.connection.load_session(cwd=cwd, session_id=existing_session_id,
                                                   mcp_servers=mcp_servers or [], **(session_meta or {}))
            finally:
                self._loading = False
        else:
            created = await self.connection.new_session(cwd=cwd, mcp_servers=mcp_servers or [], **(session_meta or {}))
            self.session_id = created.session_id
            if not self.session_id:
                raise HarnessACPError("Harness ACP returned an empty session ID")
            await self.persist_session(self.session_id)
        self._ready = True
        return self.session_id

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        del kwargs
        try:
            self._check_session(session_id)
            if self._loading:
                return  # Provider transcript replay is not a new canonical turn.
            for event in self._project(_json(update)):
                await self._events.put(event)
        except Exception as exc:
            if not self._failure.done():
                self._failure.set_exception(exc)
            raise
        finally:
            self._transport.callbacks.release()

    def _check_session(self, session_id: str) -> None:
        if self.session_id is None or session_id != self.session_id:
            raise HarnessACPError("Harness event does not belong to the bound session")

    def _project(self, update: dict[str, Any]) -> list[StreamEvent]:
        kind = update.get("sessionUpdate")
        if kind in {"agent_message_chunk", "agent_thought_chunk"}:
            content = update.get("content", {})
            if content.get("type") != "text":
                return [WarningEvent(message="The harness returned an unsupported message content type")]
            return [ReasoningDelta(text=content["text"])] if kind == "agent_thought_chunk" else [TextDelta(text=content["text"])]
        if kind in {"tool_call", "tool_call_update"}:
            key = update["toolCallId"]
            first = key not in self._tools
            if first and len(self._tools) >= MAX_TOOL_CALLS:
                raise HarnessACPError("Harness ACP tool-call limit exceeded")
            tool = self._tools.setdefault(key, {})
            tool.update({key: value for key, value in update.items() if value is not None})
            events: list[StreamEvent] = []
            if first:
                events.extend([UpdatesBoundary(), ToolStarted(
                    tool_call_id=key, tool_name=tool.get("name") or tool.get("title") or key, args=tool.get("rawInput", {}),
                )])
            output = tool.get("rawOutput", tool.get("content", ""))
            text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
            if tool.get("status") in {"completed", "failed"}:
                events.append(ToolCompleted(tool_call_id=key, message_id=None, content=text,
                                            error="Harness tool failed" if tool["status"] == "failed" else None))
            elif "rawOutput" in update or "content" in update:
                events.append(ToolOutput(tool_call_id=key, result=text))
            return events
        if kind == "usage_update":
            return [ContextUsage(value=update)]
        if kind in {"plan", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "user_message_chunk"}:
            return []
        return [WarningEvent(message=f"Unsupported harness update: {kind}")]

    async def request_permission(self, session_id: str, tool_call: Any, options: list[Any], **kwargs: Any) -> dict[str, Any]:
        del kwargs
        try:
            self._check_session(session_id)
            call, choices = _json(tool_call), [_json(option) for option in options]
            if not choices or len({option["optionId"] for option in choices}) != len(choices):
                raise RequestError.invalid_params({"reason": "Permission options must be nonempty and unique"})
            event = InputRequired(
                interrupt_id=str(uuid4()), interrupt_type="form_input", agent=self.agent_name,
                prompt=call.get("title") or "The agent requests permission for a tool operation.",
                fields=[{"field_name": "option_id", "field_label": "Permission decision", "field_type": "select",
                         "field_values": [option["optionId"] for option in choices], "required": True,
                         "field_description": "; ".join(f"{option['optionId']}: {option['name']}" for option in choices)}],
            )
            return await self._input(HarnessPendingInput(interrupt_id=event.interrupt_id, session_id=session_id,
                method="session/request_permission", request={"toolCall": call, "options": choices}, event=event))
        except Exception as exc:
            if not self._failure.done():
                self._failure.set_exception(exc)
            raise
        finally:
            self._transport.callbacks.release()

    async def create_elicitation(self, message: str, mode: Any, **kwargs: Any) -> dict[str, Any]:
        del kwargs
        try:
            request = _json(mode)
            if request.get("mode") != "form" or not request.get("sessionId"):
                raise RequestError.invalid_params({"reason": "Only session-scoped form elicitation is supported"})
            self._check_session(request["sessionId"])
            try:
                fields = _form_fields(request["requestedSchema"])
            except (ValueError, KeyError) as exc:
                raise RequestError.invalid_params({"reason": "Unsupported elicitation form schema"}) from exc
            event = InputRequired(interrupt_id=str(uuid4()), interrupt_type="form_input", prompt=message,
                                  fields=fields, agent=self.agent_name)
            return await self._input(HarnessPendingInput(interrupt_id=event.interrupt_id, session_id=request["sessionId"],
                method="elicitation/create", request=request, event=event))
        except Exception as exc:
            if not self._failure.done():
                self._failure.set_exception(exc)
            raise
        finally:
            self._transport.callbacks.release()

    async def _input(self, pending: HarnessPendingInput) -> dict[str, Any]:
        task = asyncio.current_task()
        if task is not None:
            self._input_tasks.add(task)
        try:
            return await self._wait_input(pending)
        finally:
            if task is not None:
                self._input_tasks.discard(task)

    async def request_platform_input(self, pending: HarnessPendingInput) -> dict[str, Any]:
        """Forward a server-owned tool/child interrupt through canonical input.

        This method is deliberately unavailable as an MCP tool. The executing
        broker supplies the actual interrupt and resumes only with a stored,
        validated human decision, never with agent-authored approval arguments.
        """
        if pending.method not in {"caipe/child_input", "caipe/tool_input"}:
            raise HarnessACPError("Only platform-owned input can use this entry point")
        self._check_session(pending.session_id)
        return await self._input(pending)

    def fail(self) -> None:
        """Stop the prompt if its admitted platform resource worker fails."""
        if not self._failure.done():
            self._failure.set_exception(HarnessACPError("The admitted CAIPE resource worker failed"))

    def _cancel_input(self, pending: HarnessPendingInput) -> dict[str, Any]:
        if pending.method in {"caipe/child_input", "caipe/tool_input"}:
            raise asyncio.CancelledError
        return {"outcome": {"outcome": "cancelled"}} if pending.method == "session/request_permission" else {"action": "cancel"}

    async def _wait_input(self, pending: HarnessPendingInput) -> dict[str, Any]:
        async with self._input_lock:
            if self._cancelled.is_set():
                return self._cancel_input(pending)
            _bounded(pending.model_dump(mode="json"))
            await self.persist_input(pending)
            await self._events.put(pending.event)
            decision = asyncio.create_task(self.wait_for_decision(pending))
            cancelled = asyncio.create_task(self._cancelled.wait())
            try:
                done, _ = await asyncio.wait({decision, cancelled}, return_when=asyncio.FIRST_COMPLETED)
                if cancelled in done:
                    return self._cancel_input(pending)
                result = validate_harness_decision(pending, decision.result())
                if self._run_id is not None:
                    await self._events.put(RunStarted(run_id=self._run_id, thread_id=self.canonical_session_id))
                return result
            finally:
                for task in (decision, cancelled):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(decision, cancelled, return_exceptions=True)

    async def stream(
        self, message: str, encoder: StreamEncoder[str], *, run_id: str, files: list[InputFile] | None = None,
    ) -> AsyncGenerator[str, None]:
        """Continue until an actual ACP outcome; pending input keeps this task alive."""
        if not self._ready or self.session_id is None or self._stream_lock.locked():
            raise HarnessACPError("Harness ACP session is unavailable or already running")
        async with self._stream_lock:
            self._cancelled.clear()
            self._tools.clear()
            self._run_id = run_id
            blocks: list[Any] = [TextContentBlock(type="text", text=message)]
            capabilities = self.capabilities.get("promptCapabilities", {})
            for index, file in enumerate(files or []):
                if not file.data:
                    blocks.append(ResourceContentBlock(type="resource_link", uri=file.uri, name=file.name or f"attachment-{index}"))
                elif file.mime_type.startswith("image/") and capabilities.get("image"):
                    blocks.append(ImageContentBlock(type="image", data=file.data, mime_type=file.mime_type))
                elif capabilities.get("embeddedContext"):
                    blocks.append(EmbeddedResourceContentBlock(type="resource", resource=BlobResourceContents(
                        blob=file.data, mime_type=file.mime_type, uri=file.uri or f"attachment://{index}")))
                else:
                    raise HarnessACPError("Harness does not support this attachment type")
            for frame in encoder.encode_event(RunStarted(run_id=run_id, thread_id=self.canonical_session_id)):
                yield frame
            prompt = asyncio.create_task(self.connection.prompt(self.session_id, blocks))
            try:
                while True:
                    if self._failure.done():
                        self._failure.result()
                    if prompt.done() and self._events.empty():
                        break
                    queued = asyncio.create_task(self._events.get())
                    try:
                        done, _ = await asyncio.wait({queued, prompt, self._failure}, return_when=asyncio.FIRST_COMPLETED)
                        if queued in done:
                            for frame in encoder.encode_event(queued.result()):
                                yield frame
                    finally:
                        if not queued.done():
                            queued.cancel()
                        await asyncio.gather(queued, return_exceptions=True)
                response = await prompt
                if self._cancelled.is_set() or response.stop_reason == "cancelled":
                    raise asyncio.CancelledError
                if response.stop_reason != "end_turn":
                    raise HarnessACPError("Harness stopped before completing the requested turn")
                if self._input_tasks:
                    raise HarnessACPError("Harness stopped while a platform input request was still pending")
                for event in (StreamEnded(), RunFinished(run_id=run_id, thread_id=self.canonical_session_id)):
                    for frame in encoder.encode_event(event):
                        yield frame
            except asyncio.CancelledError:
                await self.cancel()
                raise
            except Exception as exc:
                for frame in encoder.encode_event(RunError(message="The harness connection failed; the turn was not completed.", code="harness_execution_failed")):
                    yield frame
                raise HarnessACPError("Harness ACP execution failed") from exc
            finally:
                if not prompt.done():
                    await self.cancel()
                    prompt.cancel()
                await asyncio.gather(prompt, return_exceptions=True)

    async def cancel(self) -> None:
        self._cancelled.set()
        pending = [task for task in self._input_tasks if task is not asyncio.current_task()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if self.session_id is not None:
            with suppress(ConnectionError):
                await self.connection.cancel(self.session_id)

    async def close(self) -> None:
        self._ready = False
        await self.cancel()
        await self.connection.close()
        if self._failure.done():
            with suppress(Exception):
                self._failure.result()
