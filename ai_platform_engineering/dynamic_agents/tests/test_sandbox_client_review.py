"""Review regressions for immutable sandbox identity across control-plane transitions."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest

from dynamic_agents.config import Settings
from dynamic_agents.services import sandbox_client
from dynamic_agents.services.native_state_protocol import STATE_CONTRACT
from dynamic_agents.services.sandbox_client import SandboxAllocation, SandboxClient, SandboxError, SandboxProfile

PROFILE = SandboxProfile(id="primary", name="Primary", harness="claude-code", revision="v1", state_contract=STATE_CONTRACT)
REFERENCE = "11111111-2222-4333-8444-555555555555"


def allocation(**updates: Any) -> dict[str, Any]:
    return {
        "id": "primary", "uid": "original-uid", "namespace": "primary", "conversation_id": REFERENCE,
        "profile_id": PROFILE.id, "revision": PROFILE.revision, "cwd": "/workspace", "state": "Suspended", **updates,
    }


def client(monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]) -> SandboxClient:
    original = httpx.AsyncClient
    monkeypatch.setattr(sandbox_client.httpx, "AsyncClient", lambda **options: original(transport=httpx.MockTransport(handler), **options))
    return SandboxClient(Settings(sandbox_service_url="https://sandbox.example.test"), bearer="example-token")


@pytest.mark.parametrize("replacement", [{"uid": "replacement-uid"}, {"id": "replacement"}, {"namespace": "replacement"}, {"cwd": "/replacement-workspace"}])
async def test_resume_response_cannot_replace_pinned_environment(monkeypatch: pytest.MonkeyPatch, replacement: dict[str, str]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=allocation(**({"state": "Ready", **replacement} if request.method == "POST" else {})))

    saved = SandboxAllocation.model_validate(allocation())
    with pytest.raises(SandboxError, match="identity|bound|workspace|migration"):
        await client(monkeypatch, handler).restore(saved, PROFILE)


async def test_waiting_restore_cannot_change_pinned_workspace_during_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=allocation(state="Starting" if calls == 1 else "Ready", **({"cwd": "/replacement-workspace"} if calls > 1 else {})))

    async def immediate(_delay: float) -> None:
        return None

    monkeypatch.setattr(sandbox_client.asyncio, "sleep", immediate)
    saved = SandboxAllocation.model_validate(allocation())
    with pytest.raises(SandboxError, match="identity|bound|workspace|migration"):
        await client(monkeypatch, handler).restore(saved, PROFILE)
