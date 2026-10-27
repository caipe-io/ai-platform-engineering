from __future__ import annotations

import json
from collections.abc import Iterator

from harness_engine.adapters.agentcore import AgentCoreAdapter
from harness_engine.config import Settings
from harness_engine.models import (
    AgentBlueprint,
    HarnessSelection,
    PromptDefinition,
    ProviderResource,
    RenderedPrompt,
    RunContext,
    SessionBinding,
    TurnInput,
)
from harness_engine.repository import InMemoryRunRepository


class StreamingBody:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines

    def iter_lines(self, chunk_size: int) -> Iterator[bytes]:
        assert chunk_size == 64
        return iter(self._lines)


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def invoke_agent_runtime(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return {
            "contentType": "text/event-stream",
            "response": StreamingBody([b"data: first", b"", b"data: second"]),
        }


class FakeManagedHarnessClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def invoke_harness(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return {
            "stream": iter(
                [
                    {"messageStart": {"role": "assistant"}},
                    {"contentBlockDelta": {"delta": {"text": "managed"}}},
                    {"contentBlockDelta": {"delta": {"text": " harness"}}},
                    {"metadata": {"usage": {"inputTokens": 3, "outputTokens": 2}}},
                ]
            )
        }


def context(profile_id: str = "primary") -> RunContext:
    blueprint = AgentBlueprint(
        id="agent-example",
        name="Example",
        harness=HarnessSelection(id="agentcore", profile_id=profile_id),
        prompt=PromptDefinition(system="Be helpful."),
    )
    return RunContext(
        blueprint=blueprint,
        binding=SessionBinding(
            binding_id="binding-example",
            owner_subject="test-user",
            agent_id=blueprint.id,
            agent_version=1,
            conversation_id="conversation-example",
            harness_id="agentcore",
            profile_id=profile_id,
            provider_session_id="harness-session-12345678901234567890123456789012",
            checkpoint_strategy="remote_managed",
        ),
        prompt=RenderedPrompt(system="Be helpful."),
        turn=TurnInput(
            run_id="run-example",
            message="hello",
            traceparent="00-11111111111111111111111111111111-2222222222222222-01",
        ),
    )


async def test_agentcore_adapter_uses_operator_target_and_provider_session(settings: Settings) -> None:
    client = FakeClient()
    adapter = AgentCoreAdapter(settings, clients={"default": client})

    events = [event async for event in adapter.stream(context())]

    assert [event.data["text"] for event in events] == ["first", "second"]
    assert client.calls[0]["agentRuntimeArn"] == (
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/example"
    )
    assert client.calls[0]["runtimeSessionId"] == (
        "harness-session-12345678901234567890123456789012"
    )
    payload = client.calls[0]["payload"]
    assert isinstance(payload, bytes)
    assert b'"system_prompt":"Be helpful."' in payload
    assert "Authorization" not in client.calls[0]


async def test_agentcore_adapter_rejects_non_allowlisted_profile(settings: Settings) -> None:
    adapter = AgentCoreAdapter(settings, clients={"default": FakeClient()})

    try:
        _ = [event async for event in adapter.stream(context("not-configured"))]
    except ValueError as exc:
        assert "not configured" in str(exc)
    else:
        raise AssertionError("expected the profile to be rejected")


async def test_agentcore_adapter_invokes_managed_harness() -> None:
    client = FakeManagedHarnessClient()
    settings = Settings(
        internal_token="test-internal-token-value",
        agentcore_runtimes_json=json.dumps(
            {
                "primary": {
                    "arn": (
                        "arn:aws:bedrock-agentcore:us-east-2:111122223333:"
                        "harness/example-harness"
                    ),
                    "qualifier": "DEFAULT",
                    "region": "us-east-2",
                }
            }
        ),
    )
    adapter = AgentCoreAdapter(settings, clients={"us-east-2": client})

    events = [event async for event in adapter.stream(context())]

    assert [event.event_type for event in events] == [
        "content.delta",
        "content.delta",
        "usage.updated",
    ]
    assert [event.data.get("text") for event in events[:2]] == ["managed", " harness"]
    call = client.calls[0]
    assert call["harnessArn"] == (
        "arn:aws:bedrock-agentcore:us-east-2:111122223333:harness/example-harness"
    )
    assert call["messages"] == [{"role": "user", "content": [{"text": "hello"}]}]
    assert call["systemPrompt"] == [{"text": "Be helpful."}]
    assert call["traceParent"] == (
        "00-11111111111111111111111111111111-2222222222222222-01"
    )
    assert call["runtimeUserId"] != "test-user"
    assert "Authorization" not in call


async def test_agentcore_adapter_resolves_a_server_owned_per_agent_harness() -> None:
    repository = InMemoryRunRepository()
    await repository.save_provider_resource(
        ProviderResource(
            agent_id="agent-example",
            harness_id="agentcore",
            profile_id="primary",
            provider="aws_agentcore",
            resource_type="harness",
            resource_id="example-harness-AbCdEf1234",
            arn=(
                "arn:aws:bedrock-agentcore:us-east-2:111122223333:"
                "harness/example-harness-AbCdEf1234"
            ),
            region="us-east-2",
        )
    )
    client = FakeManagedHarnessClient()
    settings = Settings(
        internal_token="test-internal-token-value",
        agentcore_runtimes_json=json.dumps(
            {
                "primary": {
                    "provisioning": "per_agent",
                    "region": "us-east-2",
                    "execution_role_arn": (
                        "arn:aws:iam::111122223333:role/example-agentcore-role"
                    ),
                }
            }
        ),
    )
    adapter = AgentCoreAdapter(
        settings,
        clients={"us-east-2": client},
        resource_repository=repository,
    )

    events = [event async for event in adapter.stream(context())]

    assert [event.data.get("text") for event in events[:2]] == ["managed", " harness"]
    assert client.calls[0]["harnessArn"].endswith(
        ":harness/example-harness-AbCdEf1234"
    )
