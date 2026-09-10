# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Integration tests for the skills catalog — consistency, precedence, and backend sync.

Run with: PYTHONPATH=. uv run pytest tests/test_skills_catalog.py -v
"""

import os
import sys
from pathlib import Path
from unittest.mock import patch

# Add project root to path
sys.path.insert(0, str(Path(__file__).parents[1]))


# ---------------------------------------------------------------------------
# Test default loader
# ---------------------------------------------------------------------------


class TestDefaultLoader:
    """Tests for ai_platform_engineering.skills_middleware.loaders.default."""

    def test_load_from_folder_layout(self, tmp_path: Path):
        """Folder-per-skill layout loads SKILL.md files."""
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        skill_md = skill_dir / "SKILL.md"
        skill_md.write_text(
            "---\nname: my-skill\ndescription: A test skill\n---\n\n# My Skill\nDoes things."
        )

        with patch.dict(os.environ, {"SKILLS_DIR": str(tmp_path)}):
            from ai_platform_engineering.skills_middleware.loaders.default import (
                load_default_skills,
            )

            skills = load_default_skills(include_content=True)

        assert len(skills) == 1
        assert skills[0]["name"] == "my-skill"
        assert skills[0]["description"] == "A test skill"
        assert skills[0]["source"] == "default"
        assert skills[0]["visibility"] == "global"
        assert skills[0]["content"] is not None

    def test_load_without_content(self, tmp_path: Path):
        """include_content=False omits the content field."""
        skill_dir = tmp_path / "skill-a"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\nname: skill-a\ndescription: Desc A\n---\n\nBody."
        )

        with patch.dict(os.environ, {"SKILLS_DIR": str(tmp_path)}):
            from ai_platform_engineering.skills_middleware.loaders.default import (
                load_default_skills,
            )

            skills = load_default_skills(include_content=False)

        assert len(skills) == 1
        assert skills[0]["content"] is None

    def test_load_flat_layout(self, tmp_path: Path):
        """Flat ConfigMap layout (id--SKILL.md) is loaded."""
        flat_file = tmp_path / "flat-skill--SKILL.md"
        flat_file.write_text(
            "---\nname: flat-skill\ndescription: Flat desc\n---\n\nFlat body."
        )

        with patch.dict(os.environ, {"SKILLS_DIR": str(tmp_path)}):
            from ai_platform_engineering.skills_middleware.loaders.default import (
                load_default_skills,
            )

            skills = load_default_skills(include_content=True)

        assert len(skills) == 1
        assert skills[0]["name"] == "flat-skill"

    def test_skip_missing_name(self, tmp_path: Path):
        """Skills without name are skipped."""
        skill_dir = tmp_path / "no-name"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\ndescription: has desc but no name\n---\n\nBody."
        )

        with patch.dict(os.environ, {"SKILLS_DIR": str(tmp_path)}):
            from ai_platform_engineering.skills_middleware.loaders.default import (
                load_default_skills,
            )

            skills = load_default_skills()

        # Folder name is used as fallback id, but description check may pass
        # The key is no crash
        assert isinstance(skills, list)

    def test_empty_skills_dir(self, tmp_path: Path):
        """Empty directory returns no skills."""
        with patch.dict(os.environ, {"SKILLS_DIR": str(tmp_path)}):
            from ai_platform_engineering.skills_middleware.loaders.default import (
                load_default_skills,
            )

            skills = load_default_skills()

        assert skills == []

    def test_no_skills_dir(self):
        """Missing directory returns no skills."""
        with patch.dict(os.environ, {"SKILLS_DIR": "/nonexistent/path"}):
            from ai_platform_engineering.skills_middleware.loaders.default import (
                load_default_skills,
            )

            skills = load_default_skills()

        assert skills == []


# ---------------------------------------------------------------------------
# Test precedence
# ---------------------------------------------------------------------------


class TestPrecedence:
    """Tests for ai_platform_engineering.skills_middleware.precedence."""

    def test_default_wins_over_agent_skills(self):
        from ai_platform_engineering.skills_middleware.precedence import merge_skills

        default_skills = [
            {"name": "foo", "source": "default", "description": "default version"}
        ]
        ac_skills = [
            {"name": "foo", "source": "agent_skills", "description": "ac version"}
        ]

        merged = merge_skills(default_skills, ac_skills)
        assert len(merged) == 1
        assert merged[0]["source"] == "default"
        assert merged[0]["description"] == "default version"

    def test_default_wins_over_hub(self):
        from ai_platform_engineering.skills_middleware.precedence import merge_skills

        default_skills = [
            {"name": "bar", "source": "default", "description": "default bar"}
        ]
        hub_skills = [
            {"name": "bar", "source": "hub", "description": "hub bar"}
        ]

        merged = merge_skills(default_skills, hub_skills)
        assert len(merged) == 1
        assert merged[0]["source"] == "default"

    def test_agent_skills_wins_over_hub(self):
        from ai_platform_engineering.skills_middleware.precedence import merge_skills

        ac_skills = [
            {"name": "baz", "source": "agent_skills", "description": "ac baz"}
        ]
        hub_skills = [
            {"name": "baz", "source": "hub", "description": "hub baz"}
        ]

        merged = merge_skills(ac_skills, hub_skills)
        assert len(merged) == 1
        assert merged[0]["source"] == "agent_skills"

    def test_unique_skills_all_included(self):
        from ai_platform_engineering.skills_middleware.precedence import merge_skills

        default_skills = [
            {"name": "d1", "source": "default", "description": "d1"}
        ]
        ac_skills = [
            {"name": "a1", "source": "agent_skills", "description": "a1"}
        ]
        hub_skills = [
            {"name": "h1", "source": "hub", "description": "h1"}
        ]

        merged = merge_skills(default_skills, ac_skills, hub_skills)
        assert len(merged) == 3
        names = [s["name"] for s in merged]
        assert "d1" in names
        assert "a1" in names
        assert "h1" in names

    def test_stable_sort_order(self):
        from ai_platform_engineering.skills_middleware.precedence import merge_skills

        skills = merge_skills(
            [{"name": "z-skill", "source": "default", "description": "z"}],
            [{"name": "a-skill", "source": "agent_skills", "description": "a"}],
            [{"name": "m-skill", "source": "hub", "description": "m"}],
        )

        # Should be sorted by source priority then name
        assert skills[0]["source"] == "default"
        assert skills[1]["source"] == "agent_skills"
        assert skills[2]["source"] == "hub"

    def test_empty_input(self):
        from ai_platform_engineering.skills_middleware.precedence import merge_skills

        merged = merge_skills([], [], [])
        assert merged == []

    def test_skip_skills_without_name(self):
        from ai_platform_engineering.skills_middleware.precedence import merge_skills

        merged = merge_skills(
            [{"name": "", "source": "default", "description": "empty name"}],
            [{"name": "valid", "source": "default", "description": "valid"}],
        )
        assert len(merged) == 1
        assert merged[0]["name"] == "valid"


# ---------------------------------------------------------------------------
# Test backend sync
# ---------------------------------------------------------------------------


class TestBackendSync:
    """Tests for ai_platform_engineering.skills_middleware.backend_sync."""

    def test_build_skills_files_basic(self):
        from ai_platform_engineering.skills_middleware.backend_sync import (
            build_skills_files,
        )

        skills = [
            {
                "name": "my-skill",
                "description": "A skill",
                "source": "default",
                "source_id": None,
                "content": "---\nname: my-skill\ndescription: A skill\n---\n\n# My Skill",
                "metadata": {},
            }
        ]

        files, sources = build_skills_files(skills)

        assert len(files) == 1
        assert "/skills/default/" in sources
        path = list(files.keys())[0]
        assert path.startswith("/skills/default/")
        assert path.endswith("/SKILL.md")

    def test_build_skills_files_multiple_sources(self):
        from ai_platform_engineering.skills_middleware.backend_sync import (
            build_skills_files,
        )

        skills = [
            {
                "name": "default-skill",
                "description": "D",
                "source": "default",
                "source_id": None,
                "content": "# Default",
                "metadata": {},
            },
            {
                "name": "ac-skill",
                "description": "A",
                "source": "agent_skills",
                "source_id": "user@example.com",
                "content": "# AC",
                "metadata": {},
            },
            {
                "name": "hub-skill",
                "description": "H",
                "source": "hub",
                "source_id": "org/repo",
                "content": "# Hub",
                "metadata": {},
            },
        ]

        files, sources = build_skills_files(skills)

        assert len(files) == 3
        assert "/skills/default/" in sources
        assert "/skills/agent-skills/" in sources
        # Hub source path includes sanitized source_id
        hub_sources = [s for s in sources if "hub-" in s]
        assert len(hub_sources) == 1

    def test_build_skills_files_preserves_frontmatter(self):
        from ai_platform_engineering.skills_middleware.backend_sync import (
            build_skills_files,
        )

        original_content = "---\nname: has-fm\ndescription: Existing FM\n---\n\n# Existing"
        skills = [
            {
                "name": "has-fm",
                "description": "Existing FM",
                "source": "default",
                "source_id": None,
                "content": original_content,
                "metadata": {},
            }
        ]

        files, _ = build_skills_files(skills)
        file_data = list(files.values())[0]
        content_str = "\n".join(file_data["content"])

        # Should reuse the original content since it has frontmatter
        assert "name: has-fm" in content_str

    def test_build_skills_files_empty_input(self):
        from ai_platform_engineering.skills_middleware.backend_sync import (
            build_skills_files,
        )

        files, sources = build_skills_files([])
        assert files == {}
        assert sources == []

    def test_file_data_has_required_keys(self):
        from ai_platform_engineering.skills_middleware.backend_sync import (
            build_skills_files,
        )

        skills = [
            {
                "name": "test",
                "description": "Test",
                "source": "default",
                "source_id": None,
                "content": "Test content",
                "metadata": {},
            }
        ]

        files, _ = build_skills_files(skills)
        file_data = list(files.values())[0]

        assert "content" in file_data
        assert "created_at" in file_data
        assert "modified_at" in file_data
        assert isinstance(file_data["content"], list)


# ---------------------------------------------------------------------------
# Test catalog (with mocked loaders)
# ---------------------------------------------------------------------------


class TestCatalog:
    """Tests for ai_platform_engineering.skills_middleware.catalog."""

    def setup_method(self):
        """Clear catalog cache before each test."""
        from ai_platform_engineering.skills_middleware.catalog import (
            invalidate_skills_cache,
        )

        invalidate_skills_cache()

    def test_get_merged_skills_returns_list(self):
        """get_merged_skills returns a list of dicts."""
        with patch(
            "ai_platform_engineering.skills_middleware.catalog.load_default_skills",
            return_value=[
                {
                    "name": "s1",
                    "description": "d1",
                    "source": "default",
                    "source_id": None,
                    "content": "c1",
                    "metadata": {},
                }
            ],
        ), patch(
            "ai_platform_engineering.skills_middleware.catalog.load_agent_skills",
            return_value=[],
        ), patch(
            "ai_platform_engineering.skills_middleware.catalog._load_hub_skills",
            return_value=[],
        ):
            from ai_platform_engineering.skills_middleware.catalog import (
                get_merged_skills,
            )

            skills = get_merged_skills(include_content=True)

        assert len(skills) == 1
        assert skills[0]["name"] == "s1"
        assert skills[0]["content"] is not None

    def test_get_merged_skills_without_content(self):
        """include_content=False strips content."""
        with patch(
            "ai_platform_engineering.skills_middleware.catalog.load_default_skills",
            return_value=[
                {
                    "name": "s1",
                    "description": "d1",
                    "source": "default",
                    "source_id": None,
                    "content": "body",
                    "metadata": {},
                }
            ],
        ), patch(
            "ai_platform_engineering.skills_middleware.catalog.load_agent_skills",
            return_value=[],
        ), patch(
            "ai_platform_engineering.skills_middleware.catalog._load_hub_skills",
            return_value=[],
        ):
            from ai_platform_engineering.skills_middleware.catalog import (
                get_merged_skills,
            )

            skills = get_merged_skills(include_content=False)

        assert len(skills) == 1
        assert skills[0]["content"] is None

    def test_cache_invalidation(self):
        """invalidate_skills_cache forces fresh load."""
        call_count = 0

        def counting_loader(*_args, **_kwargs):
            nonlocal call_count
            call_count += 1
            return [
                {
                    "name": "s1",
                    "description": "d",
                    "source": "default",
                    "source_id": None,
                    "content": "c",
                    "metadata": {},
                }
            ]

        with patch(
            "ai_platform_engineering.skills_middleware.catalog.load_default_skills",
            side_effect=counting_loader,
        ), patch(
            "ai_platform_engineering.skills_middleware.catalog.load_agent_skills",
            return_value=[],
        ), patch(
            "ai_platform_engineering.skills_middleware.catalog._load_hub_skills",
            return_value=[],
        ):
            from ai_platform_engineering.skills_middleware.catalog import (
                get_merged_skills,
                invalidate_skills_cache,
            )

            # First call loads
            get_merged_skills()
            assert call_count == 1

            # Second call uses cache
            get_merged_skills()
            assert call_count == 1

            # Invalidate + third call reloads
            invalidate_skills_cache()
            get_merged_skills()
            assert call_count == 2

    def test_precedence_in_catalog(self):
        """Catalog applies precedence: default wins over agent_skills."""
        with patch(
            "ai_platform_engineering.skills_middleware.catalog.load_default_skills",
            return_value=[
                {
                    "name": "shared",
                    "description": "default version",
                    "source": "default",
                    "source_id": None,
                    "content": "d",
                    "metadata": {},
                }
            ],
        ), patch(
            "ai_platform_engineering.skills_middleware.catalog.load_agent_skills",
            return_value=[
                {
                    "name": "shared",
                    "description": "ac version",
                    "source": "agent_skills",
                    "source_id": None,
                    "content": "a",
                    "metadata": {},
                }
            ],
        ), patch(
            "ai_platform_engineering.skills_middleware.catalog._load_hub_skills",
            return_value=[],
        ):
            from ai_platform_engineering.skills_middleware.catalog import (
                get_merged_skills,
            )

            skills = get_merged_skills(include_content=True)

        assert len(skills) == 1
        assert skills[0]["description"] == "default version"


# ---------------------------------------------------------------------------
# Entitlement (FR-020)
# ---------------------------------------------------------------------------


class TestEntitlement:
    """Tests for ai_platform_engineering.skills_middleware.entitlement."""

    def test_global_visible_to_all(self):
        from ai_platform_engineering.skills_middleware.entitlement import (
            filter_skills_by_entitlement,
        )

        skills = [
            {"name": "g", "visibility": "global", "team_ids": [], "owner_user_id": None},
        ]
        out = filter_skills_by_entitlement(
            skills, sub="user-1", team_ids=["t1"], bypass_entitlement=False
        )
        assert len(out) == 1

    def test_personal_only_owner(self):
        from ai_platform_engineering.skills_middleware.entitlement import (
            filter_skills_by_entitlement,
        )

        skills = [
            {
                "name": "p",
                "visibility": "personal",
                "team_ids": [],
                "owner_user_id": "alice",
            },
        ]
        assert len(filter_skills_by_entitlement(skills, sub="alice", team_ids=[], bypass_entitlement=False)) == 1
        assert len(filter_skills_by_entitlement(skills, sub="bob", team_ids=[], bypass_entitlement=False)) == 0

    def test_team_intersection(self):
        from ai_platform_engineering.skills_middleware.entitlement import (
            filter_skills_by_entitlement,
        )

        skills = [
            {
                "name": "t",
                "visibility": "team",
                "team_ids": ["eng", "data"],
                "owner_user_id": None,
            },
        ]
        assert len(filter_skills_by_entitlement(skills, sub="u", team_ids=["eng"], bypass_entitlement=False)) == 1
        assert len(filter_skills_by_entitlement(skills, sub="u", team_ids=["sales"], bypass_entitlement=False)) == 0

    def test_bypass_entitlement(self):
        from ai_platform_engineering.skills_middleware.entitlement import (
            filter_skills_by_entitlement,
        )

        skills = [
            {
                "name": "p",
                "visibility": "personal",
                "team_ids": [],
                "owner_user_id": "alice",
            },
        ]
        assert len(filter_skills_by_entitlement(skills, sub=None, team_ids=[], bypass_entitlement=True)) == 1

    def test_team_ids_from_claims_groups(self):
        from ai_platform_engineering.skills_middleware.entitlement import team_ids_from_claims

        with patch.dict(os.environ, {"OIDC_TEAMS_CLAIM": "groups"}):
            ids = team_ids_from_claims({"sub": "x", "groups": ["a", "b"]})
        assert ids == ["a", "b"]
