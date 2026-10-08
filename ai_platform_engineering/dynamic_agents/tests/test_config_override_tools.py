"""Request overrides use the same tool-scope rules as runtime filtering."""

import pytest
from fastapi import HTTPException

from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.routes.chat import apply_config_override


@pytest.mark.parametrize("override", [True, [], ["write"], ["read", "write"]])
def test_override_cannot_broaden_an_explicit_tool_scope(override: list[str] | bool) -> None:
    agent = DynamicAgentConfig(
        _id="example", name="Example", owner_id="owner@example.com",
        model={"id": "example-model", "provider": "example-provider"},
        system_prompt="Assist the caller.", allowed_tools={"example-server": ["read"]},
    )
    with pytest.raises(HTTPException) as raised:
        apply_config_override(agent, {"allowed_tools": {"example-server": override}})
    assert raised.value.status_code == 400
    assert agent.allowed_tools == {"example-server": ["read"]}


@pytest.mark.parametrize("base", [True, []])
def test_override_can_narrow_a_legacy_all_tools_scope(base: list[str] | bool) -> None:
    agent = DynamicAgentConfig(
        _id="example", name="Example", owner_id="owner@example.com",
        model={"id": "example-model", "provider": "example-provider"},
        system_prompt="Assist the caller.", allowed_tools={"example-server": base},
    )
    narrowed = apply_config_override(agent, {"allowed_tools": {"example-server": ["read"]}})
    assert narrowed.allowed_tools == {"example-server": ["read"]}
    assert agent.allowed_tools == {"example-server": base}


@pytest.mark.parametrize("scope", [None, {"read": True}, "read", [1]])
def test_malformed_scope_is_a_client_error(scope: object) -> None:
    agent = DynamicAgentConfig(
        _id="example", name="Example", owner_id="owner@example.com",
        model={"id": "example-model", "provider": "example-provider"},
        system_prompt="Assist the caller.", allowed_tools={"example-server": True},
    )
    with pytest.raises(HTTPException) as raised:
        apply_config_override(agent, {"allowed_tools": {"example-server": scope}})
    assert raised.value.status_code == 400
