from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import pytest

from harness_engine.config import Settings
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
)
from harness_engine.repository import InMemoryRunRepository
from harness_engine.sessions import DeterministicProviderSessionManager, ProviderSessionManager


class FakeHarnessAdapter:
    def __init__(self, chunks: list[str] | None = None, delay: float = 0.0) -> None:
        self.chunks = chunks or ["hello", " world"]
        self.delay = delay
        self.calls: list[RunContext] = []
        self._session_manager = DeterministicProviderSessionManager(
            "agentcore", prefix="provider-", checkpoint_strategy="remote_managed"
        )

    @property
    def session_manager(self) -> ProviderSessionManager:
        return self._session_manager

    @property
    def descriptor(self) -> HarnessDescriptor:
        return HarnessDescriptor(
            id="agentcore",
            display_name="Fake AgentCore",
            adapter_version="test",
            execution_mode=ExecutionMode.PROVIDER_MANAGED,
            availability="available",
            profiles=[
                HarnessProfile(
                    id="primary",
                    harness_id="agentcore",
                    display_name="Primary",
                )
            ],
            options_schema={"type": "object", "properties": {}, "additionalProperties": False},
            capabilities={
                "stream.replay": CapabilityResult(level=CapabilityLevel.EMULATED),
                "thread.persistence": CapabilityResult(level=CapabilityLevel.NATIVE),
                "memory.long_term": CapabilityResult(level=CapabilityLevel.UNAVAILABLE),
                "tools.broker": CapabilityResult(level=CapabilityLevel.UNAVAILABLE),
                "sandbox.workspace": CapabilityResult(level=CapabilityLevel.UNAVAILABLE),
                "multi_agent.delegation": CapabilityResult(level=CapabilityLevel.UNAVAILABLE),
            },
        )

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        return AdapterEvaluation(normalized_options={})

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        self.calls.append(context)
        for chunk in self.chunks:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield CanonicalEventDraft(event_type="content.delta", data={"text": chunk})


def blueprint(
    *,
    harness_id: str = "agentcore",
    profile_id: str = "primary",
    options: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "id": "agent-example",
        "name": "Example agent",
        "description": "Portable test agent",
        "harness": {
            "id": harness_id,
            "profile_id": profile_id,
            "options": options or {},
        },
        "prompt": {"system": "Be helpful to {{audience}}.", "variables": {"audience": "users"}},
    }


@pytest.fixture
def settings() -> Settings:
    return Settings(
        internal_token="test-internal-token-value",
        storage_backend="memory",
        long_poll_seconds=0.1,
        agentcore_runtimes_json=json.dumps(
            {
                "primary": {
                    "arn": "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/example",
                    "qualifier": "DEFAULT",
                }
            }
        ),
        claude_sdk_profiles_json=json.dumps(
            {
                "safe": {
                    "model": "claude-example",
                    "cwd": "/workspace",
                    "permission_mode": "dontAsk",
                }
            }
        ),
    )


@pytest.fixture
def repository() -> InMemoryRunRepository:
    return InMemoryRunRepository()


def auth_headers(subject: str = "test-user") -> dict[str, str]:
    return {
        "Authorization": "Bearer test-internal-token-value",
        "X-Harness-Engine-Subject": subject,
    }
