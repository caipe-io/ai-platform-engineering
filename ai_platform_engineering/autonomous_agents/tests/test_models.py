"""Tests for autonomous_agents Pydantic models."""

from autonomous_agents.models import (
    CronTrigger,
    IntervalTrigger,
    TaskDefinition,
    TaskRun,
    TaskStatus,
    TriggerType,
    WebhookTrigger,
)


class TestTriggerTypes:
    """Trigger model discriminator and basic field defaults."""

    def test_cron_trigger_type(self):
        """CronTrigger reports ``TriggerType.CRON`` and round-trips ``schedule``."""
        trigger = CronTrigger(schedule="0 9 * * *")
        assert trigger.type == TriggerType.CRON
        assert trigger.schedule == "0 9 * * *"

    def test_interval_trigger_type(self):
        """IntervalTrigger reports ``TriggerType.INTERVAL``."""
        trigger = IntervalTrigger(minutes=30)
        assert trigger.type == TriggerType.INTERVAL
        assert trigger.minutes == 30

    def test_webhook_trigger_type(self):
        """WebhookTrigger reports ``TriggerType.WEBHOOK``."""
        trigger = WebhookTrigger()
        assert trigger.type == TriggerType.WEBHOOK
        assert trigger.provider == "generic_hmac"

    def test_webhook_trigger_optional_secret(self):
        """``secret`` is optional on WebhookTrigger."""
        trigger = WebhookTrigger(secret="my-secret")
        assert trigger.secret == "my-secret"

        trigger_no_secret = WebhookTrigger()
        assert trigger_no_secret.secret is None


class TestTaskDefinition:
    """TaskDefinition construction defaults and validation."""

    def test_task_definition_cron(self):
        """CronTrigger task constructs with sensible defaults."""
        task = TaskDefinition(
            id="daily-scan",
            name="Daily Scan",
            agent="github",
            prompt="Scan for vulnerabilities",
            trigger=CronTrigger(schedule="0 9 * * 1-5"),
        )
        assert task.id == "daily-scan"
        assert task.enabled is True
        assert task.trigger.type == TriggerType.CRON

    def test_task_definition_disabled_by_default_is_true(self):
        """``enabled`` defaults to True."""
        task = TaskDefinition(
            id="test",
            name="Test",
            agent="github",
            prompt="test prompt",
            trigger=IntervalTrigger(minutes=10),
        )
        assert task.enabled is True

    def test_task_definition_can_be_disabled(self):
        """``enabled=False`` is honoured."""
        task = TaskDefinition(
            id="test",
            name="Test",
            agent="github",
            prompt="test prompt",
            trigger=IntervalTrigger(hours=1),
            enabled=False,
        )
        assert task.enabled is False


class TestTaskStatus:
    """TaskStatus enum string values."""

    def test_task_status_values(self):
        """Status names match the persisted string values."""
        assert TaskStatus.PENDING == "pending"
        assert TaskStatus.RUNNING == "running"
        assert TaskStatus.SUCCESS == "success"
        assert TaskStatus.FAILED == "failed"


class TestTaskDefinitionOwnerField:
    def test_owner_id_defaults_to_none(self):
        """TaskDefinition.owner_id is optional and defaults to None."""
        task = TaskDefinition(
            id="t1",
            name="Test Task",
            prompt="do something",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )
        assert task.owner_id is None

    def test_owner_id_accepts_email(self):
        """TaskDefinition.owner_id stores an email string."""
        task = TaskDefinition(
            id="t1",
            name="Test Task",
            prompt="do something",
            trigger=CronTrigger(schedule="0 9 * * *"),
            owner_id="alice@example.com",
        )
        assert task.owner_id == "alice@example.com"

    def test_owner_id_round_trips_through_json(self):
        """owner_id survives model_dump / model_validate round-trip."""
        task = TaskDefinition(
            id="t1",
            name="Test Task",
            prompt="do something",
            trigger=CronTrigger(schedule="0 9 * * *"),
            owner_id="bob@example.com",
        )
        dumped = task.model_dump(mode="json")
        restored = TaskDefinition.model_validate(dumped)
        assert restored.owner_id == "bob@example.com"

    def test_owner_id_absent_from_json_parses_as_none(self):
        """Existing persisted docs without owner_id parse cleanly (backward compat)."""
        raw = {
            "id": "t1",
            "name": "Legacy Task",
            "prompt": "do something",
            "trigger": {"type": "cron", "schedule": "0 9 * * *"},
        }
        task = TaskDefinition.model_validate(raw)
        assert task.owner_id is None


class TestTaskRunOwnerField:
    def test_owner_id_defaults_to_none(self):
        """TaskRun.owner_id is optional and defaults to None."""
        from autonomous_agents.models import TaskStatus
        run = TaskRun(
            run_id="r1",
            task_id="t1",
            task_name="My Task",
            status=TaskStatus.SUCCESS,
        )
        assert run.owner_id is None

    def test_owner_id_accepts_email(self):
        """TaskRun.owner_id stores the owning user's email."""
        from autonomous_agents.models import TaskStatus
        run = TaskRun(
            run_id="r1",
            task_id="t1",
            task_name="My Task",
            status=TaskStatus.SUCCESS,
            owner_id="alice@example.com",
        )
        assert run.owner_id == "alice@example.com"

    def test_owner_id_round_trips_through_json(self):
        """owner_id survives model_dump / model_validate."""
        from autonomous_agents.models import TaskStatus
        run = TaskRun(
            run_id="r1",
            task_id="t1",
            task_name="My Task",
            status=TaskStatus.SUCCESS,
            owner_id="bob@example.com",
        )
        restored = TaskRun.model_validate(run.model_dump(mode="json"))
        assert restored.owner_id == "bob@example.com"

    def test_owner_id_absent_parses_as_none(self):
        """Legacy run docs without owner_id parse cleanly."""
        raw = {
            "run_id": "r1",
            "task_id": "t1",
            "task_name": "Legacy",
            "status": "success",
        }
        run = TaskRun.model_validate(raw)
        assert run.owner_id is None
