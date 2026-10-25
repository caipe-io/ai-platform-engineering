"""CAIPE-owned binding lifecycle and provider-native session contracts."""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from harness_engine.models import (
    AgentVersion,
    CanonicalEventDraft,
    ClearAgentSessionResult,
    SessionBinding,
)
from harness_engine.repository import RevisionConflictError, RunRepository

if TYPE_CHECKING:
    from harness_engine.registry import HarnessRegistry

CheckpointStrategy = Literal["langgraph", "adapter_store", "remote_managed", "ephemeral"]


@dataclass(frozen=True)
class ProviderSessionContext:
    """Narrow identity passed to a provider session manager."""

    binding_id: str
    agent_id: str
    agent_version: int
    conversation_id: str
    profile_id: str
    epoch: int


@dataclass(frozen=True)
class ProviderSessionState:
    provider_session_id: str | None
    checkpoint_strategy: CheckpointStrategy


class ProviderSessionManager(Protocol):
    """Provider-owned native session behavior, without CAIPE persistence authority."""

    @property
    def harness_id(self) -> str: ...

    async def open(self, context: ProviderSessionContext) -> ProviderSessionState: ...

    async def observe(
        self, binding: SessionBinding, event: CanonicalEventDraft
    ) -> str | None: ...

    async def close(self, binding: SessionBinding) -> None: ...


class DeterministicProviderSessionManager:
    """Provider session manager for caller-assigned, stable native IDs."""

    def __init__(
        self,
        harness_id: str,
        *,
        prefix: str,
        checkpoint_strategy: CheckpointStrategy,
    ) -> None:
        self._harness_id = harness_id
        self._prefix = prefix
        self._checkpoint_strategy = checkpoint_strategy

    @property
    def harness_id(self) -> str:
        return self._harness_id

    async def open(self, context: ProviderSessionContext) -> ProviderSessionState:
        digest = context.binding_id.removeprefix("binding-")
        return ProviderSessionState(
            provider_session_id=f"{self._prefix}{digest}",
            checkpoint_strategy=self._checkpoint_strategy,
        )

    async def observe(
        self, binding: SessionBinding, event: CanonicalEventDraft
    ) -> None:
        return None

    async def close(self, binding: SessionBinding) -> None:
        return None


class EventAssignedProviderSessionManager:
    """Provider session manager for SDKs that issue a session ID in their stream."""

    def __init__(
        self, harness_id: str, *, checkpoint_strategy: CheckpointStrategy
    ) -> None:
        self._harness_id = harness_id
        self._checkpoint_strategy = checkpoint_strategy

    @property
    def harness_id(self) -> str:
        return self._harness_id

    async def open(self, context: ProviderSessionContext) -> ProviderSessionState:
        return ProviderSessionState(
            provider_session_id=None,
            checkpoint_strategy=self._checkpoint_strategy,
        )

    async def observe(
        self, binding: SessionBinding, event: CanonicalEventDraft
    ) -> str | None:
        if event.event_type != "session.updated":
            return None
        provider_session_id = event.data.get("provider_session_id")
        if not isinstance(provider_session_id, str) or not provider_session_id:
            raise ValueError("Provider session update is missing a valid session ID")
        if len(provider_session_id) > 1024:
            raise ValueError("Provider session ID exceeds the platform limit")
        return provider_session_id

    async def close(self, binding: SessionBinding) -> None:
        return None


class AgentSessionNotRunnableError(Exception):
    """The selected agent version or provider session manager is unavailable."""


class AgentSessionClosedError(Exception):
    """A stale run attempted to emit after its binding was closed."""


