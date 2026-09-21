"""Tests for the configurable cron/interval frequency floor."""

import pytest

from autonomous_agents.models import CronTrigger, IntervalTrigger
from autonomous_agents.services.schedule_validation import validate_trigger_frequency


@pytest.mark.parametrize(
    "trigger",
    [
        CronTrigger(schedule="*/5 * * * *"),
        CronTrigger(schedule="0,59 0,23 * * *"),
        IntervalTrigger(minutes=29),
    ],
)
def test_rejects_triggers_faster_than_minimum(trigger) -> None:
    with pytest.raises(ValueError, match="configured minimum"):
        validate_trigger_frequency(trigger, minimum_seconds=1800)


@pytest.mark.parametrize(
    "trigger",
    [
        CronTrigger(schedule="*/30 * * * *"),
        CronTrigger(schedule="0 9 * * *"),
        IntervalTrigger(minutes=30),
        IntervalTrigger(hours=1, minutes=15),
    ],
)
def test_accepts_triggers_at_or_above_minimum(trigger) -> None:
    validate_trigger_frequency(trigger, minimum_seconds=1800)


def test_sparse_cron_does_not_false_positive_on_midnight_boundary() -> None:
    validate_trigger_frequency(
        CronTrigger(schedule="0,59 0,23 1 * *"),
        minimum_seconds=1800,
    )


def test_minimum_is_configurable() -> None:
    validate_trigger_frequency(IntervalTrigger(minutes=10), minimum_seconds=600)
