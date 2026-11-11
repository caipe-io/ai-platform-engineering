"""Tests for Dynamic Agents skill file data construction."""

from dynamic_agents.services.skills import build_skills_files


def test_build_skills_files_uses_deepagents_v2_file_data() -> None:
    files, sources = build_skills_files(
        [
            {
                "id": "example-skill",
                "name": "Example Skill",
                "description": "Example description",
                "content": "Use this skill.\nIt has multiple lines.",
                "source": "default",
                "ancillary_files": {"notes.txt": "Ancillary\ncontent"},
            }
        ]
    )

    assert sources == ["/skills/default/"]

    skill_file = files["/skills/default/example-skill/SKILL.md"]
    assert isinstance(skill_file["content"], str)
    assert skill_file["encoding"] == "utf-8"
    assert "Use this skill.\nIt has multiple lines." in skill_file["content"]

    ancillary_file = files["/skills/default/example-skill/notes.txt"]
    assert ancillary_file["content"] == "Ancillary\ncontent"
    assert ancillary_file["encoding"] == "utf-8"


def test_hub_ancillary_files_and_exact_package_pins() -> None:
    import hashlib
    from unittest.mock import MagicMock

    import pytest

    from dynamic_agents.services.skills import _load_hub_skills, verify_skill_pins

    hub_id = "a" * 24
    skill_id = "review"
    full_id = f"hub-{hub_id}-{skill_id}"
    db = MagicMock()
    db.__getitem__.return_value.find.return_value = [{
        "hub_id": hub_id, "skill_id": skill_id, "name": "Review",
        "content": "---\nname: review\n---\nMethod", "scan_status": "passed",
        "ancillary_files": {"PROVENANCE.json": "{}", "references/check.md": "Check caller"},
    }]
    skills = _load_hub_skills({full_id: (hub_id, skill_id)}, db)
    pin = {full_id: {
        "content_sha256": hashlib.sha256(skills[0]["content"].encode()).hexdigest(),
        "ancillary_sha256": {k: hashlib.sha256(v.encode()).hexdigest() for k, v in skills[0]["ancillary_files"].items()},
    }}
    verify_skill_pins(skills, pin)
    files, _ = build_skills_files(skills)
    assert files[f"/skills/hub-{hub_id}/{full_id}/references/check.md"]["content"] == "Check caller"
    for mutation in (lambda: skills[0].update(content="Changed"),
                     lambda: skills[0]["ancillary_files"].update({"PROVENANCE.json": "Changed"})):
        mutation()
        with pytest.raises(ValueError, match="changed since selection"):
            verify_skill_pins(skills, pin)
    with pytest.raises(ValueError, match="unavailable or blocked"):
        verify_skill_pins([], pin)
    skills[0]["ancillary_files"]["../escape"] = "Bad path"
    with pytest.raises(ValueError, match="ancillary path"):
        verify_skill_pins(skills, pin)


def test_original_command_without_frontmatter_is_not_rewritten() -> None:
    import hashlib

    import pytest

    from dynamic_agents.services.skills import verify_skill_pins

    original = "# Original command\n\nUnchanged instructions.\n"
    skill = {"id": "original", "source": "hub", "source_id": "a" * 24,
             "name": "Original", "content": original, "scan_status": "passed",
             "metadata": {"original_content": True}, "ancillary_files": {}}
    pins = {"original": {"content_sha256": hashlib.sha256(original.encode()).hexdigest(), "ancillary_sha256": {}}}
    verify_skill_pins([skill], pins)
    files, _ = build_skills_files([skill])
    assert files[f"/skills/hub-{'a' * 24}/original/SKILL.md"]["content"] == original
    skill["scan_status"] = "unscanned"
    with pytest.raises(ValueError, match="scan has not passed"):
        verify_skill_pins([skill], pins)


def test_chat_overrides_cannot_clear_pins_or_detach_their_skills() -> None:
    from datetime import datetime, timezone

    import pytest
    from fastapi import HTTPException
    from pydantic import ValidationError

    from dynamic_agents.models import DynamicAgentConfig
    from dynamic_agents.routes.chat import apply_config_override

    agent = DynamicAgentConfig(_id="example-agent", name="Example", system_prompt="Review",
        owner_id="owner@example.test", model={"id":"example-model","provider":"openai"},
        skills=["original"], skill_pins={"original":{"content_sha256":"a" * 64,"ancillary_sha256":{}}},
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))
    with pytest.raises(HTTPException) as rejected:
        apply_config_override(agent, {"skill_pins": {}})
    assert rejected.value.status_code == 400
    with pytest.raises(ValidationError):
        apply_config_override(agent, {"skills": []})


def test_original_hub_pins_hash_entry_bytes_without_frontmatter_flag() -> None:
    import hashlib

    import pytest

    from dynamic_agents.services.skills import verify_skill_pins

    original = "# Original command\nInstructions unchanged.\n"
    skill = {"id": "hub-original", "source": "hub", "content": original, "scan_status": "passed"}
    pin = {"hub-original": {"content_sha256": hashlib.sha256(original.encode()).hexdigest(), "ancillary_sha256": {}}}
    verify_skill_pins([skill], pin)
    for key in ("skipped_binary", "skipped_too_large", "truncated_at_count_cap", "truncated_at_size_cap"):
        skill["ancillary_summary"] = {key: 1}
        with pytest.raises(ValueError, match="package is incomplete"):
            verify_skill_pins([skill], pin)


def test_pinned_load_preserves_storage_failure() -> None:
    from unittest.mock import patch

    import pytest

    from dynamic_agents.services.skills import load_skills

    with patch("dynamic_agents.services.skills._load_agent_skills", side_effect=RuntimeError("Storage unavailable")):
        with pytest.raises(RuntimeError, match="Storage unavailable"):
            load_skills(["skill-example"], mongodb_uri="mongodb://localhost", mongodb_database="test", strict=True)
        assert load_skills(["skill-example"], mongodb_uri="mongodb://localhost", mongodb_database="test") == []


def test_runtime_rejects_obsolete_hub_cache_generation() -> None:
    from unittest.mock import MagicMock

    from dynamic_agents.services.skills import _load_hub_skills

    hub = "a" * 24
    cached = {"hub_id": hub, "skill_id": "review", "name": "Review", "scan_status": "passed", "cache_generation": "old"}
    db = {"hub_skills": MagicMock(), "skill_hubs": MagicMock()}
    db["hub_skills"].find.return_value = [cached]
    db["skill_hubs"].find.return_value = [{"id": hub, "enabled": True, "cache_generation": "new"}]
    assert _load_hub_skills({f"hub-{hub}-review": (hub, "review")}, db) == []
    cached["cache_generation"] = "new"
    assert len(_load_hub_skills({f"hub-{hub}-review": (hub, "review")}, db)) == 1
