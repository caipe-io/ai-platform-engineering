# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Skill catalog — single source of truth for the UI and dynamic agents.

Merges skills from:
  - Filesystem / SKILLS_DIR  (default)
  - MongoDB agent_skills    (agent_skills)
  - MongoDB hub_skills cache (hub) — populated by the Next.js UI crawler
    in ``ui/src/lib/hub-crawl.ts``. The catalog never calls GitHub or
    GitLab itself; both source types are consumed transparently from
    Mongo, so adding new hub providers (GitLab subgroups, future
    Bitbucket, etc.) is purely a UI concern.

Applies deterministic precedence (default > agent_skills > hub).
Provides a TTL-based in-memory cache so consumers can hot-reload
without restart (FR-012).
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from ai_platform_engineering.skills_middleware.loaders.default import load_default_skills
from ai_platform_engineering.skills_middleware.loaders.agent_skill import load_agent_skills
from ai_platform_engineering.skills_middleware.precedence import merge_skills
from ai_platform_engineering.skills_middleware.entitlement import normalize_merged_skills

logger = logging.getLogger(__name__)

# Cache — TTL covers the merged catalog. The hub portion is now sourced
# from Mongo (``hub_skills``) which the UI crawler keeps fresh; the old
# ~70s GitHub round-trip is gone, so the merged cache itself is now the
# only meaningful TTL. The hub-specific cache is retained for backwards
# compatibility (other modules may import HUB_CACHE_TTL or call
# ``invalidate_skills_cache(include_hubs=True)``) but each refresh now
# completes in milliseconds.
_skills_cache: list[dict[str, Any]] | None = None
_skills_cache_time: float = 0.0
SKILLS_CACHE_TTL = int(os.getenv("SKILLS_CACHE_TTL", "3600"))  # seconds (default 1 hour)

_hub_cache: list[dict[str, Any]] | None = None
_hub_cache_time: float = 0.0
HUB_CACHE_TTL = int(os.getenv("HUB_CACHE_TTL", "3600"))  # seconds (default 1 hour)

# Bumped on each ``invalidate_skills_cache()`` for UI vs backend diff (FR-016).
_catalog_cache_generation: int = 0


def _hub_skill_doc_to_catalog(
    doc: dict[str, Any],
    hub_meta: dict[str, Any],
    include_content: bool,
) -> dict[str, Any] | None:
    """Convert one cached ``hub_skills`` row into a catalog skill dict.

    The shape mirrors what ``loaders.agent_skill.load_agent_skills``
    produces so downstream consumers (precedence, entitlement, scan
    gate, deep-agent ``build_skills_files``) cannot tell the difference
    between an agent_skill and a hub skill except via ``source``.

    Hub-skill invariants enforced here:

    * ``visibility`` is always ``"global"`` — hub skills are
      organisation-wide assets; team/personal sharding lives in
      ``agent_skills``.
    * ``team_ids`` / ``owner_user_id`` are constant for hub skills.
    * ``hub_location`` / ``hub_type`` / ``path`` are stamped into
      ``metadata`` so the UI skill-detail page and installer can
      reproduce a stable repo URL without re-reading ``skill_hubs``.
    * Hub-level ``labels`` from ``skill_hubs.labels`` are merged into
      ``metadata.tags`` — matches what the UI surfaces in
      ``hub-crawl.ts:_crawlAndCache``. Without this the skill
      catalog would lose tag parity with the UI.

    Returns ``None`` when the cached row is missing required fields
    (name/description) so a malformed crawl can never poison the
    catalog.
    """
    name = doc.get("name")
    description = doc.get("description")
    if not isinstance(name, str) or not name:
        return None
    if not isinstance(description, str) or not description:
        return None

    skill_id = doc.get("skill_id") or name
    hub_id = hub_meta.get("id", "")

    raw_metadata = doc.get("metadata")
    metadata: dict[str, Any] = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}

    # Stamp hub-level context that lives in ``skill_hubs`` (not
    # ``hub_skills``) so the merged catalog is self-describing — the UI
    # does the same in ``hub-crawl.ts:_crawlAndCache`` so we keep parity.
    if hub_meta.get("location"):
        metadata["hub_location"] = hub_meta["location"]
    if hub_meta.get("type"):
        metadata["hub_type"] = hub_meta["type"]
    if doc.get("path"):
        metadata["path"] = doc["path"]

    hub_labels = hub_meta.get("labels") or []
    if hub_labels:
        existing_tags = metadata.get("tags")
        tag_list: list[str] = list(existing_tags) if isinstance(existing_tags, list) else []
        for label in hub_labels:
            if isinstance(label, str) and label and label not in tag_list:
                tag_list.append(label)
        metadata["tags"] = tag_list

    raw_ancillary = doc.get("ancillary_files")
    ancillary: dict[str, str] = (
        raw_ancillary if isinstance(raw_ancillary, dict) else {}
    )

    content_value = doc.get("content") if include_content else None

    out: dict[str, Any] = {
        # Match the UI catalog id (``hub-<hub_id>-<skill_id>``) so
        # ``dynamic_agents/services/skills.py`` can locate the same row
        # regardless of which catalog it pulled the id from. The plain
        # ``hub_id/skill_id`` form the old GitHub crawler used is *not*
        # produced here; it was unreachable from the UI lookup path.
        "id": f"hub-{hub_id}-{skill_id}" if hub_id else skill_id,
        "name": str(name),
        "description": str(description)[:1024],
        "source": "hub",
        "source_id": hub_id,
        "content": content_value if isinstance(content_value, str) else None,
        "metadata": metadata,
        "visibility": "global",
        "team_ids": [],
        "owner_user_id": None,
        "ancillary_files": ancillary if include_content else {},
    }

    scan_status = doc.get("scan_status")
    if scan_status is not None:
        out["scan_status"] = scan_status
    # Carry the override sub-doc through so the dynamic-agents
    # loader (which re-applies the gate as a defence-in-depth layer)
    # can detect an active override on a flagged row. Stripped from
    # the wire when absent to keep the catalog payload small.
    scan_override = doc.get("scan_override")
    if scan_override:
        out["scan_override"] = scan_override
    return out


