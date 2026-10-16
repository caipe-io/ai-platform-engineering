"""Qualified control-plane identity, transport and workspace boundaries."""

from __future__ import annotations

import json
import time

import httpx
import pytest

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.config import Settings
from dynamic_agents.services import sandbox_client
from dynamic_agents.services.native_state_protocol import STATE_CONTRACT
from dynamic_agents.services.sandbox_client import SandboxAllocation, SandboxClient, SandboxError, SandboxProfile

PROFILE = {"id": "example-harness", "name": "Example harness", "harness": "claude-code", "revision": "revision-1",
           "capabilities": {"mcp": True, "skills": True, "attachments": True}, "state_contract": STATE_CONTRACT}


def _client(monkeypatch, handler):
    original = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(sandbox_client.httpx, "AsyncClient", lambda **options: original(transport=transport, **options))
    return SandboxClient(Settings(sandbox_service_url="https://sandbox.example.test/portal"), bearer="example-bearer")


def _allocation(**updates):
    return {"id": "example-sandbox", "uid": "example-uid", "namespace": "example-namespace",
            "conversation_id": SandboxClient.conversation_reference("example-agent", "example-conversation"),
            "profile_id": PROFILE["id"], "revision": PROFILE["revision"], "cwd": "/workspace", "state": "Running", **updates}


async def test_control_plane_uses_only_approved_origin_and_verified_bearer(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer example-bearer"
        if request.method == "GET":
            return httpx.Response(200, json={"profiles": [PROFILE]})
        assert json.loads(request.content) == {
            "conversation_id": _allocation()["conversation_id"], "profile_id": PROFILE["id"], "revision": PROFILE["revision"],
        }
        return httpx.Response(201, json=_allocation())

    client = _client(monkeypatch, handler)
    profile = (await client.profiles())[0]
    allocation = await client.provision("example-agent", "example-conversation", profile)
    assert allocation.uid == "example-uid"
    assert [str(request.url) for request in requests] == [
        "https://sandbox.example.test/portal/api/caipe/profiles", "https://sandbox.example.test/portal/api/caipe/sandboxes",
    ]
    assert all("cookie" not in request.headers for request in requests)


@pytest.mark.parametrize("status", [302, 401, 403, 409, 503])
async def test_redirects_and_control_plane_failures_never_fall_back_or_expose_response(monkeypatch, status):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, headers={"Location": "https://other.example.test/steal"}, text="private upstream diagnostic")

    client = _client(monkeypatch, handler)
    with pytest.raises(SandboxError) as failure:
        await client.profiles()
    assert "private upstream" not in str(failure.value) and len(requests) == 1


