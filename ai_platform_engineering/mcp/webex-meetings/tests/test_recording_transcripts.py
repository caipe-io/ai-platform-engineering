from typing import Callable

import httpx
import pytest
from mcp.shared.exceptions import McpError

from mcp_webex_meetings import mcp_server


class ToolRegistry:
    def __init__(self) -> None:
        self.tools: dict[str, Callable] = {}

    def tool(self, *, name: str) -> Callable:
        def register(function: Callable) -> Callable:
            self.tools[name] = function
            return function
        return register


def transcript_tool(monkeypatch: pytest.MonkeyPatch, handler: Callable) -> Callable:
    client_class = httpx.AsyncClient
    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(mcp_server, "_bearer_from_request", lambda: "Bearer example-user-token")
    registry = ToolRegistry()
    mcp_server.register_tools(registry)
    return registry.tools["webex_list_transcripts"]


@pytest.mark.asyncio
async def test_recovery_deduplicates_occurrences_and_transcripts_and_downloads(monkeypatch: pytest.MonkeyPatch) -> None:
    occurrences: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer example-user-token"
        if request.url.path == "/v1/recordings":
            assert dict(request.url.params) == {"from": "2026-01-01T00:00:00Z", "to": "2026-01-02T00:00:00Z", "max": "100"}
            return httpx.Response(200, json={"items": [
                {"meetingId": "occurrence-1", "meetingSeriesId": "series-1"},
                {"meetingId": "occurrence-1"}, {"meetingId": "occurrence-2"},
                {"meetingId": "series-1", "meetingSeriesId": "series-1"},
                {"meetingId": ""}, {"meetingId": None}, "invalid",
            ]})
        if request.url.path.endswith("/download"):
            return httpx.Response(200, text="Example transcript")
        assert request.url.path == "/v1/meetingTranscripts"
        occurrence = request.url.params.get("meetingId")
        if not occurrence:
            return httpx.Response(200, json={"items": []})
        occurrences.append(occurrence)
        return httpx.Response(200, json={"items": [{"id": "transcript-1"}]})

    tool = transcript_tool(monkeypatch, handler)
    result = await tool(mcp_server.ListTranscripts(from_iso="2026-01-01T00:00:00Z", to_iso="2026-01-02T00:00:00Z", download=True))
    assert occurrences == ["occurrence-1", "occurrence-2"]
    assert result["items"] == [{"id": "transcript-1", "body": "Example transcript", "bodyFormat": "vtt"}]
    assert result["source"] == "recording_occurrence_lookup"
    assert result["recordingOccurrenceLookup"] == {"recordingsChecked": 2, "limited": False, "timedOut": False}


@pytest.mark.parametrize("args,items", [
    (mcp_server.ListTranscripts(), []),
    (mcp_server.ListTranscripts(meeting_id="occurrence-1", userhub_fallback=False), []),
    (mcp_server.ListTranscripts(from_iso="2026-01-01T00:00:00Z"), [{"id": "existing"}]),
])
@pytest.mark.asyncio
async def test_recovery_does_not_change_existing_or_unbounded_lookups(monkeypatch: pytest.MonkeyPatch, args: mcp_server.ListTranscripts, items: list[dict]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/meetingTranscripts"
        return httpx.Response(200, json={"items": items})
    result = await transcript_tool(monkeypatch, handler)(args)
    assert result == {"items": items}


@pytest.mark.parametrize("failed_path", ["/v1/meetingTranscripts", "/v1/recordings"])
@pytest.mark.asyncio
async def test_authorization_errors_remain_errors(monkeypatch: pytest.MonkeyPatch, failed_path: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "Forbidden"}) if request.url.path == failed_path else httpx.Response(200, json={"items": []})
    with pytest.raises(McpError, match="HTTP 403"):
        await transcript_tool(monkeypatch, handler)(mcp_server.ListTranscripts(from_iso="2026-01-01T00:00:00Z"))


@pytest.mark.parametrize("max_results,expected_calls,expected_items", [(1, 1, 1), (100, 10, 10)])
@pytest.mark.asyncio
async def test_recovery_bounds_calls_and_total_results(monkeypatch: pytest.MonkeyPatch, max_results: int, expected_calls: int, expected_items: int) -> None:
    occurrences: list[str] = []
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/recordings":
            return httpx.Response(200, json={"items": [{"meetingId": f"occurrence-{i}"} for i in range(20)]})
        occurrence = request.url.params.get("meetingId")
        if occurrence:
            occurrences.append(occurrence)
        return httpx.Response(200, json={"items": [{"id": occurrence}] if occurrence else []})
    result = await transcript_tool(monkeypatch, handler)(mcp_server.ListTranscripts(from_iso="2026-01-01T00:00:00Z", max_results=max_results))
    assert len(occurrences) == expected_calls
    assert len(result["items"]) == expected_items
    assert result["recordingOccurrenceLookup"]["limited"] is True


@pytest.mark.asyncio
async def test_recovery_timeout_is_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/recordings":
            raise TimeoutError
        return httpx.Response(200, json={"items": []})
    result = await transcript_tool(monkeypatch, handler)(mcp_server.ListTranscripts(from_iso="2026-01-01T00:00:00Z"))
    assert result["items"] == []
    assert result["recordingOccurrenceLookup"] == {"recordingsChecked": 0, "limited": True, "timedOut": True}
