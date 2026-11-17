"""Provider-request regression coverage for deployment and agent streaming choices."""

import json
from typing import Any

import httpx
import pytest
from langchain_core.messages import HumanMessage

from dynamic_agents.services import llm


@pytest.mark.parametrize(
    ("deployment", "agent", "expected"),
    [(None, None, True), ("true", None, True), ("false", None, False),
     ("false", True, True), ("true", False, False), (None, False, False)],
)
async def test_streaming_choice_controls_provider_request(
    monkeypatch: pytest.MonkeyPatch,
    deployment: str | None,
    agent: bool | None,
    expected: bool,
) -> None:
    if deployment is None:
        monkeypatch.delenv("LLM_STREAMING", raising=False)
    else:
        monkeypatch.setenv("LLM_STREAMING", deployment)
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    requests: list[bool] = []

    def respond(request: httpx.Request) -> httpx.Response:
        streaming = json.loads(request.content)["stream"]
        requests.append(streaming)
        common = {"id": "example", "created": 0, "model": "example-model"}
        if streaming:
            chunk = {
                **common, "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"content": "verified"}, "finish_reason": None}],
            }
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"},
                content="data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n",
            )
        return httpx.Response(200, json={
            **common, "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "verified"}, "finish_reason": "stop"}],
        })

    transport = httpx.MockTransport(respond)
    build = llm.build_chat_model
    with httpx.Client(transport=transport) as sync_client:
        async with httpx.AsyncClient(transport=transport) as async_client:
            def build_with_transport(*args: Any, **kwargs: Any) -> Any:
                return build(
                    *args, **kwargs, http_client=sync_client, http_async_client=async_client,
                    base_url="https://provider.example.test/v1", api_key="example-key", max_retries=0,
                )

            monkeypatch.setattr(llm, "build_chat_model", build_with_transport)
            model = llm.get_configured_llm("example-model", "openai", streaming=agent)
            content = "".join([
                chunk.content async for chunk in model.astream([HumanMessage(content="Verify streaming")])
            ])

    assert content == "verified"
    assert requests == [expected]