async def test_lost_saved_environment_is_never_reprovisioned(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(404)

    client = _client(monkeypatch, handler)
    with pytest.raises(SandboxError):
        await client.restore(SandboxAllocation.model_validate(_allocation()), SandboxProfile.model_validate(PROFILE))
    assert [request.method for request in requests] == ["GET"]


@pytest.mark.parametrize("replacement", [{"uid": "different-uid"}, {"revision": "revision-2"}, {"cwd": "/other-workspace"}])
async def test_saved_identity_and_workspace_cannot_drift(monkeypatch, replacement):
    client = _client(monkeypatch, lambda request: httpx.Response(200, json=_allocation(**replacement)))
    with pytest.raises(SandboxError):
        await client.restore(SandboxAllocation.model_validate(_allocation()), SandboxProfile.model_validate(PROFILE))


async def test_duplicate_profile_ids_and_oversized_responses_fail_closed(monkeypatch):
    responses = [httpx.Response(200, json={"profiles": [PROFILE, PROFILE]}),
                 httpx.Response(200, content=b"x" * (sandbox_client.MAX_CONTROL_BYTES + 1))]
    client = _client(monkeypatch, lambda request: responses.pop(0))
    with pytest.raises(SandboxError, match="catalog"):
        await client.profiles()
    with pytest.raises(SandboxError, match="size"):
        await client.profiles()


def test_missing_verified_caller_does_not_use_user_context_or_a_service_credential():
    token = current_user_token.set(None)
    try:
        with pytest.raises(SandboxError, match="authenticated"):
            SandboxClient(Settings(sandbox_service_url="https://sandbox.example.test"))
    finally:
        current_user_token.reset(token)


async def test_explicit_delete_is_idempotent_and_uses_current_uid_and_resource_version(monkeypatch):
    requests = []
    responses = [httpx.Response(200, json=_allocation(resource_version="current-version")), httpx.Response(204), httpx.Response(404)]

    def handler(request):
        requests.append(request)
        return responses.pop(0)

    client = _client(monkeypatch, handler)
    allocation = SandboxAllocation.model_validate(_allocation(resource_version="stale-version"))
    profile = SandboxProfile.model_validate(PROFILE)
    await client.delete(allocation, profile)
    await client.delete(allocation, profile)
    assert [request.method for request in requests] == ["GET", "DELETE", "GET"]
    assert json.loads(requests[1].content) == {"conversation_id": allocation.conversation_id,
        "uid": allocation.uid, "resource_version": "current-version"}


@pytest.mark.parametrize("replacement", [{"uid": "new-generation"}, {"cwd": "/different"}, {"resource_version": ""}])
async def test_explicit_delete_rejects_replacement_identity_and_missing_precondition(monkeypatch, replacement):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=_allocation(resource_version="current-version") | replacement)

    client = _client(monkeypatch, handler)
    with pytest.raises(SandboxError, match="identity changed"):
        await client.delete(SandboxAllocation.model_validate(_allocation()), SandboxProfile.model_validate(PROFILE))
    assert [request.method for request in requests] == ["GET"]


async def test_execution_capture_grant_is_bound_and_never_sent_to_control_or_restore(monkeypatch):
    token = "caiperun." + "a" * 43
    requests = []
    allocation = SandboxAllocation.model_validate(_allocation())
    run_id = "11111111-1111-4111-8111-111111111111"

    def handler(request):
        requests.append(request)
        body = json.loads(request.content) if request.content else None
        if request.url.path.endswith("/execution-grant") and request.method == "POST":
            assert "X-CAIPE-Execution-Grant" not in request.headers
            return httpx.Response(201, json={**body, "token": token, "expires_at": int(time.time()) + 60})
        if request.url.path.endswith("/execution-grant"):
            assert request.headers["X-CAIPE-Execution-Grant"] == token
            return httpx.Response(204)
        return httpx.Response(200, json={"files": [], "truncated": False})

    client = _client(monkeypatch, handler)
    async with client.execution(allocation, run_id):
        await client.workspace_files(allocation)
        assert requests[-1].headers["X-CAIPE-Execution-Grant"] == token
        for method, suffix in [("GET", ""), ("PUT", "/workspace"), ("POST", "/state/restore"), ("POST", "/acp"), ("POST", "/resume"), ("DELETE", "")]:
            assert "X-CAIPE-Execution-Grant" not in client._headers(method, f"/api/caipe/sandboxes/{allocation.id}{suffix}")
        assert "X-CAIPE-Execution-Grant" not in client._headers("GET", "/api/caipe/sandboxes/other/workspace/content")
        assert "X-CAIPE-Execution-Grant" not in client._headers("GET", "/api/caipe/profiles")
    assert client._execution is None
    assert requests[-1].method == "DELETE"


@pytest.mark.parametrize("change", [{"token": "bad"}, {"uid": "different"}, {"expires_at": 0}, {"expires_at": True}, {"expires_at": 99999999999}])
async def test_invalid_capture_grant_blocks_execution_before_prompt(monkeypatch, change):
    allocation = SandboxAllocation.model_validate(_allocation())

    def handler(request):
        body = json.loads(request.content)
        return httpx.Response(201, json={**body, "token": "caiperun." + "a" * 43,
            "expires_at": int(time.time()) + 60, **change})

    client = _client(monkeypatch, handler)
    with pytest.raises(SandboxError, match="grant is invalid"):
        async with client.execution(allocation, "11111111-1111-4111-8111-111111111111"):
            pytest.fail("An invalid grant cannot start native execution")
    assert client._execution is None
