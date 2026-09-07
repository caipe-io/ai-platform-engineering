import pytest
from pydantic import ValidationError

from caipe_scheduler.models import Schedule, ScheduleCreate, SchedulePatch


def test_schedule_create_rejects_caller_supplied_owner():
  with pytest.raises(ValidationError, match="owner_user_id"):
    ScheduleCreate(
      agent_id="agent-weekly-report",
      title="Weekly report",
      message_template="Create the weekly report.",
      cron="0 9 * * MON",
      tz="Etc/UTC",
      owner_user_id="victim@example.com",
    )


def test_schedule_accepts_runner_reconcile_history_event():
  schedule = Schedule.model_validate(
    {
      "schedule_id": "schedule-1",
      "owner_user_id": "owner@example.com",
      "agent_id": "agent-1",
      "message_template": "Run the report",
      "cron": "0 9 * * MON",
      "tz": "Etc/UTC",
      "created_at": "2026-07-02T00:00:00Z",
      "updated_at": "2026-07-02T00:00:00Z",
      "events": [
        {
          "event_id": "evt_1",
          "event_type": "runner_image_reconciled",
          "occurred_at": "2026-07-02T01:00:00Z",
          "actor_type": "system",
          "actor_id": "caipe-scheduler",
          "source": "deployment_reconcile",
          "changed_fields": ["runner_image"],
          "changes": {
            "runner_image": {
              "before": "runner:old",
              "after": "runner:new",
            }
          },
        }
      ],
    }
  )

  assert schedule.events[0].changes["runner_image"].after == "runner:new"
  assert schedule.http_timeout_seconds == 300


def test_schedule_create_defaults_http_timeout_to_300():
  schedule = ScheduleCreate(
    agent_id="agent-weekly-report",
    title="Weekly report",
    message_template="Create the weekly report.",
    cron="0 9 * * MON",
    tz="Etc/UTC",
  )

  assert schedule.http_timeout_seconds == 300


def test_schedule_patch_rejects_non_positive_http_timeout():
  with pytest.raises(ValidationError, match="greater than or equal to 1"):
    SchedulePatch(http_timeout_seconds=0)
