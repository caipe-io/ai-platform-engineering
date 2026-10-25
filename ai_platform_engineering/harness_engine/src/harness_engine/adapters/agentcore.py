"""Amazon Bedrock AgentCore Runtime adapter."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Any, Protocol

import boto3

from harness_engine.config import AgentCoreRuntimeTarget, Settings
from harness_engine.models import (
    AdapterEvaluation,
    AgentBlueprint,
    CanonicalEventDraft,
    CapabilityLevel,
    CapabilityResult,
    ExecutionMode,
    HarnessDescriptor,
    HarnessProfile,
    RunContext,
    ValidationIssue,
)
from harness_engine.repository import RunRepository
from harness_engine.sessions import DeterministicProviderSessionManager, ProviderSessionManager


class AgentCoreDataClient(Protocol):
    def invoke_agent_runtime(self, **kwargs: Any) -> dict[str, Any]: ...

    def invoke_harness(self, **kwargs: Any) -> dict[str, Any]: ...


_END = object()


@dataclass(frozen=True)
class AgentCoreInvocationTarget:
    arn: str
    qualifier: str
    region: str | None

    @property
    def is_managed_harness(self) -> bool:
        return ":harness/" in self.arn


def _next_or_end(iterator: Iterator[Any]) -> Any:
    try:
        return next(iterator)
    except StopIteration:
        return _END


class AgentCoreAdapter:
    """Invoke allowlisted AgentCore runtimes without forwarding user credentials."""

    def __init__(
        self,
        settings: Settings,
        *,
        clients: dict[str, AgentCoreDataClient] | None = None,
        resource_repository: RunRepository | None = None,
    ) -> None:
        self._settings = settings
        self._targets = settings.agentcore_targets()
        self._clients = clients or {}
        self._resource_repository = resource_repository
        self._session_manager = DeterministicProviderSessionManager(
            "agentcore",
            prefix="harness-session-",
            checkpoint_strategy="remote_managed",
        )

    def set_registered_profiles(self, targets: dict[str, AgentCoreRuntimeTarget]) -> None:
        configured = self._settings.agentcore_targets()
        if configured.keys() & targets.keys():
            raise ValueError("Registered AgentCore profiles conflict with environment configuration")
        # Connections are append-only; an older concurrent read must not remove
        # a connection another request has already loaded.
        self._targets = {**self._targets, **configured, **targets}

    @property
    def configured_aliases(self) -> list[str]:
        return sorted(self._targets)

    @property
    def session_manager(self) -> ProviderSessionManager:
        return self._session_manager

    @property
    def descriptor(self) -> HarnessDescriptor:
        profiles = [
            HarnessProfile(
                id=alias,
                harness_id="agentcore",
                display_name=alias.replace("-", " ").replace("_", " ").title(),
                description=(
                    "Operator-managed AgentCore Harness"
                    if self._targets[alias].is_managed_harness
                    else "Operator-managed AgentCore Runtime"
                ),
            )
            for alias in self.configured_aliases
        ]
        return HarnessDescriptor(
            id="agentcore",
            display_name="Amazon Bedrock AgentCore",
            adapter_version="1.0.0",
            execution_mode=ExecutionMode.PROVIDER_MANAGED,
            availability="available" if profiles else "misconfigured",
            certification="experimental",
            profiles=profiles,
            options_schema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
            capabilities={
                "stream.text": CapabilityResult(level=CapabilityLevel.NATIVE),
                "stream.replay": CapabilityResult(
                    level=CapabilityLevel.EMULATED,
                    explanation="Harness Engine persists the canonical event log",
                ),
                "thread.persistence": CapabilityResult(
                    level=CapabilityLevel.NATIVE,
                    explanation="A stable runtimeSessionId resumes the AgentCore session",
                ),
                "session.cross_replica": CapabilityResult(level=CapabilityLevel.NATIVE),
                "sandbox.isolation": CapabilityResult(
                    level=CapabilityLevel.NATIVE,
                    explanation="AgentCore provides provider-managed microVM isolation",
                ),
                "sandbox.workspace": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Persistent workspaces are not connected in this adapter",
                ),
                "memory.long_term": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="AgentCore Memory is not connected to the memory broker yet",
                ),
                "tools.broker": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Portable tool bindings are not connected yet",
                ),
                "multi_agent.delegation": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Cross-harness delegation is not connected yet",
                ),
            },
        )

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        issues: list[ValidationIssue] = []
        if blueprint.harness.options:
            issues.append(
                ValidationIssue(
                    path="harness.options",
                    capability="configuration",
                    level=CapabilityLevel.UNSUPPORTED,
                    severity="error",
                    message="AgentCore does not accept user-owned runtime options",
                )
            )
        return AdapterEvaluation(normalized_options={}, issues=issues)

    async def _target(
        self, alias: str, agent_id: str
    ) -> AgentCoreInvocationTarget:
        try:
            configured = self._targets[alias]
        except KeyError as exc:
            raise ValueError(f'AgentCore runtime alias "{alias}" is not configured') from exc

        if configured.provisioning == "shared":
            if not configured.arn:
                raise RuntimeError("Shared AgentCore target has no ARN")
            return AgentCoreInvocationTarget(
                configured.arn, configured.qualifier, configured.region
            )
        if self._resource_repository is None:
            raise RuntimeError("AgentCore per-agent resource repository is unavailable")
        resource = await self._resource_repository.get_provider_resource(agent_id)
        if (
            resource is None
            or resource.harness_id != "agentcore"
            or resource.profile_id != alias
            or resource.status != "ready"
        ):
            raise RuntimeError("AgentCore agent harness is not provisioned")
        return AgentCoreInvocationTarget(
            resource.arn, resource.qualifier, resource.region
        )

    def _client(self, target: AgentCoreInvocationTarget) -> AgentCoreDataClient:
        key = target.region or "default"
        if key not in self._clients:
            self._clients[key] = boto3.client(
                "bedrock-agentcore",
                region_name=target.region,
                endpoint_url=self._settings.agentcore_endpoint_url,
            )
        return self._clients[key]

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        target = await self._target(context.binding.profile_id, context.blueprint.id)
        if not context.binding.provider_session_id:
            raise RuntimeError("AgentCore session manager did not assign a runtime session ID")
        if target.is_managed_harness:
            async for event in self._stream_managed_harness(context, target):
                yield event
            return

        async for event in self._stream_custom_runtime(context, target):
            yield event

    async def _stream_managed_harness(
        self, context: RunContext, target: AgentCoreInvocationTarget
    ) -> AsyncIterator[CanonicalEventDraft]:
        if not context.binding.provider_session_id:
            raise RuntimeError("AgentCore session manager did not assign a runtime session ID")
        request: dict[str, Any] = {
            "harnessArn": target.arn,
            "runtimeSessionId": context.binding.provider_session_id,
            "runtimeUserId": (
                "caipe-user-"
                + hashlib.sha256(context.binding.owner_subject.encode()).hexdigest()[:32]
            ),
            "qualifier": target.qualifier,
            "messages": [
                {
                    "role": "user",
                    "content": [{"text": context.turn.message}],
                }
            ],
            "systemPrompt": [{"text": context.prompt.system}],
        }
        if context.turn.traceparent:
            request["traceParent"] = context.turn.traceparent
        if context.blueprint.model.policy == "configured" and context.blueprint.model.id:
            request["model"] = {
                "bedrockModelConfig": {"modelId": context.blueprint.model.id}
            }

        response = await asyncio.to_thread(self._client(target).invoke_harness, **request)
        body = response.get("stream")
        if body is None:
            raise RuntimeError("AgentCore Harness returned no response stream")

        iterator = iter(body)
        while True:
            raw = await asyncio.to_thread(_next_or_end, iterator)
            if raw is _END:
                break
            if not isinstance(raw, dict):
                continue
            delta = raw.get("contentBlockDelta", {}).get("delta", {})
            text = delta.get("text")
            if text:
                yield CanonicalEventDraft(event_type="content.delta", data={"text": str(text)})
            reasoning = delta.get("reasoningContent", {}).get("text")
            if reasoning:
                yield CanonicalEventDraft(
                    event_type="reasoning.delta", data={"text": str(reasoning)}
                )
            usage = raw.get("metadata", {}).get("usage")
            if usage:
                yield CanonicalEventDraft(event_type="usage.updated", data={"usage": usage})

    async def _stream_custom_runtime(
        self, context: RunContext, target: AgentCoreInvocationTarget
    ) -> AsyncIterator[CanonicalEventDraft]:
        if not context.binding.provider_session_id:
            raise RuntimeError("AgentCore session manager did not assign a runtime session ID")
        request_body = {
            "prompt": context.turn.message,
            "system_prompt": context.prompt.system,
            "agent_id": context.blueprint.id,
            "conversation_id": context.binding.conversation_id,
        }
        if context.turn.traceparent:
            request_body["traceparent"] = context.turn.traceparent
        payload = json.dumps(
            request_body,
            separators=(",", ":"),
        ).encode()
        response = await asyncio.to_thread(
            self._client(target).invoke_agent_runtime,
            agentRuntimeArn=target.arn,
            runtimeSessionId=context.binding.provider_session_id,
            qualifier=target.qualifier,
            contentType="application/json",
            accept="text/event-stream, application/json",
            payload=payload,
        )
        content_type = str(response.get("contentType", ""))
        body = response.get("response")
        if body is None:
            raise RuntimeError("AgentCore returned no response stream")

        if "text/event-stream" in content_type and hasattr(body, "iter_lines"):
            iterator = iter(body.iter_lines(chunk_size=64))
            while True:
                raw = await asyncio.to_thread(_next_or_end, iterator)
                if raw is _END:
                    break
                if not raw:
                    continue
                line = bytes(raw).decode("utf-8", errors="replace")
                if line.startswith("data:"):
                    line = line[5:].lstrip()
                if line:
                    yield CanonicalEventDraft(event_type="content.delta", data={"text": line})
            return

        chunks: list[bytes] = []
        if hasattr(body, "iter_chunks"):
            chunks.extend(chunk for chunk in body.iter_chunks() if chunk)
        elif hasattr(body, "read"):
            chunks.append(await asyncio.to_thread(body.read))
        else:
            chunks.extend(bytes(chunk) for chunk in body)
        decoded = b"".join(chunks).decode("utf-8", errors="replace")
        if not decoded:
            return
        try:
            parsed = json.loads(decoded)
            text = str(parsed.get("result") or parsed.get("response") or decoded)
        except json.JSONDecodeError:
            text = decoded
        yield CanonicalEventDraft(event_type="content.delta", data={"text": text})
