"""The sandbox capability never becomes a user token or a second executor."""

from __future__ import annotations

import asyncio
import json
import secrets
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from langchain_core.tools import tool

from dynamic_agents.models import DynamicAgentConfig, FeaturesConfig, MiddlewareEntry
from dynamic_agents.routes import harness_tools as harness_tools_route
from dynamic_agents.routes.harness_tools import router
from dynamic_agents.services import agent_runtime, harness_tools
from dynamic_agents.services.agent_runtime import AgentPlatformResources, AgentRuntime
from dynamic_agents.services.harness_tools import (
    CAPABILITY_HEADER,
    HARNESS_TOOL_REQUESTS_COLLECTION,
    HarnessResources,
    HarnessToolError,
    HarnessToolRepository,
)
from dynamic_agents.services.mongo import get_mongo_service
from dynamic_agents.services.native_run_repository import NativeExecutionRun
from dynamic_agents.services.stream_encoders.events import InputRequired
from tests.test_native_acp_mongodb import native_database as native_database


async def test_native_platform_resources_are_shared_without_constructing_an_llm_or_graph(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("Platform resources must not construct an LLM or execution graph")

    monkeypatch.setattr(agent_runtime, "get_llm", forbidden)
    monkeypatch.setattr(agent_runtime, "create_deep_agent", forbidden)
    agent = DynamicAgentConfig(_id="example-agent", name="Example", owner_id="owner@example.com",
        system_prompt="Approved instructions", model={"id": "example", "provider": "example"})
    runtime = AgentRuntime(agent, [], ephemeral=True)
    try:
        resources = await runtime.prepare_platform_resources()
        assert resources.system_prompt.startswith("Approved instructions")
        assert runtime._graph is None and not runtime._initialized
        assert await runtime.prepare_platform_resources() is resources
    finally:
        await runtime.cleanup()


async def test_broker_url_rejects_password_even_with_empty_username(native_database):
    state = native_database
    _, run, _, _ = _broker(state)
    state.settings.harness_tools_public_url = "https://:secret@example.test/api/v1/harness-tools"
    with pytest.raises(HarnessToolError, match="valid public"):
        async with harness_tools.harness_resources(state.mongo, state.agent, [], state.session_id, state.user, None, run,
            settings=state.settings):
            pytest.fail("A userinfo URL must not expose a broker capability")


def _broker(state):
    now, run_id, lease_id = datetime.now(timezone.utc), str(uuid4()), str(uuid4())
    state.mongo.get_session_runs_collection().insert_one({
        "agent_id": state.agent.id, "session_id": state.session_id, "lease_id": lease_id,
        "lease_expires_at": now + timedelta(minutes=2),
    })
    state.db["native_acp_execution_runs"].insert_one({
        "run_id": run_id, "agent_id": state.agent.id, "session_id": state.session_id,
        "owner_subject": "user:owner", "turn_id": "original", "fingerprint": "input", "protocol": "custom",
        "active": True, "status": "running", "lease_id": lease_id, "created_at": now, "updated_at": now,
    })
    run = NativeExecutionRun.model_validate(state.db["native_acp_execution_runs"].find_one({"run_id": run_id}))
    repository = HarnessToolRepository(state.mongo)
    repository.initialize()
    token = secrets.token_urlsafe(32)
    repository.register(run, token, [{"name": "lookup", "description": "Read", "inputSchema": {"type": "object"}}])
    return repository, run, token, lease_id


async def test_cross_replica_request_is_claimed_once_and_retry_attaches_result(native_database):
    state = native_database
    producer, run, token, lease_id = _broker(state)
    replica = HarnessToolRepository(state.mongo)
    request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "lookup", "arguments": {"query": "scope"}}}
    identifier = replica.enqueue(run.run_id, token, request)
    assert producer.claim(run.run_id, lease_id)["_id"] == identifier
    assert producer.claim(run.run_id, lease_id) is None
    assert replica.enqueue(run.run_id, token, request) == identifier
    result = {"content": [{"type": "text", "text": "Result"}], "isError": False}
    producer.complete(identifier, run.run_id, lease_id, result)
    assert await replica.call(run.run_id, token, request) == result
    assert state.db[HARNESS_TOOL_REQUESTS_COLLECTION].count_documents({}) == 1
    stored = state.db["native_acp_execution_runs"].find_one({"run_id": run.run_id})
    assert stored["harness_capability_hash"] != token
    assert token not in str(stored)
    changed = {**request, "params": {"name": "lookup", "arguments": {"query": "other"}}}
    with pytest.raises(HarnessToolError, match="different arguments"):
        replica.enqueue(run.run_id, token, changed)


