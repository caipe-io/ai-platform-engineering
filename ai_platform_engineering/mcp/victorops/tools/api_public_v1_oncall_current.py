# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Tool for the VictorOps current on-call endpoint."""

import json
import logging
from typing import Any, Optional

from api.client import make_api_request

logger = logging.getLogger("mcp_tools")


async def get_api_public_v1_oncall_current(
    team: str,
    escalation_policy: Optional[str] = None,
    org_slug: Optional[str] = None,
) -> str:
    """Get the users currently on call for a team, as computed by VictorOps.

    This calls ``GET /api-public/v1/oncall/current`` at request time. Unlike
    the team schedule endpoint, it does not require interpreting shifts,
    timestamps, or overrides locally. The upstream endpoint returns all teams
    in the organization and permits at most two requests per second. This tool
    returns only the requested team and, optionally, one policy.

    The ``users`` list is preserved as returned by VictorOps. It can contain
    zero, one, or multiple users; callers must not assume the first is primary.

    Args:
        team: Exact VictorOps team slug, as returned by get_api_public_v1_team.
        escalation_policy: Optional exact policy name or slug (for example,
            ``Primary``). If omitted, return all of the team's policies.
        org_slug: VictorOps organization slug. Required when multiple
            organizations are configured.
    """
    if not team.strip():
        return json.dumps({"error": "team must be a non-empty VictorOps team slug"}, indent=2)

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

    matching_teams: list[dict[str, Any]] = []
    for entry in response["teamsOnCall"]:
        if not isinstance(entry, dict):
            continue
        team_details = entry.get("team")
        if not isinstance(team_details, dict) or team_details.get("slug") != team:
            continue

        on_call_now = entry.get("onCallNow")
        if not isinstance(on_call_now, list):
            logger.error("Current on-call team has an unexpected policy format")
            return json.dumps({"error": "Unexpected current on-call policy format"}, indent=2)
        if escalation_policy is None:
            matching_teams.append(entry)
            continue

        matching_policies = [
            policy_entry
            for policy_entry in on_call_now
            if isinstance(policy_entry, dict)
            and isinstance(policy_entry.get("escalationPolicy"), dict)
            and escalation_policy in (
                policy_entry["escalationPolicy"].get("slug"),
                policy_entry["escalationPolicy"].get("name"),
            )
        ]
        matching_teams.append({**entry, "onCallNow": matching_policies})

    if not matching_teams:
        return json.dumps({"error": "Team not present in current on-call response"}, indent=2)
    if escalation_policy is not None and not any(entry["onCallNow"] for entry in matching_teams):
        return json.dumps({"error": "Policy not present in current on-call response"}, indent=2)

    return json.dumps({"teamsOnCall": matching_teams}, indent=2, default=str)
