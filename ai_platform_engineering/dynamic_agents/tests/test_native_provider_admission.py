from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.models import UserContext
from dynamic_agents.routes import chat
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.native_admission import require_native_execution
from tests.test_platform_resource_compiler import config, runtime


def selected_agent():
    agent = config()
    agent._execution_harness_id = "claude_code_acp"
    return agent


def test_canonical_read_preserves_private_placement_metadata_through_overrides() -> None:
    doc = {**config().model_dump(by_alias=True), "execution_harness_id": "claude_code_acp"}
    mongo = MongoDBService()
    mongo._get_agents_collection = lambda: SimpleNamespace(find_one=lambda query: doc)
    agent = mongo.get_agent("agent-example")
    assert agent._execution_harness_id == "claude_code_acp"
    assert "execution_harness_id" not in agent.model_dump() and "_execution_harness_id" not in agent.model_dump()
    override = chat.apply_config_override(agent, {"system_prompt": "Changed prompt", "execution_harness_id": "dynamic_agents"})
    assert override._execution_harness_id == "claude_code_acp"


async def test_native_default_has_no_additional_storage_or_provider_dependency() -> None:
    mongo = MagicMock()
    await require_native_execution(mongo, config(), "conversation-example", UserContext(email="owner@example.test"))
    assert not mongo.mock_calls


async def test_selected_coding_provider_requires_gateway_but_retains_pinned_native_conversation() -> None:
    agent = selected_agent()
    user = UserContext(email="owner@example.test", sub="owner-example")
    with pytest.raises(HTTPException) as error:
        await require_native_execution(None, agent, "conversation-example", user)
    assert error.value.status_code == 409 and error.value.detail["code"] == "HARNESS_ENGINE_GATEWAY_REQUIRED"
    calls = []

    def binding(query, projection):
        calls.append(query)
        return {"_id": "native-pinned"}

    mongo = SimpleNamespace(_db=SimpleNamespace(harness_gateway_bindings=SimpleNamespace(find_one=binding)))
    await require_native_execution(mongo, agent, "conversation-example", user)
    assert calls == [{"owner_subject": "owner-example", "agent_id": agent.id, "conversation_id": "conversation-example", "harness_id": "dynamic_agents"}]


async def test_graph_guard_does_not_block_platform_resource_preparation(monkeypatch) -> None:
    instance = runtime(monkeypatch, agent=selected_agent())
    assert (await instance.prepare_platform_resources()).system_prompt == "Help owner@example.test."
    build = MagicMock()
    monkeypatch.setattr("dynamic_agents.services.agent_runtime.create_deep_agent", build)
    with pytest.raises(HTTPException) as error:
        await instance.initialize()
    assert error.value.status_code == 409 and not build.called
    await instance.cleanup()


@pytest.mark.parametrize("path,body", [
    ("stream/start", {"message": "question"}),
    ("stream/start", {"message": "question", "autonomous": True}),
    ("stream/resume", {"resume_data": '{"type":"form_input","values":{}}'}),
    ("invoke", {"message": "question"}),
    ("invoke", {"message": "question", "config_override": {"backend": {"type": "store", "config": {"checkpoint_collection": "workflow_checkpoints"}}}}),
    ("restart-runtime", {}),
    ("stream/cancel", {}),
])
def test_direct_entrypoints_reject_selected_provider_before_graph_or_mcp_preparation(monkeypatch, path, body) -> None:
    agent = selected_agent()
    mongo = SimpleNamespace(_db=None, get_agent=lambda agent_id: agent, get_agent_mcp_servers=MagicMock())
    monkeypatch.setattr(chat, "_enforce_chat_authz", AsyncMock())
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    app = FastAPI()
    app.include_router(chat.router)
    app.dependency_overrides[get_mongo_service] = lambda: mongo
    app.dependency_overrides[get_user_context] = lambda: UserContext(email="owner@example.test", sub="owner-example")
    with TestClient(app) as client:
        response = client.post("/chat/" + path, json={"agent_id": agent.id, "conversation_id": "conversation-example", **body})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "HARNESS_ENGINE_GATEWAY_REQUIRED"
    assert not mongo.get_agent_mcp_servers.called
