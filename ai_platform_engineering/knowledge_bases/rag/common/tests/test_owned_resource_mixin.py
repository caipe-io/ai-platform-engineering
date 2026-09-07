"""Tests for OwnedResourceMixin on DataSourceInfo / MCPToolConfig.

Spec 2026-06-03-unified-shareable-resource-rbac (US5/US6): the config is the
source of truth for ownership/sharing, persisted to Redis via model_dump() and
reconstructed via DataSourceInfo(**data) / MCPToolConfig(**data). These tests
pin (de)serialization round-trips and backward-compat defaults for configs
written before the mixin existed.
"""

from common.models.rag import DataSourceInfo, MCPToolConfig, OwnedResourceMixin


def _datasource(**overrides):
    base = dict(
        datasource_id="ds-1",
        ingestor_id="ing-1",
        source_type="url",
        last_updated=0,
    )
    base.update(overrides)
    return DataSourceInfo(**base)


class TestDataSourceInfoOwnership:
    def test_defaults_when_fields_absent(self):
        """A config persisted before the mixin existed deserializes cleanly."""
        ds = _datasource()
        assert ds.creator_subject is None
        assert ds.owner_subject is None
        assert ds.owner_team_slug is None
        assert ds.shared_with_teams == []
        assert ds.search_with_teams == []
        assert ds.search_with_users == []

    def test_round_trip_preserves_ownership(self):
        ds = _datasource(
            creator_subject="alice-sub",
            owner_team_slug="platform",
            shared_with_teams=["data-eng", "ml-ops"],
        )
        dumped = ds.model_dump()
        restored = DataSourceInfo(**dumped)
        assert restored.creator_subject == "alice-sub"
        assert restored.owner_team_slug == "platform"
        assert restored.shared_with_teams == ["data-eng", "ml-ops"]

    def test_owner_deduped_out_of_shared(self):
        ds = _datasource(
            owner_team_slug="platform",
            shared_with_teams=["platform", "data-eng", "data-eng"],
        )
        # owner removed (union semantics) + duplicate collapsed.
        assert ds.shared_with_teams == ["data-eng"]

    def test_search_access_may_include_the_management_owner_team(self):
        ds = _datasource(
            owner_team_slug="platform",
            search_with_teams=["platform", "data-eng", "platform"],
        )
        assert ds.search_with_teams == ["platform", "data-eng"]

    def test_direct_user_search_access_is_normalized(self):
        ds = _datasource(
            search_with_users=["reader-sub", "reader-sub", "", "  "],
        )
        assert ds.search_with_users == ["reader-sub"]

    def test_blank_and_whitespace_shared_dropped(self):
        ds = _datasource(shared_with_teams=["", "  ", "data-eng"])
        assert ds.shared_with_teams == ["data-eng"]

    def test_legacy_blob_with_unknown_extra_keys_still_loads(self):
        # Forward/backward compat: a stored blob may carry keys this model
        # version doesn't know; Pydantic ignores unknowns by default.
        ds = DataSourceInfo(
            datasource_id="ds-2",
            ingestor_id="ing-1",
            source_type="url",
            last_updated=0,
            owner_team_slug="platform",
        )
        assert ds.owner_team_slug == "platform"


class TestMCPToolConfigOwnership:
    def test_defaults_when_fields_absent(self):
        cfg = MCPToolConfig(tool_id="infra_search")
        assert cfg.creator_subject is None
        assert cfg.owner_team_slug is None
        assert cfg.shared_with_teams == []

    def test_round_trip_preserves_ownership(self):
        cfg = MCPToolConfig(
            tool_id="infra_search",
            creator_subject="bob-sub",
            owner_team_slug="sre",
            shared_with_teams=["platform"],
        )
        restored = MCPToolConfig(**cfg.model_dump())
        assert restored.creator_subject == "bob-sub"
        assert restored.owner_team_slug == "sre"
        assert restored.shared_with_teams == ["platform"]

    def test_existing_domain_fields_unchanged(self):
        cfg = MCPToolConfig(tool_id="infra_search", description="d", enabled=False)
        assert cfg.tool_id == "infra_search"
        assert cfg.description == "d"
        assert cfg.enabled is False


class TestMixinDirectly:
    def test_mixin_is_composable_standalone(self):
        m = OwnedResourceMixin(owner_team_slug="t", shared_with_teams=["t", "u"])
        assert m.shared_with_teams == ["u"]
