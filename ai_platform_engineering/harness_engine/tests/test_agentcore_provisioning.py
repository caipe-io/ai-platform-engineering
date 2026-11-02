from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from botocore.exceptions import ClientError, ReadTimeoutError
from fastapi.testclient import TestClient

from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.models import AgentBlueprint
from harness_engine.provisioning import AgentCoreHarnessProvisioner, ProviderProvisioningError
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


def per_agent_settings() -> Settings:
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


class RetiredTokenClient(FakeAgentCoreControlClient):
    def __init__(self) -> None:
        super().__init__()
        self.retired: set[str] = set()
        self.active: dict[str, dict[str, str]] = {}

    def create_harness(self, **kwargs: object) -> dict[str, Any]:
        self.create_calls.append(kwargs)
        token = str(kwargs["clientToken"])
        if token in self.retired:
            raise ClientError({"Error": {"Code": "ConflictException", "Message":
                f"Resource previously created with clientToken {token} has since been deleted."
            }}, "CreateHarness")
        if token not in self.active:
            self.active[token] = {**self.harness, "harnessId": f"example-{len(self.retired):010d}"}
            self.active[token]["arn"] = f"arn:aws:bedrock-agentcore:us-east-2:111122223333:harness/{self.active[token]['harnessId']}"
        return {"harness": self.active[token].copy()}

    def delete_harness(self, **kwargs: object) -> dict[str, Any]:
        self.delete_calls.append(kwargs)
        for token, harness in list(self.active.items()):
            if harness["harnessId"] == kwargs["harnessId"]:
                self.retired.add(token)
                del self.active[token]
        return {"harness": {"status": "DELETING"}}


async def test_deleted_creation_generations_converge_across_replicas() -> None:
    client = RetiredTokenClient()
    settings = per_agent_settings()
    first = AgentCoreHarnessProvisioner(settings, control_clients={"us-east-2": client})
    draft = AgentBlueprint.model_validate(blueprint())
    original, _ = await first.ensure(draft, None)
    assert original is not None
    await first.delete(original)
    second = AgentCoreHarnessProvisioner(settings, control_clients={"us-east-2": client})
    resources = await asyncio.gather(first.ensure(draft, None), second.ensure(draft, None))
    assert resources[0][0] is not None and resources[1][0] is not None
    assert resources[0][0].arn == resources[1][0].arn != original.arn
    assert len(client.active) == 1
    replacement_tokens = {str(call["clientToken"]) for call in client.create_calls if call["clientToken"] not in client.retired}
    assert len(replacement_tokens) == 1


@pytest.mark.parametrize("failure", [
    ClientError({"Error": {"Code": "ConflictException", "Message": "Another operation is in progress"}}, "CreateHarness"),
    ReadTimeoutError(endpoint_url="https://example.test"),
])
async def test_unknown_creation_outcomes_do_not_rotate_tokens(failure: Exception) -> None:
    class FailingClient(FakeAgentCoreControlClient):
        def create_harness(self, **kwargs: object) -> dict[str, Any]:
            self.create_calls.append(kwargs)
            raise failure

    client = FailingClient()
    provisioner = AgentCoreHarnessProvisioner(per_agent_settings(), control_clients={"us-east-2": client})
    with pytest.raises((ProviderProvisioningError, ReadTimeoutError)):
        await provisioner.ensure(AgentBlueprint.model_validate(blueprint()), None)
    assert len(client.create_calls) == 1
    assert not client.delete_calls


async def test_retired_token_walk_is_bounded() -> None:
    class AlwaysRetiredClient(RetiredTokenClient):
        def create_harness(self, **kwargs: object) -> dict[str, Any]:
            self.retired.add(str(kwargs["clientToken"]))
            return super().create_harness(**kwargs)

    client = AlwaysRetiredClient()
    provisioner = AgentCoreHarnessProvisioner(per_agent_settings(), control_clients={"us-east-2": client})
    with pytest.raises(ProviderProvisioningError, match="Too many retired"):
        await asyncio.wait_for(provisioner.ensure(AgentBlueprint.model_validate(blueprint()), None), timeout=2)
    assert 1 < len(client.create_calls) <= 32
    assert len({call["clientToken"] for call in client.create_calls}) == len(client.create_calls)
