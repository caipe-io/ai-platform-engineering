# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable

import httpx
import pytest

from mcp_webex_meetings import mcp_server
from mcp_webex_meetings import space_occurrences as spaces
from test_recording_transcripts import ToolRegistry

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
async def test_first_space_is_read_before_the_next_catalog_page_finishes() -> None:
    first_space_started = asyncio.Event()
    next_page_finished = False
    activity_calls: set[str] = set()

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal next_page_finished
        if request.url.path == "/u2c/api/v1/catalog":
            return httpx.Response(200, json={"serviceLinks": {"conversation": "https://conv-primary.wbx2.com/conversation/api/v1"}})
        if request.url.path.endswith("/conversations"):
            if request.url.params.get("cursor"):
                await first_space_started.wait()
                next_page_finished = True
                return httpx.Response(200, json={"items": [{"url": SECONDARY}]})
            return httpx.Response(200, json={"items": [{"url": CONVERSATION}]}, headers={
                "Link": '<https://conv-primary.wbx2.com/conversation/api/v1/conversations?cursor=next>; rel="next"',
            })
        first = str(request.url.host) not in activity_calls
        activity_calls.add(str(request.url.host))
        if request.url.host == "conv-primary.wbx2.com":
            assert not next_page_finished or first_space_started.is_set()
            first_space_started.set()
        return httpx.Response(200, json={"items": [activity()] if first else []})

    result = await asyncio.wait_for(discover(handler), timeout=1)
    assert result["complete"] is True
    assert result["items"][0]["id"] == ACTUAL
    assert activity_calls == {"conv-primary.wbx2.com", "conv-secondary.wbx2.com"}


@pytest.mark.asyncio
async def test_one_slow_space_does_not_block_spaces_beyond_the_first_four() -> None:
    last_space_started = asyncio.Event()
    urls = [CONVERSATION.replace("11111111-1111-4111-8111-111111111111", f"{index:08x}-1111-4111-8111-111111111111") for index in range(6)]
    visited: set[str] = set()

    async def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url).split("?")[0].removesuffix("/activities")
        visited.add(url)
        if url == urls[0]:
            await last_space_started.wait()
        if url == urls[-1]:
            last_space_started.set()
        return httpx.Response(200, json={"items": []})

    result = await asyncio.wait_for(discover(handler, conversation_urls=urls), timeout=1)
    assert result["complete"] is True
    assert visited == set(urls)


@pytest.mark.asyncio
async def test_catalog_truncation_keeps_queued_results_and_never_claims_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spaces, "MAX_CATALOG_PAGES", 1)
    activity_requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal activity_requests
        if request.url.path == "/u2c/api/v1/catalog":
            return httpx.Response(200, json={"serviceLinks": {"conversation": "https://conv-primary.wbx2.com/conversation/api/v1"}})
        if request.url.path.endswith("/conversations"):
            return httpx.Response(200, json={"items": [{"url": CONVERSATION}]}, headers={
                "Link": '<https://conv-primary.wbx2.com/conversation/api/v1/conversations?cursor=next>; rel="next"',
            })
        activity_requests += 1
        return httpx.Response(200, json={"items": [activity()] if activity_requests == 1 else []})

    result = await discover(handler)
    assert result["items"][0]["id"] == ACTUAL
    assert result["complete"] is False
    assert any("page limit" in warning for warning in result["warnings"])


@pytest.mark.asyncio
async def test_intentional_catalog_page_boundary_returns_a_safe_continuation_and_resumes_without_u2c() -> None:
    next_url = "https://conv-primary.wbx2.com/conversation/api/v1/conversations?maxDate=1767657600000&paginate=true&membershipsType=memberships"
    u2c_requests = 0
    activity_requests: set[str] = set()

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal u2c_requests
        if request.url.path == "/u2c/api/v1/catalog":
            u2c_requests += 1
            return httpx.Response(200, json={"serviceLinks": {"conversation": "https://conv-primary.wbx2.com/conversation/api/v1"}})
        if request.url.path.endswith("/conversations"):
            if request.url.params.get("maxDate"):
                return httpx.Response(200, json={"items": [{"url": SECONDARY}]})
            return httpx.Response(200, json={"items": [{"url": CONVERSATION}]}, headers={"Link": f'<{next_url}>; rel="next"'})
        activity_requests.add(str(request.url.host))
        return httpx.Response(200, json={"items": []})

    first = await discover(handler, catalog_page_limit=1)
    assert first["complete"] is True
    assert first["has_more"] is True
    assert first["next_catalog_urls"] == [next_url]
    assert activity_requests == {"conv-primary.wbx2.com"}
    second = await discover(handler, catalog_page_limit=1, catalog_urls=first["next_catalog_urls"])
    assert second["complete"] is True
    assert second["has_more"] is False
    assert second["next_catalog_urls"] == []
    assert u2c_requests == 1
    assert activity_requests == {"conv-primary.wbx2.com", "conv-secondary.wbx2.com"}


