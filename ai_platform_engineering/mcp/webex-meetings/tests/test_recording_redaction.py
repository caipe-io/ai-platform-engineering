from typing import Any, Callable

import httpx
import pytest

from mcp_webex_meetings import mcp_server


class ToolRegistry:
    def __init__(self) -> None:
        self.tools: dict[str, Callable] = {}

    def tool(self, *, name: str) -> Callable:
        def register(function: Callable) -> Callable:
            self.tools[name] = function
            return function
        return register


@pytest.mark.asyncio
async def test_recordings_redact_nested_sensitive_fields_using_caller_token(monkeypatch: pytest.MonkeyPatch) -> None:
    payload: dict[str, Any] = {
        "items": [{
            "id": "recording-1",
            "topic": "Example meeting",
            "password": "example-password",
            "hostKey": "example-host-key",
            "details": {"PASSWORD": "example-nested-password", "durationSeconds": 60},
            "playbacks": [{"playbackPassword": "example-playback-password", "status": "available"}],
        }],
        "paging": {"total": 1},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer example-user-token"
        assert request.url.path == "/v1/recordings"
        assert dict(request.url.params) == {
            "max": "10", "meetingId": "meeting-1", "from": "2026-01-01T00:00:00Z", "to": "2026-01-02T00:00:00Z",
        }
        return httpx.Response(200, json=payload)

    client_class = httpx.AsyncClient
    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(mcp_server, "_bearer_from_request", lambda: "Bearer example-user-token")
    registry = ToolRegistry()
    mcp_server.register_tools(registry)
    result = await registry.tools["webex_list_recordings"](mcp_server.ListRecordings(
        meeting_id="meeting-1", from_iso="2026-01-01T00:00:00Z", to_iso="2026-01-02T00:00:00Z", max_results=10,
    ))
    assert result == {
        "items": [{
            "id": "recording-1", "topic": "Example meeting", "details": {"durationSeconds": 60},
            "playbacks": [{"status": "available"}],
        }],
        "paging": {"total": 1},
    }


def test_existing_redactor_does_not_mutate_response() -> None:
    payload = {"items": [{"id": "recording-1", "password": "example-password"}]}
    assert mcp_server._sanitize_sensitive(payload) == {"items": [{"id": "recording-1"}]}
    assert payload["items"][0]["password"] == "example-password"
