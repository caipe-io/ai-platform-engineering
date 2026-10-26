"""The existing Engine producer owns tool effects and durable Git review."""

from __future__ import annotations

import asyncio
import hashlib
from unittest.mock import AsyncMock

import httpx
import pytest

from harness_engine.coding.acp_client import validate_harness_decision
from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.coding.inputs import CodingInputs, SubmitCodingInput
from harness_engine.coding.resources import PlatformResourceBroker
from harness_engine.config import Settings

pytest_plugins = ["tests.coding_fixtures"]


class InputDriver:
    session_id = "provider-primary"
    failed = False

    def __init__(self, fence):
        self.fence = fence
        self.inputs = CodingInputs(fence)

    async def request_platform_input(self, pending):
        await self.inputs.persist(pending)
        self.fence.db.harness_runs.update_one(
            {}, {"$set": {"status": "awaiting_input", "pending_interrupt_id": pending.interrupt_id}}
        )
        decision = await self.inputs.wait(pending)
        self.fence.db.harness_runs.update_one({}, {"$set": {"status": "running", "pending_interrupt_id": None}})
        return validate_harness_decision(pending, decision)

    def fail(self):
        self.failed = True


def prepare(scope):
    db, context, _, _ = scope
    fence = RunFence(db, context)
    settings = Settings(
        storage_backend="memory",
        coding_resources_url="https://resources.example.test",
        coding_tools_public_url="https://broker.example.test",
    )
    broker = PlatformResourceBroker(settings, fence, object())
    driver = InputDriver(fence)
    cap = "c" * 43
    db.harness_runs.update_one(
        {},
        {
            "$set": {
                "_coding_capability_hash": hashlib.sha256(cap.encode()).hexdigest(),
                "_coding_tools": [{"name": "write_example", "inputSchema": {"type": "object"}}],
                "_coding_call_count": 0,
            }
        },
    )
    return broker, driver, fence, cap


async def pending(scope):
    async with asyncio.timeout(3):
        while True:
            run = scope[0].harness_runs.find_one()
            if run.get("status") == "awaiting_input":
                return run["pending_interrupt_id"]
            await asyncio.sleep(0.01)


async def test_git_write_cannot_bypass_the_durable_human_decision(coding_scope):
    broker, driver, fence, _ = prepare(coding_scope)
    broker._platform_request = AsyncMock()
    await broker.start(driver)
    approval = asyncio.create_task(
        PlatformResourceBroker.approve_git(
            fence, repository="example/repository", refs=["refs/heads/agent/example"], pack_sha256="a" * 64
        )
    )
    try:
        input_id = await pending(coding_scope)
        assert not approval.done()
        assert coding_scope[0].harness_tool_requests.find_one()["status"] == "claimed"
        broker._platform_request.assert_not_awaited()
        await driver.inputs.submit(
            SubmitCodingInput(
                client_request_id="decision-primary",
                decision={
                    "type": "tool_approval",
                    "interrupt_id": input_id,
                    "decisions": [{"decision": "approve", "tool_name": "git_push"}],
                },
            )
        )
        identifier = await asyncio.wait_for(approval, 3)
        assert coding_scope[0].harness_tool_requests.find_one({"_id": identifier})["result"] == {"approved": True}
        broker._platform_request.assert_not_awaited()
    finally:
        if not approval.done():
            approval.cancel()
            await asyncio.gather(approval, return_exceptions=True)
        await broker.close()


async def test_rejected_git_review_is_not_a_tool_capability(coding_scope):
    broker, driver, fence, cap = prepare(coding_scope)
    await broker.start(driver)
    approval = asyncio.create_task(
        PlatformResourceBroker.approve_git(
            fence, repository="example/repository", refs=["refs/heads/agent/example"], pack_sha256="a" * 64
        )
    )
    try:
        input_id = await pending(coding_scope)
        await driver.inputs.submit(
            SubmitCodingInput(
                client_request_id="decision-primary",
                decision={
                    "type": "tool_approval",
                    "interrupt_id": input_id,
                    "decisions": [{"decision": "reject", "tool_name": "git_push"}],
                },
            )
        )
        with pytest.raises(CodingAdmissionError, match="did not approve"):
            await asyncio.wait_for(approval, 3)
        with pytest.raises(CodingAdmissionError, match="not admitted"):
            await PlatformResourceBroker.call(
                fence, cap, {"id": "call-primary", "params": {"name": "git_push", "arguments": {"approved": True}}}
            )
    finally:
        if not approval.done():
            approval.cancel()
            await asyncio.gather(approval, return_exceptions=True)
        await broker.close()


