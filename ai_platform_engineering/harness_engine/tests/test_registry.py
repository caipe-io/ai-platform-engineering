from __future__ import annotations

import pytest

from harness_engine.adapters import AgentCoreAdapter, ClaudeSDKAdapter
from harness_engine.config import Settings
from harness_engine.models import AgentBlueprint
from harness_engine.registry import HarnessRegistry
from tests.conftest import blueprint


def test_registry_catalog_contains_both_contract_probes(settings) -> None:
    registry = HarnessRegistry([AgentCoreAdapter(settings), ClaudeSDKAdapter(settings)])

    assert [descriptor.id for descriptor in registry.catalog()] == [
        "agentcore",
        "claude_agent_sdk",
    ]
    assert len(registry.catalog_revision) == 64


def test_registry_blocks_unconnected_portable_capability(settings) -> None:
    registry = HarnessRegistry([ClaudeSDKAdapter(settings)])
    draft = blueprint(
        harness_id="claude_agent_sdk", profile_id="safe", options={"max_turns": 10}
    )
    draft["memory"] = {"enabled": True}

    result = registry.validate(AgentBlueprint.model_validate(draft))

    assert result.valid is False
    assert result.normalized_blueprint.harness.options == {"max_turns": 10}
    assert [(issue.path, issue.capability) for issue in result.issues] == [
        ("memory", "memory.long_term")
    ]


def test_registry_rejects_a_stale_catalog_revision(settings) -> None:
    registry = HarnessRegistry([AgentCoreAdapter(settings)])

    result = registry.validate(
        AgentBlueprint.model_validate(blueprint()), requested_catalog_revision="stale"
    )

    assert result.valid is False
    assert result.issues[0].path == "catalog_revision"


def test_public_service_token_is_rejected_before_startup() -> None:
    with pytest.raises(ValueError, match="private HARNESS_ENGINE_INTERNAL_TOKEN"):
        Settings(internal_token="local-development-only").require_private_token()
    Settings(internal_token="example-private-service-token").require_private_token()
