# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Tests for the computed current-on-call VictorOps tool."""

import asyncio
import importlib
import json
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

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
    monkeypatch.setattr(tool_mod, "_MIN_REQUEST_INTERVAL_SECONDS", 0)
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


def _mock_results(monkeypatch: pytest.MonkeyPatch, current_tool: ModuleType, *results: tuple[bool, dict[str, Any]]) -> None:
    monkeypatch.setattr(current_tool, "make_api_request", AsyncMock(side_effect=results))


@pytest.mark.asyncio
async def test_filters_exact_team_and_policy_name_without_dropping_users(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, str, str | None, dict[str, Any] | None, dict[str, Any] | None]] = []
    response = _on_call_response()
    response["teamsOnCall"].append(None)

    async def fake_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        requests.append((path, method, org_slug, params, data))
        return (True, response)

    monkeypatch.setattr(current_tool, "make_api_request", fake_request)
    result = await current_tool.get_api_public_v1_oncall_current(
        team=" team-example ", escalation_policy="Primary", org_slug="example-org",
    )

    assert requests == [("/api-public/v1/oncall/current", "GET", "example-org", {}, {})]
    teams = json.loads(result)["teamsOnCall"]
    assert len(teams) == 1 and teams[0]["team"]["slug"] == "team-example"
    assert [entry["escalationPolicy"]["name"] for entry in teams[0]["onCallNow"]] == ["Primary"]
    assert [user["onCallUser"]["username"] for user in teams[0]["onCallNow"][0]["users"]] == [
        "first@example.com", "second@example.com",
    ]


@pytest.mark.asyncio
async def test_exact_spaced_policy_name_matches_with_unrelated_malformed_users(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _on_call_response()
    response["teamsOnCall"][0]["onCallNow"][0]["users"] = None
    response["teamsOnCall"][0]["onCallNow"][1]["escalationPolicy"]["name"] = " Primary "
    _mock_results(monkeypatch, current_tool, (True, response))
    result = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy=" Primary ",
    )

    policies = json.loads(result)["teamsOnCall"][0]["onCallNow"]
    assert len(policies) == 1 and policies[0]["escalationPolicy"]["name"] == " Primary "


@pytest.mark.asyncio
async def test_policy_slug_takes_precedence_and_duplicate_names_are_rejected(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _on_call_response()
    response["teamsOnCall"][0]["onCallNow"][1]["escalationPolicy"]["name"] = "policy-primary"
    _mock_results(monkeypatch, current_tool, (True, response), (True, response))
    slug_result = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="policy-primary",
    )
    policies = json.loads(slug_result)["teamsOnCall"][0]["onCallNow"]
    assert [entry["escalationPolicy"]["slug"] for entry in policies] == ["policy-primary"]

    for entry in response["teamsOnCall"][0]["onCallNow"]:
        entry["escalationPolicy"]["name"] = "Primary"
    ambiguous_name = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="Primary",
    )
    assert json.loads(ambiguous_name) == {"error": "Policy name is ambiguous; use the policy slug"}


