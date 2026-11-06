"""Exercise both bot transports against the public Gateway HTTP/SSE contract."""

from __future__ import annotations

import json
from collections.abc import Iterator

import httpx
import pytest

from ai_platform_engineering.integrations.slack_bot import sse_client as slack
from ai_platform_engineering.integrations.slack_bot.utils.harness_gateway import NativeConversation, stream_gateway
from ai_platform_engineering.integrations.webex_bot.a2a_client import WebexSSEClient


PAYLOAD = {"agent_id": "example-agent", "conversation_id": "example-chat", "message": "Hello",
           "client_context": {"delivery_id": "example-delivery"}}


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ai_platform_engineering.integrations.slack_bot.utils.harness_gateway.time.sleep", lambda _: None)


def headers() -> dict[str, str]:
    return {"Authorization": "Bearer example-token", "X-Client-Source": "example-bot"}


def frame(cursor: str, kind: str = "TEXT_MESSAGE_CONTENT", **fields: object) -> bytes:
    return f"id: {cursor}\ndata: {json.dumps({'type': kind, **fields})}\n\n".encode()


class InterruptedBody(httpx.SyncByteStream):
    def __iter__(self) -> Iterator[bytes]:
        yield frame("1.0", delta="hello")
        raise httpx.ReadError("Disconnected")


def test_admission_retry_and_subscription_reconnect_do_not_restart_execution() -> None:
    posts, gets = [], []

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer example-token"
        if request.method == "POST":
            posts.append(json.loads(request.content))
            if len(posts) == 1:
                raise httpx.ReadTimeout("Admission response lost", request=request)
            return httpx.Response(202, json={"success": True, "data": {"run_id": "example-run"}})
        gets.append(request)
        if len(gets) == 1:
            return httpx.Response(200, stream=InterruptedBody())
        return httpx.Response(200, content=frame("1.0", delta="hello") +
                              frame("1.1", delta=" world") + frame("2.0", "RUN_FINISHED"))

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        events = [json.loads(v) for v in stream_gateway(client, "https://example.test", PAYLOAD, headers)]
    assert posts[0] == posts[1]
    assert [r.url.params["after"] for r in gets] == ["0", "1.0"]
    assert [e.get("delta") for e in events if e["type"] == "TEXT_MESSAGE_CONTENT"] == ["hello", " world"]
    assert events[-1]["type"] == "RUN_FINISHED"
    assert all(r.method == "GET" for r in gets)


@pytest.mark.parametrize("status,code,error", [
    (401, "unauthorized", RuntimeError), (403, "agent#use", RuntimeError),
    (409, "HARNESS_RUNTIME_MISMATCH", NativeConversation),
    (501, "APP_STREAM_REQUIRED", NativeConversation), (409, "active_run", RuntimeError),
])
def test_only_explicit_native_bindings_can_fall_back(status: int, code: str, error: type[Exception]) -> None:
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json={"code": code, "error": "access_token=private-value"})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client, pytest.raises(error) as caught:
        list(stream_gateway(client, "https://example.test", PAYLOAD, headers))
    assert len(requests) == 1
    assert "private-value" not in str(caught.value)


def test_reauthorization_failure_never_starts_a_second_run() -> None:
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(202, json={"success": True, "data": {"run_id": "example-run"}})
        return httpx.Response(403)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client, pytest.raises(RuntimeError, match="HTTP 403"):
        list(stream_gateway(client, "https://example.test", PAYLOAD, headers))
    assert [r.method for r in requests] == ["POST", "GET"]


@pytest.mark.parametrize("delivery_field", ["delivery_id", "webex_message_id"])
def test_redelivered_platform_message_keeps_its_admission_key(delivery_field: str) -> None:
    keys = []

    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            keys.append(json.loads(request.content)["client_request_id"])
            return httpx.Response(202, json={"success": True, "data": {"run_id": "example-run"}})
        return httpx.Response(200, content=frame("1.10", "RUN_FINISHED"))

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        for _ in range(2):
            list(stream_gateway(client, "https://example.test", {**PAYLOAD, "client_context": {delivery_field: "example-delivery"}}, headers))
    assert len(keys) == 2 and keys[0] == keys[1]


@pytest.mark.parametrize("envelope", [{"success": True, "data": None}, {"success": True, "data": {}}, []])
def test_unconfirmed_admission_does_not_attach_or_fall_back(envelope: object) -> None:
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(202, json=envelope)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client, pytest.raises(RuntimeError, match="did not confirm"):
        list(stream_gateway(client, "https://example.test", PAYLOAD, headers))
    assert [r.method for r in requests] == ["POST"]


