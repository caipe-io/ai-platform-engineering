from datetime import datetime, timezone

import httpx
import pytest

from mcp_webex_meetings.mcp_server import (
    _derive_userhub_site_url,
    _select_userhub_recording_candidates,
    _userhub_transcripts_for_meeting,
)


def test_derive_userhub_site_from_meeting_link() -> None:
    assert (
        _derive_userhub_site_url(
            {"webLink": "https://primary.webex.com/primary/j.php?MTID=example"},
            None,
        )
        == "https://primary.webex.com"
    )


def test_explicit_userhub_site_overrides_meeting_link() -> None:
    assert (
        _derive_userhub_site_url(
            {"webLink": "https://primary.webex.com/meet/example"},
            "secondary.webex.com",
        )
        == "https://secondary.webex.com"
    )


def test_recording_candidates_match_title_suffix_and_nearby_time() -> None:
    meeting_start = datetime(2026, 8, 26, 15, 0, tzinfo=timezone.utc)
    recordings = [
        {
            "recordUUID": "nearby",
            "recordName": "Weekly Sync-20260826 1505-1",
            "gmtCreateTime": "2026-08-26 15:05:00",
        },
        {
            "recordUUID": "older",
            "recordName": "Weekly Sync-20260819 1505-1",
            "gmtCreateTime": "2026-08-19 15:05:00",
        },
        {
            "recordUUID": "different",
            "recordName": "Different Sync-20260826 1505-1",
            "gmtCreateTime": "2026-08-26 15:05:00",
        },
    ]

    assert _select_userhub_recording_candidates(
        recordings,
        meeting_title="Weekly Sync",
        meeting_start=meeting_start,
    ) == [recordings[0]]


@pytest.mark.asyncio
async def test_userhub_fallback_resolves_instance_and_downloads_transcript() -> None:
    offsets: list[int] = []
    transcript_url = "https://media.webex.com/nbr/transcript.txt?token=secret"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/webappng/api/v1/recordings":
            offset = int(request.url.params["offset"])
            offsets.append(offset)
            if offset == 0:
                rows = [
                    {
                        "recordUUID": f"other-{index}",
                        "recordName": "Different Meeting-20260826 1505-1",
                        "gmtCreateTime": "2026-08-26 15:05:00",
                    }
                    for index in range(100)
                ]
            else:
                rows = [
                    {
                        "recordUUID": "recording-1",
                        "recordName": "Weekly Sync-20260826 1505-1",
                        "gmtCreateTime": "2026-08-26 15:05:00",
                    }
                ]
            return httpx.Response(
                200,
                json={"recordings": rows, "totalCount": 101},
            )
        if request.url.path.endswith("/recordings/recording-1/stream"):
            assert request.headers["clienttype"] == "web"
            return httpx.Response(
                200,
                json={
                    "meetingInstanceId": "meeting-instance-1",
                    "recordName": "Weekly Sync-20260826 1505-1",
                    "recordingToken": "recording-token",
                    "coHost": True,
                    "shareToMe": True,
                    "downloadRecordingInfo": {
                        "downloadInfo": {"transcriptURL": transcript_url}
                    },
                },
            )
        if request.url.path == "/nbr/transcript.txt":
            assert request.headers["recordingtoken"] == "recording-token"
            return httpx.Response(200, text="WEBVTT\n\n00:00.000 --> 00:01.000\nHello")
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await _userhub_transcripts_for_meeting(
            client,
            bearer="Bearer user-token",
            site_url="https://primary.webex.com",
            meeting_id=None,
            meeting_title="Weekly Sync",
            meeting_start=datetime(2026, 8, 26, 15, 0, tzinfo=timezone.utc),
            max_results=10,
            download=True,
        )

    assert offsets == [0, 100]
    assert items == [
        {
            "id": "recording-1",
            "meetingId": "meeting-instance-1",
            "meetingTopic": "Weekly Sync",
            "startTime": "2026-08-26T15:05:00+00:00",
            "status": "available",
            "recordingId": "recording-1",
            "source": "userhub",
            "coHost": True,
            "shareToMe": True,
            "body": "WEBVTT\n\n00:00.000 --> 00:01.000\nHello",
            "bodyFormat": "txt",
        }
    ]