def _load_hub_skills(include_content: bool = True) -> list[dict[str, Any]]:
    """Load skills for the merged catalog from MongoDB ``hub_skills``.

    The Next.js UI is the only producer of ``hub_skills``; it crawls
    GitHub and GitLab via ``ui/src/lib/hub-crawl.ts`` and persists the
    SKILL.md body, parsed metadata, ancillary text files, and scan
    status. The catalog (this function) is now a pure consumer:

    * No GitHub/GitLab API calls are made here. Adding new hub
      providers is a UI-only change.
    * Per-skill scan gating uses the cached ``scan_status`` written by
      the UI scanner (``ui/src/lib/skill-scan.ts``) — single source of
      truth for both surfaces.
    * Hub-level metadata (``last_success_at`` / ``last_failure_at``) is
      maintained by the UI's ``_crawlAndCache``; we don't write it from
      here anymore. ``get_unavailable_sources()`` still reads it for
      ``meta.unavailable_sources`` on the catalog API.

    Returns an empty list when MongoDB is unavailable or no hubs are
    enabled. ``_hub_cache`` keeps a TTL-bounded copy so repeated
    requests don't repeatedly query Mongo, but the underlying read is
    now milliseconds instead of the ~70s GitHub round-trip the previous
    implementation paid.
    """
    global _hub_cache, _hub_cache_time

    now = time.time()
    if _hub_cache is not None and (now - _hub_cache_time) < HUB_CACHE_TTL:
        logger.debug(
            "Hub cache hit (%d skills, age %.0fs)",
            len(_hub_cache),
            now - _hub_cache_time,
        )
        return list(_hub_cache)

    try:
        from ai_platform_engineering.utils.mongodb_client import get_mongodb_client
    except ImportError:
        return []

    client = get_mongodb_client()
    if client is None:
        return []

    database = os.getenv("MONGODB_DATABASE", "caipe")
    try:
        db = client[database]
        hubs_collection = db["skill_hubs"]
        hubs = list(hubs_collection.find({"enabled": True}).sort("created_at", 1))
    except Exception as e:
        logger.warning("Failed to read skill_hubs from MongoDB: %s", e)
        return []

    if not hubs:
        _hub_cache = []
        _hub_cache_time = now
        return []

    # Build (hub_id -> hub_meta) lookup so we can stamp hub_location /
    # hub_type / labels onto each cached skill row.
    hub_meta_by_id: dict[str, dict[str, Any]] = {}
    hub_ids: list[str] = []
    for hub in hubs:
        hub_id = hub.get("id") or str(hub.get("_id", ""))
        if not hub_id:
            continue
        hub_meta_by_id[hub_id] = {
            "id": hub_id,
            "type": hub.get("type", ""),
            "location": hub.get("location", ""),
            "labels": hub.get("labels") or [],
        }
        hub_ids.append(hub_id)

    if not hub_ids:
        _hub_cache = []
        _hub_cache_time = now
        return []

    try:
        hub_skills_col = db["hub_skills"]
        rows = list(hub_skills_col.find({"hub_id": {"$in": hub_ids}}))
    except Exception as e:
        logger.warning("Failed to read hub_skills from MongoDB: %s", e)
        return []

    # Per-skill scan gating uses the same shared helper the UI uses, so
    # the merged catalog and the UI listing can never disagree on what
    # is "blocked vs visible".
    try:
        from ai_platform_engineering.skills_middleware.scan_gate import (
            is_status_blocked,
        )
    except ImportError:  # pragma: no cover - defensive, scan_gate is in-tree
        is_status_blocked = lambda _status: False  # noqa: E731

    all_hub_skills: list[dict[str, Any]] = []
    blocked_per_hub: dict[str, int] = {}

    for row in rows:
        hub_id = row.get("hub_id")
        if not isinstance(hub_id, str):
            continue
        hub_meta = hub_meta_by_id.get(hub_id)
        if hub_meta is None:
            # ``hub_skills`` row points at a hub that has been disabled
            # or deleted — drop it from the merged catalog.
            continue

        # Hub-level scan-gate signals (``hub_scan_should_block_merge``)
        # are no longer evaluated here because the UI scanner records
        # per-skill ``scan_status`` directly on each ``hub_skills`` row.
        # Hub-wide blocks would have to be reintroduced in the UI
        # scanner if we ever want them again.
        #
        # Pass ``has_override`` so a flagged hub skill with an active
        # admin override sub-doc is allowed through (under the warn
        # gate). Without this the override would be invisible to the
        # skill catalog and the merged listing would silently
        # drop overridden hub skills.
        scan_status = row.get("scan_status")
        has_override = bool(row.get("scan_override"))
        if is_status_blocked(scan_status, has_override=has_override):
            blocked_per_hub[hub_id] = blocked_per_hub.get(hub_id, 0) + 1
            continue

        skill = _hub_skill_doc_to_catalog(row, hub_meta, include_content)
        if skill is not None:
            all_hub_skills.append(skill)

    for hub_id, count in blocked_per_hub.items():
        logger.warning(
            "Scan gate excluded %d hub skills from hub %s", count, hub_id
        )

    _hub_cache = all_hub_skills
    _hub_cache_time = now
    logger.info(
        "Hub cache refreshed: %d skills from %d hubs (read from MongoDB hub_skills)",
        len(all_hub_skills),
        len(hub_ids),
    )
    return list(all_hub_skills)


