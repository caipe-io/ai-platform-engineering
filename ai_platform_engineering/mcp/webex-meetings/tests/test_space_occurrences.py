# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable

import httpx
import pytest

from mcp_webex_meetings import space_occurrences as spaces

SERIES = "a" * 32
OTHER_SERIES = "b" * 32
ACTUAL = f"{SERIES}_I_123456789"
CONVERSATION = "https://conv-primary.wbx2.com/conversation/api/v1/conversations/11111111-1111-4111-8111-111111111111"
SECONDARY = "https://conv-secondary.wbx2.com/conversation/api/v1/conversations/22222222-2222-4222-8222-222222222222"
LOWER = datetime(2026, 1, 5, tzinfo=timezone.utc)
UPPER = datetime(2026, 1, 6, tzinfo=timezone.utc)


def activity(
    *, actual: str = ACTUAL, summary: bool = True, activity_id: str = "event-1",
    start: str = "2026-01-05T17:00:00Z", published: str = "2026-01-05T18:00:00Z",
) -> dict[str, Any]:
    return {
        "id": activity_id, "verb": "update" if summary else "share", "published": published,
        "object": {
            "objectType": "locusSessionSummary" if summary else "meetingContainer",
            "meetingInstanceId": actual, "startTime": start, "published": start,
            "displayName": "eyJexample-encrypted-topic", "participants": [{"email": "private@example.com"}],
        },
    }


async def discover(handler: Callable, **kwargs: Any) -> dict[str, Any]:
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        return await spaces.list_space_meeting_occurrences(
            client, "Bearer example-user-token", LOWER, UPPER, "primary.webex.com", **kwargs,
        )


@pytest.mark.asyncio
async def test_series_discovers_missed_actual_id_without_a_device_or_chat_decryption() -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert request.headers["authorization"] == "Bearer example-user-token"
        if request.method == "POST":
            assert str(request.url) == "https://primary.webex.com/wbxappapi/v1/meetingInfo"
            assert SERIES.encode() in request.content
            return httpx.Response(200, json={"conversationUrl": CONVERSATION, "hostKey": "private-key"})
        assert request.url.path.endswith("/activities")
        rows = [] if paths.count(request.url.path) > 1 else [
            activity(summary=False, activity_id="share"),
            activity(actual=f"{OTHER_SERIES}_I_42", activity_id="other"),
            activity(),
            {"id": "comment", "verb": "post", "published": "2026-01-05T19:00:00Z", "object": {"content": "private message"}},
        ]
        return httpx.Response(200, json={"items": rows})

    result = await discover(handler, meeting_series_id=SERIES)
    assert result["complete"] is True
    assert result["items"] == [{
        "id": ACTUAL, "meetingSeriesId": SERIES, "meetingType": "meeting",
        "start": "2026-01-05T17:00:00+00:00", "end": "2026-01-05T18:00:00+00:00",
        "state": "ended", "source": "space_activity", "siteUrl": "https://primary.webex.com",
    }]
    assert "private" not in str(result)
    assert "encrypted" not in str(result)
    assert paths[0] == "/wbxappapi/v1/meetingInfo"


@pytest.mark.asyncio
async def test_share_does_not_invent_an_end_time_or_recording_availability() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"items": [activity(summary=False)] if calls == 1 else []})

    result = await discover(handler, conversation_urls=[CONVERSATION])
    assert len(result["items"]) == 1
    assert "end" not in result["items"][0]
    assert "state" not in result["items"][0]
    assert "hasRecording" not in result["items"][0]


