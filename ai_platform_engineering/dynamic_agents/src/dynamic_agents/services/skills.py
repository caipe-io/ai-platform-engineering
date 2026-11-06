"""Skill loading and file-building utilities for Dynamic Agents.

Loads skill documents from both ``agent_skills`` and ``hub_skills``
MongoDB collections, normalises them into a unified format with a single
``content`` key, and builds the ``files`` dict + source paths that
``SkillsMiddleware`` / ``StateBackend`` consume.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import UTC, datetime
from typing import Any

from pymongo import MongoClient

from dynamic_agents.services.scan_gate import get_scan_gate

logger = logging.getLogger(__name__)


# ─────────────────────────── content helpers ─────────────────────────────


def extract_llm_prompt(doc: dict[str, Any]) -> str:
    """Extract ``llm_prompt`` from ``tasks[0]`` for template-based skills."""
    tasks = doc.get("tasks")
    if isinstance(tasks, list) and tasks:
        return tasks[0].get("llm_prompt", "") if isinstance(tasks[0], dict) else ""
    return ""


# ─────────────────────────── skill loading ───────────────────────────────

# Hub skill IDs use the format "hub-{hub_id}-{skill_id}" as built by the
# UI's hub-crawl.ts ``docToCatalogSkill`` helper.
_HUB_ID_PREFIX = "hub-"


def _parse_hub_skill_id(composite_id: str) -> tuple[str, str] | None:
    """Parse a hub composite ID into ``(hub_id, skill_id)`` or ``None``."""
    if not composite_id.startswith(_HUB_ID_PREFIX):
        return None
    rest = composite_id[len(_HUB_ID_PREFIX) :]
    # hub_id is a 24-char hex ObjectId; skill_id is the remainder after the next '-'
    dash = rest.find("-", 1)
    if dash < 0:
        return None
    return rest[:dash], rest[dash + 1 :]


def _load_agent_skills(
    skill_ids: list[str],
    db: Any,
) -> tuple[list[dict[str, Any]], set[str]]:
    """Query ``agent_skills`` collection. Returns ``(skills, found_ids)``.

    Skills with ``scan_status=="flagged"`` are unconditionally
    excluded; ``unscanned`` skills are excluded only under
    ``SKILL_SCANNER_GATE=strict`` (the default is ``warn`` so
    deployments without the optional skill-scanner sidecar still
    load skills). This applies the shared skill-catalog scan-gate
    policy so a flagged skill cannot be ingested.
    """
    if not skill_ids:
        return [], set()

    # Vendored module — see scan_gate.py docstring. We previously
    # imported from ai_platform_engineering.skills_middleware.scan_gate,
    # which works in the dev monorepo but raises ModuleNotFoundError
    # in the dynamic-agents container (only the dynamic_agents package
    # is shipped). The exception was caught by load_skills' broad
    # except, silently returning [] and making every dynamic agent's
    # virtual filesystem appear empty to the LLM.
    from dynamic_agents.services.scan_gate import (
        is_skill_blocked,
        mongo_scan_filter,
    )

    collection = db["agent_skills"]
    docs = list(
        collection.find(
            {
                "$and": [
                    {
                        "$or": [
                            {"id": {"$in": skill_ids}},
                            {"_id": {"$in": skill_ids}},
                        ]
                    },
                    mongo_scan_filter(),
                ]
            }
        )
    )
    logger.info(
        "agent_skills query returned %d docs for %d requested IDs",
        len(docs),
        len(skill_ids),
    )

    found_ids: set[str] = set()
    skills: list[dict[str, Any]] = []
    for doc in docs:
        name = doc.get("name", "")
        description = doc.get("description", "")
        doc_id = str(doc.get("id", "")) or str(doc.get("_id", ""))
        found_ids.add(str(doc.get("id", "")))
        found_ids.add(str(doc.get("_id", "")))

        if not name:
            logger.warning("Skipping skill doc %s: missing name", doc_id)
            continue

        if is_skill_blocked(doc):
            logger.warning(
                "Refusing to load agent_skill %r for dynamic agent (scan_status=%r)",
                name,
                doc.get("scan_status"),
            )
            continue

        content = doc.get("skill_content") or doc.get("skill_template") or extract_llm_prompt(doc) or ""
        content_source = (
            "skill_content"
            if doc.get("skill_content")
            else "skill_template"
            if doc.get("skill_template")
            else "tasks[0].llm_prompt"
            if extract_llm_prompt(doc)
            else "empty"
        )
        logger.debug(
            "Skill %r (%s): content_source=%s content_len=%d",
            name,
            doc_id,
            content_source,
            len(content),
        )

        owner_user = doc.get("owner_user_id") or str(doc.get("owner_id", ""))
        raw_ancillary = doc.get("ancillary_files")
        ancillary: dict[str, str] = raw_ancillary if isinstance(raw_ancillary, dict) else {}

        skills.append(
            {
                "id": doc_id,
                "name": str(name),
                "description": str(description)[:1024],
                "source": "agent_skills",
                "source_id": doc.get("owner_id"),
                "content": content,
                "scan_status": doc.get("scan_status"),
                "metadata": doc.get("metadata", {}),
                "visibility": doc.get("visibility"),
                "team_ids": doc.get("team_ids"),
                "owner_user_id": owner_user,
                "ancillary_files": ancillary,
            }
        )

    return skills, found_ids


def _load_hub_skills(
    hub_ids_map: dict[str, tuple[str, str]],
    db: Any,
) -> list[dict[str, Any]]:
    """Query ``hub_skills`` collection for hub skill IDs.

    Args:
        hub_ids_map: Mapping of composite ID → ``(hub_id, skill_id)`` pairs.
        db: pymongo Database instance.

    Returns:
        List of normalised skill dicts compatible with ``build_skills_files()``.
    """
    if not hub_ids_map:
        return []

    # Vendored — see scan_gate.py docstring (same reason as
    # ``_load_agent_skills`` above).
    from dynamic_agents.services.scan_gate import (
        is_skill_blocked,
        mongo_scan_filter,
    )

    # Build $or conditions for each (hub_id, skill_id) pair, then
    # AND with the scanner gate so a flagged hub skill is never
    # returned even if explicitly requested by id.
    or_conditions = [{"hub_id": hub_id, "skill_id": skill_id} for hub_id, skill_id in hub_ids_map.values()]
    collection = db["hub_skills"]
    docs = list(collection.find({"$and": [{"$or": or_conditions}, mongo_scan_filter()]}))
    logger.info(
        "hub_skills query returned %d docs for %d requested hub skill IDs",
        len(docs),
        len(hub_ids_map),
    )

    # Index docs by (hub_id, skill_id) for lookup
    doc_index: dict[tuple[str, str], dict[str, Any]] = {}
    for doc in docs:
        key = (str(doc.get("hub_id", "")), str(doc.get("skill_id", "")))
        doc_index[key] = doc

    skills: list[dict[str, Any]] = []
    for composite_id, (hub_id, skill_id) in hub_ids_map.items():
        doc = doc_index.get((hub_id, skill_id))
        if doc is None:
            logger.warning("Hub skill not found: hub_id=%s skill_id=%s", hub_id, skill_id)
            continue

        name = doc.get("name", "")
        if not name:
            logger.warning("Skipping hub skill doc (hub_id=%s, skill_id=%s): missing name", hub_id, skill_id)
            continue

        if is_skill_blocked(doc):
            logger.warning(
                "Refusing to load hub skill %r (hub=%s) for dynamic agent (scan_status=%r)",
                name,
                hub_id,
                doc.get("scan_status"),
            )
            continue

        # Hub skills store the full SKILL.md (with frontmatter) in ``content``
        content = doc.get("content", "")
        logger.debug(
            "Hub skill %r (hub=%s, skill=%s): content_len=%d",
            name,
            hub_id,
            skill_id,
            len(content),
        )

        skills.append(
            {
                "id": composite_id,
                "name": str(name),
                "description": str(doc.get("description", ""))[:1024],
                "source": "hub",
                "source_id": hub_id,
                "content": content,
                "scan_status": doc.get("scan_status"),
                "metadata": doc.get("metadata", {}),
                "visibility": "global",
                "team_ids": None,
                "owner_user_id": "",
                "ancillary_files": doc.get("ancillary_files") if isinstance(doc.get("ancillary_files"), dict) else {},
            }
        )

    return skills


def load_skills(
    skill_ids: list[str],
    *,
    mongodb_uri: str,
    mongodb_database: str,
) -> list[dict[str, Any]]:
    """Load skill documents from MongoDB ``agent_skills`` and ``hub_skills``.

    Skill IDs starting with ``hub-`` are looked up in ``hub_skills`` (by
    extracting ``hub_id`` and ``skill_id`` from the composite ID). All
    other IDs are looked up in ``agent_skills``.

    Args:
        skill_ids: List of skill ``id`` values to load.
        mongodb_uri: MongoDB connection URI.
        mongodb_database: Database name (overridden by ``MONGODB_DATABASE`` env var).

    Returns:
        List of normalised skill dicts compatible with ``build_skills_files()``.
    """
    database = os.getenv("MONGODB_DATABASE", mongodb_database)
    client = MongoClient(mongodb_uri, tz_aware=True)
    logger.info(
        "Loading skills: requested_ids=%s db=%s",
        skill_ids,
        database,
    )

    # Partition IDs into agent_skills vs hub_skills
    agent_ids: list[str] = []
    hub_ids_map: dict[str, tuple[str, str]] = {}  # composite_id → (hub_id, skill_id)
    for sid in skill_ids:
        parsed = _parse_hub_skill_id(sid)
        if parsed:
            hub_ids_map[sid] = parsed
        else:
            agent_ids.append(sid)

    try:
        db = client[database]
        agent_skills, found_ids = _load_agent_skills(agent_ids, db)
        hub_skills = _load_hub_skills(hub_ids_map, db)
    except Exception as e:
        logger.warning("Failed to load skills: %s", e, exc_info=True)
        return []
    finally:
        client.close()

    skills = agent_skills + hub_skills

    # Log missing IDs
    missing_agent = [sid for sid in agent_ids if sid not in found_ids]
    loaded_hub_ids = {s["id"] for s in hub_skills}
    missing_hub = [sid for sid in hub_ids_map if sid not in loaded_hub_ids]
    missing = missing_agent + missing_hub
    if missing:
        logger.warning("Skills not found: %s", missing)
    logger.info(
        "Loaded %d/%d skills (agent=%d, hub=%d, missing=%d)",
        len(skills),
        len(skill_ids),
        len(agent_skills),
        len(hub_skills),
        len(missing),
    )
    return skills


# ───────────────────── Deep Agents file data building ────────────────────
#
# Converts loaded skill dicts into the ``files`` dict and source paths
# that ``SkillsMiddleware`` / ``StateBackend`` consume at runtime.


def _sanitize_name(name: str) -> str:
    """Sanitize a skill name for use as a directory name."""
    return re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")


def _create_file_data(content: str) -> dict[str, Any]:
    """Create a file data dict compatible with Deep Agents backends.

    Mirrors ``deepagents.backends.utils.create_file_data``.
    """
    now = datetime.now(UTC).isoformat()
    return {
        "content": content,
        "encoding": "utf-8",
        "created_at": now,
        "modified_at": now,
    }


def _build_skill_md(skill: dict[str, Any]) -> str:
    """Build a SKILL.md string (YAML frontmatter + body) from a skill dict."""
    name = skill.get("name", "")
    description = skill.get("description", "")
    content = skill.get("content", "")

    # Pinned original Hub entries are never rewritten, including command Markdown.
    if skill.get("source") == "hub" and skill.get("metadata", {}).get("original_content") is True:
        return content

    # If the original content already has valid frontmatter, use it as-is
    if content and content.strip().startswith("---"):
        return content

    # Build frontmatter + body
    metadata = skill.get("metadata", {})
    fm_lines = [
        "---",
        f"name: {name}",
        f"description: {description}",
    ]
    for key in ("license", "compatibility"):
        val = metadata.get(key)
        if val:
            fm_lines.append(f"{key}: {val}")

    source = skill.get("source", "")
    source_id = skill.get("source_id", "")
    if source:
        fm_lines.append("metadata:")
        fm_lines.append(f"  source: {source}")
        if source_id:
            fm_lines.append(f"  source_id: {source_id}")

    fm_lines.append("---")
    fm_lines.append("")

    if content:
        fm_lines.append(content)
    else:
        fm_lines.append(f"# {name}")
        fm_lines.append("")
        fm_lines.append(description)

    return "\n".join(fm_lines)


def build_skills_files(
    skills: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    """Build a ``files`` dict and source paths for StateBackend + SkillsMiddleware.

    Args:
        skills: List of skill dicts from ``load_skills()``.

    Returns:
        Tuple of:
        - ``files``: Dict of ``{path: file_data}`` to inject into agent state.
        - ``sources``: List of source paths for ``SkillsMiddleware(sources=...)``.
    """
    files: dict[str, Any] = {}
    source_paths: set[str] = set()

    for skill in skills:
        source = skill.get("source", "default")
        source_id = skill.get("source_id")
        # Use skill id for directory name (unique), fall back to name
        dir_name = _sanitize_name(skill.get("id") or skill.get("name", "unknown"))

        if source == "default":
            source_dir = "/skills/default"
        elif source == "agent_skills":
            source_dir = "/skills/agent-skills"
        elif source == "hub" and source_id:
            safe_id = _sanitize_name(source_id)
            source_dir = f"/skills/hub-{safe_id}"
        else:
            source_dir = "/skills/default"

        source_path = f"{source_dir}/"
        source_paths.add(source_path)

        file_path = f"{source_dir}/{dir_name}/SKILL.md"
        skill_md = _build_skill_md(skill)
        files[file_path] = _create_file_data(skill_md)

        for rel_path, file_content in skill.get("ancillary_files", {}).items():
            anc_path = f"{source_dir}/{dir_name}/{rel_path}"
            files[anc_path] = _create_file_data(file_content)

    sources = sorted(source_paths)
    logger.info(
        "Built %d skill files for StateBackend (%d sources: %s)",
        len(files),
        len(sources),
        sources,
    )
    return files, sources


def detect_missing_skills(
    requested_skill_ids: list[str],
    loaded_skills: list[dict[str, Any]],
) -> tuple[list[str], str | None]:
    """Detect skills that were requested but not loaded.

    Distinguishes between skills not found in DB vs blocked by the scan
    gate (SKILL_SCANNER_GATE=strict).

    Returns:
        Tuple of (missing_ids, error_message). error_message is None if
        no skills are missing.
    """
    loaded_ids = {s["id"] for s in loaded_skills}
    missing = [sid for sid in requested_skill_ids if sid not in loaded_ids]
    if not missing:
        return [], None

    if get_scan_gate() == "strict":
        error = (
            f"Skills unavailable (not found in DB or blocked by scan gate "
            f"under SKILL_SCANNER_GATE=strict): {', '.join(missing)}"
        )
    else:
        error = f"Skills not found: {', '.join(missing)}"

    return missing, error


def verify_skill_pins(skills: list[dict[str, Any]], pins: dict[str, Any]) -> None:
    """Verify the exact executable package before files reach model context."""
    by_id = {skill["id"]: skill for skill in skills}
    for skill_id, pin in pins.items():
        skill = by_id.get(skill_id)
        if skill is None:
            raise ValueError(f"Pinned skill is unavailable or blocked: {skill_id}")
        if skill.get("scan_status") != "passed":
            raise ValueError(f"Pinned skill security scan has not passed: {skill_id}")
        expected = pin.model_dump() if hasattr(pin, "model_dump") else pin
        content_hash = hashlib.sha256(_build_skill_md(skill).encode()).hexdigest()
        ancillary = skill.get("ancillary_files", {})
        hashes = {}
        for path, content in ancillary.items():
            if not isinstance(content, str) or path.startswith("/") or "\\" in path or any(
                part in {"", ".", ".."} for part in path.split("/")
            ) or path == "SKILL.md":
                raise ValueError(f"Invalid pinned skill ancillary path: {skill_id}")
            hashes[path] = hashlib.sha256(content.encode()).hexdigest()
        if content_hash != expected["content_sha256"] or hashes != expected["ancillary_sha256"]:
            raise ValueError(f"Pinned skill changed since selection; rescan and explicitly reselect it: {skill_id}")
