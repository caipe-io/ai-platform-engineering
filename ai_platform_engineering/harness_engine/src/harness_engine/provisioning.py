"""Server-owned provider resource lifecycle for Harness Engine agents."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any, Protocol
from uuid import uuid4

import boto3
from botocore.exceptions import ClientError

from harness_engine.config import AgentCoreRuntimeTarget, Settings
from harness_engine.models import AgentBlueprint, ProviderResource, utc_now


class AgentCoreControlClient(Protocol):
    def create_harness(self, **kwargs: object) -> dict[str, Any]: ...

    def get_harness(self, **kwargs: object) -> dict[str, Any]: ...

    def update_harness(self, **kwargs: object) -> dict[str, Any]: ...

    def delete_harness(self, **kwargs: object) -> dict[str, Any]: ...


class ProviderProvisioningError(RuntimeError):
    """A provider resource could not be made ready or safely removed."""


def _harness_name(blueprint: AgentBlueprint) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_]", "_", blueprint.name).strip("_")
    if not normalized or not normalized[0].isalpha():
        normalized = f"agent_{normalized}"
    digest = hashlib.sha256(blueprint.id.encode()).hexdigest()[:8]
    return f"caipe_{normalized[:25]}_{digest}"


def _provider_configuration(
    blueprint: AgentBlueprint, profile: AgentCoreRuntimeTarget
) -> dict[str, object]:
    configuration: dict[str, object] = {
        "executionRoleArn": profile.execution_role_arn or "",
        "systemPrompt": [{"text": blueprint.prompt.system}],
    }
    if profile.model_id:
        configuration["model"] = {
            "bedrockModelConfig": {
                "modelId": profile.model_id,
                "apiFormat": profile.api_format,
            }
        }
    return configuration


def _configuration_fingerprint(
    blueprint: AgentBlueprint, profile: AgentCoreRuntimeTarget
) -> str:
    encoded = json.dumps(
        _provider_configuration(blueprint, profile),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _create_token(
    blueprint: AgentBlueprint, configuration_fingerprint: str
) -> str:
    """Make concurrent retries for one CAIPE agent converge in AgentCore."""

    material = (
        f"{blueprint.id}:{blueprint.harness.profile_id}:"
        f"{configuration_fingerprint}"
    )
    return f"caipe-{hashlib.sha256(material.encode()).hexdigest()}"


class AgentCoreHarnessProvisioner:
    """Create one managed AgentCore Harness for each CAIPE AgentCore agent."""

    def __init__(
        self,
        settings: Settings,
        *,
        control_clients: Mapping[str, AgentCoreControlClient] | None = None,
    ) -> None:
        self._settings = settings
        self._profiles = settings.agentcore_targets()
        self._clients = dict(control_clients or {})

    def set_registered_profiles(self, targets: dict[str, AgentCoreRuntimeTarget]) -> None:
        configured = self._settings.agentcore_targets()
        if configured.keys() & targets.keys():
            raise ValueError("Registered AgentCore profiles conflict with environment configuration")
        self._profiles = {**self._profiles, **configured, **targets}

    def _profile(self, profile_id: str) -> AgentCoreRuntimeTarget:
        try:
            return self._profiles[profile_id]
        except KeyError as exc:
            raise ProviderProvisioningError(
                f'AgentCore operator profile "{profile_id}" is not configured'
            ) from exc

    def _client(self, region: str) -> AgentCoreControlClient:
        if region not in self._clients:
            self._clients[region] = boto3.client(
                "bedrock-agentcore-control", region_name=region
            )
        return self._clients[region]

    async def ensure(
        self,
        blueprint: AgentBlueprint,
        current: ProviderResource | None,
    ) -> tuple[ProviderResource | None, bool]:
        """Return the ready resource and whether this call created it."""

        profile = self._profile(blueprint.harness.profile_id)
        if profile.provisioning == "shared":
            return None, False
        if not profile.region or not profile.execution_role_arn:
            raise ProviderProvisioningError("AgentCore provisioning profile is incomplete")
        configuration = _provider_configuration(blueprint, profile)
        configuration_fingerprint = _configuration_fingerprint(blueprint, profile)

        if (
            current
            and current.provider == "aws_agentcore"
            and current.region == profile.region
        ):
            harness = await self._get_harness(profile.region, current.resource_id)
            if harness is not None:
                if current.configuration_fingerprint != configuration_fingerprint:
                    harness = await self._update_harness(
                        profile.region,
                        current.resource_id,
                        configuration,
                        configuration_fingerprint,
                    )
                ready = await self._wait_until_ready(
                    profile.region, current.resource_id, harness
                )
                return current.model_copy(
                    update={
                        "arn": str(ready["arn"]),
                        "profile_id": blueprint.harness.profile_id,
                        "qualifier": profile.qualifier,
                        "configuration_fingerprint": configuration_fingerprint,
                        "status": "ready",
                        "updated_at": utc_now(),
                    }
                ), False

        client = self._client(profile.region)
        request: dict[str, object] = {
            "harnessName": _harness_name(blueprint),
            "clientToken": _create_token(blueprint, configuration_fingerprint),
            "tags": {
                "caipe:managed-by": "harness-engine",
                "caipe:agent-id": blueprint.id,
            },
            **configuration,
        }
        resource_id: str | None = None
        try:
            response = await asyncio.to_thread(client.create_harness, **request)
            harness = response["harness"]
            resource_id = str(harness["harnessId"])
            ready = await self._wait_until_ready(profile.region, resource_id, harness)
        except ProviderProvisioningError:
            if resource_id is not None:
                await self._best_effort_delete(profile.region, resource_id)
            raise
        except (ClientError, KeyError, TypeError) as exc:
            raise ProviderProvisioningError(
                "Amazon Bedrock AgentCore could not create the agent harness"
            ) from exc

        now = utc_now()
        return (
            ProviderResource(
                agent_id=blueprint.id,
                harness_id="agentcore",
                profile_id=blueprint.harness.profile_id,
                provider="aws_agentcore",
                resource_type="harness",
                resource_id=resource_id,
                arn=str(ready["arn"]),
                region=profile.region,
                qualifier=profile.qualifier,
                configuration_fingerprint=configuration_fingerprint,
                created_at=now,
                updated_at=now,
            ),
            True,
        )

    async def delete(self, resource: ProviderResource) -> None:
        if resource.provider != "aws_agentcore" or resource.ownership != "agent":
            return
        try:
            await asyncio.to_thread(
                self._client(resource.region).delete_harness,
                harnessId=resource.resource_id,
                clientToken=str(uuid4()),
                deleteManagedMemory=True,
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                return
            raise ProviderProvisioningError(
                "Amazon Bedrock AgentCore could not delete the agent harness"
            ) from exc

    async def _update_harness(
        self,
        region: str,
        resource_id: str,
        configuration: dict[str, object],
        configuration_fingerprint: str,
    ) -> dict[str, Any]:
        try:
            response = await asyncio.to_thread(
                self._client(region).update_harness,
                harnessId=resource_id,
                clientToken=f"caipe-{configuration_fingerprint}",
                **configuration,
            )
            return response["harness"]
        except (ClientError, KeyError, TypeError) as exc:
            raise ProviderProvisioningError(
                "Amazon Bedrock AgentCore could not update the agent harness"
            ) from exc

    async def _best_effort_delete(self, region: str, resource_id: str) -> None:
        try:
            await asyncio.to_thread(
                self._client(region).delete_harness,
                harnessId=resource_id,
                clientToken=str(uuid4()),
                deleteManagedMemory=True,
            )
        except ClientError:
            return

    async def _get_harness(
        self, region: str, resource_id: str
    ) -> dict[str, Any] | None:
        try:
            response = await asyncio.to_thread(
                self._client(region).get_harness, harnessId=resource_id
            )
            return response["harness"]
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                return None
            raise ProviderProvisioningError(
                "Amazon Bedrock AgentCore could not inspect the agent harness"
            ) from exc
        except (KeyError, TypeError) as exc:
            raise ProviderProvisioningError(
                "Amazon Bedrock AgentCore returned an invalid harness response"
            ) from exc

    async def _wait_until_ready(
        self, region: str, resource_id: str, initial: dict[str, Any]
    ) -> dict[str, Any]:
        deadline = (
            asyncio.get_running_loop().time()
            + self._settings.agentcore_provision_timeout_seconds
        )
        harness = initial
        while True:
            state = str(harness.get("status", ""))
            if state == "READY":
                return harness
            if state in {"CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"}:
                raise ProviderProvisioningError(
                    f"Amazon Bedrock AgentCore harness entered {state}"
                )
            if asyncio.get_running_loop().time() >= deadline:
                raise ProviderProvisioningError(
                    "Timed out waiting for the Amazon Bedrock AgentCore harness"
                )
            await asyncio.sleep(self._settings.agentcore_provision_poll_seconds)
            refreshed = await self._get_harness(region, resource_id)
            if refreshed is None:
                raise ProviderProvisioningError(
                    "Amazon Bedrock AgentCore harness disappeared while provisioning"
                )
            harness = refreshed
