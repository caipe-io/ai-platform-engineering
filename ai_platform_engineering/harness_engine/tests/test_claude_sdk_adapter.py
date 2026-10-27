from __future__ import annotations

import time
from collections.abc import AsyncIterator
from dataclasses import replace

from claude_agent_sdk import AssistantMessage, InMemorySessionStore, ResultMessage, TextBlock
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


async def test_claude_adapter_maps_messages_and_resumes_session(settings) -> None:
    captured = {}
    transcript_store = InMemorySessionStore()

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
    blueprint = AgentBlueprint(
        id="agent-example",
        name="Claude example",
        harness=HarnessSelection(
            id="claude_agent_sdk", profile_id="safe", options={"max_turns": 7}
        ),
        prompt=PromptDefinition(system="Be careful."),
    )
    context = RunContext(
        blueprint=blueprint,
        binding=SessionBinding(
            binding_id="binding-example",
            owner_subject="test-user",
            agent_id=blueprint.id,
            agent_version=1,
            conversation_id="conversation-example",
            harness_id="claude_agent_sdk",
            profile_id="safe",
            provider_session_id="claude-session-old",
            checkpoint_strategy="adapter_store",
        ),
        prompt=RenderedPrompt(system="Be careful."),
        turn=TurnInput(run_id="run-example", message="hello"),
    )

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
    assert options.session_store is transcript_store
    assert options.session_store_flush == "eager"
    assert options.env["CLAUDE_CONFIG_DIR"] == "/tmp/claude-agent-sdk"
    assert options.setting_sources == []
    assert options.tools == []
    command = SubprocessCLITransport(
        prompt=captured["prompt"], options=replace(options, cli_path="claude")
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
    adapter = ClaudeSDKAdapter(settings, transcript_store=InMemorySessionStore())

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

    adapter = ClaudeSDKAdapter(settings, query_fn=fake_query)
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
        for options in sdk_options:
            command = SubprocessCLITransport(
                prompt="hello", options=replace(options, cli_path="claude")
            )._build_command()
            assert command[command.index("--tools") + 1] == ""
