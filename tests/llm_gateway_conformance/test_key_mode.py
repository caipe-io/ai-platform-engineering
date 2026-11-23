"""Key-mode checks from the gateway conformance contract (contracts/routing-backend-contract.md).

Each test is one check. Run against a live gateway; see README.md in this folder.
"""

import json
import time

import httpx
import pytest

from .gateway import GatewayProfile, chat, require

pytestmark = pytest.mark.integration

LIMIT_ATTEMPTS = 5


@pytest.fixture(autouse=True)
def _key_mode_only(request: pytest.FixtureRequest, profile: GatewayProfile) -> None:
    if profile.auth != "key":
        pytest.skip(f"NOT_RUN: key-mode check, gateway profile uses auth={profile.auth}")
    fail_closed_run = request.node.name == "test_limit_store_down_fails_closed"
    if profile.limit_store_down != fail_closed_run:
        pytest.skip("NOT_RUN: runs only when LIMIT_STORE_DOWN matches this check")


def _assert_rejected_as_limit(response: httpx.Response) -> None:
    assert 400 <= response.status_code < 500, f"limit rejection should be a 4xx, got {response.status_code}: {response.text[:300]}"
    assert response.status_code != 401, f"limit key was rejected as unauthenticated: {response.text[:300]}"


def _hit_limit(client: httpx.Client, key: str, model: str) -> httpx.Response:
    """Spend against a tiny limit until the gateway rejects; usage may be recorded asynchronously."""
    response = chat(client, key, model)
    for _ in range(LIMIT_ATTEMPTS):
        if response.status_code >= 400:
            return response
        time.sleep(1)
        response = chat(client, key, model)
    return response


def test_no_credential_is_401(client: httpx.Client, profile: GatewayProfile) -> None:
    assert chat(client, None, profile.model).status_code == 401


def test_invalid_key_is_401(client: httpx.Client, profile: GatewayProfile) -> None:
    assert chat(client, "sk-conformance-invalid", profile.model).status_code == 401


def test_revoked_key_is_401(client: httpx.Client, profile: GatewayProfile) -> None:
    key = require(profile.revoked_key, "REVOKED_KEY")
    assert chat(client, key, profile.model).status_code == 401


def test_models_endpoint_lists_model(client: httpx.Client, profile: GatewayProfile) -> None:
    key = require(profile.key, "KEY")
    response = client.get("/v1/models", headers={"Authorization": f"Bearer {key}"})
    assert response.status_code == 200, response.text[:300]
    assert profile.model in {item["id"] for item in response.json()["data"]}


def test_completion(client: httpx.Client, profile: GatewayProfile) -> None:
    key = require(profile.key, "KEY")
    response = chat(client, key, profile.model)
    assert response.status_code == 200, response.text[:300]
    body = response.json()
    assert body["choices"][0]["message"]["content"]
    assert body["usage"]["total_tokens"] > 0


def test_streaming_completion(client: httpx.Client, profile: GatewayProfile) -> None:
    key = require(profile.key, "KEY")
    body = {"model": profile.model, "stream": True, "messages": [{"role": "user", "content": "Reply with one word."}]}
    with client.stream("POST", "/v1/chat/completions", headers={"Authorization": f"Bearer {key}"}, json=body) as response:
        assert response.status_code == 200
        events = [line.removeprefix("data: ") for line in response.iter_lines() if line.startswith("data: ")]
    assert events and events[-1] == "[DONE]"
    text = "".join((json.loads(e)["choices"] or [{}])[0].get("delta", {}).get("content") or "" for e in events[:-1])
    assert text


def test_tool_call(client: httpx.Client, profile: GatewayProfile) -> None:
    key = require(profile.key, "KEY")
    tool = {"type": "function", "function": {"name": "get_time", "description": "Current time.", "parameters": {"type": "object", "properties": {}}}}
    response = chat(client, key, profile.model, tools=[tool], tool_choice="required")
    assert response.status_code == 200, response.text[:300]
    calls = response.json()["choices"][0]["message"].get("tool_calls") or []
    assert calls and calls[0]["function"]["name"] == "get_time"


def test_agent_limit_rejects(client: httpx.Client, profile: GatewayProfile) -> None:
    key = require(profile.agent_limit_key, "AGENT_LIMIT_KEY")
    _assert_rejected_as_limit(_hit_limit(client, key, profile.model))


def test_team_limit_rejects(client: httpx.Client, profile: GatewayProfile) -> None:
    key = require(profile.team_limit_key, "TEAM_LIMIT_KEY")
    _assert_rejected_as_limit(_hit_limit(client, key, profile.model))


@pytest.mark.parametrize("status", [429, 500, 402])
def test_upstream_error_keeps_class(client: httpx.Client, profile: GatewayProfile, status: int) -> None:
    key = require(profile.key, "KEY")
    model = require(profile.error_models.get(status), f"ERROR_MODELS entry for {status}")
    response = chat(client, key, model)
    assert response.status_code // 100 == status // 100, f"upstream {status} became {response.status_code}: {response.text[:300]}"
    if status == 402:
        assert response.status_code == 402, f"quota error changed class: {response.status_code}"
        assert "quota" in response.text.lower(), "provider quota wording was dropped"


def test_limit_store_down_fails_closed(client: httpx.Client, profile: GatewayProfile, record_property) -> None:
    """Some gateways keep admitting cached credentials for a bounded window; the profile declares it."""
    key = require(profile.key, "KEY")
    started = time.monotonic()
    response = chat(client, key, profile.model)
    while response.status_code < 400 and time.monotonic() - started < profile.limit_store_grace_seconds:
        time.sleep(1)
        response = chat(client, key, profile.model)
    elapsed = time.monotonic() - started
    record_property("detail", f"first rejection {response.status_code} after {elapsed:.0f}s (grace {profile.limit_store_grace_seconds:.0f}s)")
    assert response.status_code >= 400, f"requests still admitted {elapsed:.0f}s after the limit store went down"