class CAIPEAgentSessionManager:
    """Own binding identity, epochs, version pinning, and durable session state."""

    def __init__(
        self,
        repository: RunRepository,
        registry: HarnessRegistry,
        session_key: bytes,
    ) -> None:
        self._repository = repository
        self._registry = registry
        self._session_key = session_key

    def _binding_id(
        self,
        owner_subject: str,
        agent_id: str,
        conversation_id: str,
        epoch: int,
    ) -> str:
        identity = "\0".join(
            (owner_subject, agent_id, conversation_id, str(epoch))
        ).encode()
        digest = hmac.new(self._session_key, identity, hashlib.sha256).hexdigest()
        return f"binding-{digest}"

    async def current(
        self, owner_subject: str, agent_id: str, conversation_id: str
    ) -> SessionBinding | None:
        return await self._repository.get_latest_session(
            owner_subject, agent_id, conversation_id
        )

    async def resolve(
        self, owner_subject: str, agent_id: str, conversation_id: str
    ) -> tuple[SessionBinding, AgentVersion]:
        record = await self._repository.get_agent(agent_id)
        if record is None or not record.enabled:
            raise AgentSessionNotRunnableError(agent_id)

        latest = await self.current(owner_subject, agent_id, conversation_id)
        if latest is not None and latest.status == "active":
            version = await self._repository.get_agent_version(
                agent_id, latest.agent_version
            )
            if version is None:
                raise AgentSessionNotRunnableError(agent_id)
            return latest, version

        epoch = latest.epoch + 1 if latest else 0
        version = await self._repository.get_agent_version(
            agent_id, record.current_version
        )
        if version is None:
            raise AgentSessionNotRunnableError(agent_id)
        try:
            adapter = self._registry.adapter(version.blueprint.harness.id)
        except KeyError as exc:
            raise AgentSessionNotRunnableError(version.blueprint.harness.id) from exc
        context = ProviderSessionContext(
            binding_id=self._binding_id(
                owner_subject, agent_id, conversation_id, epoch
            ),
            agent_id=agent_id,
            agent_version=version.version,
            conversation_id=conversation_id,
            profile_id=version.blueprint.harness.profile_id,
            epoch=epoch,
        )
        provider_state = await adapter.session_manager.open(context)
        binding = await self._repository.create_session(
            SessionBinding(
                binding_id=context.binding_id,
                owner_subject=owner_subject,
                agent_id=agent_id,
                agent_version=version.version,
                conversation_id=conversation_id,
                harness_id=version.blueprint.harness.id,
                profile_id=version.blueprint.harness.profile_id,
                provider_session_id=provider_state.provider_session_id,
                checkpoint_strategy=provider_state.checkpoint_strategy,
                epoch=epoch,
            )
        )
        return binding, version

    async def observe_provider_event(
        self, binding: SessionBinding, event: CanonicalEventDraft
    ) -> SessionBinding:
        persisted = await self.ensure_active(binding)
        adapter = self._registry.adapter(binding.harness_id)
        provider_session_id = await adapter.session_manager.observe(persisted, event)
        if provider_session_id is None or provider_session_id == persisted.provider_session_id:
            return persisted
        try:
            return await self._repository.update_session_provider_id(
                persisted.binding_id, provider_session_id
            )
        except RevisionConflictError as exc:
            raise AgentSessionClosedError(binding.binding_id) from exc

    async def ensure_active(self, binding: SessionBinding) -> SessionBinding:
        persisted = await self._repository.get_session(binding.binding_id)
        if persisted is None or persisted.status != "active":
            raise AgentSessionClosedError(binding.binding_id)
        return persisted

    async def clear(
        self, owner_subject: str, agent_id: str, conversation_id: str
    ) -> ClearAgentSessionResult:
        binding = await self.current(owner_subject, agent_id, conversation_id)
        if binding is None or binding.status == "closed":
            return ClearAgentSessionResult(
                cleared=False,
                closed_binding_id=binding.binding_id if binding else None,
                next_epoch=(binding.epoch + 1) if binding else 0,
            )
        adapter = self._registry.adapter(binding.harness_id)
        closed = await self._repository.close_session(binding.binding_id)
        await adapter.session_manager.close(closed)
        return ClearAgentSessionResult(
            cleared=True,
            closed_binding_id=closed.binding_id,
            next_epoch=closed.epoch + 1,
        )
