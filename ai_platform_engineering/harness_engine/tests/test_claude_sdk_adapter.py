from __future__ import annotations

import time
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    InMemorySessionStore,
    MirrorErrorMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
)
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
from fastapi.testclient import TestClient

from harness_engine.adapters.claude_sdk import ClaudeSDKAdapter
from harness_engine.main import create_app
from harness_engine.models import (
    AgentBlueprint,
    HarnessSelection,
    PromptDefinition,
    RenderedPrompt,
    RunContext,
    SessionBinding,
    TurnInput,
)
from harness_engine.repository import InMemoryRunRepository
from tests.conftest import auth_headers, blueprint


class RecordingScope(InMemorySessionStore):
    def __init__(self, context: RunContext) -> None:
        super().__init__()
        self.context = context
        self.closed = False
        self.prepared = False

    async def ready(self) -> None:
        self.prepared = True

    async def close(self) -> None:
        self.closed = True


class RecordingTranscriptStore:
    def __init__(self) -> None:
        self.scopes: list[RecordingScope] = []
        self.purged: list[SessionBinding] = []

    def for_run(self, context: RunContext) -> RecordingScope:
        scoped = RecordingScope(context)
        self.scopes.append(scoped)
        return scoped

    async def purge_for_binding(self, binding: SessionBinding) -> None:
        self.purged.append(binding)


def sdk_context(*, provider_session_id: str | None = None) -> RunContext:
    definition = AgentBlueprint(
        id="agent-example",
        name="Claude example",
        harness=HarnessSelection(id="claude_agent_sdk", profile_id="safe", options={"max_turns": 7}),
        prompt=PromptDefinition(system="Be careful."),
    )
    return RunContext(
        blueprint=definition,
        binding=SessionBinding(
            binding_id="binding-example",
            owner_subject="test-user",
            agent_id=definition.id,
            agent_version=1,
            conversation_id="conversation-example",
            harness_id="claude_agent_sdk",
            profile_id="safe",
            provider_session_id=provider_session_id,
            checkpoint_strategy="adapter_store",
        ),
        prompt=RenderedPrompt(system="Be careful."),
        turn=TurnInput(run_id="run-example", message="hello"),
        producer_token="producer-example",
    )


async def test_claude_adapter_maps_messages_and_resumes_session(settings) -> None:
    captured = {}
    transcript_store = RecordingTranscriptStore()

    async def fake_query(**kwargs: object) -> AsyncIterator[object]:
        captured.update(kwargs)
        yield AssistantMessage(content=[TextBlock(text="hello")], model="claude-example")
        yield ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id="claude-session-next",
            usage={"input_tokens": 2},
        )

    adapter = ClaudeSDKAdapter(
        settings,
        query_fn=fake_query,
        transcript_store=transcript_store,
    )
    context = sdk_context(provider_session_id="claude-session-old")

    events = [event async for event in adapter.stream(context)]

    assert [event.event_type for event in events] == [
        "content.delta",
        "session.updated",
        "usage.updated",
    ]
    options = captured["options"]
    assert options.resume == "claude-session-old"
    assert options.max_turns == 7
    assert options.permission_mode == "dontAsk"
    assert options.session_store is transcript_store.scopes[0]
    assert transcript_store.scopes[0].context is context
    assert transcript_store.scopes[0].prepared and transcript_store.scopes[0].closed
    assert options.session_store_flush == "eager"
    assert not Path(options.env["CLAUDE_CONFIG_DIR"]).exists()
    assert options.setting_sources == []
    assert options.tools == []
    # This verifies the pinned SDK actually disables CLI built-ins; an empty
    # allowed_tools list or permission mode alone does not do that.
    command = SubprocessCLITransport(
        prompt=captured["prompt"], options=replace(options, cli_path="/example/claude")
    )._build_command()
    assert command[command.index("--tools") + 1] == ""
    assert "--allowedTools" not in command


def test_claude_descriptor_and_validation_are_declarative(settings) -> None:
    adapter = ClaudeSDKAdapter(settings)
    assert adapter.descriptor.execution_mode == "in_process"
    assert adapter.descriptor.options_schema["properties"]["max_turns"]["maximum"] == 100
    assert adapter.descriptor.capabilities["sandbox.isolation"].level == "unavailable"
    assert adapter.descriptor.capabilities["session.cross_replica"].level == "unavailable"


def test_claude_descriptor_reports_shared_transcript_store(settings) -> None:
    adapter = ClaudeSDKAdapter(settings, transcript_store=RecordingTranscriptStore())

    assert adapter.descriptor.capabilities["session.cross_replica"].level == "native"


