import pytest
from fastapi import HTTPException

from caipe_scheduler.validation import validate_cron


def test_validate_cron_accepts_kubernetes_five_field_expression():
  assert validate_cron("0 9 * * MON", 1800) is None


def test_validate_cron_rejects_non_kubernetes_six_field_expression():
  with pytest.raises(HTTPException) as exc_info:
    validate_cron("0 0 9 * * MON", 1800)

  assert exc_info.value.status_code == 400
  assert "exactly 5 fields" in str(exc_info.value.detail)


@pytest.mark.parametrize(
  "expr",
  [
    "*/5 * * * *",
    "0,59 0,23 * * *",
  ],
)
def test_validate_cron_rejects_schedules_faster_than_minimum(expr: str):
  with pytest.raises(HTTPException) as exc_info:
    validate_cron(expr, 1800)

  assert exc_info.value.status_code == 400
  assert "configured minimum of 1800 seconds" in str(exc_info.value.detail)


@pytest.mark.parametrize(
  "expr",
  [
    "*/30 * * * *",
    "0 9 * * *",
  ],
)
def test_validate_cron_accepts_schedules_at_or_above_minimum(expr: str):
  assert validate_cron(expr, 1800) is None


def test_sparse_cron_does_not_false_positive_at_midnight_boundary():
  assert validate_cron("0,59 0,23 1 * *", 1800) is None


def test_validate_cron_uses_configured_minimum():
  assert validate_cron("*/10 * * * *", 600) is None