async def test_uncertain_claimed_tool_is_never_automatically_retried(coding_scope):
    broker, driver, fence, cap = prepare(coding_scope)
    broker._platform_request = AsyncMock(side_effect=TimeoutError("uncertain effect"))
    await broker.start(driver)
    request = {"id": "call-primary", "params": {"name": "write_example", "arguments": {"value": "example"}}}
    try:
        result = await asyncio.wait_for(PlatformResourceBroker.call(fence, cap, request), 3)
        assert result["isError"] is True
        assert await PlatformResourceBroker.call(fence, cap, request) == result
        broker._platform_request.assert_awaited_once()
        with pytest.raises(CodingAdmissionError, match="different tool arguments"):
            await PlatformResourceBroker.call(
                fence, cap, {**request, "params": {"name": "write_example", "arguments": {"value": "other"}}}
            )
        broker._platform_request.assert_awaited_once()
    finally:
        await broker.close()


async def test_required_tool_limit_stops_provider_after_retained_error(coding_scope):
    broker, driver, fence, cap = prepare(coding_scope)
    broker._platform_request = AsyncMock(return_value={"result": {"isError": True, "content": []}, "stop_run": True})
    await broker.start(driver)
    try:
        result = await asyncio.wait_for(
            PlatformResourceBroker.call(
                fence, cap, {"id": "call-primary", "params": {"name": "write_example", "arguments": {}}}
            ),
            3,
        )
        assert result["isError"] is True and driver.failed is True
    finally:
        await broker.close()


async def test_close_revokes_new_calls_and_waits_for_current_effect_ack(coding_scope):
    broker, driver, fence, cap = prepare(coding_scope)
    admitted, release = asyncio.Event(), asyncio.Event()

    async def execute(*args):
        coding_scope[0].harness_tool_requests.update_one({}, {"$set": {"platform_phase": "executing"}})
        admitted.set()
        await release.wait()
        coding_scope[0].harness_tool_requests.update_one({}, {"$set": {"platform_phase": "completed"}})
        return {"result": {"content": [], "isError": False}}

    broker._platform_request = execute
    await broker.start(driver)
    observer = asyncio.create_task(
        PlatformResourceBroker.call(
            fence, cap, {"id": "call-primary", "params": {"name": "write_example", "arguments": {}}}
        )
    )
    try:
        await asyncio.wait_for(admitted.wait(), 3)
        closing = asyncio.create_task(broker.close())
        await asyncio.sleep(0.05)
        assert not closing.done()
        assert "_coding_capability_hash" not in coding_scope[0].harness_runs.find_one()
        release.set()
        await asyncio.wait_for(closing, 3)
        assert broker.unsettled is False
        await broker.close()  # Idempotent after native checkpoint publication.
    finally:
        release.set()
        await broker.close()
        await asyncio.gather(observer, return_exceptions=True)


async def test_intermediate_http_timeout_observes_the_accepted_effect_without_resending(coding_scope):
    broker, driver, fence, cap = prepare(coding_scope)
    acknowledged = asyncio.Event()

    async def complete_after_timeout():
        await asyncio.sleep(0.1)
        coding_scope[0].harness_tool_requests.update_one(
            {},
            {
                "$set": {
                    "platform_phase": "completed",
                    "platform_result": {"content": [{"type": "text", "text": "actual result"}], "isError": False},
                }
            },
        )
        acknowledged.set()

    completion = None

    async def interrupted_http(*args):
        nonlocal completion
        coding_scope[0].harness_tool_requests.update_one({}, {"$set": {"platform_phase": "executing"}})
        completion = asyncio.create_task(complete_after_timeout())
        raise httpx.ReadTimeout("Observer timed out")

    broker._platform_request = AsyncMock(side_effect=interrupted_http)
    await broker.start(driver)
    try:
        result = await asyncio.wait_for(
            PlatformResourceBroker.call(
                fence, cap, {"id": "call-primary", "params": {"name": "write_example", "arguments": {}}}
            ),
            3,
        )
        assert acknowledged.is_set()
        assert result == {"content": [{"type": "text", "text": "actual result"}], "isError": False}
        broker._platform_request.assert_awaited_once()
    finally:
        await broker.close()
        if completion is not None:
            await completion


@pytest.mark.parametrize("effect_map", ["_coding_active_effects", "_coding_git_dispatches"])
async def test_close_waits_for_atomically_admitted_remote_effect_before_checkpoint(coding_scope, effect_map):
    broker, _, _, _ = prepare(coding_scope)
    db = coding_scope[0]
    db.harness_runs.update_one({}, {"$set": {f"{effect_map}.request_primary": "executing"}})
    closing = asyncio.create_task(broker.close())
    try:
        await asyncio.sleep(0.1)
        assert not closing.done()
        assert db.harness_runs.find_one()["_coding_resources_closed"] is True
        db.harness_runs.update_one({}, {"$set": {f"{effect_map}.request_primary": "completed"}})
        await asyncio.wait_for(closing, 3)
        assert broker.unsettled is False
    finally:
        db.harness_runs.update_one({}, {"$set": {f"{effect_map}.request_primary": "completed"}})
        await closing
