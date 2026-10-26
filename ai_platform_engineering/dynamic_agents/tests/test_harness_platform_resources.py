from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict
from pymongo import MongoClient

from dynamic_agents.auth.jwt_middleware import JwtAuthMiddleware
from dynamic_agents.config import Settings
from dynamic_agents.models import DynamicAgentConfig, UserContext
from dynamic_agents.routes import harness_resources as resource_routes
from dynamic_agents.services.agent_runtime import AgentPlatformResources, AgentRuntime
from dynamic_agents.services.harness_resources import HarnessResourceService
from dynamic_agents.services.mongo import get_mongo_service


class ToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: int


class SelectedTool:
    name = "selected_operation"
    description = "Perform the selected test operation."

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()

    def get_input_schema(self) -> type[BaseModel]:
        return ToolArguments

    async def ainvoke(self, value: dict[str, Any]) -> str:
        self.calls.append(value)
        self.entered.set()
        await self.release.wait()
        return "effect completed"


@pytest.fixture
async def resources(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[tuple[HarnessResourceService, Any, SelectedTool, list[str]]]:
    uri = os.environ.get("HARNESS_ENGINE_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set HARNESS_ENGINE_TEST_MONGODB_URI for platform fencing tests")
    client = MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=5000)
    database = client["harness_resources_test_" + uuid4().hex]
    agent = DynamicAgentConfig(
        _id="agent-example", name="Example agent", system_prompt="Use the selected platform resources.",
        owner_id="owner@example.test", model={"id": "example-model", "provider": "anthropic"},
    )
    agents = {agent.id: agent}
    mongo = SimpleNamespace(_db=database, _client=client, settings=Settings(),
                            get_agent=agents.get, get_agent_mcp_servers=lambda agent: [])
    database.harness_runs.insert_one({
        "run_id": "run-example", "owner_subject": "owner-example", "agent_id": agent.id,
        "agent_version": 1,
        "binding_id": "binding-example", "conversation_id": "conversation-example", "visible_conversation_id": "conversation-example",
        "harness_id": "claude_code_acp", "status": "running", "_producer_id": "producer-example-123456",
        "_producer_expires_at": datetime.now(timezone.utc) + timedelta(seconds=60),
        "_coding_capability_hash": "test-active-capability",
        "_provider_started": True, "_coding_tools": [{"name": "selected_operation"}],
    })
    database.harness_sessions.insert_one({
        "binding_id": "binding-example", "owner_subject": "owner-example", "agent_id": agent.id,
        "conversation_id": "conversation-example", "harness_id": "claude_code_acp", "status": "active",
        "_active_run_id": "run-example", "_producer_id": "producer-example-123456", "_lease_expires_at": datetime.now(timezone.utc) + timedelta(seconds=60),
    })
    database.conversations.insert_one({"_id": "conversation-example", "owner_id": "owner@example.test", "owner_subject": "owner-example", "participants": [{"type": "agent", "id": agent.id}]})
    database.harness_gateway_bindings.insert_one({"owner_subject": "owner-example", "agent_id": agent.id, "conversation_id": "conversation-example", "harness_id": "claude_code_acp"})
    database.dynamic_agents.insert_one(agent.model_dump(by_alias=True))
    database.harness_agent_versions.insert_one({"agent_id": agent.id, "version": 1,
        "blueprint": {"prompt": {"system": agent.system_prompt, "variables": {}}}})
    database.harness_tool_requests.insert_one({
        "_id": "call-example", "run_id": "run-example", "binding_id": "binding-example", "producer_id": "producer-example-123456",
        "status": "claimed", "params": {"name": "selected_operation", "arguments": {"value": 7}}, "platform_phase": "admitted",
    })
    authorized: list[str] = []

    async def authorize(agent_id: str) -> None:
        authorized.append(agent_id)

    monkeypatch.setattr("dynamic_agents.services.harness_resources.require_agent_use_permission", authorize)
    service = HarnessResourceService(mongo, "run-example", "owner-example", "producer-example-123456", UserContext(email="owner@example.test", sub="owner-example"))
    service.test_agents = agents
    tool = SelectedTool()

    @asynccontextmanager
    async def platform(config: DynamicAgentConfig, session_id: str) -> AsyncIterator[tuple[Any, AgentPlatformResources, list[Any]]]:
        runtime = SimpleNamespace(_build_interrupt_config=lambda tools, names: AgentRuntime._build_interrupt_config(SimpleNamespace(config=config), tools, names))
        yield runtime, AgentPlatformResources([tool], config.system_prompt, [], {}, [], {tool.name}, None), []

    monkeypatch.setattr(service, "platform", platform)
    try:
        yield service, database, tool, authorized
    finally:
        await asyncio.to_thread(client.drop_database, database.name)
        client.close()


