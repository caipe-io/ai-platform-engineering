# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Deterministic precedence and merge for the skill catalog.

Precedence order (highest wins):
  1. default  (filesystem / MongoDB built-in skills)
  2. agent_skills  (projected from agent_skills collection)
  3. hub  (external sources like GitHub; earlier registration wins among hubs)

When the same skill ``name`` appears from multiple sources, the highest-
precedence source wins.  Among hubs the catalog calls them in registration
order so the first hub's copy wins.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

SOURCE_PRIORITY: dict[str, int] = {
    "default": 0,       # highest priority (lowest number wins)
    "agent_skills": 1,
    "hub": 2,            # lowest priority
}


def merge_skills(
    *skill_lists: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge multiple skill lists with deterministic precedence.

    Skills are keyed by ``name``.  When the same name appears in more than
    one list, the entry with the highest precedence source wins.  Within
    the same source priority, the entry encountered first (earlier list or
    earlier position) wins.

    Args:
        *skill_lists: One or more lists of skill dicts (each must have
            ``name`` and ``source`` keys).

    Returns:
        Merged list of skill dicts, sorted by source priority then name
        for stable output.
    """
    merged: dict[str, dict[str, Any]] = {}

    for skills in skill_lists:
        for skill in skills:
            name = skill.get("name", "")
            if not name:
                continue
            source = skill.get("source", "hub")
            priority = SOURCE_PRIORITY.get(source, 99)

            existing = merged.get(name)
            if existing is None:
                merged[name] = skill
            else:
                existing_priority = SOURCE_PRIORITY.get(existing.get("source", "hub"), 99)
                # Lower number = higher priority
                if priority < existing_priority:
                    merged[name] = skill

    # Stable sort: by source priority, then by name
    result = sorted(
        merged.values(),
        key=lambda s: (SOURCE_PRIORITY.get(s.get("source", "hub"), 99), s.get("name", "")),
    )
    return result