async def test_wrong_capability_stale_lease_and_worker_loss_never_reexecute_claimed_tool(native_database):
    state = native_database
    producer, run, token, lease_id = _broker(state)
    request = {"jsonrpc": "2.0", "id": "write", "method": "tools/call", "params": {"name": "lookup", "arguments": {}}}
    with pytest.raises(HarnessToolError):
        producer.enqueue(run.run_id, "a" * 43, request)
    identifier = producer.enqueue(run.run_id, token, request)
    assert producer.claim(run.run_id, lease_id)["_id"] == identifier
    state.mongo.get_session_runs_collection().update_one({"session_id": state.session_id}, {"$set": {"lease_id": "replacement"}})
    with pytest.raises(HarnessToolError, match="lost its admission"):
        producer.complete(identifier, run.run_id, lease_id, {"content": []})
    with pytest.raises(HarnessToolError):
        await producer.call(run.run_id, token, request)
    assert state.db[HARNESS_TOOL_REQUESTS_COLLECTION].find_one({"_id": identifier})["status"] == "claimed"
    producer.revoke(run.run_id, lease_id)
    assert state.db[HARNESS_TOOL_REQUESTS_COLLECTION].find_one({"_id": identifier})["status"] == "interrupted"


async def test_configured_tool_limit_uses_existing_atomic_run_counter_and_cached_result(native_database, monkeypatch):
    state = native_database
    state.agent.features = FeaturesConfig(middleware=[MiddlewareEntry(type="tool_call_limit", params={"run_limit": 1})])
    monkeypatch.setattr(state.mongo, "get_agent", lambda _identifier: state.agent)
    repository, run, capability, lease_id = _broker(state)
    request = {"jsonrpc": "2.0", "id": "first", "method": "tools/call", "params": {"name": "lookup", "arguments": {}}}
    identifier = repository.enqueue(run.run_id, capability, request)
    assert repository.claim(run.run_id, lease_id)["_id"] == identifier
    result = {"content": [{"type": "text", "text": "Saved"}], "isError": False}
    repository.complete(identifier, run.run_id, lease_id, result)
    assert await repository.call(run.run_id, capability, request) == result
    with pytest.raises(HarnessToolError, match="tool-call limit"):
        repository.enqueue(run.run_id, capability, {**request, "id": "second"})
    stored = state.db["native_acp_execution_runs"].find_one({"run_id": run.run_id})
    assert stored["harness_call_count"] == 1
    assert stored["harness_tool_counts"][harness_tools._digest("lookup")] == 1
    assert not stored.get("harness_tool_limit_failed")
    assert state.db[HARNESS_TOOL_REQUESTS_COLLECTION].count_documents({"run_id": run.run_id}) == 1


async def test_specific_tool_limit_and_stop_policy_are_owned_by_same_run_lease(native_database, monkeypatch):
    state = native_database
    state.agent.features = FeaturesConfig(middleware=[
        MiddlewareEntry(type="tool_call_limit", params={"run_limit": 20}),
        MiddlewareEntry(type="tool_call_limit", params={"tool_name": "lookup", "run_limit": 0, "exit_behavior": "error"}),
    ])
    monkeypatch.setattr(state.mongo, "get_agent", lambda _identifier: state.agent)
    repository, run, capability, lease_id = _broker(state)
    request = {"jsonrpc": "2.0", "id": "first", "method": "tools/call", "params": {"name": "lookup", "arguments": {}}}
    with pytest.raises(HarnessToolError, match="tool-call limit"):
        repository.enqueue(run.run_id, capability, request)
    with pytest.raises(harness_tools.HarnessToolExecutionFailed, match="tool-call limit"):
        repository.claim(run.run_id, lease_id)
    stored = state.db["native_acp_execution_runs"].find_one({"run_id": run.run_id})
    assert stored["harness_call_count"] == 0 and stored["harness_tool_limit_failed"] is True


