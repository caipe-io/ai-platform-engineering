from __future__ import annotations

import os
from threading import Event, Thread
from time import sleep
from uuid import uuid4

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.cache import CachePolicy, ServerCache


@pytest.mark.integration
def test_redis_lease_prevents_a_slow_follower_load_and_survives_new_client() -> None:
  redis_url = os.getenv("CACHE_TEST_REDIS_URL")
  if not redis_url:
    pytest.skip("set CACHE_TEST_REDIS_URL to run Redis cache acceptance tests")
  policy = CachePolicy(namespace=f"slack:acceptance:{uuid4().hex}", fresh_seconds=60, stale_seconds=300)
  owner = ServerCache(redis_url=redis_url, load_deadline_seconds=7)
  follower = ServerCache(redis_url=redis_url, load_deadline_seconds=0.1)
  started = Event()
  completed = Event()

  def owner_loader() -> list[dict[str, str]]:
    started.set()
    sleep(6)
    return [{"id": "U1"}]

  def run_owner() -> None:
    owner.get_or_load(policy, {"workspace": "example"}, owner_loader)
    completed.set()

  thread = Thread(target=run_owner)
  thread.start()
  assert started.wait(1)
  with pytest.raises(TimeoutError, match="refresh is still in progress"):
    follower.get_or_load(
      policy,
      {"workspace": "example"},
      lambda: (_ for _ in ()).throw(AssertionError("follower loader ran")),
    )
  thread.join(timeout=8)
  assert completed.is_set()
  restarted = ServerCache(redis_url=redis_url)
  result = restarted.get_or_load(
    policy,
    {"workspace": "example"},
    lambda: (_ for _ in ()).throw(AssertionError("persistent Redis snapshot was missed")),
  )
  assert result.state == "hit"
