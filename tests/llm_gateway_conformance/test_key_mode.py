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
MAX_LIMIT_STORE_GRACE_SECONDS = 60
FAIL_CLOSED_PROBES = 3


@pytest.fixture(autouse=True)
def _key_mode_only(request: pytest.FixtureRequest, profile: GatewayProfile) -> None:
    if profile.auth != "key":
        pytest.skip(f"NOT_RUN: key-mode check, gateway profile uses auth={profile.auth}")
    fail_closed_run = request.node.name == "test_limit_store_down_fails_closed"
    if profile.limit_store_down != fail_closed_run:
        pytest.skip("NOT_RUN: runs only when LIMIT_STORE_DOWN matches this check")


def _assert_rejected_as_limit(response: httpx.Response, profile: GatewayProfile) -> None:
    """Only the gateway's limit statuses count; 401, 403 or 404 would mean a broken fixture, not enforcement."""
    assert response.status_code in profile.limit_statuses, f"expected a limit rejection {sorted(profile.limit_statuses)}, got {response.status_code}: {response.text[:300]}"
    if profile.limit_error_type:
        error = response.json().get("error")
        assert isinstance(error, dict), "expected a gateway error object for the limit rejection"
        assert error.get("type") == profile.limit_error_type, f"unexpected limit error type: {error.get('type')!r}"


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
    _assert_rejected_as_limit(_hit_limit(client, key, profile.model), profile)


def test_team_limit_rejects(client: httpx.Client, profile: GatewayProfile) -> None:
    key = require(profile.team_limit_key, "TEAM_LIMIT_KEY")
    _assert_rejected_as_limit(_hit_limit(client, key, profile.model), profile)


@pytest.mark.parametrize("status", [429, 500, 402])
def test_upstream_error_keeps_class(client: httpx.Client, profile: GatewayProfile, status: int) -> None:
    key = require(profile.key, "KEY")
    model = require(profile.error_models.get(status), f"ERROR_MODELS entry for {status}")
    response = chat(client, key, model)
    if status >= 500:
        assert response.status_code // 100 == 5, f"upstream {status} became {response.status_code}: {response.text[:300]}"
    else:
        assert response.status_code == status, f"upstream {status} became {response.status_code}: {response.text[:300]}"
    if status == 402:
        assert "quota" in response.text.lower(), "provider quota wording was dropped"


def test_limit_store_down_fails_closed(client: httpx.Client, profile: GatewayProfile, record_property) -> None:
    """After the declared grace window, measured from the outage, every request must be rejected."""
    key = require(profile.key, "KEY")
    down_at = require(profile.limit_store_down_at, "LIMIT_STORE_DOWN_AT (epoch seconds when the store was stopped)")
    assert profile.limit_store_grace_seconds <= MAX_LIMIT_STORE_GRACE_SECONDS, "the contract caps the grace window at 60 s"
    deadline = down_at + profile.limit_store_grace_seconds
    if time.time() >= deadline:
        pytest.skip("NOT_RUN: started after the grace window ended, so it cannot show when admission stopped; rerun right after stopping the store")
    first_rejection = None
    while time.time() < deadline:  # Early errors do not prove fail-closed; keep observing until the window ends.
        if first_rejection is None and chat(client, key, profile.model).status_code >= 400:
            first_rejection = time.time() - down_at
        time.sleep(1)
    after = [chat(client, key, profile.model).status_code for _ in range(FAIL_CLOSED_PROBES)]
    seen = "none" if first_rejection is None else f"{first_rejection:.0f}s"
    record_property("detail", f"first rejection after {seen}; after grace {profile.limit_store_grace_seconds:.0f}s: {after}")
    assert all(code >= 400 for code in after), f"requests admitted after the grace window: {after}"
