"""An injected JSON-RPC peer exercises the real ACP client connection."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from harness_engine.coding import acp_client as harness_acp
from harness_engine.coding.acp_client import (
    HarnessACPDriver,
    HarnessACPError,
    HarnessPendingInput,
    InputRequired,
    validate_harness_decision,
)
from harness_engine.models import ProviderTurnOutcome


def test_native_child_form_reply_matches_actual_choices_and_interrupt() -> None:
    pending = HarnessPendingInput(
        interrupt_id="native-request",
        session_id="provider-session",
        method="caipe/child_input",
        request={"agent_id": "child"},
        event=InputRequired(
            interrupt_id="native-request",
            interrupt_type="form_input",
            agent="Child",
            prompt="Select scope",
            fields=[{"field_name": "scope", "field_type": "select", "field_values": ["primary"], "required": True}],
        ),
    )
    valid = {"type": "form_input", "interrupt_id": "native-request", "values": {"scope": "primary"}}
    assert validate_harness_decision(pending, valid) == valid
    for invalid in (
        {**valid, "interrupt_id": "another-request"},
        {**valid, "values": {"scope": "invented"}},
        {**valid, "values": {}},
        {"action": "accept", "content": {"scope": "primary"}},
    ):
        with pytest.raises(ValueError):
            validate_harness_decision(pending, invalid)


def test_native_child_tool_batch_never_approves_omitted_or_replaced_tools() -> None:
    approvals = [{"tool_name": name, "allowed_decisions": ["approve", "reject"]} for name in ("write", "read")]
    pending = HarnessPendingInput(
        interrupt_id="native-tools",
        session_id="provider-session",
        method="caipe/child_input",
        request={},
        event=InputRequired(
            interrupt_id="native-tools",
            interrupt_type="tool_approval",
            agent="Child",
            prompt="Review tools",
            fields=[],
            tool_approvals=approvals,
        ),
    )
    valid = {
        "type": "tool_approval",
        "interrupt_id": "native-tools",
        "decisions": [
            {"decision": "reject", "tool_name": "write"},
            {"decision": "approve", "tool_name": "read"},
        ],
    }
    assert validate_harness_decision(pending, valid) == valid
    for invalid in (
        {"type": "tool_approval", "interrupt_id": "native-tools", "decision": "approve"},
        {**valid, "decisions": valid["decisions"][:1]},
        {**valid, "decisions": [{"decision": "edit", "edited_args": {}}, valid["decisions"][1]]},
        {**valid, "decisions": [{"decision": "approve", "tool_name": "other"}, valid["decisions"][1]]},
    ):
        with pytest.raises(ValueError):
            validate_harness_decision(pending, invalid)


def test_rendered_legacy_elicitation_values_follow_stored_schema_and_raw_acp_stays_strict() -> None:
    schema = {
        "type": "object",
        "properties": {
            "enabled": {"type": "boolean", "default": False},
            "replicas": {"type": "integer", "minimum": 1, "default": 2},
            "threshold": {"type": "number", "minimum": 0, "default": 0.5},
            "scopes": {
                "type": "array",
                "items": {"type": "string", "enum": ["primary", "secondary"]},
                "default": ["primary"],
            },
            "optional_number": {"type": "number"},
            "optional_text": {"type": "string", "minLength": 1},
        },
        "required": ["enabled", "replicas", "threshold", "scopes"],
    }
    fields = harness_acp._form_fields(schema)
    defaults = {field["field_name"]: field["default_value"] for field in fields if "default_value" in field}
    assert defaults == {"enabled": "No", "replicas": "2", "threshold": "0.5", "scopes": "primary"}
    assert all(isinstance(value, str) for value in defaults.values())
    pending = HarnessPendingInput(
        interrupt_id="form",
        session_id="provider-session",
        method="elicitation/create",
        request={"requestedSchema": schema},
        event=InputRequired(
            interrupt_id="form", interrupt_type="form_input", agent="Example", prompt="Configure scope", fields=fields
        ),
    )
    values = {
        "__acp_action": "accept",
        "enabled": "Yes",
        "replicas": "3",
        "threshold": ".75",
        "scopes": "primary, secondary",
        "optional_number": "",
        "optional_text": "",
    }
    result = validate_harness_decision(pending, {"type": "form_input", "values": values})
    assert result == {
        "action": "accept",
        "content": {
            "enabled": True,
            "replicas": 3,
            "threshold": 0.75,
            "scopes": ["primary", "secondary"],
        },
    }
    assert validate_harness_decision(pending, result) == result
    false_values = {**values, "enabled": "No"}
    assert (
        validate_harness_decision(pending, {"type": "form_input", "values": false_values})["content"]["enabled"]
        is False
    )
    with pytest.raises(ValueError, match="field type"):
        validate_harness_decision(
            pending,
            {"action": "accept", "content": {key: value for key, value in values.items() if key != "__acp_action"}},
        )
    with pytest.raises(ValueError, match="unknown"):
        validate_harness_decision(pending, {"type": "form_input", "values": {**values, "unapproved": ""}})
    assert validate_harness_decision(
        pending, {"type": "form_input", "values": {"__acp_action": "decline", "replicas": "invalid"}}
    ) == {"action": "decline"}
    with pytest.raises(ValueError, match="typed multiselect"):
        harness_acp._form_fields(
            {
                "properties": {
                    "scope": {"type": "array", "items": {"enum": ["primary, secondary", "primary", "secondary"]}}
                }
            }
        )


def test_native_child_form_keeps_string_resume_values_after_typed_validation() -> None:
    pending = HarnessPendingInput(
        interrupt_id="native-request",
        session_id="provider-session",
        method="caipe/child_input",
        request={},
        event=InputRequired(
            interrupt_id="native-request",
            interrupt_type="form_input",
            agent="Child",
            prompt="Choose",
            fields=[
                {"field_name": "enabled", "field_type": "boolean", "required": True},
                {"field_name": "replicas", "field_type": "number", "required": True},
                {"field_name": "scopes", "field_type": "multiselect", "field_values": ["primary", "secondary"]},
            ],
        ),
    )
    decision = {
        "type": "form_input",
        "interrupt_id": "native-request",
        "values": {
            "enabled": "Yes",
            "replicas": "2",
            "scopes": "primary, secondary",
        },
    }
    assert validate_harness_decision(pending, decision) == decision


class HarnessPeer:
    def __init__(
        self,
        *,
        interaction: str | None = None,
        load_error: bool = False,
        oversized: bool = False,
        mcp_http: bool = True,
    ) -> None:
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
            await self.inbox.put(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": True,
                            "mcpCapabilities": {"http": self.mcp_http},
                            "promptCapabilities": {"image": True, "embeddedContext": True},
                        },
                        "authMethods": [],
                    },
                }
            )
        elif method in {"session/new", "session/load"}:
            result = (
                {"error": {"code": -32602, "message": "Saved session unavailable"}}
                if self.load_error
                else {"result": {"sessionId": "provider-session"} if method == "session/new" else {}}
            )
            await self.inbox.put({"jsonrpc": "2.0", "id": message["id"], **result})
        elif method == "session/prompt":
            self.task = asyncio.create_task(self._prompt(message["id"]))
        elif method == "session/cancel" and self.task is not None:
            self.task.cancel()

    async def _update(self, update: dict[str, Any]) -> None:
        await self.inbox.put(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"sessionId": "provider-session", "update": update},
            }
        )

    async def _prompt(self, request_id: int) -> None:
        try:
            await self._update(
                {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-1",
                    "title": "Search",
                    "status": "in_progress",
                    "rawInput": {"query": "example"},
                }
            )
            if self.interaction:
                params = {"sessionId": "provider-session"}
                if self.interaction == "permission":
                    method = "session/request_permission"
                    params.update(
                        toolCall={"toolCallId": "call-1", "title": "Search remote source"},
                        options=[
                            {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                            {"optionId": "reject-once", "name": "Reject once", "kind": "reject_once"},
                        ],
                    )
                else:
                    method = "elicitation/create"
                    params.update(
                        mode="form",
                        message="Select a scope",
                        requestedSchema={
                            "type": "object",
                            "properties": {"scope": {"type": "string", "enum": ["primary", "secondary"]}},
                            "required": ["scope"],
                        },
                    )
                await self.inbox.put({"jsonrpc": "2.0", "id": "permission-1", "method": method, "params": params})
                await self.responses.get()
            await self._update(
                {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-1",
                    "status": "completed",
                    "rawOutput": "Found",
                }
            )
            await self._update(
                {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {
                        "type": "text",
                        "text": "x" * (harness_acp.MAX_MESSAGE_BYTES + 1) if self.oversized else "Result",
                    },
                }
            )
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


def driver_for(
    peer: HarnessPeer,
) -> tuple[HarnessACPDriver, list[str], list[HarnessPendingInput], asyncio.Queue[dict[str, Any]]]:
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

    return (
        HarnessACPDriver(
            peer,
            agent_name="Example agent",
            canonical_session_id="example-conversation",
            persist_session=persist_session,
            persist_input=persist_input,
            wait_for_decision=wait_for_decision,
        ),
        saved,
        pending,
        decisions,
    )


async def test_released_acp_progress_is_projected_into_the_one_engine_journal_contract() -> None:
    peer = HarnessPeer()
    driver, saved, _, _ = driver_for(peer)
    try:
        await driver.open("/workspace", session_meta={"example": {"systemPrompt": "Approved instructions"}})
        events = [event async for event in driver.stream("hello", run_id="run-example")]
        assert saved == ["provider-session"]
        assert [event.event_type for event in events[:-1]] == ["tool.started", "tool.completed", "content.delta"]
        assert events[-1] == ProviderTurnOutcome(status="completed")
        assert events[-2].data["text"] == "Result"
        assert [message.get("method") for message in peer.sent][:3] == ["initialize", "session/new", "session/prompt"]
        assert peer.sent[1]["params"]["_meta"] == {"example": {"systemPrompt": "Approved instructions"}}
        assert not peer.sent[0]["params"]["clientCapabilities"].get("terminal", False)
    finally:
        await driver.close()


async def test_failed_load_cannot_fall_back_to_an_empty_native_session() -> None:
    peer = HarnessPeer(load_error=True)
    driver, saved, _, _ = driver_for(peer)
    try:
        with pytest.raises(Exception, match="Saved session unavailable"):
            await driver.open("/workspace", existing_session_id="provider-session")
        assert saved == []
        assert not any(message.get("method") == "session/new" for message in peer.sent)
    finally:
        await driver.close()


@pytest.mark.parametrize("existing", [None, "provider-session"])
async def test_mcp_transport_must_be_negotiated_before_any_session_effect(existing) -> None:
    peer = HarnessPeer(mcp_http=False)
    driver, saved, _, _ = driver_for(peer)
    try:
        with pytest.raises(HarnessACPError, match="negotiated.*MCP http"):
            await driver.open(
                "/workspace",
                [{"type": "http", "name": "caipe", "url": "https://api.example.test/mcp", "headers": []}],
                existing_session_id=existing,
            )
        assert saved == []
        assert [message.get("method") for message in peer.sent] == ["initialize"]
    finally:
        await driver.close()


@pytest.mark.parametrize("interaction", ["permission", "form"])
async def test_pending_human_input_keeps_exactly_one_prompt_and_requires_stored_answer(interaction) -> None:
    peer = HarnessPeer(interaction=interaction)
    driver, _, pending, decisions = driver_for(peer)
    events = []

    async def consume():
        async for event in driver.stream("hello", run_id="run-example"):
            events.append(event)

    await driver.open("/workspace")
    task = asyncio.create_task(consume())
    try:
        async with asyncio.timeout(2):
            while not any(getattr(event, "event_type", None) == "interrupt.requested" for event in events):
                await asyncio.sleep(0.01)
        assert pending and not task.done()
        assert not any("result" in message and message.get("id") == "permission-1" for message in peer.sent)
        values = (
            {"option_id": "allow-once"}
            if interaction == "permission"
            else {"__acp_action": "accept", "scope": "primary"}
        )
        await decisions.put({"type": "form_input", "values": values})
        await asyncio.wait_for(task, 2)
        assert len([message for message in peer.sent if message.get("method") == "session/prompt"]) == 1
        assert events[-1] == ProviderTurnOutcome(status="completed")
        assert [event.event_type for event in events if hasattr(event, "event_type")].count("interrupt.resolved") == 1
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await driver.close()


async def test_oversized_provider_output_cannot_report_partial_success() -> None:
    driver, _, _, _ = driver_for(HarnessPeer(oversized=True))
    events = []
    try:
        await driver.open("/workspace")
        with pytest.raises(HarnessACPError):
            async with asyncio.timeout(2):
                async for event in driver.stream("hello", run_id="run-example"):
                    events.append(event)
        assert not any(isinstance(event, ProviderTurnOutcome) and event.status == "completed" for event in events)
    finally:
        await driver.close()


async def test_pending_storage_failure_never_exposes_an_actionable_form() -> None:
    driver, _, _, _ = driver_for(HarnessPeer(interaction="permission"))

    async def unavailable(_pending):
        raise RuntimeError("Storage unavailable")

    driver.persist_input = unavailable
    events = []
    try:
        await driver.open("/workspace")
        with pytest.raises(HarnessACPError):
            async with asyncio.timeout(2):
                async for event in driver.stream("hello", run_id="run-example"):
                    events.append(event)
        assert not any(getattr(event, "event_type", None) == "interrupt.requested" for event in events)
    finally:
        await driver.close()
