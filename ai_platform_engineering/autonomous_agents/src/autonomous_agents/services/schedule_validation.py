"""Validation helpers for cron and interval trigger frequency."""

from datetime import datetime, timedelta, timezone

from apscheduler.triggers.cron import CronTrigger as APSCronTrigger

from autonomous_agents.models import CronTrigger, IntervalTrigger

_CRON_CYCLE_START = datetime(2000, 1, 1, tzinfo=timezone.utc)
_CRON_CYCLE_END = datetime(2400, 1, 1, tzinfo=timezone.utc)


def _cron_field_values(trigger: APSCronTrigger, field_name: str, limit: int) -> list[int]:
    """Return every allowed value for a fixed-size cron field."""
    field = next(field for field in trigger.fields if field.name == field_name)
    values: list[int] = []
    for value in range(limit):
        probe = _CRON_CYCLE_START.replace(**{field_name: value})
        if field.get_next_value(probe) == value:
            values.append(value)
    return values


def _cron_date_trigger(trigger: APSCronTrigger) -> APSCronTrigger:
    """Build a once-per-eligible-day trigger from a full cron trigger."""
    fields = {field.name: str(field) for field in trigger.fields}
    return APSCronTrigger(
        year=fields["year"],
        month=fields["month"],
        day=fields["day"],
        week=fields["week"],
        day_of_week=fields["day_of_week"],
        hour=0,
        minute=0,
        second=0,
        timezone=timezone.utc,
    )


def _validate_cron_frequency(schedule: str, minimum_seconds: int) -> None:
    """Reject a five-field cron expression with any gap below the minimum.

    Cron calendar rules repeat every 400 years. We inspect all times within an
    eligible day, then walk eligible dates over one Gregorian cycle to cover
    gaps across day/month/year boundaries without expanding every individual
    firing.
    """
    trigger = APSCronTrigger.from_crontab(schedule, timezone=timezone.utc)
    hours = _cron_field_values(trigger, "hour", 24)
    minutes = _cron_field_values(trigger, "minute", 60)
    times = sorted(hour * 3600 + minute * 60 for hour in hours for minute in minutes)
    if not times:
        raise ValueError("Cron schedule does not produce any run times")

    for previous, current in zip(times, times[1:], strict=False):
        if current - previous < minimum_seconds:
            raise ValueError(
                f"Cron schedule fires more frequently than the configured minimum "
                f"of {minimum_seconds} seconds"
            )

    # A one-day boundary is already at least the configured minimum, so date
    # restrictions cannot create a shorter gap.
    shortest_possible_cross_day_gap = 86400 - times[-1] + times[0]
    if shortest_possible_cross_day_gap >= minimum_seconds:
        return

    date_trigger = _cron_date_trigger(trigger)
    previous_date = date_trigger.get_next_fire_time(None, _CRON_CYCLE_START)
    if previous_date is None:
        raise ValueError("Cron schedule does not produce any run times")

    while previous_date < _CRON_CYCLE_END:
        current_date = date_trigger.get_next_fire_time(
            previous_date,
            previous_date + timedelta(microseconds=1),
        )
        if current_date is None:
            break
        gap_seconds = (
            (current_date - previous_date).total_seconds() - times[-1] + times[0]
        )
        if gap_seconds < minimum_seconds:
            raise ValueError(
                f"Cron schedule fires more frequently than the configured minimum "
                f"of {minimum_seconds} seconds"
            )
        previous_date = current_date


def validate_trigger_frequency(
    trigger: CronTrigger | IntervalTrigger,
    minimum_seconds: int,
) -> None:
    """Raise ``ValueError`` when a scheduled trigger exceeds the rate limit."""
    if isinstance(trigger, CronTrigger):
        _validate_cron_frequency(trigger.schedule, minimum_seconds)
        return

    interval_seconds = (
        (trigger.seconds or 0)
        + (trigger.minutes or 0) * 60
        + (trigger.hours or 0) * 3600
    )
    if interval_seconds < minimum_seconds:
        raise ValueError(
            f"Interval must be at least the configured minimum of "
            f"{minimum_seconds} seconds"
        )
