"""Deep Agents adapter using the existing graph, tools, files and checkpoints."""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator
from contextlib import aclosing
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
    SessionBinding,
    TurnOutcome,
    ValidationIssue,
)
from harness_engine.sessions import ProviderSessionContext, ProviderSessionState


class DeepAgentsSessionManager:
    harness_id = "dynamic_agents"

    async def open(self, context: ProviderSessionContext) -> ProviderSessionState:
        # Adopt legacy threads unchanged. Clear rotates the native context and
        # retains old checkpoints for explicit history/rewind operations.
        native_id = (
            context.conversation_id if context.epoch == 0 else f"{context.conversation_id}:epoch:{context.epoch}"
        )
        state_key = hashlib.sha256(f"{context.checkpoint_namespace}\0{native_id}".encode()).hexdigest()
        return ProviderSessionState(native_id, "langgraph", state_key)

    async def observe(self, binding: SessionBinding, event: CanonicalEventDraft) -> None:
        return None

    async def close(self, binding: SessionBinding) -> None:
        return None


class DeepAgentsAdapter:
    def __init__(self, runtime: Any | None = None) -> None:
        # Optional package isolation keeps the provider-only Engine install
        # usable without importing the Dynamic Agents HTTP application.
        self.runtime = runtime or import_module("harness_engine.deep_agents_runtime").DeepAgentsRuntime()
        self.session_manager = DeepAgentsSessionManager()

    @property
    def checkpoint_namespace(self) -> str:
        return self.runtime.mongo.settings.checkpoint_collection

    @property
    def descriptor(self) -> HarnessDescriptor:
        capabilities = {
            name: CapabilityResult(level=CapabilityLevel.NATIVE)
            for name in (
                "thread.persistence",
                "thread.rewind",
                "session.cross_replica",
                "stream.text",
                "human_input.resume",
                "attachments",
                "tools.broker",
                "tools.builtin",
                "knowledge",
                "skills",
                "model.configured",
                "multi_agent.delegation",
                "deep_agents.middleware",
                "remote_agents",
                "workflows",
            )
        }
        capabilities.update(
            {
                "stream.replay": CapabilityResult(
                    level=CapabilityLevel.EMULATED, explanation="Engine persists ordered runtime events"
                ),
                "sandbox.workspace": CapabilityResult(
                    level=CapabilityLevel.NATIVE, explanation="Existing state/GridFS filesystem backend"
                ),
                "sandbox.isolation": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE, explanation="External workers are not configured"
                ),
                "memory.long_term": CapabilityResult(level=CapabilityLevel.UNAVAILABLE),
            }
        )
        return HarnessDescriptor(
            id="dynamic_agents",
            display_name="LangChain Deep Agents",
            adapter_version="2.0.0",
            contract_version=2,
            execution_mode=ExecutionMode.IN_PROCESS,
            availability="available",
            certification="experimental",
            profiles=[
                HarnessProfile(
                    id="existing", harness_id="dynamic_agents", display_name="Existing runtime configuration"
                )
            ],
            options_schema={
                "type": "object",
                "properties": {"runtime": {"type": "object"}},
                "required": ["runtime"],
                "additionalProperties": False,
            },
            ui_schema={
                "version": 1,
                "sections": [
                    {
                        "id": "remote",
                        "title": "Remote agents",
                        "step": "advanced",
                        "requires": ["remote_agents"],
                        "renderer": "remote-agents",
                        "valuePath": "/tools",
                    },
                    {
                        "id": "approvals",
                        "title": "Human Approval",
                        "step": "advanced",
                        "requires": ["human_input.resume"],
                        "renderer": "tool-approvals",
                        "valuePath": "/tools",
                    },
                    {
                        "id": "workflows",
                        "title": "Workflows",
                        "step": "advanced",
                        "requires": ["workflows"],
                        "renderer": "workflow-tools",
                        "valuePath": "/tools",
                    },
                    {
                        "id": "delegation",
                        "title": "Subagents",
                        "step": "advanced",
                        "requires": ["multi_agent.delegation"],
                        "renderer": "agent-delegation",
                        "valuePath": "/delegation",
                    },
                    {
                        "id": "middleware",
                        "title": "Middleware",
                        "step": "advanced",
                        "requires": ["deep_agents.middleware"],
                        "renderer": "deep-agents-middleware",
                        "valuePath": "/harness/options/runtime/features",
                    },
                ],
            },
            capabilities=capabilities,
        )

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        issues: list[ValidationIssue] = []
        normalized: dict[str, Any] = {}
        try:
            normalized = self.runtime.normalize_options(blueprint.harness.options)
            config = normalized["runtime"]
            if blueprint.model.policy != "configured" or not blueprint.model.id or not blueprint.model.provider:
                raise ValueError("Deep Agents requires a configured model and provider")
            if sorted(blueprint.delegation.agents) != sorted(
                child["agent_id"] for child in config.get("subagents", [])
            ):
                raise ValueError("Delegation targets must match the runtime's subagents")
        except ValueError as exc:
            issues.append(
                ValidationIssue(
                    path="harness.options.runtime",
                    capability="configuration",
                    level=CapabilityLevel.UNSUPPORTED,
                    severity="error",
                    message=str(exc),
                )
            )
        return AdapterEvaluation(normalized_options=normalized, issues=issues)

    async def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]:
        async with aclosing(self.runtime.execute(context)) as events:
            async for event in events:
                yield event

    async def cancel_run(self, run_id: str) -> bool:
        return await self.runtime.cancel_run(run_id)

    async def close(self) -> None:
        await self.runtime.close()