@pytest.mark.parametrize("bot", ["slack", "webex"])
@pytest.mark.parametrize("enabled,native", [(False, False), (True, False), (True, True)])
def test_bot_toggle_preserves_legacy_and_app_dispatch(
    monkeypatch: pytest.MonkeyPatch, bot: str, enabled: bool, native: bool,
) -> None:
    paths = []

    def handle(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert request.headers["Authorization"] == "Bearer example-user-token"
        assert request.headers["X-Client-Source"] == f"{bot}-bot"
        if request.url.path == "/api/harness-engine/runs":
            if native:
                return httpx.Response(501, json={"code": "APP_STREAM_REQUIRED"})
            return httpx.Response(202, json={"success": True, "data": {"run_id": "example-run"}})
        content = frame("1.0", delta="hello") + frame("2.0", "RUN_FINISHED")
        return httpx.Response(200, content=content)

    client_class = httpx.Client
    if bot == "slack":
        monkeypatch.setattr(slack.httpx, "Client", lambda **_: client_class(transport=httpx.MockTransport(handle)))
        client = slack.SSEClient("https://example.test", harness_gateway_enabled=enabled)
        events = list(client.stream_chat(**PAYLOAD, bearer_token="example-user-token"))
    else:
        with client_class(transport=httpx.MockTransport(handle)) as http:
            client = WebexSSEClient("https://example.test", http_client=http, harness_gateway_enabled=enabled)
            events = list(client.stream_chat(**PAYLOAD, bearer_token="example-user-token"))
    assert events[0].delta == "hello"
    assert paths == (["/api/v1/chat/stream/start"] if not enabled else
                     ["/api/harness-engine/runs", "/api/v1/chat/stream/start"] if native else
                     ["/api/harness-engine/runs", "/api/harness-engine/runs/example-run/events/stream"])


def test_partial_frame_replays_without_skipping_numeric_subframes() -> None:
    cursors = []

    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"success": True, "data": {"run_id": "example-run"}})
        cursors.append(request.url.params["after"])
        if len(cursors) == 1:
            return httpx.Response(200, content=frame("1.9", delta="first") + b'id: 1.10\ndata: {"type":')
        return httpx.Response(200, content=frame("1.9", delta="first") + frame("1.10", delta="second") + frame("2.0", "RUN_FINISHED"))

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        events = [json.loads(v) for v in stream_gateway(client, "https://example.test", PAYLOAD, headers)]
    assert cursors == ["0", "1.9"]
    assert [e["delta"] for e in events if "delta" in e] == ["first", "second"]


def test_repeated_stream_disconnects_are_bounded_without_cancelling_or_resubmitting() -> None:
    methods = []

    def handle(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.method == "POST":
            return httpx.Response(202, json={"success": True, "data": {"run_id": "example-run"}})
        return httpx.Response(200, content=b": keepalive\n\n")

    with httpx.Client(transport=httpx.MockTransport(handle)) as client, pytest.raises(RuntimeError, match="may still be active"):
        list(stream_gateway(client, "https://example.test", PAYLOAD, headers))
    assert methods == ["POST", *["GET"] * 6]


def test_closing_subscriber_does_not_cancel_provider() -> None:
    methods = []

    def handle(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.method == "POST":
            return httpx.Response(202, json={"success": True, "data": {"run_id": "example-run"}})
        return httpx.Response(200, content=frame("1.0", delta="hello"))

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        subscription = stream_gateway(client, "https://example.test", PAYLOAD, headers)
        assert json.loads(next(subscription))["delta"] == "hello"
        subscription.close()
    assert methods == ["POST", "GET"]


@pytest.mark.parametrize("terminal", ["RUN_FINISHED", "RUN_ERROR"])
def test_slack_nonstreaming_invocation_uses_gateway(monkeypatch: pytest.MonkeyPatch, terminal: str) -> None:
    paths = []

    def handle(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.method == "POST":
            return httpx.Response(202, json={"success": True, "data": {"run_id": "example-run"}})
        return httpx.Response(200, content=frame("1.0", delta="hello") + frame("2.0", terminal, message="example error"))

    client_class = httpx.Client
    monkeypatch.setattr(slack.httpx, "Client", lambda **_: client_class(transport=httpx.MockTransport(handle)))
    result = slack.SSEClient("https://example.test", harness_gateway_enabled=True).invoke(**PAYLOAD)
    assert result == ({"success": True, "content": "hello"} if terminal == "RUN_FINISHED" else {"success": False, "error": "example error"})
    assert paths == ["/api/harness-engine/runs", "/api/harness-engine/runs/example-run/events/stream"]
