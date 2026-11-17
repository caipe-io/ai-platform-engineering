"""Date-only upstream windows must cover exact timestamp filters."""

import pytest

from mcp_webex_meetings.mcp_server import UserHubCalendar, _userhub_calendar_params


@pytest.mark.parametrize(
    ("start", "end", "expected_start", "expected_end"),
    [
        ("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2025-12-31", "2026-01-02"),
        ("2026-12-31T12:00:00Z", "2027-01-01T12:00:00Z", "2026-12-30", "2027-01-02"),
        (None, "2026-09-08T00:00:00Z", None, "2026-09-08"),
        ("2026-09-01T00:00:00Z", None, "2026-08-31", None),
        (None, None, None, None),
    ],
)
def test_calendar_window_keeps_optional_bounds_and_crosses_years(
    start: str | None,
    end: str | None,
    expected_start: str | None,
    expected_end: str | None,
) -> None:
    params = _userhub_calendar_params(UserHubCalendar(from_iso=start, to_iso=end))
    assert params.get("startDate") == expected_start
    assert params.get("endDate") == expected_end
