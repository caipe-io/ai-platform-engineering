from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from caipe_scheduler.app import create_schedule, patch_schedule, runtime_settings
from caipe_scheduler.auth import CallerIdentity
from caipe_scheduler.config import Settings
from caipe_scheduler.models import ScheduleCreate, SchedulePatch


def _caller() -> CallerIdentity:
  return CallerIdentity(sub="user-1", email="user@example.com")


def test_runtime_settings_exposes_deployed_minimum():
  assert runtime_settings(Settings(minimum_schedule_interval_seconds=600)) == {
    "minimum_schedule_interval_seconds": 600,
  }


def test_create_rejects_too_frequent_cron_before_writes():
  store = Mock()
  k8s = Mock()
  body = ScheduleCreate(
    agent_id="agent-1",
    title="Frequent report",
    message_template="Run the report",
    cron="*/5 * * * *",
    tz="UTC",
  )

  with pytest.raises(HTTPException, match="configured minimum"):
    create_schedule(
      body=body,
      store=store,
      k8s=k8s,
      settings=Settings(minimum_schedule_interval_seconds=1800),
      caller=_caller(),
    )

  store.insert.assert_not_called()
  k8s.create.assert_not_called()


def test_patch_rejects_too_frequent_cron_before_writes():
  store = Mock()
  store.get_for_owner.return_value = {
    "schedule_id": "schedule-1",
    "cronjob_name": "caipe-sched-schedule-1",
  }
  k8s = Mock()

  with pytest.raises(HTTPException, match="configured minimum"):
    patch_schedule(
      schedule_id="schedule-1",
      body=SchedulePatch(cron="*/5 * * * *"),
      store=store,
      k8s=k8s,
      settings=Settings(minimum_schedule_interval_seconds=1800),
      caller=_caller(),
    )

  store.patch.assert_not_called()
  k8s.patch.assert_not_called()
