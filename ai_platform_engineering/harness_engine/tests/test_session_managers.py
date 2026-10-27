from __future__ import annotations

from harness_engine.models import AgentBlueprint, CanonicalEventDraft, SessionBinding
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import InMemoryRunRepository
from harness_engine.sessions import (
    CAIPEAgentSessionManager,
    ProviderSessionContext,
    ProviderSessionState,
)
from tests.conftest import FakeHarnessAdapter, blueprint


class TrackingProviderSessionManager:
    harness_id = "agentcore"

    def __init__(self) -> None:
        self.opened: list[ProviderSessionContext] = []
        self.closed: list[str] = []

    async def open(self, context: ProviderSessionContext) -> ProviderSessionState:
        self.opened.append(context)
        return ProviderSessionState(
            provider_session_id=f"native-{context.binding_id}",
            checkpoint_strategy="remote_managed",
        )

    async def observe(
        self, binding: SessionBinding, event: CanonicalEventDraft
    ) -> None:
        return None

    async def close(self, binding: SessionBinding) -> None:
        self.closed.append(binding.binding_id)


class TrackingAdapter(FakeHarnessAdapter):
    def __init__(self, sessions: TrackingProviderSessionManager) -> None:
        super().__init__()
        self._tracking_sessions = sessions

    @property
    def session_manager(self) -> TrackingProviderSessionManager:
        return self._tracking_sessions


async def test_caipe_manager_owns_version_pinning_and_epoch_rotation() -> None:
    repository = InMemoryRunRepository()
    provider_sessions = TrackingProviderSessionManager()
    registry = HarnessRegistry([TrackingAdapter(provider_sessions)])
    draft = AgentBlueprint.model_validate(blueprint())
    validation = registry.validate(draft)
    await repository.save_agent(
        validation.normalized_blueprint,
        validation.config_fingerprint,
        validation.catalog_revision,
        None,
    )
    sessions = CAIPEAgentSessionManager(repository, registry, b"session-test-key")

    first, first_version = await sessions.resolve(
        "test-user", "agent-example", "conversation-example"
    )
    same, same_version = await sessions.resolve(
        "test-user", "agent-example", "conversation-example"
    )

    assert first == same
    assert first_version.version == same_version.version == 1
    assert first.epoch == 0
    assert len(provider_sessions.opened) == 1

    cleared = await sessions.clear(
        "test-user", "agent-example", "conversation-example"
    )
    second, _ = await sessions.resolve(
        "test-user", "agent-example", "conversation-example"
    )

    assert cleared.cleared is True
    assert provider_sessions.closed == [first.binding_id]
    assert second.epoch == 1
    assert second.binding_id != first.binding_id
    assert second.provider_session_id != first.provider_session_id
    assert len(provider_sessions.opened) == 2