async def test_selected_tool_executes_once_and_exact_retry_returns_result(resources) -> None:
    service, database, tool, authorized = resources
    await service.catalog()
    result = await service.call("call-example")
    assert result == {"result": {"content": [{"type": "text", "text": "effect completed"}], "isError": False}}
    assert await service.call("call-example") == result
    assert len(tool.calls) == 1 and tool.calls[0]["args"] == {"value": 7}
    assert authorized and set(authorized) == {"agent-example"}
    assert database.harness_tool_requests.find_one({"_id": "call-example"})["platform_phase"] == "completed"
    assert database.harness_runs.find_one({"run_id": "run-example"})["_coding_active_effects"] == {"call-example": "completed"}


async def test_concurrent_executor_and_uncertain_effect_are_never_replayed(resources) -> None:
    service, database, tool, _ = resources
    await service.catalog()
    tool.release.clear()
    first = asyncio.create_task(service.call("call-example"))
    await asyncio.wait_for(tool.entered.wait(), 2)
    with pytest.raises(HTTPException, match="uncertain"):
        await service.call("call-example")
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert database.harness_tool_requests.find_one({"_id": "call-example"})["platform_phase"] == "executing"
    with pytest.raises(HTTPException, match="uncertain"):
        await service.call("call-example")
    assert len(tool.calls) == 1
    assert database.harness_runs.find_one({"run_id": "run-example"})["_coding_active_effects"] == {"call-example": "executing"}


@pytest.mark.parametrize("revoke_capability", [False, True])
async def test_close_wins_after_fresh_validation_before_effect_reservation(resources, monkeypatch, revoke_capability) -> None:
    service, database, tool, _ = resources
    await service.catalog()
    validated, resume = asyncio.Event(), asyncio.Event()
    reserve = service._reserve_effect

    async def paused_reservation(record, run, **kwargs):
        # All canonical owner/CAS/producer checks have passed. Pause at the
        # cross-service race boundary, immediately before the atomic run write.
        validated.set()
        await resume.wait()
        await reserve(record, run, **kwargs)

    monkeypatch.setattr(service, "_reserve_effect", paused_reservation)
    operation = asyncio.create_task(service.call("call-example"))
    try:
        await asyncio.wait_for(validated.wait(), 2)
        change = {"$set": {"_coding_resources_closed": True}}
        if revoke_capability:
            change["$unset"] = {"_coding_capability_hash": "", "_coding_tools": ""}
        database.harness_runs.update_one({"run_id": "run-example", "_producer_id": service.producer}, change)
        resume.set()
        with pytest.raises(HTTPException, match="lost its live resource admission"):
            await asyncio.wait_for(operation, 2)
        assert tool.calls == []
        assert not database.harness_runs.find_one({"run_id": "run-example"}).get("_coding_active_effects")
    finally:
        resume.set()
        if not operation.done():
            operation.cancel()
        await asyncio.gather(operation, return_exceptions=True)