async def test_capability_route_has_no_human_bearer_fallback_and_returns_mcp_framing(native_database):
    state = native_database
    _, run, token, _ = _broker(state)
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_mongo_service] = lambda: state.mongo
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://example.invalid") as client:
        path = f"/api/v1/harness-tools/{run.run_id}/mcp"
        message = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        assert (await client.post(path, json=message, headers={"Authorization": "Bearer not-a-capability"})).status_code == 401
        response = await client.post(path, json=message, headers={CAPABILITY_HEADER: token})
        assert response.status_code == 200 and response.json()["result"]["tools"][0]["name"] == "lookup"
        response = await client.post(path, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers={CAPABILITY_HEADER: token})
        assert response.status_code == 202 and response.content == b""


async def test_mcp_sse_keeps_approval_wait_alive_and_emits_standard_final_message(native_database, monkeypatch):
    state = native_database
    repository, run, token, lease_id = _broker(state)
    monkeypatch.setattr(harness_tools_route, "KEEPALIVE_SECONDS", 0.01)
    request = {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "lookup", "arguments": {}}}
    stream = harness_tools_route._call_events(repository, run.run_id, token, request)
    assert await anext(stream) == ": connected\n\n"
    assert await anext(stream) == ": keepalive\n\n"
    record = repository.claim(run.run_id, lease_id)
    assert record is not None
    repository.complete(record["_id"], run.run_id, lease_id, {"content": [{"type": "text", "text": "Result"}]})
    async with asyncio.timeout(2):
        while (frame := await anext(stream)).startswith(":"):
            pass
    assert frame.startswith("event: message\ndata: ")
    assert json.loads(frame.split("data: ", 1)[1])["result"]["content"][0]["text"] == "Result"
    await stream.aclose()


async def test_mcp_observer_disconnect_does_not_cancel_or_requeue_producer_tool(native_database, monkeypatch):
    repository, run, token, lease_id = _broker(native_database)
    monkeypatch.setattr(harness_tools_route, "KEEPALIVE_SECONDS", 0.01)
    request = {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "lookup", "arguments": {}}}
    stream = harness_tools_route._call_events(repository, run.run_id, token, request)
    await anext(stream)
    await anext(stream)
    record = repository.claim(run.run_id, lease_id)
    await stream.aclose()
    assert repository.claim(run.run_id, lease_id) is None
    repository.complete(record["_id"], run.run_id, lease_id, {"content": [{"type": "text", "text": "Saved result"}]})
    result = await HarnessToolRepository(native_database.mongo).call(run.run_id, token, request)
    assert result["content"][0]["text"] == "Saved result"


async def test_current_tool_policy_is_reloaded_and_form_values_require_human_input(native_database, monkeypatch):
    state = native_database
    repository, run, _, _ = _broker(state)
    calls = []
    runtime_configs = []

    @tool
    async def lookup(query: str) -> str:
        """Read an admitted resource."""
        calls.append(query)
        return "Result"

    class FreshRuntime:
        available = True

        def __init__(self, *_args, **_kwargs):
            if _args:
                runtime_configs.append(_args[0])

        async def prepare_platform_resources(self):
            return AgentPlatformResources(tools=[lookup] if self.available else [], system_prompt="", skills=[],
                skills_files={}, skills_sources=[], builtin_tool_names=set(), skills_middleware=None)

        def _build_interrupt_config(self, *_args):
            return {"lookup": {"allowed_decisions": ["approve", "reject"]}}

        async def cleanup(self):
            pass

    async def allow(_identifier):
        pass

    monkeypatch.setattr(harness_tools, "AgentRuntime", FreshRuntime)
    monkeypatch.setattr(harness_tools, "require_agent_use_permission", allow)
    changed_backend = state.agent.backend.model_copy(update={"config": state.agent.backend.config.model_copy(
        update={"fs_namespace": ["example", "other-session", "filesystem"]})})
    current_agent = state.agent.model_copy(update={"backend": changed_backend})
    monkeypatch.setattr(state.mongo, "get_agent", lambda _identifier: current_agent)
    monkeypatch.setattr(state.mongo, "get_agent_mcp_servers", lambda _agent: [])
    resources = HarnessResources(repository, run, SimpleNamespace(
        config=state.agent, settings=state.settings, _user=state.user, _client_context=None,
    ), await FreshRuntime().prepare_platform_resources(), invoke_child=None, admit_child=None)
    pending = []

    class Driver:
        session_id = "provider-session"

        async def request_platform_input(self, value):
            pending.append(value)
            return {"type": "tool_approval", "interrupt_id": value.interrupt_id,
                "decisions": [{"decision": "reject", "tool_name": "lookup"}]}

    resources.bind_driver(Driver())
    result = await resources.execute("lookup", {"query": "scope"})
    assert result["isError"] and not calls
    assert runtime_configs[0].backend == state.agent.backend
    assert runtime_configs[0].backend != current_agent.backend
    assert pending[0].event.allowed_decisions == ["approve", "reject"]
    FreshRuntime.available = False
    with pytest.raises(HarnessToolError, match="revoked"):
        await resources.execute("lookup", {"query": "scope"})


