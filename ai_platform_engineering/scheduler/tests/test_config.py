import pytest
from pydantic import ValidationError

from caipe_scheduler.config import Settings


def test_minimum_schedule_interval_defaults_to_thirty_minutes(monkeypatch):
  monkeypatch.delenv("MINIMUM_SCHEDULE_INTERVAL_SECONDS", raising=False)
  assert Settings().minimum_schedule_interval_seconds == 1800


def test_minimum_schedule_interval_is_deploy_configurable(monkeypatch):
  monkeypatch.setenv("MINIMUM_SCHEDULE_INTERVAL_SECONDS", "600")
  assert Settings().minimum_schedule_interval_seconds == 600


def test_minimum_schedule_interval_must_be_positive(monkeypatch):
  monkeypatch.setenv("MINIMUM_SCHEDULE_INTERVAL_SECONDS", "0")
  with pytest.raises(ValidationError):
    Settings()