async def test_unknown_error_hidden_by_retry_failure_result_remains_unsettled(resources, monkeypatch) -> None:
    service, database, tool, _ = resources
    agent = service.test_agents["agent-example"]
    service.test_agents[agent.id] = DynamicAgentConfig.model_validate({**agent.model_dump(by_alias=True), "features": {"middleware": [{
        "type": "tool_retry", "params": {"max_retries": 0, "on_failure": "continue"},
    }]}})
    tool.metadata = {"readOnlyHint": True}

    async def unknown_result(value):
        raise RuntimeError("The remote result could not be confirmed")

    monkeypatch.setattr(tool, "ainvoke", unknown_result)
    await service.catalog()
    result = await service.call("call-example")
    assert "failed" in result["result"]["content"][0]["text"]
    assert database.harness_runs.find_one({"run_id": "run-example"})["_coding_active_effects"] == {"call-example": "executing"}


async def test_effect_reservation_map_is_bounded(resources) -> None:
    service, database, tool, _ = resources
    await service.catalog()
    database.harness_runs.update_one({"run_id": "run-example"}, {"$set": {
        "_coding_active_effects": {f"prior-{index}": "completed" for index in range(1000)},
    }})
    with pytest.raises(HTTPException, match="lost its live resource admission"):
        await service.call("call-example")
    assert tool.calls == []


@pytest.mark.parametrize("collection,query,change", [
    ("harness_runs", {"run_id": "run-example"}, {"cancellation_requested": True}),
    ("harness_runs", {"run_id": "run-example"}, {"owner_subject": "another-owner"}),
    ("harness_runs", {"run_id": "run-example"}, {"_producer_id": "another-producer"}),
    ("harness_sessions", {"binding_id": "binding-example"}, {"_lease_expires_at": datetime(2000, 1, 1, tzinfo=timezone.utc)}),
    ("harness_sessions", {"binding_id": "binding-example"}, {"status": "closed"}),
    ("conversations", {"_id": "conversation-example"}, {"participants": [{"type": "agent", "id": "another-agent"}]}),
    ("conversations", {"_id": "conversation-example"}, {"owner_subject": "another-owner"}),
    ("harness_gateway_bindings", {}, {"harness_id": "another-provider"}),
    ("harness_tool_requests", {"_id": "call-example"}, {"binding_id": "another-binding"}),
    ("harness_runs", {"run_id": "run-example"}, {"_coding_tools": [{"name": "another-tool"}]}),
])
async def test_owner_selection_lease_and_canonical_binding_fence_every_effect(resources, collection, query, change) -> None:
    service, database, tool, _ = resources
    await service.catalog()
    database[collection].update_one(query, {"$set": change})
    with pytest.raises(HTTPException):
        await service.call("call-example")
    assert tool.calls == []


async def test_approval_is_bound_and_revalidated_before_side_effect(resources) -> None:
    service, database, tool, _ = resources
    config = service.test_agents["agent-example"]
    service.test_agents[config.id] = config.model_copy(update={"interrupt_on": {"builtin": {tool.name: {"allowed_decisions": ["approve", "reject"]}}}})
    await service.catalog()
    pending = (await service.call("call-example"))["pending_input"]
    assert tool.calls == [] and pending["interrupt_type"] == "tool_approval"
    database.harness_runs.update_one({"run_id": "run-example"}, {"$set": {"_coding_pending": {
        "interrupt_id": pending["interrupt_id"], "decision": {"type": "tool_approval", "interrupt_id": pending["interrupt_id"], "decisions": [{"decision": "approve"}]},
    }}})
    assert (await service.call("call-example"))["result"]["isError"] is False
    assert len(tool.calls) == 1


