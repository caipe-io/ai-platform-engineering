"""Provider-neutral adapter contract."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Protocol

from harness_engine.models import (
    AdapterEvaluation,
    AgentBlueprint,
    CanonicalEventDraft,
    HarnessDescriptor,
    RunContext,
    TurnOutcome,
)

if TYPE_CHECKING:
    from harness_engine.sessions import ProviderSessionManager


class HarnessAdapter(Protocol):
    @property
    def descriptor(self) -> HarnessDescriptor: ...

    @property
    def session_manager(self) -> ProviderSessionManager: ...

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation: ...

    def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]: ...


class HarnessAdapterV2(Protocol):
    """An execution attempt ends with exactly one explicit, durable outcome."""

    @property
    def descriptor(self) -> HarnessDescriptor: ...

    @property
    def session_manager(self) -> ProviderSessionManager: ...

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation: ...

    def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]: ...

    async def cancel_run(self, run_id: str) -> bool: ...