@pytest.mark.parametrize("query", ["access_token=example-secret", "password=example-secret", "Authorization=example-secret", "maxDate=1&token=example-secret", "maxDate=1&maxDate=2"])
@pytest.mark.asyncio
async def test_catalog_continuations_reject_secret_or_ambiguous_queries_before_forwarding_bearer(query: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        pytest.fail("An invalid continuation must not receive an authenticated request")

    url = f"https://conv-primary.wbx2.com/conversation/api/v1/conversations?{query}"
    with pytest.raises(ValueError, match="continuation query"):
        await discover(handler, catalog_urls=[url], catalog_page_limit=1)


@pytest.mark.asyncio
async def test_secret_query_in_server_next_link_is_never_returned_or_fetched() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if request.url.path == "/u2c/api/v1/catalog":
            return httpx.Response(200, json={"serviceLinks": {"conversation": "https://conv-primary.wbx2.com/conversation/api/v1"}})
        return httpx.Response(200, json={"items": []}, headers={
            "Link": '<https://conv-primary.wbx2.com/conversation/api/v1/conversations?token=example-secret>; rel="next"',
        })

    result = await discover(handler, catalog_page_limit=1)
    assert calls == 2
    assert result["complete"] is False
    assert result["has_more"] is False
    assert result["next_catalog_urls"] == []
    assert "example-secret" not in str(result)


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

    urls = [CONVERSATION.replace("11111111-1111-4111-8111-111111111111", f"{index:08x}-1111-4111-8111-111111111111") for index in range(20)]
    result = await asyncio.wait_for(discover(handler, conversation_urls=urls), timeout=1)
    assert maximum == 4
    assert active == 0
    assert result["complete"] is False
    assert any("time limit" in warning for warning in result["warnings"])


@pytest.mark.parametrize("privilege", ["verified", "missing", "different-instance", "untrusted-url", "denied"])
@pytest.mark.asyncio
async def test_tool_only_marks_transcript_verified_after_exact_privilege_metadata_success(
    monkeypatch: pytest.MonkeyPatch, privilege: str,
) -> None:
    async def occurrences(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"items": [{"id": ACTUAL}], "complete": True, "warnings": []}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == mcp_server.RECORDING_PRIVILEGE_PATH
        assert request.url.params["meetingInstanceId"] == ACTUAL
        if privilege == "denied":
            return httpx.Response(403)
        return httpx.Response(200, json={"privileges": [] if privilege == "missing" else [{
            "meetingInstanceId": f"{OTHER_SERIES}_I_42" if privilege == "different-instance" else ACTUAL,
            "recordUUID": "recording-1", "recordName": "Weekly Review-20260105 1700",
            "transcriptURL": "https://example.org/file" if privilege == "untrusted-url" else "https://media.webex.com/transcript.vtt?token=example-secret",
        }]})

    client_class = httpx.AsyncClient
    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(mcp_server, "_bearer_from_request", lambda: "Bearer example-user-token")
    monkeypatch.setattr(mcp_server, "list_space_meeting_occurrences", occurrences)
    registry = ToolRegistry()
    mcp_server.register_tools(registry)
    result = await registry.tools["webex_space_meeting_occurrences"](mcp_server.SpaceMeetingOccurrences(
        from_iso=LOWER.isoformat(), to_iso=UPPER.isoformat(), site_url="primary.webex.com",
    ))
    if privilege == "verified":
        assert result["items"][0] == {"id": ACTUAL, "title": "Weekly Review", "hasRecording": True, "transcriptVerified": True}
    else:
        assert result["items"][0] == {"id": ACTUAL}
    assert "example-secret" not in str(result)
