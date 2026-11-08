"""Registered A2A participants using the existing Dynamic Agents transport."""
from __future__ import annotations

from collections.abc import AsyncIterator
from importlib import import_module
from typing import Any

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
    TurnOutcome,
    ValidationIssue,
)
from harness_engine.sessions import EventAssignedProviderSessionManager


class RemoteA2AAdapter:
    def __init__(self, registry_runtime: Any, runtime: Any | None = None) -> None:
        self.runtime = runtime or import_module("harness_engine.a2a_runtime").A2ARuntime(registry_runtime)
        self.session_manager = EventAssignedProviderSessionManager("a2a_remote", checkpoint_strategy="remote_managed")

    @property
    def descriptor(self) -> HarnessDescriptor:
        return HarnessDescriptor(
            id="a2a_remote", display_name="Remote A2A agent", adapter_version="1.0.0", contract_version=2,
            execution_mode=ExecutionMode.PROVIDER_MANAGED, availability="available", certification="experimental",
            profiles=[HarnessProfile(id="registry", harness_id="a2a_remote", display_name="Approved A2A registry")],
            options_schema={"type": "object", "properties": {"registry_id": {"type": "string"}},
                            "required": ["registry_id"], "additionalProperties": False},
            capabilities={
                "stream.text": CapabilityResult(level=CapabilityLevel.EMULATED, explanation="Stream artifact snapshots in the tool timeline; publish the final answer once"),
                "human_input.resume": CapabilityResult(level=CapabilityLevel.EMULATED),
                "stream.replay": CapabilityResult(level=CapabilityLevel.EMULATED, explanation="Engine persists events"),
                "thread.persistence": CapabilityResult(level=CapabilityLevel.NATIVE, explanation="Remote context IDs are persisted; retention is controlled by the remote service"),
                "session.cross_replica": CapabilityResult(level=CapabilityLevel.NATIVE),
                "multi_agent.delegation": CapabilityResult(level=CapabilityLevel.UNAVAILABLE, explanation="Receives assignments; remote initiation requires a handoff bridge"),
            },
        )

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        options = blueprint.harness.options
        registry_id = options.get("registry_id")
        if (set(options) != {"registry_id"} or not isinstance(registry_id, str)
                or not registry_id.startswith("remote-") or blueprint.id != f"a2a-{registry_id}"
                or blueprint.harness.profile_id != "registry"):
            return AdapterEvaluation(normalized_options={}, issues=[ValidationIssue(
                path="harness.options", capability="configuration", level=CapabilityLevel.UNSUPPORTED,
                severity="error", message="Choose an approved registry participant with a matching identity",
            )])
        return AdapterEvaluation(normalized_options=options)

    async def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]:
        async for event in self.runtime.execute(context):
            yield event

    async def cancel_run(self, run_id: str) -> bool:
        return await self.runtime.cancel_run(run_id)
