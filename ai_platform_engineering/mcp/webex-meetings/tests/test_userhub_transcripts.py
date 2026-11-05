from datetime import datetime, timedelta, timezone
from typing import Any

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


def test_recording_candidates_do_not_fall_back_to_old_or_undated_recordings() -> None:
    recordings = [
        {
            "recordUUID": "old-recording",
            "recordName": "Weekly Sync-20260904 1700-1",
            "gmtCreateTime": "2026-09-04 17:00:39",
        },
        {"recordUUID": "undated-recording", "recordName": "Weekly Sync"},
    ]
    assert _select_userhub_recording_candidates(
        recordings,
        meeting_title="Weekly Sync",
        meeting_start=datetime(2026, 11, 5, 13, 0, tzinfo=timezone.utc),
    ) == []


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
        if request.url.path == "/v1/meetings/meeting-instance-1":
            return httpx.Response(200, json={
                "id": "meeting-instance-1",
                "meetingType": "meeting",
                "start": "2026-08-26T15:00:30Z",
            })
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
            "occurrenceStart": "2026-08-26T15:00:30+00:00",
            "body": "WEBVTT\n\n00:00.000 --> 00:01.000\nHello",
            "bodyFormat": "txt",
        }
    ]


@pytest.mark.parametrize("actual_start,metadata_overrides", [
    ("2026-09-04T16:58:27Z", {}), ("2026-11-05T00:59:59Z", {}),
    ("2026-11-06T01:00:01Z", {}), (None, {}),
    ("2026-11-05T13:00:00Z", {"id": "different-instance"}),
    ("2026-11-05T13:00:00Z", {"meetingType": "scheduledMeeting"}),
])
@pytest.mark.asyncio
async def test_recording_time_cannot_override_different_or_unknown_actual_occurrence(
    actual_start: str | None,
    metadata_overrides: dict[str, Any],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/webappng/api/v1/recordings":
            return httpx.Response(200, json={"recordings": [{
                "recordUUID": "recording-1", "recordName": "Weekly Sync",
                "gmtCreateTime": "2026-11-05 13:02:00",
            }]})
        if request.url.path.endswith("/stream"):
            return httpx.Response(200, json={
                "meetingInstanceId": "instance-1",
                "downloadRecordingInfo": {"downloadInfo": {
                    "transcriptURL": "https://media.webex.com/transcript.txt",
                }},
            })
        assert request.url.path == "/v1/meetings/instance-1"
        return httpx.Response(200, json={
            "id": "instance-1", "meetingType": "meeting", "start": actual_start,
            **metadata_overrides,
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await _userhub_transcripts_for_meeting(
            client, bearer="Bearer example-user-token", site_url="https://primary.webex.com",
            meeting_id=None, meeting_title="Weekly Sync",
            meeting_start=datetime(2026, 11, 5, 13, 0, tzinfo=timezone.utc),
            max_results=1, download=True,
        ) == []


@pytest.mark.parametrize("public_available", [True, False])
@pytest.mark.parametrize("offset_seconds,expected_match", [
    (-12 * 3600 - 1, False), (-12 * 3600, True), (10 * 60, True),
    (12 * 3600, True), (12 * 3600 + 1, False), (-62 * 24 * 3600, False),
])
@pytest.mark.asyncio
async def test_occurrence_window_accepts_twelve_hours_inclusively(
    public_available: bool,
    offset_seconds: int,
    expected_match: bool,
) -> None:
    meeting_start = datetime(2026, 11, 5, 13, 0, tzinfo=timezone.utc)
    source_start = meeting_start + timedelta(seconds=offset_seconds)
    recording_start = meeting_start if public_available else source_start
    downloads: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/webappng/api/v1/recordings":
            return httpx.Response(200, json={"recordings": [{
                "recordUUID": "recording-1", "recordName": "Weekly Sync",
                "gmtCreateTime": recording_start.strftime("%Y-%m-%d %H:%M:%S"),
            }]})
        if request.url.path.endswith("/stream"):
            return httpx.Response(200, json={
                "meetingInstanceId": "instance-1",
                "downloadRecordingInfo": {"downloadInfo": {
                    "transcriptURL": "https://media.webex.com/transcript.txt",
                }},
            })
        if request.url.path == "/v1/meetings/instance-1":
            if not public_available:
                return httpx.Response(403, json={"message": "Forbidden"})
            return httpx.Response(200, json={
                "id": "instance-1", "meetingType": "meeting", "start": source_start.isoformat(),
            })
        assert request.url.path == "/transcript.txt"
        downloads.append(request.url.path)
        return httpx.Response(200, text="Example transcript")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await _userhub_transcripts_for_meeting(
            client, bearer="Bearer example-user-token", site_url="https://primary.webex.com",
            meeting_id=None, meeting_title="Weekly Sync", meeting_start=meeting_start,
            max_results=1, download=True,
        )
    assert bool(items) is expected_match
    assert len(downloads) == int(expected_match)
    if items:
        assert items[0]["body"] == "Example transcript"
        if public_available:
            assert items[0]["occurrenceStart"] == source_start.isoformat()
        else:
            assert "occurrenceStart" not in items[0]


@pytest.mark.parametrize("public_available", [True, False])
@pytest.mark.asyncio
async def test_same_instance_keeps_late_segments_and_shared_attendee_access(
    public_available: bool,
) -> None:
    meeting_calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/webappng/api/v1/recordings":
            return httpx.Response(200, json={"recordings": [
                {"recordUUID": "early", "recordName": "Weekly Sync", "gmtCreateTime": "2026-11-05 13:02:00"},
                {"recordUUID": "late", "recordName": "Weekly Sync", "gmtCreateTime": "2026-11-05 14:15:00"},
            ]})
        if request.url.path.endswith("/stream"):
            return httpx.Response(200, json={
                "meetingInstanceId": "instance-1", "coHost": False, "shareToMe": True,
                "downloadRecordingInfo": {"downloadInfo": {
                    "transcriptURL": "https://media.webex.com/transcript.txt",
                }},
            })
        assert request.url.path == "/v1/meetings/instance-1"
        meeting_calls.append(request.url.path)
        if not public_available:
            return httpx.Response(403, json={"message": "Forbidden"})
        return httpx.Response(200, json={
            "id": "instance-1", "meetingType": "meeting", "start": "2026-11-05T13:01:00Z",
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await _userhub_transcripts_for_meeting(
            client, bearer="Bearer example-user-token", site_url="https://primary.webex.com",
            meeting_id=None, meeting_title="Weekly Sync",
            meeting_start=datetime(2026, 11, 5, 13, 0, tzinfo=timezone.utc),
            max_results=10, download=False,
        )
    assert [item["id"] for item in items] == ["early", "late"]
    assert len(meeting_calls) == 1
    assert all(item["shareToMe"] is True and item["coHost"] is False for item in items)
    if public_available:
        assert all(item["occurrenceStart"] == "2026-11-05T13:01:00+00:00" for item in items)
    else:
        assert all("occurrenceStart" not in item for item in items)


@pytest.mark.parametrize("recording_times", [
    ["2026-11-05 00:59:59"],
    ["2026-11-05 13:01:00", "2026-11-05 13:02:00"],
])
@pytest.mark.parametrize("public_available", [True, False])
@pytest.mark.asyncio
async def test_shared_access_rejects_old_or_ambiguous_instance_anchors(
    recording_times: list[str],
    public_available: bool,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/webappng/api/v1/recordings":
            return httpx.Response(200, json={"recordings": [
                {"recordUUID": f"recording-{index}", "recordName": "Weekly Sync", "gmtCreateTime": start}
                for index, start in enumerate(recording_times)
            ]})
        if request.url.path.endswith("/stream"):
            instance_id = request.url.path.split("/")[-2]
            return httpx.Response(200, json={
                "meetingInstanceId": instance_id,
                "downloadRecordingInfo": {"downloadInfo": {
                    "transcriptURL": "https://media.webex.com/transcript.txt",
                }},
            })
        assert request.url.path.startswith("/v1/meetings/")
        if public_available:
            instance_id = request.url.path.split("/")[-1]
            index = int(instance_id.rsplit("-", 1)[-1])
            return httpx.Response(200, json={
                "id": instance_id, "meetingType": "meeting",
                "start": recording_times[index].replace(" ", "T") + "Z",
            })
        return httpx.Response(403, json={"message": "Forbidden"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await _userhub_transcripts_for_meeting(
            client, bearer="Bearer example-user-token", site_url="https://primary.webex.com",
            meeting_id=None, meeting_title="Weekly Sync",
            meeting_start=datetime(2026, 11, 5, 13, 0, tzinfo=timezone.utc),
            max_results=1, download=True,
        ) == []


@pytest.mark.parametrize("metadata_failure", ["network", "server"])
@pytest.mark.asyncio
async def test_unverified_instance_does_not_abort_other_candidates_or_use_recording_anchor(
    metadata_failure: str,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/webappng/api/v1/recordings":
            return httpx.Response(200, json={"recordings": [
                {"recordUUID": "unverified", "recordName": "Weekly Sync", "gmtCreateTime": "2026-11-05 13:01:00"},
                {"recordUUID": "verified", "recordName": "Weekly Sync", "gmtCreateTime": "2026-11-05 13:02:00"},
            ]})
        if request.url.path.endswith("/stream"):
            return httpx.Response(200, json={
                "meetingInstanceId": request.url.path.split("/")[-2],
                "downloadRecordingInfo": {"downloadInfo": {
                    "transcriptURL": "https://media.webex.com/transcript.txt",
                }},
            })
        if request.url.path.endswith("/unverified"):
            if metadata_failure == "network":
                raise httpx.ConnectError("Metadata unavailable", request=request)
            return httpx.Response(500, json={"message": "Unavailable"})
        assert request.url.path == "/v1/meetings/verified"
        return httpx.Response(200, json={
            "id": "verified", "meetingType": "meeting", "start": "2026-11-05T13:00:00Z",
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await _userhub_transcripts_for_meeting(
            client, bearer="Bearer example-user-token", site_url="https://primary.webex.com",
            meeting_id=None, meeting_title="Weekly Sync",
            meeting_start=datetime(2026, 11, 5, 13, 0, tzinfo=timezone.utc),
            max_results=10, download=False,
        )
    assert [item["id"] for item in items] == ["verified"]


@pytest.mark.asyncio
async def test_exact_instance_id_preserves_late_and_undated_segments() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/webappng/api/v1/recordings":
            assert request.url.params["keyword"] in {"Changed Title", ""}
            return httpx.Response(200, json={"recordings": [
                {"recordUUID": "late", "recordName": "Original Title", "gmtCreateTime": "2026-09-04 17:00:39"},
                {"recordUUID": "undated", "recordName": "Original Title"},
                {"recordUUID": "other", "recordName": "Original Title"},
            ]})
        assert request.url.path.endswith("/stream")
        recording_id = request.url.path.split("/")[-2]
        detail: dict[str, Any] = {
            "meetingInstanceId": "other-instance" if recording_id == "other" else "exact-instance",
            "downloadRecordingInfo": {"downloadInfo": {
                "transcriptURL": "https://media.webex.com/transcript.txt",
            }},
        }
        return httpx.Response(200, json=detail)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await _userhub_transcripts_for_meeting(
            client, bearer="Bearer example-user-token", site_url="https://primary.webex.com",
            meeting_id="exact-instance", meeting_title="Changed Title",
            meeting_start=datetime(2026, 11, 5, 13, 0, tzinfo=timezone.utc),
            max_results=10, download=False,
        )
    assert [item["id"] for item in items] == ["late", "undated"]
    assert items[1]["startTime"] is None
    assert all(item["meetingId"] == "exact-instance" for item in items)


@pytest.mark.asyncio
async def test_title_time_lookup_bounds_detail_calls_and_reuses_instance_metadata() -> None:
    detail_calls: list[str] = []
    metadata_calls: list[str] = []
    recordings = [
        {"recordUUID": f"segment-{index}", "recordName": "Weekly Sync", "gmtCreateTime": "2026-11-05 13:02:00"}
        for index in range(105)
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/webappng/api/v1/recordings":
            offset = int(request.url.params["offset"])
            return httpx.Response(200, json={"recordings": recordings[offset:offset + 100], "totalCount": 105})
        if request.url.path.endswith("/stream"):
            detail_calls.append(request.url.path)
            return httpx.Response(200, json={
                "meetingInstanceId": "instance-1",
                "downloadRecordingInfo": {"downloadInfo": {
                    "transcriptURL": "https://media.webex.com/transcript.txt",
                }},
            })
        assert request.url.path == "/v1/meetings/instance-1"
        metadata_calls.append(request.url.path)
        return httpx.Response(200, json={
            "id": "instance-1", "meetingType": "meeting", "start": "2026-11-05T13:00:00Z",
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await _userhub_transcripts_for_meeting(
            client, bearer="Bearer example-user-token", site_url="https://primary.webex.com",
            meeting_id=None, meeting_title="Weekly Sync",
            meeting_start=datetime(2026, 11, 5, 13, 0, tzinfo=timezone.utc),
            max_results=1, download=False,
        )
    assert len(items) == 1
    assert len(detail_calls) == 100
    assert len(metadata_calls) == 1
