"""Optional real Redis acceptance coverage; every key belongs to one test UUID."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import os
import select
import socket
import socketserver
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Iterator
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import pytest
import redis

from ai_platform_engineering.integrations.slack_bot.utils.cache import CacheLeaseLostError, CachePolicy, ServerCache


@pytest.fixture
def cache_scope() -> Iterator[tuple[str, str, redis.Redis]]:
  url = os.getenv("CACHE_TEST_REDIS_URL")
  if not url:
    pytest.skip("Set CACHE_TEST_REDIS_URL to run cache acceptance tests")
  client = redis.Redis.from_url(url, decode_responses=True, socket_timeout=1)
  client.ping()
  namespace = f"acceptance:{uuid4().hex}"
  try:
    yield url, namespace, client
  finally:
    owned = list(client.scan_iter(match=f"caipe:cache:v1:{namespace}:*"))
    if owned:
      client.delete(*owned)
    client.close()


@contextmanager
def redis_proxy(url: str, initially_blocked: bool) -> Iterator[tuple[str, Event]]:
  target, blocked, stopped = urlsplit(url), Event(), Event()
  if initially_blocked:
    blocked.set()

  class Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
      with socket.create_connection((target.hostname or "127.0.0.1", target.port or 6379), timeout=1) as upstream:
        while not stopped.is_set():
          for source in select.select([self.request, upstream], [], [], 0.05)[0]:
            data = source.recv(65536)
            if not data:
              return
            if not blocked.is_set():
              (upstream if source is self.request else self.request).sendall(data)

  class Proxy(socketserver.ThreadingTCPServer):
    daemon_threads = True

  with Proxy(("127.0.0.1", 0), Handler) as server:
    thread = Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True)
    thread.start()
    authentication = target.netloc.rsplit("@", 1)[0] + "@" if "@" in target.netloc else ""
    proxy_url = urlunsplit(target._replace(netloc=f"{authentication}127.0.0.1:{server.server_address[1]}"))
    try:
      yield proxy_url, blocked
    finally:
      stopped.set()
      server.shutdown()
      thread.join(timeout=1)


def test_lease_takeover_fences_old_publication_and_restart_hits(cache_scope: tuple[str, str, redis.Redis]) -> None:
  url, namespace, client = cache_scope
  policy = CachePolicy(namespace, 60, 300)
  owner, replacement = ServerCache(url), ServerCache(url)
  started, release = Event(), Event()

  def old_loader() -> str:
    started.set()
    assert release.wait(3)
    return "old"

  with ThreadPoolExecutor(max_workers=1) as workers:
    pending = workers.submit(owner.get_or_load, policy, "directory", old_loader)
    try:
      assert started.wait(2)
      client.delete(owner._key(policy, "directory") + ":lease")
      assert replacement.get_or_load(policy, "directory", lambda: "current").value == "current"
    finally:
      release.set()
    with pytest.raises(CacheLeaseLostError):
      pending.result(timeout=2)
  result = ServerCache(url).get_or_load(policy, "directory", lambda: pytest.fail("restart missed shared snapshot"))
  assert result.state == "hit" and result.value == "current"


def test_method_cooldowns_are_shared_and_shorter_delay_cannot_replace_longer(cache_scope: tuple[str, str, redis.Redis]) -> None:
  url, namespace, _ = cache_scope
  first, second = ServerCache(url), ServerCache(url)
  first.set_cooldown(namespace, "users.list", 8)
  second.set_cooldown(namespace, "users.list", 1)
  assert ServerCache(url).cooldown_remaining_seconds(namespace, "users.list") > 6
  assert second.cooldown_remaining_seconds(namespace, "emoji.list") == 0


@pytest.mark.parametrize("established", [False, True])
def test_blackholed_redis_returns_bounded_local_fallback(cache_scope: tuple[str, str, redis.Redis], established: bool) -> None:
  url, namespace, _ = cache_scope
  with redis_proxy(url, initially_blocked=not established) as (proxy_url, blocked):
    cache, policy = ServerCache(proxy_url), CachePolicy(namespace, 60, 300)
    if established:
      assert cache.get_or_load(policy, "warm", lambda: "warm").value == "warm"
      blocked.set()
    started = monotonic()
    assert cache.get_or_load(policy, "cold", lambda: "fallback").value == "fallback"
    assert monotonic() - started < 2.5
    started = monotonic()
    assert cache.get_or_load(policy, "another", lambda: "local").value == "local"
    assert monotonic() - started < 0.2


def test_cold_cache_outage_limits_distinct_loaders_to_two(cache_scope: tuple[str, str, redis.Redis]) -> None:
  _, namespace, _ = cache_scope
  active = peak = 0
  lock = Lock()

  def load() -> str:
    nonlocal active, peak
    with lock:
      active += 1
      peak = max(peak, active)
    sleep(0.03)
    with lock:
      active -= 1
    return "local"

  with socket.socket() as unavailable:
    unavailable.bind(("127.0.0.1", 0))
    cache = ServerCache(f"redis://127.0.0.1:{unavailable.getsockname()[1]}", load_concurrency=2)
    with ThreadPoolExecutor(max_workers=12) as workers:
      results = list(workers.map(lambda key: cache.get_or_load(CachePolicy(namespace, 60, 300), key, load), range(12)))
  assert peak == 2 and all(result.value == "local" for result in results)