async def test_review_cannot_survive_agent_revision_or_forge_approval(resources) -> None:
    service, database, tool, _ = resources
    config = service.test_agents["agent-example"]
    service.test_agents[config.id] = config.model_copy(update={"interrupt_on": {"builtin": {tool.name: {"allowed_decisions": ["approve"]}}}})
    await service.catalog()
    pending = (await service.call("call-example"))["pending_input"]
    database.harness_runs.update_one({"run_id": "run-example"}, {"$set": {"_coding_pending": {
        "interrupt_id": pending["interrupt_id"], "decision": {"type": "tool_approval", "interrupt_id": pending["interrupt_id"], "decisions": [{"decision": "edit", "edited_args": {"value": 8}}]},
    }}})
    with pytest.raises(HTTPException, match="not allowed"):
        await service.call("call-example")
    service.test_agents[config.id] = service.test_agents[config.id].model_copy(update={"updated_at": config.updated_at + timedelta(seconds=1)})
    with pytest.raises(HTTPException, match="changed"):
        await service.call("call-example")
    assert tool.calls == []


async def test_catalog_preserves_selected_schemas_and_current_native_specialists(resources) -> None:
    service, database, _, authorized = resources
    agent = service.test_agents["agent-example"]
    child = agent.model_copy(update={"id": "child-example", "name": "Example specialist"})
    service.test_agents[child.id] = child
    service.test_agents[agent.id] = agent.model_copy(update={"subagents": [SimpleNamespace(name="helper", agent_id=child.id)]})
    database.dynamic_agents.insert_one(child.model_dump(by_alias=True))
    catalog = await service.catalog()
    assert [tool["name"] for tool in catalog["tools"]] == ["selected_operation", "task"]
    assert catalog["tools"][1]["inputSchema"]["properties"]["subagent_type"]["enum"] == ["helper"]
    assert "child-example" in authorized and catalog["system_prompt"] == agent.system_prompt
    assert database.harness_sessions.count_documents({}) == 1 and database.harness_runs.count_documents({}) == 1


async def test_specialist_keeps_its_native_context_across_bound_human_continuation(resources, monkeypatch) -> None:
    service, database, _, authorized = resources
    agent = service.test_agents["agent-example"]
    child = agent.model_copy(update={"id": "child-example", "name": "Example specialist"})
    service.test_agents[child.id] = child
    service.test_agents[agent.id] = agent.model_copy(update={"subagents": [SimpleNamespace(name="helper", agent_id=child.id)]})
    database.dynamic_agents.insert_one(child.model_dump(by_alias=True))
    database.harness_runs.update_one({"run_id": "run-example"}, {"$set": {"_coding_tools": [{"name": "task"}]}})
    database.harness_tool_requests.update_one({"_id": "call-example"}, {"$set": {"params": {"name": "task", "arguments": {"subagent_type": "helper", "description": "Investigate the selected task"}}}})
    await service.catalog()
    calls = []
    sessions = []
    checkpoint = {"pending": None}

    class NativeChild:
        def __init__(self, config, servers, settings, mongo, **kwargs):
            sessions.append(kwargs["session_id"])

        async def initialize(self):
            return None

        async def stream(self, message, session_id, subject, **kwargs):
            calls.append(("stream", message, session_id, subject))
            checkpoint["pending"] = {"type": "form_input", "interrupt_id": "native-input-example", "prompt": "Choose an environment", "fields": [{"field_name": "target", "field_type": "select", "field_values": ["primary", "secondary"], "required": True}]}
            yield "event: input_required\n\n"

        async def resume(self, session_id, subject, resume_data, **kwargs):
            calls.append(("resume", resume_data, session_id, subject))
            checkpoint["pending"] = None
            yield "event: done\n\n"

        async def has_pending_interrupt(self, session_id):
            return checkpoint["pending"]

        async def cleanup(self):
            return None

    monkeypatch.setattr("dynamic_agents.services.harness_resources.AgentRuntime", NativeChild)
    monkeypatch.setattr("dynamic_agents.services.harness_resources.get_encoder", lambda protocol: SimpleNamespace(get_accumulated_content=lambda: "Specialist answer"))
    pending = (await service.call("call-example"))["pending_input"]
    assert pending["interrupt_id"] != "native-input-example" and pending["interrupt_type"] == "form_input"
    assert database.harness_runs.find_one({"run_id": "run-example"})["_coding_active_effects"] == {"call-example": "paused"}
    database.harness_runs.update_one({"run_id": "run-example"}, {"$set": {"_coding_pending": {
        "interrupt_id": pending["interrupt_id"], "decision": {"type": "form_input", "interrupt_id": pending["interrupt_id"], "values": {"target": "primary"}},
    }}})
    result = await service.call("call-example")
    assert result["result"]["content"][0]["text"] == "Specialist answer"
    assert [item[0] for item in calls] == ["stream", "resume"] and len(set(sessions)) == 1
    assert sessions[0] != "conversation-example" and "child-example" in authorized
    assert "session_id" not in pending and "native_interrupt_id" not in pending
    assert database.harness_runs.find_one({"run_id": "run-example"})["_coding_active_effects"] == {"call-example": "completed"}


