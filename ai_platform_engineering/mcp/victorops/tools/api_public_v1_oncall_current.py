# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Tool for the VictorOps current on-call endpoint."""

import asyncio
import json
import logging
import time
from typing import Any, Optional

from api.client import make_api_request

logger = logging.getLogger("mcp_tools")

_MIN_REQUEST_INTERVAL_SECONDS = 0.5
_request_lock = asyncio.Lock()
_last_request_started_at = 0.0


async def _wait_for_request_slot() -> None:
    """Pace process-wide requests to the endpoint's two-per-second limit."""
    global _last_request_started_at

    async with _request_lock:
        delay = _last_request_started_at + _MIN_REQUEST_INTERVAL_SECONDS - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        _last_request_started_at = time.monotonic()


def _validated_policies(on_call_now: Any, *, validate_users: bool = True) -> Optional[list[dict[str, Any]]]:
    """Return policies only when the nested current-on-call payload is usable."""
    if not isinstance(on_call_now, list):
        return None

    validated: list[dict[str, Any]] = []
    policy_slugs: set[str] = set()
    for entry in on_call_now:
        if not isinstance(entry, dict):
            return None
        policy = entry.get("escalationPolicy")
        users = entry.get("users")
        if not isinstance(policy, dict) or (validate_users and not isinstance(users, list)):
            return None
        if any(key in policy and (not isinstance(policy[key], str) or not policy[key].strip()) for key in ("slug", "name")):
            return None
        if not any(isinstance(policy.get(key), str) and policy[key].strip() for key in ("slug", "name")):
            return None
        policy_slug = policy.get("slug")
        if policy_slug is not None:
            if policy_slug in policy_slugs:
                return None
            policy_slugs.add(policy_slug)
        for user_entry in users if validate_users else []:
            if not isinstance(user_entry, dict):
                return None
            on_call_user = user_entry.get("onCallUser")
            if (
                not isinstance(on_call_user, dict)
                or not isinstance(on_call_user.get("username"), str)
                or not on_call_user["username"].strip()
            ):
                return None
        validated.append(entry)
    return validated


def _select_policy(policies: list[dict[str, Any]], identifier: str) -> tuple[list[dict[str, Any]], Optional[str]]:
    """Select one policy, preferring its unique slug over its display name."""
    slug_matches = [entry for entry in policies if entry["escalationPolicy"].get("slug") == identifier]
    if len(slug_matches) == 1:
        return slug_matches, None

    name_matches = [
        entry for entry in policies if entry["escalationPolicy"].get("name") == identifier
    ]
    if len(name_matches) == 1:
        return name_matches, None
    if len(name_matches) > 1:
        return [], "Policy name is ambiguous; use the policy slug"
    return [], "Policy not present in current on-call response"


async def get_api_public_v1_oncall_current(
    team: str,
    escalation_policy: Optional[str] = None,
    org_slug: Optional[str] = None,
) -> str:
    """Get the users currently on call for a team, as computed by VictorOps.

    Calls ``GET /api-public/v1/oncall/current`` at request time. Filters the
    organization-wide result to the requested team and optional policy,
    using VictorOps' computed users instead of reconstructing shifts.

    The ``users`` list is preserved as returned by VictorOps. It can contain
    zero, one, or multiple users; callers must not assume the first is primary.

    Args:
        team: Exact VictorOps team slug, as returned by get_api_public_v1_team.
        escalation_policy: Optional exact policy name or slug (for example,
            ``Primary``). If omitted, return all of the team's policies.
        org_slug: VictorOps organization slug. Required when multiple
            organizations are configured.
    """
    if not isinstance(team, str) or not team.strip():
        return json.dumps({"error": "team must be a non-empty VictorOps team slug"}, indent=2)
    team = team.strip()
    if escalation_policy is not None:
        if not isinstance(escalation_policy, str) or not escalation_policy.strip():
            return json.dumps({"error": "escalation_policy must be a non-empty policy name or slug"}, indent=2)

    await _wait_for_request_slot()
    success, response = await make_api_request(
        "/api-public/v1/oncall/current", method="GET",
        org_slug=org_slug, params={}, data={},
    )
    if not success:
        logger.error("Current on-call request failed: %s", response.get("error"))
        return json.dumps({"error": response.get("error", "Request failed")}, indent=2)

    if not isinstance(response, dict) or not isinstance(response.get("teamsOnCall"), list):
        logger.error("Current on-call response has an unexpected format")
        return json.dumps({"error": "Unexpected current on-call response format"}, indent=2)

    teams_on_call = response["teamsOnCall"]
    valid_teams = [
        entry for entry in teams_on_call if isinstance(entry, dict) and isinstance(entry.get("team"), dict) and isinstance(entry["team"].get("slug"), str) and entry["team"]["slug"]
    ]
    matching_teams = [entry for entry in valid_teams if entry["team"]["slug"] == team]
    if not matching_teams:
        if len(valid_teams) != len(teams_on_call):
            return json.dumps({"error": "Unexpected current on-call response format"}, indent=2)
        return json.dumps({"error": "Team not present in current on-call response"}, indent=2)
    if len(matching_teams) != 1:
        return json.dumps({"error": "Multiple team entries in current on-call response"}, indent=2)

    team_entry = matching_teams[0]
    policies = _validated_policies(team_entry.get("onCallNow"), validate_users=escalation_policy is None)
    if policies is None:
        logger.error("Current on-call team has an unexpected policy format")
        return json.dumps({"error": "Unexpected current on-call policy format"}, indent=2)
    if escalation_policy is not None:
        policies, selection_error = _select_policy(policies, escalation_policy)
        if selection_error is not None:
            return json.dumps({"error": selection_error}, indent=2)
        policies = _validated_policies(policies)
        if policies is None:
            return json.dumps({"error": "Unexpected current on-call policy format"}, indent=2)
        team_entry = {**team_entry, "onCallNow": policies}

    return json.dumps({"teamsOnCall": [team_entry]}, indent=2, default=str)
