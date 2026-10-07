# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Backend sync — writes normalized skills into StateBackend files dict.

The upstream ``deepagents.middleware.skills.SkillsMiddleware`` reads skills
from a ``StateBackend`` by scanning source paths for ``<skill-name>/SKILL.md``
entries.  This module builds the ``files`` dict that should be injected into
the agent's initial state so StateBackend can serve them.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


def _sanitize_name(name: str) -> str:
    """Sanitize a skill name for use as a directory name."""
    return re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")


def _create_file_data(content: str) -> dict[str, Any]:
    """Create a file data dict compatible with StateBackend.

    Mirrors ``deepagents.backends.utils.create_file_data``.
    """
    lines = content.split("\n") if isinstance(content, str) else content
    now = datetime.now(UTC).isoformat()
    return {
        "content": lines,
        "created_at": now,
        "modified_at": now,
    }


def _build_skill_md(skill: dict[str, Any]) -> str:
    """Build a SKILL.md string (YAML frontmatter + body) from a skill dict."""
    name = skill.get("name", "")
    description = skill.get("description", "")
    content = skill.get("content", "")

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
        # Strip existing frontmatter from content if present
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
        skills: Merged skill list from ``get_merged_skills(include_content=True)``.

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
        name = _sanitize_name(skill.get("name", "unknown"))

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

        file_path = f"{source_dir}/{name}/SKILL.md"
        skill_md = _build_skill_md(skill)
        files[file_path] = _create_file_data(skill_md)

        for rel_path, file_content in skill.get("ancillary_files", {}).items():
            anc_path = f"{source_dir}/{name}/{rel_path}"
            files[anc_path] = _create_file_data(file_content)

    sources = sorted(source_paths)
    logger.info(
        "Built %d skill files for StateBackend (%d sources: %s)",
        len(files),
        len(sources),
        sources,
    )
    return files, sources