async def test_route_requires_verified_user_bearer_and_never_accepts_trusted_owner_override(resources, monkeypatch) -> None:
    service, _, _, _ = resources
    claims = {"sub": "owner-example", "email": "owner@example.test"}
    monkeypatch.setattr("dynamic_agents.auth.jwt_middleware._validate_bearer_or_none", lambda token: claims if token == "verified-example" else None)
    monkeypatch.setattr("dynamic_agents.auth.jwt_middleware.DA_REQUIRE_BEARER", False)
    app = FastAPI()
    app.add_middleware(JwtAuthMiddleware)
    app.include_router(resource_routes.router, prefix="/api/v1")
    app.dependency_overrides[get_mongo_service] = lambda: service.mongo
    original = HarnessResourceService.catalog

    async def identity(self):
        return {"subject": self.subject, "email": self.user.email}

    monkeypatch.setattr(HarnessResourceService, "catalog", identity)
    client = TestClient(app)
    try:
        path = "/api/v1/harness-resources/run-example"
        headers = {"X-Harness-Producer": "producer-example-123456", "X-User-Context": "eyJzdWIiOiJmb3JnZWQifQ=="}
        assert client.get(path, headers=headers).status_code == 401
        assert client.get(path, headers={**headers, "Authorization": "Bearer invalid-example"}).status_code == 401
        verified = client.get(path, headers={**headers, "Authorization": "Bearer verified-example"})
        assert verified.status_code == 200 and verified.json() == {"subject": "owner-example", "email": "owner@example.test"}
        claims["preferred_username"] = "service-account-example"
        assert client.get(path, headers={**headers, "Authorization": "Bearer verified-example"}).status_code == 403
    finally:
        client.close()
        monkeypatch.setattr(HarnessResourceService, "catalog", original)


async def test_catalog_uses_pinned_prompt_and_rejects_changed_admitted_tool_schema(resources, monkeypatch) -> None:
    service, database, tool, _ = resources
    agent = service.test_agents["agent-example"]
    service.test_agents[agent.id] = agent.model_copy(update={"system_prompt": "Changed mutable prompt"})
    database.harness_agent_versions.update_one({}, {"$set": {"blueprint.prompt": {"system": "Pinned {{audience}} prompt", "variables": {"audience": "owner"}}}})
    catalog = await service.catalog()
    assert catalog["system_prompt"] == "Pinned owner prompt"

    class ChangedArguments(BaseModel):
        value: bool

    monkeypatch.setattr(tool, "get_input_schema", lambda: ChangedArguments)
    with pytest.raises(HTTPException, match="schema changed"):
        await service.call("call-example")
    assert tool.calls == []


