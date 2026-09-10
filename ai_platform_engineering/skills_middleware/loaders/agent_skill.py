# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Agent skills loader — projects agent_skills from MongoDB as skills."""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def _extract_llm_prompt(doc: dict[str, Any]) -> str:
  """Extract llm_prompt from tasks[0] for template-based skills."""
  tasks = doc.get("tasks")
  if isinstance(tasks, list) and tasks:
    return tasks[0].get("llm_prompt", "") if isinstance(tasks[0], dict) else ""
  return ""


def load_agent_skills(include_content: bool = True) -> list[dict[str, Any]]:
  """Load skills projected from the agent_skills MongoDB collection.

  Each document with a ``skill_template`` field is projected as a skill
  in the catalog with ``source="agent_skills"``.

  Args:
      include_content: If True, include the skill template body.

  Returns:
      List of skill dicts matching the catalog Skill entity shape.
  """
  try:
    from ai_platform_engineering.utils.mongodb_client import get_mongodb_client
  except ImportError:
    logger.debug("mongodb_client not available; skipping agent skills")
    return []

  client = get_mongodb_client()
  if client is None:
    return []

  database = os.getenv("MONGODB_DATABASE", "caipe")
  # Shared scan-gating policy: flagged is always blocked, unscanned
  # is blocked only under SKILL_SCANNER_GATE=strict (default is warn).
  from ai_platform_engineering.skills_middleware.scan_gate import (
    is_skill_blocked,
    mongo_scan_filter,
  )
  try:
    db = client[database]
    collection = db["agent_skills"]
    query: dict[str, Any] = {
      "$and": [
        {
          "$or": [
            {"skill_content": {"$exists": True, "$ne": ""}},
            {"skill_template": {"$exists": True, "$ne": ""}},
            {"tasks.0.llm_prompt": {"$exists": True, "$ne": ""}},
          ]
        },
        mongo_scan_filter(),
      ]
    }
    docs = list(
      collection.find(
        query,
        {
          "_id": 0,
          "name": 1,
          "description": 1,
          "skill_content": 1,
          "skill_template": 1,
          "tasks": 1,
          "metadata": 1,
          "owner_id": 1,
          "visibility": 1,
          "team_ids": 1,
          "owner_user_id": 1,
          "ancillary_files": 1,
          "scan_status": 1,
          # Project the override sub-doc so ``is_skill_blocked`` can
          # detect an active admin override on a flagged row. The
          # sub-doc shape (set_by/set_at/reason) isn't read here —
          # the gate only cares whether the field is present.
          "scan_override": 1,
        },
      )
    )
  except Exception as e:
    logger.warning("Failed to read agent_skills from MongoDB: %s", e)
    return []

  skills: list[dict[str, Any]] = []
  blocked = 0
  for doc in docs:
    name = doc.get("name", "")
    description = doc.get("description", "")
    if not name or not description:
      continue

    # Belt + suspenders: even if the Mongo predicate above somehow
    # let a flagged doc through (e.g. legacy rows missing scan_status
    # under a non-strict gate), reapply the policy in Python.
    if is_skill_blocked(doc):
      blocked += 1
      logger.info(
        "Excluding agent_skill %r from skill catalog (scan_status=%r)",
        name,
        doc.get("scan_status"),
      )
      continue

    owner_user = doc.get("owner_user_id")
    if owner_user is None and doc.get("owner_id") is not None:
      owner_user = str(doc.get("owner_id"))

    raw_ancillary = doc.get("ancillary_files")
    ancillary: dict[str, str] = raw_ancillary if isinstance(raw_ancillary, dict) else {}

    skill: dict[str, Any] = {
      "id": str(name),
      "name": str(name),
      "description": str(description)[:1024],
      "source": "agent_skills",
      "source_id": doc.get("owner_id"),
      "content": (doc.get("skill_content") or doc.get("skill_template") or _extract_llm_prompt(doc) or "") if include_content else None,
      "metadata": doc.get("metadata", {}),
      "visibility": doc.get("visibility"),
      "team_ids": doc.get("team_ids"),
      "owner_user_id": owner_user,
      "ancillary_files": ancillary if include_content else {},
      "scan_status": doc.get("scan_status"),
    }
    # Carry the admin override sub-doc through so downstream
    # consumers (dynamic-agents loader, UI) can detect an active
    # override on a flagged row. Only stamped when present so docs
    # without an override keep their compact shape.
    scan_override = doc.get("scan_override")
    if scan_override:
      skill["scan_override"] = scan_override
    skills.append(skill)

  if blocked:
    logger.warning(
      "Scan gate excluded %d agent_skills from skill catalog", blocked
    )
  logger.info("Loaded %d skills from agent_skills", len(skills))
  return skills
