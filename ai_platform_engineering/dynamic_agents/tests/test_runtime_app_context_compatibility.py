"""Runtime selection retains Managed context support without claiming coding support."""

import pytest
from pydantic import ValidationError

from dynamic_agents.models import DynamicAgentConfigBase


@pytest.mark.parametrize("harness_id", ["agentcore", "claude_agent_sdk"])
def test_sdk_profiles_do_not_require_a_native_model(harness_id: str) -> None:
    agent = DynamicAgentConfigBase(name="Example", system_prompt="Operate.", execution_harness_id=harness_id)
    assert agent.model is None


def test_coding_profiles_do_not_claim_managed_app_context_projection() -> None:
    with pytest.raises(ValidationError, match="supported only by the managed runtime"):
        DynamicAgentConfigBase(
            name="Example", system_prompt="Operate.", execution={"kind": "sandbox", "profile_id": "primary"},
            app_context_prompt={"app_ids": ["example"], "fields": ["title"]},
        )
