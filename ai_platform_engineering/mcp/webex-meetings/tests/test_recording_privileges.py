from typing import Any, Callable

import httpx
import pytest

from mcp_webex_meetings import mcp_server
from test_recording_transcripts import transcript_tool

ACTUAL = "a" * 32 + "_I_123456789"
OTHER = "a" * 32 + "_I_987654321"
SIGNED_URL = "https://media.webex.com/transcript.vtt?token=example-secret"
VTT = "WEBVTT\n\n00:00.000 --> 00:02.000\nExample discussion"


def recording(**overrides: Any) -> dict[str, Any]:
    return {
        "meetingInstanceId": ACTUAL, "recordUUID": "recording-1",
        "recordName": "Weekly Review", "recordingStartTime": "2026-01-05T17:01:00Z",
        "transcriptURL": SIGNED_URL, "accessPwd": "example-password",
        "preventDownload": False, **overrides,
    }


async def lookup(handler: Callable, **kwargs: Any) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        return await mcp_server._recording_privilege_transcripts(
            client, bearer="Bearer example-user-token", site_url="https://primary.webex.com",
            meeting_id=kwargs.pop("meeting_id", ACTUAL), max_results=10, **kwargs,
        )


@pytest.mark.asyncio
async def test_existing_credential_reads_recap_without_library_membership() -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert request.headers["authorization"] == "Bearer example-user-token"
        if request.url.path == mcp_server.RECORDING_PRIVILEGE_PATH:
            assert dict(request.url.params) == {"meetingInstanceId": ACTUAL, "siteurl": "primary"}
            return httpx.Response(200, json={"privileges": [recording()]})
        assert request.url.host == "media.webex.com"
        return httpx.Response(200, text=VTT)

    items = await lookup(handler, download=True)
    assert paths == [mcp_server.RECORDING_PRIVILEGE_PATH, "/transcript.vtt"]
    assert items[0]["meetingId"] == ACTUAL
    assert items[0]["body"] == VTT
    assert items[0]["bodyFormat"] == "vtt"
    assert "example-secret" not in str(items)
    assert "example-password" not in str(items)


@pytest.mark.asyncio
async def test_metadata_only_never_downloads_and_filters_other_instances() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == mcp_server.RECORDING_PRIVILEGE_PATH
        return httpx.Response(200, json={"privileges": [
            recording(meetingInstanceId=OTHER), recording(), recording(),
        ]})

    items = await lookup(handler, download=False)
    assert len(items) == 1
    assert "body" not in items[0]
    assert "token=" not in str(items)
    assert "accessPwd" not in str(items)


@pytest.mark.parametrize("meeting_id", ["a" * 32, "a" * 32 + "_20260105T170000Z", "unknown"])
@pytest.mark.asyncio
async def test_never_resolves_scheduled_or_series_id_to_a_different_occurrence(meeting_id: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        pytest.fail("Non-actual identifiers must not reach privilege lookup")

    assert await lookup(handler, download=True, meeting_id=meeting_id) == []


@pytest.mark.parametrize("url", ["https://example.org/leak", "http://media.webex.com/file", "https://webex.com.example.org/file"])
@pytest.mark.asyncio
async def test_rejects_untrusted_download_host_without_forwarding_bearer(url: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == mcp_server.RECORDING_PRIVILEGE_PATH
        return httpx.Response(200, json={"privileges": [recording(transcriptURL=url)]})

    assert await lookup(handler, download=True) == []


@pytest.mark.parametrize("failure", ["redirect", "html", "http", "timeout", "disabled"])
@pytest.mark.asyncio
async def test_download_failures_are_explicit_without_leaking_signed_url(failure: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == mcp_server.RECORDING_PRIVILEGE_PATH:
            return httpx.Response(200, json={"privileges": [recording(preventDownload=failure == "disabled")]})
        if failure == "disabled":
            pytest.fail("Downloads disabled by Webex must not be fetched")
        if failure == "redirect":
            return httpx.Response(302, headers={"location": "https://example.org/leak"})
        if failure == "html":
            return httpx.Response(200, text="<html>Sign in</html>")
        if failure == "http":
            return httpx.Response(403, text="secret diagnostic")
        raise httpx.ReadTimeout(str(request.url), request=request)

    items = await lookup(handler, download=True)
    assert items[0]["body"] is None
    assert items[0]["bodyError"]
    assert "example-secret" not in str(items)
    assert "secret diagnostic" not in str(items)


@pytest.mark.asyncio
async def test_tool_uses_privilege_path_when_public_transcript_and_meeting_are_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    # Exercise the real tool flow, not a mocked successful reader.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v1/"):
            return httpx.Response(403, json={"message": "Forbidden"})
        if request.url.path == mcp_server.RECORDING_PRIVILEGE_PATH:
            return httpx.Response(200, json={"privileges": [recording()]})
        assert request.url.path == "/transcript.vtt"
        return httpx.Response(200, text=VTT)

    result = await transcript_tool(monkeypatch, handler)(mcp_server.ListTranscripts(
        meeting_id=ACTUAL, site_url="primary.webex.com", download=True,
    ))
    assert result["source"] == "recording_privilege"
    assert result["items"][0]["body"] == VTT


@pytest.mark.asyncio
async def test_privilege_denial_preserves_independent_userhub_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/meetingTranscripts":
            return httpx.Response(200, json={"items": []})
        if request.url.path.startswith("/v1/meetings/") or request.url.path == mcp_server.RECORDING_PRIVILEGE_PATH:
            return httpx.Response(403)
        if request.url.path == "/webappng/api/v1/recordings":
            return httpx.Response(200, json={"recordings": [{"recordUUID": "recording-1", "recordName": "Weekly Review"}]})
        if request.url.path.endswith("/stream"):
            return httpx.Response(200, json={"meetingInstanceId": ACTUAL, "downloadRecordingInfo": {"downloadInfo": {"transcriptURL": SIGNED_URL}}})
        assert request.url.path == "/transcript.vtt"
        return httpx.Response(200, text=VTT)

    result = await transcript_tool(monkeypatch, handler)(mcp_server.ListTranscripts(
        meeting_id=ACTUAL, site_url="primary.webex.com", download=True,
    ))
    assert result["source"] == "userhub"
    assert result["items"][0]["body"] == VTT
