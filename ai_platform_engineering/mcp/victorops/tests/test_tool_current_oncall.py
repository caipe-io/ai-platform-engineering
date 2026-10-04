# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Tests for the computed current-on-call VictorOps tool."""

import importlib
import json
from types import ModuleType
from typing import Any

import pytest


@pytest.fixture
def current_tool(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    monkeypatch.setenv("VICTOROPS_API_URL", "https://example.com")
    monkeypatch.setenv("X_VO_API_KEY", "test-key")
    monkeypatch.setenv("X_VO_API_ID", "test-id")
    monkeypatch.delenv("VICTOROPS_ORGS", raising=False)

    import api.client as client_mod
    import tools.api_public_v1_oncall_current as tool_mod

    importlib.reload(client_mod)
    importlib.reload(tool_mod)
    return tool_mod


def _on_call_response() -> dict[str, Any]:
    return {
        "teamsOnCall": [
            {
                "team": {"name": "Example", "slug": "team-example"},
                "onCallNow": [
                    {
                        "escalationPolicy": {"name": "Primary", "slug": "policy-primary"},
                        "users": [
                            {"onCallUser": {"username": "first@example.com"}},
                            {"onCallUser": {"username": "second@example.com"}},
                        ],
                    },
                    {
                        "escalationPolicy": {"name": "Secondary", "slug": "policy-secondary"},
                        "users": [{"onCallUser": {"username": "backup@example.com"}}],
                    },
                ],
            },
            {
                "team": {"name": "Other", "slug": "team-other"},
                "onCallNow": [
                    {
                        "escalationPolicy": {"name": "Primary", "slug": "other-primary"},
                        "users": [{"onCallUser": {"username": "other@example.com"}}],
                    },
                ],
            },
        ],
    }


@pytest.mark.asyncio
async def test_filters_exact_team_and_policy_name_without_dropping_users(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, str, str | None, dict[str, Any] | None, dict[str, Any] | None]] = []

    async def fake_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        requests.append((path, method, org_slug, params, data))
        return (True, _on_call_response())

    monkeypatch.setattr(current_tool, "make_api_request", fake_request)
    result = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="Primary", org_slug="example-org",
    )

    assert requests == [("/api-public/v1/oncall/current", "GET", "example-org", {}, {})]
    assert isinstance(result, str) and result.count("\n") > 10
    teams = json.loads(result)["teamsOnCall"]
    assert len(teams) == 1
    assert teams[0]["team"]["slug"] == "team-example"
    assert [entry["escalationPolicy"]["name"] for entry in teams[0]["onCallNow"]] == ["Primary"]
    assert [user["onCallUser"]["username"] for user in teams[0]["onCallNow"][0]["users"]] == [
        "first@example.com", "second@example.com",
    ]


@pytest.mark.asyncio
async def test_policy_slug_also_matches(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        return (True, _on_call_response())

    monkeypatch.setattr(current_tool, "make_api_request", fake_request)
    result = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="policy-secondary",
    )

    policies = json.loads(result)["teamsOnCall"][0]["onCallNow"]
    assert len(policies) == 1
    assert policies[0]["escalationPolicy"]["name"] == "Secondary"


@pytest.mark.asyncio
async def test_unfiltered_policies_and_fresh_request_each_time(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        nonlocal calls
        calls += 1
        response = _on_call_response()
        response["teamsOnCall"][0]["onCallNow"][0]["users"][0]["onCallUser"]["username"] = (
            f"person-{calls}@example.com"
        )
        return (True, response)

    monkeypatch.setattr(current_tool, "make_api_request", fake_request)
    first = json.loads(await current_tool.get_api_public_v1_oncall_current(team="team-example"))
    second = json.loads(await current_tool.get_api_public_v1_oncall_current(team="team-example"))

    assert calls == 2
    assert len(first["teamsOnCall"][0]["onCallNow"]) == 2
    assert first["teamsOnCall"][0]["onCallNow"][0]["users"][0]["onCallUser"]["username"] == (
        "person-1@example.com"
    )
    assert second["teamsOnCall"][0]["onCallNow"][0]["users"][0]["onCallUser"]["username"] == (
        "person-2@example.com"
    )


@pytest.mark.asyncio
async def test_missing_team_and_policy_return_errors(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        return (True, _on_call_response())

    monkeypatch.setattr(current_tool, "make_api_request", fake_request)
    missing_team = await current_tool.get_api_public_v1_oncall_current(team="team-missing")
    missing_policy = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="policy-missing",
    )

    assert json.loads(missing_team) == {"error": "Team not present in current on-call response"}
    assert json.loads(missing_policy) == {"error": "Policy not present in current on-call response"}


@pytest.mark.asyncio
async def test_existing_policy_with_no_users_is_not_a_missing_policy(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        response = _on_call_response()
        response["teamsOnCall"][0]["onCallNow"][0]["users"] = []
        return (True, response)

    monkeypatch.setattr(current_tool, "make_api_request", fake_request)
    result = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="Primary",
    )

    assert json.loads(result)["teamsOnCall"][0]["onCallNow"][0]["users"] == []


@pytest.mark.asyncio
async def test_api_failure_and_unexpected_response_fail_closed(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failed_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        return (False, {"error": "API request failed: 403"})

    monkeypatch.setattr(current_tool, "make_api_request", failed_request)
    failure = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    assert json.loads(failure) == {"error": "API request failed: 403"}

    async def malformed_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        return (True, {"unexpected": []})

    monkeypatch.setattr(current_tool, "make_api_request", malformed_request)
    malformed = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    assert json.loads(malformed) == {"error": "Unexpected current on-call response format"}

    async def malformed_policy_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        return (True, {"teamsOnCall": [{"team": {"slug": "team-example"}}]})

    monkeypatch.setattr(current_tool, "make_api_request", malformed_policy_request)
    malformed_policy = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="Primary",
    )
    assert json.loads(malformed_policy) == {"error": "Unexpected current on-call policy format"}
    malformed_unfiltered = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    assert json.loads(malformed_unfiltered) == {"error": "Unexpected current on-call policy format"}


@pytest.mark.asyncio
async def test_empty_team_rejected_without_request(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unexpected_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        pytest.fail("A request with an empty team slug must not reach VictorOps")

    monkeypatch.setattr(current_tool, "make_api_request", unexpected_request)
    result = await current_tool.get_api_public_v1_oncall_current(team="")
    assert "error" in json.loads(result)