@pytest.mark.asyncio
async def test_manual_catalog_follows_next_page_and_federation_then_reads_actual_occurrences() -> None:
    visited: list[str] = []
    activity_calls: set[str] = set()

    def handler(request: httpx.Request) -> httpx.Response:
        visited.append(str(request.url))
        assert request.headers["authorization"] == "Bearer example-user-token"
        if request.url.path == "/u2c/api/v1/catalog":
            assert dict(request.url.params) == {"format": "hostmap"}
            return httpx.Response(200, json={"serviceLinks": {"conversation": "https://conv-primary.wbx2.com/conversation/api/v1"}})
        if request.url.path.endswith("/conversations"):
            if request.url.params.get("cursor"):
                return httpx.Response(200, json={"items": [{"url": CONVERSATION}]})
            assert request.url.params["membershipsType"] == "memberships"
            assert request.url.params["paginate"] == "true"
            if request.url.host == "conv-secondary.wbx2.com":
                return httpx.Response(200, json={"items": [{"url": SECONDARY}]})
            return httpx.Response(200, json={
                "items": [], "additionalUrls": ["https://conv-secondary.wbx2.com/conversation/api/v1"],
            }, headers={"Link": '<https://conv-primary.wbx2.com/conversation/api/v1/conversations?cursor=next>; rel="next"'})
        assert request.url.path.endswith("/activities")
        first = request.url.host not in activity_calls
        activity_calls.add(request.url.host)
        return httpx.Response(200, json={"items": [activity(activity_id=str(request.url.host))] if first else []})

    result = await discover(handler)
    assert result["complete"] is True
    assert len(result["items"]) == 1
    assert len(activity_calls) == 2
    assert any("cursor=next" in url for url in visited)


