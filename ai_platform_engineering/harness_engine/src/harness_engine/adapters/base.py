"""Provider-neutral adapter contract."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Protocol

from harness_engine.models import (
    AdapterEvaluation,
    AgentBlueprint,
    CanonicalEventDraft,
    HarnessDescriptor,
    ProviderTurnOutcome,
    RunContext,
)

if TYPE_CHECKING:
    from harness_engine.sessions import ProviderSessionManager


class HarnessAdapter(Protocol):
    @property
    def descriptor(self) -> HarnessDescriptor: ...

    @property
    def session_manager(self) -> ProviderSessionManager: ...

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation: ...

    def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | ProviderTurnOutcome]: ...


class CancellableHarnessAdapter(Protocol):
    """Optional provider stop capability, separate from stream ownership."""

    async def cancel(self, context: RunContext) -> None: ...
