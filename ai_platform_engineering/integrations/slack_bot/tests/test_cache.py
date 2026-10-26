from __future__ import annotations

from threading import Event, Thread
from time import sleep

import redis
import pytest

from ai_platform_engineering.integrations.slack_bot.utils.cache import CacheLeaseLostError, CachePolicy, ServerCache


class FakeRedis:
  def __init__(self) -> None:
    self.values: dict[str, str] = {}
    self.fail = False

  def ping(self) -> bool:
    if self.fail:
      raise redis.RedisError("unavailable")
    return True

  def get(self, key: str) -> str | None:
    if self.fail:
      raise redis.RedisError("unavailable")
    return self.values.get(key)

  def set(self, key: str, value: str, **options: object) -> bool:
    if self.fail:
      raise redis.RedisError("unavailable")
    if options.get("nx") and key in self.values:
      return None  # redis-py returns None for SET NX contention.
    if options.get("xx") and key not in self.values:
      return False
    self.values[key] = value
    return True

  def eval(self, script: str, numkeys: int, *args: str) -> int:
    if self.fail:
      raise redis.RedisError("unavailable")
    keys, values = args[:numkeys], args[numkeys:]
    if self.values.get(keys[-1]) != values[0]:
      return 0
    if "PEXPIRE" in script:
      return 1
    if "SET" in script:
      self.values[keys[0]] = values[1]
    self.values.pop(keys[-1], None)
    return 1


def test_canonical_key_coalesces_local_loads() -> None:
  cache = ServerCache(redis_url=None)
  policy = CachePolicy(namespace="slack:users", fresh_seconds=60, stale_seconds=300)
  calls = 0

  def loader() -> dict[str, int]:
    nonlocal calls
    calls += 1
    return {"value": 1}

  cache.get_or_load(policy, {"b": 2, "a": 1}, loader)
  result = cache.get_or_load(policy, {"a": 1, "b": 2}, loader)

  assert result.state == "hit"
  assert calls == 1


def test_concurrent_calls_share_one_loader() -> None:
  cache = ServerCache(redis_url=None)
  policy = CachePolicy(namespace="slack:emoji", fresh_seconds=60, stale_seconds=300)
  started, release = Event(), Event()
  results = []

  def loader() -> dict[str, bool]:
    started.set()
    release.wait(1)
    return {"complete": True}

  first = Thread(target=lambda: results.append(cache.get_or_load(policy, "workspace", loader)))
  second = Thread(target=lambda: results.append(cache.get_or_load(policy, "workspace", loader)))
  first.start()
  assert started.wait(1)
  second.start()
  release.set()
  first.join()
  second.join()

  assert sorted(result.state for result in results) == ["miss", "shared"]


def test_renew_does_not_extend_another_owner_lease() -> None:
  fake = FakeRedis()
  cache = ServerCache(redis_url="redis://example", redis_client_factory=lambda _: fake)
  assert cache._acquire_lease("lease", "owner-a") is True
  fake.values["lease"] = "owner-b"

  assert cache._renew_lease("lease", "owner-a") is False
  assert fake.values["lease"] == "owner-b"


def test_redis_py_none_for_nx_contention_is_not_an_outage() -> None:
  fake = FakeRedis()
  cache = ServerCache(redis_url="redis://example", redis_client_factory=lambda _: fake)

  assert cache._acquire_lease("lease", "owner-a") is True
  assert cache._acquire_lease("lease", "owner-b") is False
  assert cache.metrics().redis_errors == 0


def test_lost_lease_does_not_publish_or_remember_loader_value() -> None:
  fake = FakeRedis()
  cache = ServerCache(redis_url="redis://example", redis_client_factory=lambda _: fake)
  policy = CachePolicy(namespace="slack:users", fresh_seconds=60, stale_seconds=300)
  cache._publish = lambda *_args: False  # type: ignore[method-assign]

  with pytest.raises(CacheLeaseLostError, match="lease was lost"):
    cache.get_or_load(policy, "workspace", lambda: {"generation": "stale-owner"})

  assert cache.get(policy, "workspace") is None


def test_redis_circuit_serves_local_hit() -> None:
  fake = FakeRedis()
  cache = ServerCache(redis_url="redis://example", redis_client_factory=lambda _: fake)
  policy = CachePolicy(namespace="slack:users", fresh_seconds=60, stale_seconds=300)
  cache.get_or_load(policy, "workspace", lambda: {"users": []})
  fake.fail = True

  result = cache.get_or_load(policy, "workspace", lambda: {"unexpected": True})

  assert result.state == "hit"
  assert result.value == {"users": []}


def test_reduced_hard_ttl_expires_an_existing_local_snapshot() -> None:
  cache = ServerCache(redis_url=None)
  key = "workspace"
  cache.get_or_load(CachePolicy(namespace="slack:users", fresh_seconds=60, stale_seconds=300), key, lambda: {"generation": 1})
  sleep(0.01)

  result = cache.get_or_load(CachePolicy(namespace="slack:users", fresh_seconds=0.001, stale_seconds=0.005), key, lambda: {"generation": 2})

  assert result.value == {"generation": 2}
  assert result.state == "miss"
