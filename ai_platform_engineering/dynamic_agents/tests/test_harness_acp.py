"""An injected JSON-RPC peer exercises the real ACP client connection."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

import pytest

from dynamic_agents.services import harness_acp
from dynamic_agents.services.harness_acp import (
    HarnessACPDriver,
    HarnessACPError,
    HarnessPendingInput,
    validate_harness_decision,
)
from dynamic_agents.services.stream_encoders import get_encoder
from dynamic_agents.services.stream_encoders.events import InputRequired, ReasoningDelta, TextDelta, ToolStarted


def test_native_child_form_reply_matches_actual_choices_and_interrupt() -> None:
    pending = HarnessPendingInput(interrupt_id="native-request", session_id="provider-session", method="caipe/child_input",
        request={"agent_id": "child"}, event=InputRequired(interrupt_id="native-request", interrupt_type="form_input", agent="Child",
            prompt="Select scope", fields=[{"field_name": "scope", "field_type": "select", "field_values": ["primary"], "required": True}]))
    valid = {"type": "form_input", "interrupt_id": "native-request", "values": {"scope": "primary"}}
    assert validate_harness_decision(pending, valid) == valid
    for invalid in ({**valid, "interrupt_id": "another-request"}, {**valid, "values": {"scope": "invented"}},
                    {**valid, "values": {}}, {"action": "accept", "content": {"scope": "primary"}}):
        with pytest.raises(ValueError):
            validate_harness_decision(pending, invalid)


def test_native_child_tool_batch_never_approves_omitted_or_replaced_tools() -> None:
    approvals = [{"tool_name": name, "allowed_decisions": ["approve", "reject"]} for name in ("write", "read")]
    pending = HarnessPendingInput(interrupt_id="native-tools", session_id="provider-session", method="caipe/child_input",
        request={}, event=InputRequired(interrupt_id="native-tools", interrupt_type="tool_approval", agent="Child",
            prompt="Review tools", fields=[], tool_approvals=approvals))
    valid = {"type": "tool_approval", "interrupt_id": "native-tools", "decisions": [
        {"decision": "reject", "tool_name": "write"}, {"decision": "approve", "tool_name": "read"},
    ]}
    assert validate_harness_decision(pending, valid) == valid
    for invalid in ({"type": "tool_approval", "interrupt_id": "native-tools", "decision": "approve"},
                    {**valid, "decisions": valid["decisions"][:1]},
                    {**valid, "decisions": [{"decision": "edit", "edited_args": {}}, valid["decisions"][1]]},
                    {**valid, "decisions": [{"decision": "approve", "tool_name": "other"}, valid["decisions"][1]]}):
        with pytest.raises(ValueError):
            validate_harness_decision(pending, invalid)


def test_rendered_legacy_elicitation_values_follow_stored_schema_and_raw_acp_stays_strict() -> None:
    schema = {"type": "object", "properties": {
        "enabled": {"type": "boolean", "default": False},
        "replicas": {"type": "integer", "minimum": 1, "default": 2},
        "threshold": {"type": "number", "minimum": 0, "default": 0.5},
        "scopes": {"type": "array", "items": {"type": "string", "enum": ["primary", "secondary"]}, "default": ["primary"]},
        "optional_number": {"type": "number"}, "optional_text": {"type": "string", "minLength": 1},
    }, "required": ["enabled", "replicas", "threshold", "scopes"]}
    fields = harness_acp._form_fields(schema)
    defaults = {field["field_name"]: field["default_value"] for field in fields if "default_value" in field}
    assert defaults == {"enabled": "No", "replicas": "2", "threshold": "0.5", "scopes": "primary"}
    assert all(isinstance(value, str) for value in defaults.values())
    pending = HarnessPendingInput(interrupt_id="form", session_id="provider-session", method="elicitation/create",
        request={"requestedSchema": schema}, event=InputRequired(interrupt_id="form", interrupt_type="form_input", agent="Example",
            prompt="Configure scope", fields=fields))
    values = {"__acp_action": "accept", "enabled": "Yes", "replicas": "3", "threshold": ".75",
        "scopes": "primary, secondary", "optional_number": "", "optional_text": ""}
    result = validate_harness_decision(pending, {"type": "form_input", "values": values})
    assert result == {"action": "accept", "content": {
        "enabled": True, "replicas": 3, "threshold": 0.75, "scopes": ["primary", "secondary"],
    }}
    assert validate_harness_decision(pending, result) == result
    false_values = {**values, "enabled": "No"}
    assert validate_harness_decision(pending, {"type": "form_input", "values": false_values})["content"]["enabled"] is False
    with pytest.raises(ValueError, match="field type"):
        validate_harness_decision(pending, {"action": "accept", "content": {key: value for key, value in values.items() if key != "__acp_action"}})
    with pytest.raises(ValueError, match="unknown"):
        validate_harness_decision(pending, {"type": "form_input", "values": {**values, "unapproved": ""}})
    assert validate_harness_decision(pending, {"type": "form_input", "values": {"__acp_action": "decline", "replicas": "invalid"}}) == {"action": "decline"}
    with pytest.raises(ValueError, match="typed multiselect"):
        harness_acp._form_fields({"properties": {"scope": {"type": "array", "items": {"enum": ["primary, secondary", "primary", "secondary"]}}}})


def test_native_child_form_keeps_string_resume_values_after_typed_validation() -> None:
    pending = HarnessPendingInput(interrupt_id="native-request", session_id="provider-session", method="caipe/child_input",
        request={}, event=InputRequired(interrupt_id="native-request", interrupt_type="form_input", agent="Child", prompt="Choose", fields=[
            {"field_name": "enabled", "field_type": "boolean", "required": True},
            {"field_name": "replicas", "field_type": "number", "required": True},
            {"field_name": "scopes", "field_type": "multiselect", "field_values": ["primary", "secondary"]},
        ]))
    decision = {"type": "form_input", "interrupt_id": "native-request", "values": {
        "enabled": "Yes", "replicas": "2", "scopes": "primary, secondary",
    }}
    assert validate_harness_decision(pending, decision) == decision


class HarnessPeer:
    def __init__(self, *, interaction: str | None = None, load_error: bool = False, oversized: bool = False, mcp_http: bool = True) -> None:
        self.inbox: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self.sent: list[dict[str, Any]] = []
        self.interaction, self.load_error, self.oversized = interaction, load_error, oversized
        self.mcp_http = mcp_http
        self.responses: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.task: asyncio.Task[None] | None = None
        self.closed = False

    async def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)
        method = message.get("method")
        if method is None:
            await self.responses.put(message)
        elif method == "initialize":
            await self.inbox.put({"jsonrpc": "2.0", "id": message["id"], "result": {
                "protocolVersion": 1, "agentCapabilities": {"loadSession": True,
                    "mcpCapabilities": {"http": self.mcp_http},
                    "promptCapabilities": {"image": True, "embeddedContext": True}}, "authMethods": [],
            }})
        elif method in {"session/new", "session/load"}:
            result = {"error": {"code": -32602, "message": "Saved session unavailable"}} if self.load_error else {
                "result": {"sessionId": "provider-session"} if method == "session/new" else {}}
            await self.inbox.put({"jsonrpc": "2.0", "id": message["id"], **result})
        elif method == "session/prompt":
            self.task = asyncio.create_task(self._prompt(message["id"]))
        elif method == "session/cancel" and self.task is not None:
            self.task.cancel()

    async def _update(self, update: dict[str, Any]) -> None:
        await self.inbox.put({"jsonrpc": "2.0", "method": "session/update",
                              "params": {"sessionId": "provider-session", "update": update}})

    async def _prompt(self, request_id: int) -> None:
        try:
            await self._update({"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "Search",
                                "status": "in_progress", "rawInput": {"query": "example"}})
            if self.interaction:
                params = {"sessionId": "provider-session"}
                if self.interaction == "permission":
                    method = "session/request_permission"
                    params.update(toolCall={"toolCallId": "call-1", "title": "Search remote source"}, options=[
                        {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                        {"optionId": "reject-once", "name": "Reject once", "kind": "reject_once"},
                    ])
                else:
                    method = "elicitation/create"
                    params.update(mode="form", message="Select a scope", requestedSchema={
                        "type": "object", "properties": {"scope": {"type": "string", "enum": ["primary", "secondary"]}},
                        "required": ["scope"],
                    })
                await self.inbox.put({"jsonrpc": "2.0", "id": "permission-1", "method": method, "params": params})
                await self.responses.get()
            await self._update({"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed", "rawOutput": "Found"})
            await self._update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text",
                "text": "x" * (harness_acp.MAX_MESSAGE_BYTES + 1) if self.oversized else "Result"}})
            await self.inbox.put({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})
        except asyncio.CancelledError:
            await self.inbox.put({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "cancelled"}})

    async def receive(self) -> dict[str, Any] | None:
        return await self.inbox.get()

    async def close(self) -> None:
        self.closed = True
        if self.task is not None and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await self.inbox.put(None)


def driver_for(peer: HarnessPeer) -> tuple[HarnessACPDriver, list[str], list[HarnessPendingInput], asyncio.Queue[dict[str, Any]]]:
    saved: list[str] = []
    pending: list[HarnessPendingInput] = []
    decisions: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def persist_session(session_id: str) -> None:
        saved.append(session_id)

    async def persist_input(value: HarnessPendingInput) -> None:
        pending.append(value)

    async def wait_for_decision(value: HarnessPendingInput) -> dict[str, Any]:
        assert pending[-1] == value
        return await decisions.get()

    return HarnessACPDriver(peer, agent_name="Example agent", canonical_session_id="example-conversation",
        persist_session=persist_session, persist_input=persist_input, wait_for_decision=wait_for_decision), saved, pending, decisions


@pytest.mark.parametrize("protocol", ["custom", "agui"])
async def test_standard_progress_uses_existing_encoders_and_persists_provider_binding(protocol: str) -> None:
    peer = HarnessPeer()
    driver, saved, _, _ = driver_for(peer)
    try:
        await driver.open("/workspace", session_meta={"example": {"systemPrompt": "Approved instructions"}})
        assert saved == ["provider-session"]
        encoder = get_encoder(protocol)
        frames = [frame async for frame in driver.stream("hello", encoder, run_id="example-run")]
        assert encoder.get_accumulated_content() == "Result"
        assert encoder.get_outcome() == "completed"
        assert any("Search" in frame for frame in frames)
        methods = [message.get("method") for message in peer.sent]
        assert methods[:3] == ["initialize", "session/new", "session/prompt"]
        assert not any(method and method.startswith("_caipe") for method in methods)
        assert peer.sent[1]["params"]["_meta"] == {"example": {"systemPrompt": "Approved instructions"}}
        assert peer.sent[2]["params"]["sessionId"] == "provider-session"
        assert not peer.sent[0]["params"]["clientCapabilities"].get("terminal", False)
    finally:
        await driver.close()


async def test_failed_load_never_creates_a_replacement_provider_session() -> None:
    peer = HarnessPeer(load_error=True)
    driver, saved, _, _ = driver_for(peer)
    try:
        with pytest.raises(Exception, match="Saved session unavailable"):
            await driver.open("/workspace", existing_session_id="provider-session")
        assert saved == []
        assert not any(message.get("method") == "session/new" for message in peer.sent)
    finally:
        await driver.close()


@pytest.mark.parametrize("existing_session_id", [None, "provider-session"])
async def test_platform_http_mcp_must_be_negotiated_before_new_or_load(existing_session_id) -> None:
    peer = HarnessPeer(mcp_http=False)
    driver, saved, _, _ = driver_for(peer)
    try:
        with pytest.raises(HarnessACPError, match="negotiated.*MCP http"):
            await driver.open("/workspace", [{"type": "http", "name": "caipe", "url": "https://caipe.example.test/mcp", "headers": []}],
                existing_session_id=existing_session_id)
        assert saved == []
        assert [message.get("method") for message in peer.sent] == ["initialize"]
    finally:
        await driver.close()


@pytest.mark.parametrize("interaction", ["permission", "form"])
async def test_pending_input_waits_for_an_actual_durable_decision_and_keeps_one_prompt(interaction: str) -> None:
    peer = HarnessPeer(interaction=interaction)
    driver, _, pending, decisions = driver_for(peer)
    encoder = get_encoder("custom")
    frames: list[str] = []
    resumed_outcomes: list[str | None] = []

    async def consume() -> None:
        async for frame in driver.stream("hello", encoder, run_id="example-run"):
            frames.append(frame)
            if "input_required" in frame:
                assert pending  # Canonical pending persistence precedes publication.
            if "Result" in frame:
                resumed_outcomes.append(encoder.get_outcome())

    task: asyncio.Task[None] | None = None
    try:
        await driver.open("/workspace")
        task = asyncio.create_task(consume())
        async with asyncio.timeout(2):
            while not any("input_required" in frame for frame in frames):
                await asyncio.sleep(0.01)
        assert not task.done()
        assert encoder.get_outcome() == "awaiting_input"
        assert not any("result" in message and message.get("id") == "permission-1" for message in peer.sent)
        values = {"option_id": "allow-once"} if interaction == "permission" else {"__acp_action": "accept", "scope": "primary"}
        await decisions.put({"type": "form_input", "values": values})
        await asyncio.wait_for(task, 2)
        reply = next(message["result"] for message in peer.sent if message.get("id") == "permission-1")
        assert reply == ({"outcome": {"outcome": "selected", "optionId": "allow-once"}} if interaction == "permission"
                         else {"action": "accept", "content": {"scope": "primary"}})
        assert encoder.get_outcome() == "completed"
        assert len([message for message in peer.sent if message.get("method") == "session/prompt"]) == 1
        assert resumed_outcomes == [None]  # Input pause no longer controls resumed progress.
    finally:
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await driver.close()


async def test_oversized_output_fails_instead_of_reporting_partial_completion() -> None:
    driver, _, _, _ = driver_for(HarnessPeer(oversized=True))
    try:
        await driver.open("/workspace")
        encoder = get_encoder("custom")
        with pytest.raises(HarnessACPError):
            async with asyncio.timeout(2):
                async for _frame in driver.stream("hello", encoder, run_id="example-run"):
                    pass
        assert encoder.get_outcome() == "failed"
    finally:
        await driver.close()


async def test_permission_decisions_are_exact_offered_choices_and_dismiss_is_cancel() -> None:
    peer = HarnessPeer(interaction="permission")
    driver, _, pending, decisions = driver_for(peer)
    task: asyncio.Task[list[str]] | None = None
    try:
        await driver.open("/workspace")

        async def consume() -> list[str]:
            return [frame async for frame in driver.stream("hello", get_encoder("custom"), run_id="example-run")]

        task = asyncio.create_task(consume())
        async with asyncio.timeout(2):
            while not pending:
                await asyncio.sleep(0.01)
        with pytest.raises(ValueError, match="offered option"):
            validate_harness_decision(pending[0], {"outcome": {"outcome": "selected", "optionId": "invented"}})
        assert validate_harness_decision(pending[0], {"type": "form_input", "dismissed": True}) == {"outcome": {"outcome": "cancelled"}}
        await decisions.put({"type": "form_input", "values": {"option_id": "reject-once"}})
        await asyncio.wait_for(task, 2)
    finally:
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await driver.close()


async def test_cancel_answers_a_pending_permission_as_cancelled_without_approval() -> None:
    peer = HarnessPeer(interaction="permission")
    driver, _, pending, _ = driver_for(peer)

    async def consume() -> None:
        async for _frame in driver.stream("hello", get_encoder("custom"), run_id="example-run"):
            pass

    task: asyncio.Task[None] | None = None
    try:
        await driver.open("/workspace")
        task = asyncio.create_task(consume())
        async with asyncio.timeout(2):
            while not pending:
                await asyncio.sleep(0.01)
        await driver.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        reply = next(message["result"] for message in peer.sent if message.get("id") == "permission-1")
        assert reply == {"outcome": {"outcome": "cancelled"}}
    finally:
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await driver.close()


async def test_pending_persistence_failure_never_exposes_an_actionable_form() -> None:
    peer = HarnessPeer(interaction="permission")
    driver, _, _, _ = driver_for(peer)

    async def unavailable(_pending: HarnessPendingInput) -> None:
        raise RuntimeError("Canonical storage unavailable")

    driver.persist_input = unavailable
    encoder = get_encoder("custom")
    frames: list[str] = []
    try:
        await driver.open("/workspace")
        with pytest.raises(HarnessACPError):
            async with asyncio.timeout(2):
                async for frame in driver.stream("hello", encoder, run_id="example-run"):
                    frames.append(frame)
        assert not any("input_required" in frame for frame in frames)
        assert encoder.get_outcome() == "failed"
    finally:
        await driver.close()


async def test_form_decisions_validate_required_fields_types_and_enums() -> None:
    peer = HarnessPeer(interaction="form")
    driver, _, pending, decisions = driver_for(peer)
    task: asyncio.Task[None] | None = None

    async def consume() -> None:
        async for _frame in driver.stream("hello", get_encoder("custom"), run_id="example-run"):
            pass

    try:
        await driver.open("/workspace")
        task = asyncio.create_task(consume())
        async with asyncio.timeout(2):
            while not pending:
                await asyncio.sleep(0.01)
        for content in [{}, {"scope": 1}, {"scope": "unoffered"}, {"scope": "primary", "extra": "unexpected"}]:
            with pytest.raises(ValueError):
                validate_harness_decision(pending[0], {"action": "accept", "content": content})
        assert validate_harness_decision(pending[0], {"action": "decline"}) == {"action": "decline"}
        await decisions.put({"action": "cancel"})
        await asyncio.wait_for(task, 2)
    finally:
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await driver.close()


@pytest.mark.parametrize("protocol", ["custom", "agui"])
def test_reasoning_is_rendered_and_retained_without_entering_the_final_answer(protocol: str) -> None:
    encoder = get_encoder(protocol)
    frames = encoder.encode_event(ReasoningDelta(text="Published summary. "))
    encoder.encode_event(TextDelta(text="Before tool. "))
    encoder.encode_event(ToolStarted(tool_call_id="example-call", tool_name="search", args={}))
    encoder.encode_event(ReasoningDelta(text="Later summary. "))
    encoder.encode_event(TextDelta(text="Final answer."))
    assert any("Published summary." in frame for frame in frames)
    assert encoder.get_accumulated_content() == "Final answer."
    assert encoder.get_thinking_content() == "Published summary. Before tool. Later summary. "