async def test_child_interrupt_stays_native_and_only_durable_human_reply_resumes(native_database, monkeypatch):
    state = native_database
    repository, run, _, _ = _broker(state)
    parent = state.agent.model_copy(update={"subagents": [SimpleNamespace(name="specialist", agent_id="child")]})
    child = state.agent.model_copy(update={"id": "child", "name": "Specialist"})
    monkeypatch.setattr(state.mongo, "get_agent", lambda identifier: child if identifier == "child" else parent)
    admitted, invoked = [], []

    async def allow(identifier):
        admitted.append(identifier)

    async def privacy(config, session_id):
        assert config is child and session_id != run.session_id

    async def invoke(config, session_id, message, resume):
        invoked.append((message, resume, session_id))
        if resume is None:
            return SimpleNamespace(content="", interrupt={"type": "form_input", "interrupt_id": "native-child-request",
                "prompt": "Select scope", "fields": [{"field_name": "scope", "field_type": "select", "field_values": ["primary"], "required": True}]})
        return SimpleNamespace(content="Child result", interrupt=None)

    monkeypatch.setattr(harness_tools, "require_agent_use_permission", allow)
    runtime = SimpleNamespace(config=parent)
    platform = AgentPlatformResources(tools=[], system_prompt="", skills=[], skills_files={}, skills_sources=[], builtin_tool_names=set(), skills_middleware=None)
    resources = HarnessResources(repository, run, runtime, platform, invoke_child=invoke, admit_child=privacy)

    class Driver:
        session_id = "provider-session"

        async def request_platform_input(self, pending):
            assert pending.method == "caipe/child_input" and pending.event.interrupt_id == "native-child-request"
            assert isinstance(pending.event, InputRequired)
            assert len(invoked) == 1
            await asyncio.sleep(0)
            return {"type": "form_input", "interrupt_id": pending.interrupt_id, "values": {"scope": "primary"}}

    resources.bind_driver(Driver())
    result = await resources.execute("task", {"description": "Inspect the scope", "subagent_type": "specialist"})
    assert result["content"][0]["text"] == "Child result"
    assert len(invoked) == 2 and invoked[0][0] == "Inspect the scope" and invoked[1][0] is None
    assert invoked[0][2] == invoked[1][2]
    assert "native-child-request" in invoked[1][1]
    assert admitted == [state.agent.id, "child", "child"]


async def test_parent_delegation_gate_is_not_bypassed_by_canonical_child_tool(native_database, monkeypatch):
    state = native_database
    repository, run, _, _ = _broker(state)
    parent = state.agent.model_copy(update={"subagents": [SimpleNamespace(name="specialist", agent_id="child")],
        "interrupt_on": {"builtin": {"task": {"allowed_decisions": ["approve", "reject"]}}}})
    monkeypatch.setattr(state.mongo, "get_agent", lambda _identifier: parent)

    async def allow(_identifier):
        pass

    async def forbidden(*_args):
        pytest.fail("A rejected delegation must not invoke its child")

    monkeypatch.setattr(harness_tools, "require_agent_use_permission", allow)
    platform = AgentPlatformResources(tools=[], system_prompt="", skills=[], skills_files={}, skills_sources=[], builtin_tool_names=set(), skills_middleware=None)
    resources = HarnessResources(repository, run, SimpleNamespace(config=parent), platform, invoke_child=forbidden, admit_child=forbidden)

    class Driver:
        session_id = "provider-session"

        async def request_platform_input(self, pending):
            assert pending.method == "caipe/tool_input" and pending.event.tool_name == "task"
            return {"type": "tool_approval", "interrupt_id": pending.interrupt_id,
                "decisions": [{"decision": "reject", "tool_name": "task"}]}

    resources.bind_driver(Driver())
    result = await resources.execute("task", {"description": "Inspect scope", "subagent_type": "specialist"})
    assert result["isError"] and "rejected" in result["content"][0]["text"]