@pytest.mark.asyncio
async def test_manual_catalog_skips_proven_old_spaces_and_prioritizes_recent_activity() -> None:
    calls: list[str] = []
    unknown = CONVERSATION.replace("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333")
    old = CONVERSATION.replace("11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/u2c/api/v1/catalog":
            return httpx.Response(200, json={"serviceLinks": {"conversation": "https://conv-primary.wbx2.com/conversation/api/v1"}})
        if request.url.path.endswith("/conversations"):
            return httpx.Response(200, json={"items": [
                {"url": unknown, "lastReadableActivityDate": "invalid"},
                {"url": old, "lastReadableActivityDate": "2025-12-01T00:00:00Z"},
                {"url": CONVERSATION, "lastReadableActivityDate": "2026-01-05T12:00:00Z"},
                {"url": SECONDARY, "lastReadableActivityDate": int(UPPER.timestamp() * 1000)},
            ]})
        calls.append(str(request.url).split("?")[0].removesuffix("/activities"))
        return httpx.Response(200, json={"items": []})

    result = await discover(handler)
    assert result["complete"] is True
    assert calls == [SECONDARY, CONVERSATION, unknown]
    assert old not in calls


@pytest.mark.asyncio
async def test_one_inaccessible_space_retains_discovery_from_other_spaces() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        if request.url.host == "conv-secondary.wbx2.com":
            return httpx.Response(403, text="private server message")
        calls += 1
        return httpx.Response(200, json={"items": [activity()] if calls == 1 else []})

    result = await discover(handler, conversation_urls=[CONVERSATION, SECONDARY])
    assert result["complete"] is False
    assert result["items"][0]["id"] == ACTUAL
    assert "private" not in str(result)


@pytest.mark.asyncio
async def test_catalog_rejects_untrusted_next_page_without_forwarding_bearer() -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert request.url.host.endswith(".wbx2.com")
        if request.url.path == "/u2c/api/v1/catalog":
            return httpx.Response(200, json={"serviceLinks": {"conversation": "https://conv-primary.wbx2.com/conversation/api/v1"}})
        return httpx.Response(200, json={"items": []}, headers={
            "Link": '<https://example.org/conversation/api/v1/conversations>; rel="next"',
        })

    result = await discover(handler)
    assert len(paths) == 2
    assert result["complete"] is False
    assert any("untrusted" in warning for warning in result["warnings"])


@pytest.mark.parametrize("bad_url", [
    "https://example.org/conversation/api/v1/conversations/11111111-1111-4111-8111-111111111111",
    CONVERSATION.replace("https://", "http://"),
    CONVERSATION.replace("https://", "https://user@"),
    CONVERSATION.replace(".wbx2.com", ".wbx2.com:8443"),
    CONVERSATION.replace(".wbx2.com", ".wbx2.com.example.org"),
    CONVERSATION.replace("/conversation/", "/other/"),
    CONVERSATION + "/../other",
])
@pytest.mark.asyncio
async def test_untrusted_conversation_never_receives_bearer(bad_url: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        pytest.fail("Rejected URLs must not receive an authenticated request")

    result = await discover(handler, conversation_urls=[bad_url])
    assert result["items"] == []
    assert result["complete"] is False
    assert result["warnings"]
    assert bad_url not in str(result)


@pytest.mark.parametrize("failure", ["redirect", "timeout", "html", "denied"])
@pytest.mark.asyncio
async def test_failures_remain_incomplete_without_forwarding_redirects_or_leaking_diagnostics(failure: str) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if failure == "redirect":
            return httpx.Response(302, headers={"location": "https://example.org/private"})
        if failure == "timeout":
            raise httpx.ReadTimeout("private diagnostic", request=request)
        if failure == "html":
            return httpx.Response(200, text="<html>private diagnostic</html>")
        return httpx.Response(403, text="private diagnostic")

    result = await discover(handler, conversation_urls=[CONVERSATION])
    assert calls == 1
    assert result["complete"] is False
    assert "private" not in str(result)


@pytest.mark.asyncio
async def test_boundary_timestamp_overlap_preserves_distinct_activities_and_detects_stalled_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spaces, "ACTIVITY_PAGE_SIZE", 2)
    cursors: list[int] = []
    batch = [activity(activity_id="one"), activity(actual=f"{SERIES}_I_2", activity_id="two")]

    def handler(request: httpx.Request) -> httpx.Response:
        cursors.append(int(request.url.params["maxDate"]))
        return httpx.Response(200, json={"items": batch})

    result = await discover(handler, conversation_urls=[CONVERSATION])
    assert len(result["items"]) == 2
    assert cursors[1] == int(datetime(2026, 1, 5, 18, tzinfo=timezone.utc).timestamp() * 1000)
    assert len(cursors) == 2
    assert result["complete"] is False
    assert any("did not advance" in warning for warning in result["warnings"])


@pytest.mark.asyncio
async def test_start_bounds_and_completion_metadata_override_share_regardless_of_order() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"items": [
            activity(start="2026-01-05T00:00:00Z"),
            activity(summary=False, activity_id="share", start="2026-01-05T00:01:00Z"),
            activity(actual=f"{SERIES}_I_2", activity_id="upper", start="2026-01-06T00:00:00Z"),
            activity(actual=f"{SERIES}_20260105T170000Z", activity_id="scheduled"),
        ] if calls == 1 else []})

    result = await discover(handler, conversation_urls=[CONVERSATION])
    assert result["complete"] is True
    assert len(result["items"]) == 1
    assert result["items"][0]["start"] == "2026-01-05T00:00:00+00:00"


@pytest.mark.asyncio
async def test_result_cap_is_explicit_and_does_not_return_chat_payloads() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"items": [activity(), activity(actual=f"{SERIES}_I_2", activity_id="two")]})

    result = await discover(handler, conversation_urls=[CONVERSATION], max_results=1)
    assert len(result["items"]) == 1
    assert result["complete"] is False
    assert any("result limit" in warning for warning in result["warnings"])


@pytest.mark.asyncio
async def test_overall_timeout_returns_partial_status_and_limits_parallel_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spaces, "DISCOVERY_TIMEOUT", 0.02)
    active = 0
    maximum = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        try:
            await asyncio.sleep(0.1)
            return httpx.Response(200, json={"items": []})
        finally:
            active -= 1

    result = await discover(handler, conversation_urls=[CONVERSATION] * 8)
    assert maximum <= 4
    assert result["complete"] is False
    assert any("time limit" in warning for warning in result["warnings"])
