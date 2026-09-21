# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-invoke entitled skill files for dynamic agents (T066, FR-020)."""

from __future__ import annotations

import logging
import os
from typing import Any

from ai_platform_engineering.skills_middleware.backend_sync import build_skills_files
from ai_platform_engineering.skills_middleware.catalog import get_merged_skills
from ai_platform_engineering.skills_middleware.entitlement import filter_skills_by_entitlement

logger = logging.getLogger(__name__)


def _apply_skill_summary_cap(skills: list[dict[str, Any]]) -> list[dict[str, Any]]:
    raw = os.getenv("MAX_SKILL_SUMMARIES_IN_PROMPT", "0").strip()
    try:
        n = int(raw)
    except ValueError:
        n = 0
    if n <= 0 or len(skills) <= n:
        return skills
    sorted_skills = sorted(
        skills,
        key=lambda s: (str(s.get("source", "")), str(s.get("name", "")).lower()),
    )
    return sorted_skills[:n]


def catalog_entitlement_bypass() -> bool:
    """Match ``GET /skills`` when OIDC issuer is unset (development / open catalog)."""
    return not (os.getenv("OIDC_ISSUER") or "").strip()


def build_entitled_skills_files(
    *,
    sub: str | None,
    team_ids: list[str] | None = None,
) -> dict[str, Any] | None:
    """Build StateBackend ``files`` for the entitled, prompt-capped skill set.

    Returns:
        ``files`` dict, or ``None`` if loading fails (caller may fall back to graph snapshot).
    """
    teams = list(team_ids or [])
    bypass = catalog_entitlement_bypass()

    try:
        skills = get_merged_skills(include_content=True)
        entitled = filter_skills_by_entitlement(
            skills,
            sub=sub,
            team_ids=teams,
            bypass_entitlement=bypass,
        )
        capped = _apply_skill_summary_cap(entitled)
        files, _sources = build_skills_files(capped)
        return files
    except Exception as e:
        logger.warning("build_entitled_skills_files failed: %s", e)
        return None
