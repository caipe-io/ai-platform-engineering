"""Autonomous runs require team entitlement in addition to agent access."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from dynamic_agents.routes import chat as chat_routes


@pytest.mark.asyncio
async def test_autonomous_run_requires_entitlement(monkeypatch):
    calls = {"use": False, "autonomous": False}

    async def fake_use(agent_id, delegated_user_sub=None):
        calls["use"] = True

    async def fake_autonomous(delegated_user_sub=None):
        calls["autonomous"] = True
        raise HTTPException(status_code=403, detail={"code": "organization#automate"})

    monkeypatch.setattr(chat_routes, "require_agent_use_permission", fake_use)
    monkeypatch.setattr(chat_routes, "require_autonomous_permission", fake_autonomous)

    with pytest.raises(HTTPException) as exc:
        await chat_routes._enforce_chat_authz(agent_id="agent-x", user_sub="owner-1", autonomous=True)
    assert exc.value.status_code == 403
    assert calls == {"use": True, "autonomous": True}


@pytest.mark.asyncio
async def test_interactive_run_skips_autonomous_entitlement(monkeypatch):
    calls = {"use": False, "autonomous": False}

    async def fake_use(agent_id, delegated_user_sub=None):
        calls["use"] = True

    async def fake_autonomous(delegated_user_sub=None):
        calls["autonomous"] = True

    monkeypatch.setattr(chat_routes, "require_agent_use_permission", fake_use)
    monkeypatch.setattr(chat_routes, "require_autonomous_permission", fake_autonomous)

    await chat_routes._enforce_chat_authz(agent_id="agent-x", user_sub="u-1", autonomous=False)
    assert calls == {"use": True, "autonomous": False}