@pytest.mark.parametrize("entry", [
    {"type": "pii", "params": {"pii_type": "email", "strategy": "block"}},
    {"type": "llm_tool_selector"},
    {"type": "unmapped_middleware"},
    {"type": "context_editing", "params": {"trigger": 90000}},
    {"type": "model_retry", "params": {"backoff_factor": 7}},
    {"type": "tool_call_limit", "params": {"thread_limit": 3}},
])
async def test_unmapped_required_policy_rejects_before_prompt_or_tool_transfer(resources, entry) -> None:
    service, database, tool, _ = resources
    agent = service.test_agents["agent-example"]
    service.test_agents[agent.id] = DynamicAgentConfig.model_validate({**agent.model_dump(by_alias=True), "features": {"middleware": [entry]}})
    with pytest.raises(HTTPException):
        await service.catalog()
    assert database.harness_runs.find_one({"run_id": "run-example"}).get("_coding_platform_admission") is None
    assert tool.calls == []


async def test_native_defaults_have_explicit_provider_policy_mapping(resources) -> None:
    service, _, _, _ = resources
    policy = (await service.catalog())["execution_policy"]
    assert policy["model_retry"] == {"max_retries": 5, "backoff_factor": 2.0, "on_failure": "error"}
    assert policy["model_call_limit"] == {"run_limit": 200, "exit_behavior": "end"}
    assert policy["context_management"] == "provider_native"
    assert policy["tool_retry"]["max_retries"] == 3 and policy["tool_call_limits"] == []


async def test_only_trusted_replay_safe_tools_use_shared_native_retry(resources, monkeypatch) -> None:
    service, database, tool, _ = resources
    agent = service.test_agents["agent-example"]
    service.test_agents[agent.id] = DynamicAgentConfig.model_validate({**agent.model_dump(by_alias=True), "features": {"middleware": [{
        "type": "tool_retry", "params": {"max_retries": 2, "initial_delay": 0, "backoff_factor": 1, "jitter": False},
    }]}})
    attempts = []

    async def flaky(value):
        attempts.append(value)
        if len(attempts) < 2:
            raise RuntimeError("transient test failure")
        return "safe retry succeeded"

    tool.metadata = {"readOnlyHint": True}
    monkeypatch.setattr(tool, "ainvoke", flaky)
    await service.catalog()
    assert (await service.call("call-example"))["result"]["content"][0]["text"] == "safe retry succeeded"
    assert len(attempts) == 2
    database.harness_tool_requests.insert_one({"_id": "call-unsafe", "run_id": "run-example", "binding_id": "binding-example", "producer_id": "producer-example-123456", "status": "claimed", "platform_phase": "admitted", "params": {"name": tool.name, "arguments": {"value": 8}}})
    tool.metadata = {}
    attempts.clear()
    with pytest.raises(RuntimeError):
        await service.call("call-unsafe")
    assert len(attempts) == 1
    assert database.harness_tool_requests.find_one({"_id": "call-unsafe"})["platform_phase"] == "executing"


async def test_current_per_run_tool_limit_stops_before_another_effect(resources) -> None:
    service, database, tool, _ = resources
    agent = service.test_agents["agent-example"]
    service.test_agents[agent.id] = DynamicAgentConfig.model_validate({**agent.model_dump(by_alias=True), "features": {"middleware": [{
        "type": "tool_call_limit", "params": {"run_limit": 1, "exit_behavior": "end"},
    }]}})
    await service.catalog()
    assert (await service.call("call-example"))["result"]["isError"] is False
    database.harness_tool_requests.insert_one({"_id": "call-over-limit", "run_id": "run-example", "binding_id": "binding-example", "producer_id": "producer-example-123456", "status": "claimed", "platform_phase": "admitted", "params": {"name": tool.name, "arguments": {"value": 8}}})
    result = await service.call("call-over-limit")
    assert result["result"]["isError"] is True and result["stop_run"] is True
    assert await service.call("call-over-limit") == result
    assert len(tool.calls) == 1
