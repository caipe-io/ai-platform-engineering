from mcp_webex_meetings.mcp_server import (
    UserHubCalendar,
    _extract_items,
    _normalize_userhub_calendar_item,
    _userhub_calendar_params,
)


def test_post_meeting_query_requests_the_all_past_meetings_view() -> None:
    params = _userhub_calendar_params(UserHubCalendar(meeting_view_type="post"))
    assert params["meetingViewType"] == "post"
    assert params["showMeetings"] == 2
    assert params["hidePastMeeting"] == "false"


def test_post_meeting_normalization_preserves_actual_identity_without_join_link() -> None:
    actual = "a" * 32 + "_I_123456789"
    result = _normalize_userhub_calendar_item({
        "id": actual,
        "seriesId": "a" * 32,
        "subject": "Example review",
        "startTime": {"dateTime": "2026-10-15 09:00:10", "timeZone": "America/Los_Angeles"},
        "endTime": {"dateTime": "2026-10-15 10:00:00", "timeZone": "America/Los_Angeles"},
        "webex": {
            "wbxIsPostMeeting": True, "wbxMeetingUuid": actual,
            "wbxSiteUrl": "https://primary.webex.com", "wbxHasRecording": True,
            "wbxHasTranscript": True, "wbxHost": {"wbxHostEmail": "host@example.com"},
        },
    })
    assert result["id"] == actual
    assert result["meetingSeriesId"] == "a" * 32
    assert result["title"] == "Example review"
    assert result["start"] == "2026-10-15T16:00:10+00:00"
    assert result["meetingType"] == "meeting"
    assert result["state"] == "ended"
    assert result["siteUrl"] == "https://primary.webex.com"
    assert result["hostEmail"] == "host@example.com"
    assert result["webLink"] is None
    assert result["source"] == "userhub_history"
    # A metadata flag is not proof of readable transcript content.
    assert "hasTranscript" not in result
    assert "transcriptVerified" not in result


def test_invitation_uuid_is_never_promoted_to_an_actual_meeting() -> None:
    for post in (False, True):
        result = _normalize_userhub_calendar_item({
            "id": "calendar-invitation", "subject": "Example review",
            "webex": {"wbxIsPostMeeting": post, "wbxMeetingUuid": "a" * 32 + "_20261015T160000Z"},
        })
        assert "meetingType" not in result
        assert result["id"] == "calendar-invitation"


def test_calendar_invitation_preserves_webex_identity_without_claiming_it_happened() -> None:
    for suffix in ("", "_20261015T160000Z"):
        result = _normalize_userhub_calendar_item({
            "id": "calendar-invitation", "seriesId": "external-calendar-series",
            "subject": "Previous title", "organizer": {"email": "delegate@example.com"},
            "webex": {
                "wbxIsPostMeeting": False, "wbxMeetingUuid": "A" * 32 + suffix,
                "wbxHost": {"wbxHostEmail": "host@example.com"},
                "wbxSiteUrl": "https://primary.webex.com", "wbxHasRecording": True,
            },
        })
        assert result["meetingSeriesId"] == "a" * 32
        assert result["seriesId"] == "external-calendar-series"
        assert result["hostEmail"] == "host@example.com"
        assert result["siteUrl"] == "https://primary.webex.com"
        assert result["id"] == "calendar-invitation"
        assert "meetingType" not in result
        assert "state" not in result
        assert "hasRecording" not in result
        assert "hasTranscript" not in result


def test_personal_room_uuid_is_not_a_public_meeting_series_id() -> None:
    result = _normalize_userhub_calendar_item({
        "id": "calendar-invitation",
        "webex": {"wbxMeetingUuid": "a" * 32, "wbxPMRMeeting": True},
    })
    assert "meetingSeriesId" not in result
    assert "meetingType" not in result


def test_conflicting_post_meeting_ids_are_not_accepted_as_an_actual() -> None:
    result = _normalize_userhub_calendar_item({
        "id": "a" * 32 + "_I_1",
        "webex": {"wbxIsPostMeeting": True, "wbxMeetingUuid": "b" * 32 + "_I_2"},
    })
    assert "meetingType" not in result


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
        "startDate": "2026-08-29",
        "endDate": "2026-12-01",
    }


def test_userhub_calendar_end_date_preserves_exclusive_midnight_bound_with_timezone_overlap() -> None:
    args = UserHubCalendar(from_iso="2026-09-01T00:00:00Z", to_iso="2026-09-08T00:00:00Z")
    assert _userhub_calendar_params(args)["startDate"] == "2026-08-31"
    assert _userhub_calendar_params(args)["endDate"] == "2026-09-08"


def test_userhub_calendar_does_not_invent_an_end_date_without_upper_bound() -> None:
    assert "endDate" not in _userhub_calendar_params(UserHubCalendar())


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
