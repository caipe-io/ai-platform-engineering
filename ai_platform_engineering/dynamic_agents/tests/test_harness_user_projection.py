"""Credentials stay in server tool closures, never model-visible projections."""

from __future__ import annotations

import json

from dynamic_agents.models import BuiltinToolsConfig, DynamicAgentConfig, UserContext
from dynamic_agents.services import agent_runtime
from dynamic_agents.services.agent_runtime import AgentRuntime, _render_system_prompt
from dynamic_agents.services.builtin_tools import create_user_info_tool
from tests.test_native_acp_mongodb import native_database as native_database


def _user():
    return UserContext(email="owner@example.com", name="Owner", access_token="access-token-must-stay-server-side",
        obo_jwt="obo-token-must-stay-server-side", raw_claims={"secret": "raw-claims-must-stay-server-side"}, is_admin=False)


def _assert_public(value):
    encoded = json.dumps(value)
    assert "owner@example.com" in encoded
    assert "access-token-must-stay-server-side" not in encoded
    assert "obo-token-must-stay-server-side" not in encoded
    assert "raw-claims-must-stay-server-side" not in encoded
    assert not {"access_token", "obo_jwt", "raw_claims"}.intersection(value)


def test_user_info_projection_omits_bearers_and_raw_claims():
    _assert_public(create_user_info_tool(_user()).invoke({}))


def test_rendered_prompt_user_projection_omits_bearers_and_raw_claims():
    rendered = _render_system_prompt("{{ user | tojson }}", None, _user())
    _assert_public(json.loads(rendered))


async def test_workflow_trigger_user_projection_omits_credentials_but_server_client_keeps_obo(native_database, monkeypatch):
    state = native_database
    state.db["workflow_configs"].insert_one({"_id": "fixture-workflow", "name": "Fixture workflow", "steps": []})
    captured = {}

    def workflow_tools(client, _identifiers, **options):
        captured["context"] = options["trigger_context"]
        captured["client"] = client
        return []

    monkeypatch.setattr(agent_runtime, "create_workflow_tools", workflow_tools)
    agent = DynamicAgentConfig(_id="projection-agent", name="Projection", owner_id=state.user.email,
        system_prompt="Assist.", model={"id": "fixture-model", "provider": "fixture-provider"},
        builtin_tools=BuiltinToolsConfig(workflows=["fixture-workflow"]))
    runtime = AgentRuntime(agent, [], settings=state.settings, mongo_service=state.mongo,
        mongo_client=state.client, session_id="projection-session", user=_user())
    try:
        await runtime.prepare_platform_resources()
        _assert_public(captured["context"]["user_context"])
        assert captured["client"]._headers()["Authorization"] == "Bearer obo-token-must-stay-server-side"
    finally:
        await runtime.cleanup()