def get_merged_skills(include_content: bool = False) -> list[dict[str, Any]]:
    """Return the merged skill catalog from all sources.

    Uses a TTL-based cache.  Call ``invalidate_skills_cache()`` to force
    a fresh load on next access.

    Args:
        include_content: If True, include full SKILL.md body for each skill.

    Returns:
        List of skill dicts with id, name, description, source, source_id,
        content (optional), and metadata.
    """
    global _skills_cache, _skills_cache_time

    now = time.time()
    if _skills_cache is not None and (now - _skills_cache_time) < SKILLS_CACHE_TTL:
        if not include_content:
            return [{**s, "content": None} for s in _skills_cache]
        return list(_skills_cache)

    default_skills = load_default_skills(include_content=True)
    agent_skills_list = load_agent_skills(include_content=True)

    try:
        hub_skills = _load_hub_skills(include_content=True)
    except Exception:
        logger.exception("Hub skill loading failed; continuing without hub skills")
        hub_skills = []

    merged = merge_skills(default_skills, agent_skills_list, hub_skills)
    merged = normalize_merged_skills(merged)

    _skills_cache = merged
    _skills_cache_time = now

    logger.info(
        "Skills catalog refreshed: %d total (%d default, %d agent_skills, %d hub)",
        len(merged),
        len(default_skills),
        len(agent_skills_list),
        len(hub_skills),
    )

    if not include_content:
        return [{**s, "content": None} for s in merged]
    return list(merged)


def get_unavailable_sources() -> list[str]:
    """Return hub IDs that failed on the last catalog refresh.

    This is a best-effort indicator for the API ``meta.unavailable_sources``.
    """
    try:
        from ai_platform_engineering.utils.mongodb_client import get_mongodb_client

        client = get_mongodb_client()
        if client is None:
            return []
        database = os.getenv("MONGODB_DATABASE", "caipe")
        db = client[database]
        hubs = db["skill_hubs"]
        failed = hubs.find(
            {"enabled": True, "last_failure_at": {"$exists": True}},
            {"id": 1, "_id": 0},
        )
        return [h.get("id", "") for h in failed if h.get("id")]
    except Exception:
        return []


def invalidate_skills_cache(*, include_hubs: bool = True) -> None:
    """Clear the in-memory skills cache, forcing a fresh load on next access.

    Args:
        include_hubs: Also clear the hub cache (default True).  Set False to
            keep cached hub results and only re-merge default + agent_skills.
    """
    global _skills_cache, _skills_cache_time, _catalog_cache_generation
    global _hub_cache, _hub_cache_time
    _skills_cache = None
    _skills_cache_time = 0.0
    _catalog_cache_generation += 1
    if include_hubs:
        _hub_cache = None
        _hub_cache_time = 0.0


def get_catalog_cache_generation() -> int:
    """Monotonic counter incremented when the merged-skills cache is invalidated."""
    return _catalog_cache_generation