@pytest.mark.asyncio
async def test_paces_concurrent_requests_process_wide(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    started_at: list[float] = []
    clock = [10.0]
    active_sleeps = max_active_sleeps = 0

    def fake_monotonic() -> float:
        return clock[0]

    async def fake_sleep(delay: float) -> None:
        nonlocal active_sleeps, max_active_sleeps
        active_sleeps += 1
        max_active_sleeps = max(max_active_sleeps, active_sleeps)
        await asyncio.sleep(0)
        clock[0] += delay
        active_sleeps -= 1

    async def fake_request(
        path: str, method: str = "GET", org_slug: str | None = None,
        params: dict[str, Any] | None = None, data: dict[str, Any] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        started_at.append(fake_monotonic())
        return (True, _on_call_response())

    monkeypatch.setattr(current_tool, "_MIN_REQUEST_INTERVAL_SECONDS", 0.5)
    monkeypatch.setattr(current_tool, "time", SimpleNamespace(monotonic=fake_monotonic))
    monkeypatch.setattr(current_tool, "asyncio", SimpleNamespace(sleep=fake_sleep))
    monkeypatch.setattr(current_tool, "make_api_request", fake_request)
    calls = [current_tool.get_api_public_v1_oncall_current(team="team-example", org_slug=f"org-{index}") for index in range(3)]
    await asyncio.gather(*calls)

    assert started_at == [10.0, 10.5, 11.0]
    assert max_active_sleeps == 1


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
    response = _on_call_response()
    _mock_results(monkeypatch, current_tool, (True, response), (True, response))
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
    response = _on_call_response()
    response["teamsOnCall"][0]["onCallNow"][0]["users"] = []
    _mock_results(monkeypatch, current_tool, (True, response))
    result = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="Primary",
    )

    assert json.loads(result)["teamsOnCall"][0]["onCallNow"][0]["users"] == []


@pytest.mark.asyncio
async def test_duplicate_team_or_policy_slugs_fail_closed(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    duplicate_team = _on_call_response()
    duplicate_team["teamsOnCall"].append(_on_call_response()["teamsOnCall"][0])
    duplicate_policy = _on_call_response()
    duplicate_policy["teamsOnCall"][0]["onCallNow"][1]["escalationPolicy"]["slug"] = "policy-primary"
    _mock_results(monkeypatch, current_tool, (True, duplicate_team), (True, duplicate_policy))
    duplicate_team_result = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    duplicate_policy_result = await current_tool.get_api_public_v1_oncall_current(team="team-example")

    assert json.loads(duplicate_team_result) == {"error": "Multiple team entries in current on-call response"}
    assert json.loads(duplicate_policy_result) == {"error": "Unexpected current on-call policy format"}


@pytest.mark.asyncio
async def test_api_failure_and_unexpected_response_fail_closed(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    malformed_policy = {"teamsOnCall": [{"team": {"slug": "team-example"}}]}
    _mock_results(
        monkeypatch, current_tool,
        (False, {"error": "API request failed: 403"}),
        (True, {"unexpected": []}),
        (True, {"teamsOnCall": [None]}),
        (True, malformed_policy),
        (True, malformed_policy),
    )
    failure = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    assert json.loads(failure) == {"error": "API request failed: 403"}

    malformed = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    assert json.loads(malformed) == {"error": "Unexpected current on-call response format"}

    malformed_team = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    assert json.loads(malformed_team) == {"error": "Unexpected current on-call response format"}

    malformed_policy = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="Primary",
    )
    assert json.loads(malformed_policy) == {"error": "Unexpected current on-call policy format"}
    malformed_unfiltered = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    assert json.loads(malformed_unfiltered) == {"error": "Unexpected current on-call policy format"}


@pytest.mark.parametrize(
    "malformed_policy",
    [
        None,
        {"escalationPolicy": {"name": "Primary", "slug": None}, "users": []},
        {"escalationPolicy": {"name": "Primary", "slug": "policy-primary"}},
        {"escalationPolicy": {"name": "Primary", "slug": "policy-primary"}, "users": None},
        {"escalationPolicy": {"name": "Primary", "slug": "policy-primary"}, "users": [None]},
        {
            "escalationPolicy": {"name": "Primary", "slug": "policy-primary"},
            "users": [{"onCallUser": None}],
        },
        {
            "escalationPolicy": {"name": "Primary", "slug": "policy-primary"},
            "users": [{"onCallUser": {"username": None}}],
        },
        {
            "escalationPolicy": {"name": "Primary", "slug": "policy-primary"},
            "users": [{"onCallUser": {"username": "   "}}],
        },
        {"escalationPolicy": {"name": "   ", "slug": "policy-primary"}, "users": []},
        {"escalationPolicy": {"name": "Primary", "slug": "   "}, "users": []},
    ],
)
@pytest.mark.asyncio
async def test_malformed_nested_user_data_fails_closed(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch, malformed_policy: Any,
) -> None:
    response = _on_call_response()
    response["teamsOnCall"][0]["onCallNow"] = [malformed_policy]
    _mock_results(monkeypatch, current_tool, (True, response), (True, response))
    unfiltered = await current_tool.get_api_public_v1_oncall_current(team="team-example")
    filtered = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy="Primary",
    )

    expected = {"error": "Unexpected current on-call policy format"}
    assert json.loads(unfiltered) == expected
    assert json.loads(filtered) == expected


@pytest.mark.asyncio
async def test_empty_team_rejected_without_request(
    current_tool: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = AsyncMock()
    monkeypatch.setattr(current_tool, "make_api_request", request)
    team_error = await current_tool.get_api_public_v1_oncall_current(team="")
    policy_error = await current_tool.get_api_public_v1_oncall_current(
        team="team-example", escalation_policy=" ",
    )
    assert "error" in json.loads(team_error)
    assert "error" in json.loads(policy_error)
    request.assert_not_awaited()
