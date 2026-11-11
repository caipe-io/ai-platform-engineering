"""Compatibility between Hub package materialization and skill discovery."""

import hashlib
from pathlib import Path

import pytest
from deepagents.backends import FilesystemBackend
from deepagents.middleware.skills import SkillsMiddleware
from langgraph.runtime import Runtime

from dynamic_agents.services.skills import build_skills_files, verify_skill_pins


def test_legacy_hub_without_frontmatter_remains_discoverable(tmp_path: Path) -> None:
    hub_id = "a" * 24
    skill_id = f"hub-{hub_id}-example-review"
    original = "# Review\nCheck the change.\n"
    files, sources = build_skills_files([{
        "id": skill_id,
        "name": "example-review",
        "description": "Review a change.",
        "source": "hub",
        "source_id": hub_id,
        "content": original,
    }])
    for path, data in files.items():
        target = tmp_path / path.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(data["content"], encoding="utf-8")

    middleware = SkillsMiddleware(
        backend=FilesystemBackend(root_dir=str(tmp_path), virtual_mode=True), sources=sources,
    )
    update = middleware.before_agent({"messages": []}, Runtime(), {})

    assert update is not None
    assert [(skill["name"], skill["description"]) for skill in update["skills_metadata"]] == [
        ("example-review", "Review a change."),
    ]
    assert files[f"/skills/hub-{hub_id}/{skill_id}/SKILL.md"]["content"].endswith(original)


@pytest.mark.parametrize("pinned", [False, True])
def test_original_hub_entries_retain_exact_bytes(pinned: bool) -> None:
    original = "# Original command\n\nUnchanged Unicode instructions: 🟠\n"
    skill = {
        "id": "example-review", "name": "example-review", "source": "hub",
        "source_id": "a" * 24, "content": original, "scan_status": "passed",
        "metadata": {} if pinned else {"original_content": True},
    }
    pins = {skill["id"]: {
        "content_sha256": hashlib.sha256(original.encode()).hexdigest(), "ancillary_sha256": {},
    }} if pinned else {}
    verify_skill_pins([skill], pins)
    files, _ = build_skills_files([skill], pinned_skill_ids=pins)

    assert files[f"/skills/hub-{'a' * 24}/example-review/SKILL.md"]["content"] == original


def test_legacy_hub_with_frontmatter_retains_exact_bytes() -> None:
    original = "---\nname: example-review\ndescription: Review a change.\n---\n# Review\n"
    files, _ = build_skills_files([{
        "id": "example-review", "source": "hub", "content": original,
    }])
    assert files["/skills/default/example-review/SKILL.md"]["content"] == original
