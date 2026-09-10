from mcp_webex_meetings.mcp_server import (
    UserHubCalendar,
    _extract_items,
    _normalize_userhub_calendar_item,
    _userhub_calendar_params,
)


def test_userhub_calendar_query_requests_meetings_from_requested_start() -> None:
    args = UserHubCalendar(
        from_iso="2026-08-30T12:00:00Z",
        to_iso="2026-11-30T12:00:00Z",
        max_results=500,
    )

    assert _userhub_calendar_params(args) == {
        "meetingListType": "All",
        "offset": 0,
        "limit": 500,
        "hidePastMeeting": "false",
        "showMeetings": 1,
        "startDate": "2026-08-30",
    }


def test_extract_items_accepts_nested_userhub_response() -> None:
    rows = [{"id": "meeting-1"}]
    assert _extract_items({"result": {"data": {"meetingList": rows}}}) == rows


def test_normalize_userhub_calendar_accepts_live_shape_aliases() -> None:
    result = _normalize_userhub_calendar_item(
        {
            "meetingId": "meeting-1",
            "meetingSeriesId": "series-1",
            "meetingName": "OpenClaw UCL MSc Student Project Weekly Sync",
            "startDateTime": "2026-09-01T17:00:00Z",
            "endDateTime": "2026-09-01T18:00:00Z",
            "joinUrl": "https://cisco.webex.com/meet/openclaw-sync",
            "host": {"emailAddress": "suwhang@cisco.com"},
            "recurrenceType": "seriesOccurrence",
        }
    )

    assert result == {
        "id": "meeting-1",
        "seriesId": "series-1",
        "subject": "OpenClaw UCL MSc Student Project Weekly Sync",
        "source": None,
        "start": "2026-09-01T17:00:00+00:00",
        "end": "2026-09-01T18:00:00+00:00",
        "timezone": None,
        "startRaw": "2026-09-01T17:00:00Z",
        "endRaw": "2026-09-01T18:00:00Z",
        "location": None,
        "webLink": "https://cisco.webex.com/meet/openclaw-sync",
        "organizerEmail": "suwhang@cisco.com",
        "organizer": {"emailAddress": "suwhang@cisco.com"},
        "occurrenceType": "seriesOccurrence",
        "isCancelled": None,
        "isAllDay": None,
        "originalStartTime": None,
    }


def test_normalize_userhub_calendar_converts_live_iana_timezone_to_utc() -> None:
    result = _normalize_userhub_calendar_item(
        {
            "meetingId": "meeting-1",
            "seriesId": "series-1",
            "subject": "Example weekly",
            "startTime": {
                "dateTime": "2026-09-03 05:30:00",
                "timeZone": "America/Los_Angeles",
            },
            "endTime": {
                "dateTime": "2026-09-03 06:00:00",
                "timeZone": "America/Los_Angeles",
            },
            "occurrenceType": "Repeat",
        }
    )

    assert result["start"] == "2026-09-03T12:30:00+00:00"
    assert result["end"] == "2026-09-03T13:00:00+00:00"
    assert result["timezone"] == "America/Los_Angeles"


def test_normalize_userhub_calendar_rejects_timezone_less_local_time() -> None:
    result = _normalize_userhub_calendar_item(
        {
            "meetingId": "meeting-1",
            "seriesId": "series-1",
            "subject": "Example weekly",
            "startTime": "2026-09-03 05:30:00",
            "endTime": "2026-09-03 06:00:00",
        }
    )

    assert result["start"] is None
    assert result["end"] is None
    assert result["startRaw"] == "2026-09-03 05:30:00"
    assert result["endRaw"] == "2026-09-03 06:00:00"
