"""Stable platform contracts consumed by harness adapters.

The initial release supplies a prompt compiler and durable event/session storage.
The remaining protocols deliberately describe extension points without pretending
that an implementation exists. Descriptor capabilities expose that distinction.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

from harness_engine.models import AgentBlueprint, CanonicalEventDraft, RenderedPrompt, RunContext


class ThreadStateStore(Protocol):
    async def load(self, binding_id: str) -> dict[str, Any] | None: ...

    async def save(self, binding_id: str, state: dict[str, Any]) -> None: ...


class MemoryBroker(Protocol):
    async def search(
        self, *, subject: str, agent_id: str, query: str, limit: int
    ) -> list[dict[str, Any]]: ...

    async def remember(
        self, *, subject: str, agent_id: str, memories: list[dict[str, Any]]
    ) -> None: ...


class ToolBroker(Protocol):
    async def invoke(
        self, *, subject: str, tool_id: str, arguments: dict[str, Any]
    ) -> dict[str, Any]: ...


class SandboxManager(Protocol):
    async def acquire(self, *, profile_id: str, binding_id: str) -> str: ...

    async def release(self, lease_id: str) -> None: ...


class PromptCompiler(Protocol):
    async def compile(self, blueprint: AgentBlueprint) -> RenderedPrompt: ...


class DelegationBroker(Protocol):
    def stream(self, context: RunContext, target_agent_id: str) -> AsyncIterator[CanonicalEventDraft]: ...


class TelemetrySink(Protocol):
    async def emit(self, event_name: str, attributes: dict[str, Any]) -> None: ...


class DefaultPromptCompiler:
    """Render the portable prompt without executing provider-specific templates."""

    async def compile(self, blueprint: AgentBlueprint) -> RenderedPrompt:
        system = blueprint.prompt.system
        for name, value in blueprint.prompt.variables.items():
            system = system.replace("{{" + name + "}}", value)
        return RenderedPrompt(system=system)


@dataclass(frozen=True)
class RuntimeServices:
    """Optional platform services injected into adapters as support lands."""

    thread_state: ThreadStateStore | None = None
    memory: MemoryBroker | None = None
    tools: ToolBroker | None = None
    sandboxes: SandboxManager | None = None
    delegation: DelegationBroker | None = None
    telemetry: TelemetrySink | None = None
