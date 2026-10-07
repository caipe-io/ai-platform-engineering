"""Validators for incoming schedule requests."""

from __future__ import annotations

from datetime import datetime, timedelta

from croniter import CroniterBadDateError, croniter
from fastapi import HTTPException
from pytz import all_timezones_set


_CRON_CYCLE_START = datetime(2000, 1, 1)
_CRON_CYCLE_END = datetime(2400, 1, 1)
_CRON_CYCLE_DAYS = 146097


def _frequency_error(minimum_seconds: int) -> HTTPException:
  return HTTPException(
    400,
    "Cron schedule fires more frequently than the configured minimum "
    f"of {minimum_seconds} seconds.",
  )


def _daily_fire_times(fields: list[str]) -> list[int]:
  """Return all wall-clock fire times for the cron minute/hour fields."""
  time_only_expr = f"{fields[0]} {fields[1]} * * *"
  cursor = croniter(time_only_expr, _CRON_CYCLE_START - timedelta(minutes=1))
  times: list[int] = []

  while True:
    fire = cursor.get_next(datetime)
    if fire.date() != _CRON_CYCLE_START.date():
      break
    times.append(fire.hour * 3600 + fire.minute * 60)

  return times


def _eligible_dates(fields: list[str]):
  """Yield eligible dates over one complete Gregorian calendar cycle."""
  date_only_expr = f"0 0 {fields[2]} {fields[3]} {fields[4]}"
  cursor = croniter(date_only_expr, _CRON_CYCLE_START - timedelta(minutes=1))

  while True:
    try:
      fire = cursor.get_next(datetime)
    except CroniterBadDateError:
      return
    if fire >= _CRON_CYCLE_END:
      return
    yield fire


def validate_cron_frequency(expr: str, minimum_seconds: int) -> None:
  """Reject a cron expression with any gap below the deployment minimum."""
  fields = expr.split()
  times = _daily_fire_times(fields)
  if not times:
    raise HTTPException(400, "Cron schedule does not produce any run times.")

  for previous, current in zip(times, times[1:], strict=False):
    if current - previous < minimum_seconds:
      raise _frequency_error(minimum_seconds)

  shortest_possible_cross_day_gap = 86400 - times[-1] + times[0]
  if shortest_possible_cross_day_gap >= minimum_seconds:
    return

  dates = _eligible_dates(fields)
  first_date = next(dates, None)
  if first_date is None:
    raise HTTPException(400, "Cron schedule does not produce any run times.")

  previous_date = first_date
  for current_date in dates:
    gap_seconds = (
      (current_date - previous_date).total_seconds()
      - times[-1]
      + times[0]
    )
    if gap_seconds < minimum_seconds:
      raise _frequency_error(minimum_seconds)
    previous_date = current_date

  # Cron calendar rules repeat every 400 years. Check the boundary from the
  # last eligible day in this cycle to the first eligible day in the next one.
  wrapped_first_date = first_date + timedelta(days=_CRON_CYCLE_DAYS)
  wrap_gap_seconds = (
    (wrapped_first_date - previous_date).total_seconds()
    - times[-1]
    + times[0]
  )
  if wrap_gap_seconds < minimum_seconds:
    raise _frequency_error(minimum_seconds)


def validate_cron(expr: str, minimum_seconds: int) -> None:
  # Kubernetes CronJob accepts exactly five fields. croniter also supports
  # seconds/year variants, so constrain the grammar before asking croniter.
  fields = expr.split()
  if len(fields) != 5:
    raise HTTPException(400, "Cron must use exactly 5 fields: minute hour day-of-month month day-of-week.")
  if not croniter.is_valid(expr):
    raise HTTPException(400, f"Invalid cron expression: {expr!r}")
  validate_cron_frequency(expr, minimum_seconds)


def validate_tz(tz: str) -> None:
  if tz not in all_timezones_set:
    raise HTTPException(400, f"Unknown timezone: {tz!r}")


def validate_message(msg: str, max_chars: int) -> None:
  if not msg or not msg.strip():
    raise HTTPException(400, "message_template must be non-empty.")
  if len(msg) > max_chars:
    raise HTTPException(400, f"message_template exceeds {max_chars} chars.")
