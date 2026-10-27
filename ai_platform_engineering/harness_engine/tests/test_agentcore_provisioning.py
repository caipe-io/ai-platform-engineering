from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from harness_engine.main import create_app
from harness_engine.models import AgentBlueprint
from harness_engine.provisioning import AgentCoreHarnessProvisioner
from harness_engine.repository import InMemoryRunRepository
from tests.conftest import FakeHarnessAdapter, auth_headers, blueprint


class FakeAgentCoreControlClient:
    def __init__(self) -> None:
        self.create_calls: list[dict[str, object]] = []
        self.get_calls: list[dict[str, object]] = []
        self.update_calls: list[dict[str, object]] = []
        self.delete_calls: list[dict[str, object]] = []
        self.harness = {
            "harnessId": "caipe_example-AbCdEf1234",
            "harnessName": "caipe_Example_agent_7d9b9eaa",
            "arn": (
                "arn:aws:bedrock-agentcore:us-east-2:111122223333:"
                "harness/caipe_example-AbCdEf1234"
            ),
            "status": "READY",
        }

    def create_harness(self, **kwargs: object) -> dict[str, Any]:
        self.create_calls.append(kwargs)
        return {"harness": self.harness.copy()}

    def get_harness(self, **kwargs: object) -> dict[str, Any]:
        self.get_calls.append(kwargs)
        return {"harness": self.harness.copy()}

    def update_harness(self, **kwargs: object) -> dict[str, Any]:
        self.update_calls.append(kwargs)
        return {"harness": self.harness.copy()}

    def delete_harness(self, **kwargs: object) -> dict[str, Any]:
        self.delete_calls.append(kwargs)
        return {"harness": {**self.harness, "status": "DELETING"}}


def per_agent_settings():
    from harness_engine.config import Settings

    return Settings(
        internal_token="test-internal-token-value",
        storage_backend="memory",
        agentcore_runtimes_json=json.dumps(
            {
                "primary": {
                    "provisioning": "per_agent",
                    "region": "us-east-2",
                    "execution_role_arn": (
                        "arn:aws:iam::111122223333:role/example-agentcore-role"
                    ),
                    "model_id": "global.anthropic.claude-sonnet-example",
                }
            }
        ),
        claude_sdk_profiles_json="{}",
    )


async def test_provisioner_creates_and_reuses_one_harness_per_agent() -> None:
    settings = per_agent_settings()
    client = FakeAgentCoreControlClient()
    provisioner = AgentCoreHarnessProvisioner(
        settings, control_clients={"us-east-2": client}
    )
    draft = AgentBlueprint.model_validate(blueprint())

    resource, created = await provisioner.ensure(draft, None)

    assert created is True
    assert resource is not None
    assert resource.agent_id == "agent-example"
    assert resource.arn == client.harness["arn"]
    assert client.create_calls[0]["harnessName"].startswith("caipe_Example_agent_")
    assert client.create_calls[0]["systemPrompt"] == [
        {"text": "Be helpful to {{audience}}."}
    ]
    assert client.create_calls[0]["tags"] == {
        "caipe:managed-by": "harness-engine",
        "caipe:agent-id": "agent-example",
    }

    # Provider retries and parallel CAIPE saves use the same AWS idempotency key.
    retry_provisioner = AgentCoreHarnessProvisioner(
        settings, control_clients={"us-east-2": client}
    )
    await retry_provisioner.ensure(draft, None)
    assert client.create_calls[0]["clientToken"] == client.create_calls[1]["clientToken"]

    reused, created_again = await provisioner.ensure(draft, resource)

    assert created_again is False
    assert reused is not None and reused.arn == resource.arn
    assert len(client.create_calls) == 2
    assert client.get_calls == [{"harnessId": resource.resource_id}]

    changed = draft.model_copy(deep=True)
    changed.prompt.system = "Use the revised instructions."
    updated, created_by_update = await provisioner.ensure(changed, resource)

    assert created_by_update is False
    assert updated is not None
    assert updated.configuration_fingerprint != resource.configuration_fingerprint
    assert client.update_calls[0]["systemPrompt"] == [
        {"text": "Use the revised instructions."}
    ]


def test_agent_api_provisions_and_deletes_the_server_owned_harness() -> None:
    settings = per_agent_settings()
    repository = InMemoryRunRepository()
    control_client = FakeAgentCoreControlClient()
    provisioner = AgentCoreHarnessProvisioner(
        settings, control_clients={"us-east-2": control_client}
    )
    app = create_app(
        settings=settings,
        repository=repository,
        adapters=[FakeHarnessAdapter()],
        agentcore_provisioner=provisioner,
    )

    with TestClient(app) as client:
        saved = client.put(
            "/api/v1/agents/agent-example",
            headers=auth_headers(),
            json={"blueprint": blueprint()},
        )
        assert saved.status_code == 200, saved.text
        # Provider ARNs remain server-owned and are not returned to the author.
        assert "bedrock-agentcore" not in saved.text

        deleted = client.delete(
            "/api/v1/agents/agent-example", headers=auth_headers()
        )
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["data"] == {
            "deleted": True,
            "agent_id": "agent-example",
        }

    assert len(control_client.create_calls) == 1
    assert control_client.delete_calls[0]["harnessId"] == (
        "caipe_example-AbCdEf1234"
    )
