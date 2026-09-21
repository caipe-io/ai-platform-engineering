# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Visibility defaults and entitlement filtering (FR-020).

Caller sees union of: all ``global`` skills; ``team`` skills where
``team_ids`` intersects caller teams; ``personal`` where ``owner_user_id``
matches caller ``sub``.
"""

from __future__ import annotations

import os
from typing import Any, Iterable

_VALID_VISIBILITY = frozenset({"global", "team", "personal"})


def apply_visibility_defaults(skill: dict[str, Any]) -> dict[str, Any]:
    """Ensure skill dict has ``visibility``, ``team_ids``, ``owner_user_id`` (mutates in place)."""
    vis = skill.get("visibility")
    if vis not in _VALID_VISIBILITY:
        skill["visibility"] = "global"
    team_ids = skill.get("team_ids")
    if team_ids is None or not isinstance(team_ids, list):
        skill["team_ids"] = []
    else:
        skill["team_ids"] = [str(t) for t in team_ids if t is not None]
    owner = skill.get("owner_user_id")
    skill["owner_user_id"] = str(owner) if owner is not None else None
    return skill


def normalize_merged_skills(skills: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply visibility defaults to every skill after merge."""
    out: list[dict[str, Any]] = []
    for s in skills:
        skill = dict(s)
        apply_visibility_defaults(skill)
        out.append(skill)
    return out


def team_ids_from_claims(claims: dict[str, Any]) -> list[str]:
    """Read team / group ids from JWT claims.

    Uses ``OIDC_TEAMS_CLAIM`` if set, else ``OIDC_GROUP_CLAIM`` (align with UI), else ``groups``.
    """
    claim_name = (
        os.getenv("OIDC_TEAMS_CLAIM", "").strip()
        or os.getenv("OIDC_GROUP_CLAIM", "").strip()
        or "groups"
    )
    raw = claims.get(claim_name)
    if raw is None:
        # Common alternates
        for alt in ("teams", "cognito:groups", "groups"):
            raw = claims.get(alt)
            if raw is not None:
                break
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [str(x) for x in raw if x is not None]
    return []


def skill_visible_to_principal(
    skill: dict[str, Any],
    *,
    sub: str | None,
    team_ids: frozenset[str],
    bypass_entitlement: bool,
) -> bool:
    """Return True if the skill is visible to the caller."""
    if bypass_entitlement:
        return True

    vis = skill.get("visibility", "global")

    if vis == "global":
        return True

    if vis == "personal":
        if sub is None:
            return False
        return skill.get("owner_user_id") == sub

    if vis == "team":
        st = skill.get("team_ids") or []
        if not st:
            return False
        if not team_ids:
            return False
        return bool(team_ids & frozenset(st))

    return True


def filter_skills_by_entitlement(
    skills: list[dict[str, Any]],
    *,
    sub: str | None,
    team_ids: Iterable[str],
    bypass_entitlement: bool,
) -> list[dict[str, Any]]:
    """Filter merged catalog to entitled subset."""
    teams = frozenset(team_ids)
    return [
        s
        for s in skills
        if skill_visible_to_principal(
            s, sub=sub, team_ids=teams, bypass_entitlement=bypass_entitlement
        )
    ]


def filter_by_visibility_param(
    skills: list[dict[str, Any]],
    visibility: str,
) -> list[dict[str, Any]]:
    """Optional query filter: only skills matching this visibility value."""
    v = visibility.strip().lower()
    if v not in _VALID_VISIBILITY:
        return skills
    return [s for s in skills if s.get("visibility", "global") == v]