def test_claude_native_session_is_persisted_and_resumed_by_caipe(settings) -> None:
    sdk_options = []

    async def fake_query(**kwargs: object) -> AsyncIterator[object]:
        sdk_options.append(kwargs["options"])
        yield AssistantMessage(content=[TextBlock(text="hello")], model="claude-example")
        yield ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id="claude-session-persisted",
        )

    adapter = ClaudeSDKAdapter(settings, query_fn=fake_query, transcript_store=RecordingTranscriptStore())
    app = create_app(
        settings=settings,
        repository=InMemoryRunRepository(),
        adapters=[adapter],
    )
    with TestClient(app) as client:
        draft = blueprint(
            harness_id="claude_agent_sdk",
            profile_id="safe",
            options={"max_turns": 7},
        )
        saved = client.put(
            "/api/v1/agents/agent-example",
            headers=auth_headers(),
            json={"blueprint": draft},
        )
        assert saved.status_code == 200

        first = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "one",
            },
        )
        time.sleep(0.05)
        second = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "two",
            },
        )
        time.sleep(0.05)

        assert first.json()["data"]["provider_session_id"] is None
        assert second.json()["data"]["provider_session_id"] == "claude-session-persisted"
        assert sdk_options[0].resume is None
        assert sdk_options[1].resume == "claude-session-persisted"
        assert sdk_options[0].env["CLAUDE_CONFIG_DIR"] != sdk_options[1].env["CLAUDE_CONFIG_DIR"]
        assert all(not Path(options.env["CLAUDE_CONFIG_DIR"]).exists() for options in sdk_options)
        for options in sdk_options:
            command = SubprocessCLITransport(
                prompt="hello", options=replace(options, cli_path="/example/claude")
            )._build_command()
            assert command[command.index("--tools") + 1] == ""


async def test_claude_reports_partial_provider_identity_before_final_result(settings) -> None:
    async def fake_query(**kwargs: object) -> AsyncIterator[object]:
        yield SystemMessage(subtype="init", data={"session_id": "claude-session-partial"})
        yield AssistantMessage(
            content=[TextBlock(text="partial")], model="claude-example", session_id="claude-session-partial"
        )
        raise RuntimeError("provider disconnected")

    adapter = ClaudeSDKAdapter(settings, query_fn=fake_query)
    events = []
    with pytest.raises(RuntimeError, match="provider disconnected"):
        async for event in adapter.stream(sdk_context()):
            events.append(event)

    assert [event.event_type for event in events] == ["session.updated", "content.delta"]
    assert events[0].data == {"provider_session_id": "claude-session-partial"}


async def test_claude_mirror_failure_fails_run_and_closes_provider_before_scope(settings) -> None:
    store = RecordingTranscriptStore()
    config_dirs: list[Path] = []
    provider_closed = False

    async def fake_query(**kwargs: object) -> AsyncIterator[object]:
        nonlocal provider_closed
        config_dir = Path(kwargs["options"].env["CLAUDE_CONFIG_DIR"])
        config_dirs.append(config_dir)
        assert config_dir.is_dir()
        try:
            yield MirrorErrorMessage(subtype="mirror_error", data={}, error="example failure")
        finally:
            assert not store.scopes[0].closed
            assert config_dir.exists()
            provider_closed = True

    adapter = ClaudeSDKAdapter(settings, query_fn=fake_query, transcript_store=store)
    with pytest.raises(RuntimeError, match="mirroring failed"):
        _ = [event async for event in adapter.stream(sdk_context())]

    assert provider_closed and store.scopes[0].closed
    assert all(not path.exists() for path in config_dirs)


async def test_claude_rejects_resume_without_transcript_store_before_provider(settings) -> None:
    sent = False

    async def fake_query(**kwargs: object) -> AsyncIterator[object]:
        nonlocal sent
        sent = True
        yield SystemMessage(subtype="init", data={})

    adapter = ClaudeSDKAdapter(settings, query_fn=fake_query)
    with pytest.raises(RuntimeError, match="transcript store is required"):
        _ = [event async for event in adapter.stream(sdk_context(provider_session_id="session-existing"))]
    assert not sent
    assert adapter.descriptor.capabilities["thread.persistence"].level == "unavailable"


async def test_claude_delete_delegates_exact_binding_to_transcript_store(settings) -> None:
    store = RecordingTranscriptStore()
    adapter = ClaudeSDKAdapter(settings, transcript_store=store)
    binding = sdk_context().binding.model_copy(update={"status": "closed"})

    await adapter.delete_session(binding)

    assert store.purged == [binding]
