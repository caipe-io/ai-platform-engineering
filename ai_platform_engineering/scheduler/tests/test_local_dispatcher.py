from datetime import datetime, timedelta, timezone
from threading import Event
from unittest.mock import MagicMock

from caipe_scheduler.config import Settings
from caipe_scheduler.local_dispatcher import LocalScheduleDispatcher


def test_slow_runs_do_not_block_polling_or_overlap_recurring_runs() -> None:
  store = MagicMock()
  schedule = {"schedule_id": "example", "cron": "* * * * *", "tz": "UTC"}
  store.list.return_value = [schedule]
  settings = Settings(one_off_dispatch_enabled=False, one_off_dispatch_concurrency=2)
  dispatcher = LocalScheduleDispatcher(store=store, settings=settings)
  started, release = Event(), Event()

  def invoke(_: dict) -> None:
    started.set()
    assert release.wait(3)

  dispatcher._fire = MagicMock(side_effect=invoke)
  dispatcher._next_runs["example"] = (("* * * * *", "UTC"), datetime.now(timezone.utc) - timedelta(minutes=1))
  try:
    dispatcher.dispatch_once()
    assert started.wait(1)
    dispatcher._next_runs["example"] = (("* * * * *", "UTC"), datetime.now(timezone.utc) - timedelta(minutes=1))
    dispatcher.dispatch_once()
    assert dispatcher._fire.call_count == 1
    store.claim_due_one_off_runs.assert_not_called()
  finally:
    release.set()
    dispatcher.stop()


def test_one_off_claims_are_limited_to_free_workers() -> None:
  store = MagicMock()
  store.list.return_value = []
  store.claim_due_one_off_runs.return_value = []
  dispatcher = LocalScheduleDispatcher(store=store, settings=Settings(one_off_dispatch_concurrency=2))
  try:
    dispatcher.dispatch_once()
    store.claim_due_one_off_runs.assert_called_once_with(limit=2, claim_timeout_seconds=600)
  finally:
    dispatcher.stop()
