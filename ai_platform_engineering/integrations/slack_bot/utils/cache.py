"""Thread-safe JSON cache-aside storage for bot-owned directory snapshots."""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from datetime import date, datetime
from hashlib import sha256
import json
import os
from threading import BoundedSemaphore, Event, Lock, RLock, Thread, local
from time import monotonic, time
from typing import Any, Generic, Literal, TypeVar
from uuid import uuid4

import redis

T = TypeVar("T")
CacheState = Literal["hit", "stale", "miss", "shared"]
_PREFIX = "caipe:cache:v1"
_COOLDOWN_SECONDS = 30.0
_LEASE_SECONDS = 15
_POLL_SECONDS = 0.075


@dataclass(frozen=True)
class CachePolicy:
  namespace: str
  fresh_seconds: float
  """Fresh window. A non-positive value disables caching."""
  stale_seconds: float
  """Total hard lifetime from computation, including the fresh window."""
  max_entries: int = 500
  force_refresh: bool = False


@dataclass(frozen=True)
class CacheResult(Generic[T]):
  value: T
  state: CacheState
  computed_at_ms: int


@dataclass
class CacheMetrics:
  hits: int = 0
  stale: int = 0
  misses: int = 0
  shared: int = 0
  loads: int = 0
  load_failures: int = 0
  redis_errors: int = 0
  circuit_open: int = 0
  cache_age_ms_total: int = 0
  cache_age_samples: int = 0


class CacheLeaseLostError(RuntimeError):
  """A completed loader lost ownership before its value could be published."""


@dataclass(frozen=True)
class _Entry:
  value: Any
  computed_at_ms: int
  hard_expires_at_ms: int


def _json_default(value: object) -> str:
  if isinstance(value, (datetime, date)):
    return value.isoformat()
  raise TypeError(f"Cache values must be JSON serializable, got {type(value).__name__}")


def _json(value: object) -> str:
  return json.dumps(value, default=_json_default, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


class ServerCache:
  """Uses local snapshots until an optional Redis cache is available."""

  def __init__(
    self,
    redis_url: str | None = None,
    redis_client_factory: Callable[[str], redis.Redis] | None = None,
    load_concurrency: int | None = None,
    load_deadline_seconds: float | None = None,
  ) -> None:
    self._redis_url = redis_url if redis_url is not None else os.getenv("CAIPE_CACHE_REDIS_URL")
    self._redis_client_factory = redis_client_factory or self._new_redis_client
    self._redis_client: redis.Redis | None = None
    self._redis_lock = Lock()
    self._circuit_open_until = 0.0
    self._entries: OrderedDict[str, _Entry] = OrderedDict()
    self._cooldowns: dict[str, int] = {}
    self._entries_lock = RLock()
    self._in_flight: dict[str, Future[CacheResult[Any]]] = {}
    self._in_flight_lock = Lock()
    self._metrics = CacheMetrics()
    self._metrics_lock = Lock()
    self._load_slots = BoundedSemaphore(max(1, load_concurrency or int(os.getenv("CAIPE_CACHE_LOAD_CONCURRENCY", "2"))))
    self._load_deadline_seconds = load_deadline_seconds or float(os.getenv("CAIPE_CACHE_LOAD_DEADLINE_SECONDS", "5"))
    self._loader_context = local()

  @staticmethod
  def _new_redis_client(url: str) -> redis.Redis:
    return redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1, decode_responses=True)

  @staticmethod
  def _now_ms() -> int:
    return int(time() * 1000)

  @staticmethod
  def _enabled(policy: CachePolicy) -> bool:
    if policy.fresh_seconds <= 0:
      return False
    if policy.stale_seconds < policy.fresh_seconds:
      raise ValueError("Cache stale_seconds must be greater than or equal to fresh_seconds")
    return True

  @staticmethod
  def _key(policy: CachePolicy, key: object) -> str:
    digest = sha256(_json(key).encode()).hexdigest()
    return f"{_PREFIX}:{policy.namespace}:{digest}"

  def _record(self, state: CacheState | None = None, **increments: int) -> None:
    with self._metrics_lock:
      if state == "hit":
        self._metrics.hits += 1
      elif state == "stale":
        self._metrics.stale += 1
      for name, amount in increments.items():
        setattr(self._metrics, name, getattr(self._metrics, name) + amount)

  def _record_age(self, computed_at_ms: int) -> None:
    self._record(cache_age_ms_total=max(0, self._now_ms() - computed_at_ms), cache_age_samples=1)

  def metrics(self) -> CacheMetrics:
    with self._metrics_lock:
      return CacheMetrics(**self._metrics.__dict__)

  def _remember(self, key: str, entry: _Entry, policy: CachePolicy) -> None:
    bounded = _Entry(entry.value, entry.computed_at_ms, entry.computed_at_ms + int(policy.stale_seconds * 1000))
    with self._entries_lock:
      self._entries.pop(key, None)
      self._entries[key] = bounded
      while len(self._entries) > max(1, policy.max_entries):
        self._entries.popitem(last=False)

  def _read_local(self, key: str, policy: CachePolicy) -> CacheResult[Any] | None:
    with self._entries_lock:
      entry = self._entries.get(key)
      if entry is None:
        return None
      if entry.hard_expires_at_ms <= self._now_ms() or entry.computed_at_ms + int(policy.stale_seconds * 1000) <= self._now_ms():
        self._entries.pop(key, None)
        return None
      self._entries.move_to_end(key)
    state: CacheState = "hit" if self._now_ms() - entry.computed_at_ms < policy.fresh_seconds * 1000 else "stale"
    self._record(state)
    self._record_age(entry.computed_at_ms)
    return CacheResult(entry.value, state, entry.computed_at_ms)

  def _redis(self) -> redis.Redis | None:
    if not self._redis_url:
      return None
    with self._redis_lock:
      if monotonic() < self._circuit_open_until:
        self._record(circuit_open=1)
        return None
      if self._redis_client is None:
        try:
          client = self._redis_client_factory(self._redis_url)
          client.ping()
          self._redis_client = client
        except redis.RedisError:
          self._record(redis_errors=1)
          self._circuit_open_until = monotonic() + _COOLDOWN_SECONDS
          return None
      return self._redis_client

  def _redis_operation(self, operation: Callable[[redis.Redis], T]) -> T | None:
    client = self._redis()
    if client is None:
      return None
    try:
      return operation(client)
    except redis.RedisError:
      with self._redis_lock:
        self._redis_client = None
        self._circuit_open_until = monotonic() + _COOLDOWN_SECONDS
      self._record(redis_errors=1)
      return None

  @staticmethod
  def _decode(raw: str | bytes | None) -> _Entry | None:
    if raw is None:
      return None
    try:
      payload = json.loads(raw)
      computed_at_ms = payload["computed_at_ms"]
      if not isinstance(computed_at_ms, int) or "value" not in payload:
        return None
      return _Entry(payload["value"], computed_at_ms, 0)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
      return None

  def _read_redis(self, key: str, policy: CachePolicy) -> CacheResult[Any] | None:
    entry = self._decode(self._redis_operation(lambda client: client.get(key)))
    if entry is None or self._now_ms() - entry.computed_at_ms >= policy.stale_seconds * 1000:
      return None
    self._remember(key, entry, policy)
    state: CacheState = "hit" if self._now_ms() - entry.computed_at_ms < policy.fresh_seconds * 1000 else "stale"
    self._record(state)
    self._record_age(entry.computed_at_ms)
    return CacheResult(entry.value, state, entry.computed_at_ms)

  def _load(self, loader: Callable[[], T]) -> T:
    nested = getattr(self._loader_context, "depth", 0) > 0
    if not nested and not self._load_slots.acquire(timeout=self._load_deadline_seconds):
      raise TimeoutError("Cache loader queue deadline exceeded")
    self._loader_context.depth = getattr(self._loader_context, "depth", 0) + 1
    self._record(loads=1)
    try:
      return loader()
    except Exception:
      self._record(load_failures=1)
      raise
    finally:
      self._loader_context.depth -= 1
      if not nested:
        self._load_slots.release()

  def _acquire_lease(self, key: str, token: str) -> bool | None:
    return self._redis_operation(lambda client: bool(client.set(key, token, nx=True, px=_LEASE_SECONDS * 1000)))

  def _renew_lease(self, key: str, token: str) -> bool:
    result = self._redis_operation(
      lambda client: client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; return 0",
        1,
        key,
        token,
        str(_LEASE_SECONDS * 1000),
      )
    )
    return result == 1

  def _release_lease(self, key: str, token: str) -> None:
    self._redis_operation(
      lambda client: client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0", 1, key, token
      )
    )

  def _publish(self, key: str, lock_key: str, token: str, entry: _Entry, policy: CachePolicy) -> bool:
    payload = _json({"value": entry.value, "computed_at_ms": entry.computed_at_ms})
    result = self._redis_operation(
      lambda client: client.eval(
        "if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); redis.call('DEL', KEYS[2]); return 1 end; return 0",
        2,
        key,
        lock_key,
        token,
        payload,
        str(int(policy.stale_seconds * 1000)),
      )
    )
    return result == 1

  def _wait_for_publish(self, key: str, policy: CachePolicy) -> CacheResult[Any] | None:
    deadline = monotonic() + self._load_deadline_seconds
    while monotonic() < deadline:
      Event().wait(_POLL_SECONDS)
      entry = self._read_redis(key, policy)
      if entry is not None and entry.state == "hit":
        return entry
    return None

  def _refresh(self, key: str, policy: CachePolicy, loader: Callable[[], T], use_lease: bool) -> CacheResult[T]:
    lock_key = f"{key}:lease"
    token = uuid4().hex
    lease = self._acquire_lease(lock_key, token) if use_lease else None
    if lease is False:
      published = self._wait_for_publish(key, policy)
      if published is not None:
        return CacheResult(published.value, published.state, published.computed_at_ms)
      raise TimeoutError("Cache refresh is still in progress")
    owns_lease = Event()
    if lease:
      owns_lease.set()
    stop_renewal = Event()

    def renew() -> None:
      while not stop_renewal.wait(_LEASE_SECONDS / 3):
        if not self._renew_lease(lock_key, token):
          owns_lease.clear()
          return

    renewal = Thread(target=renew, daemon=True) if lease else None
    if renewal:
      renewal.start()
    try:
      value = json.loads(_json(self._load(loader)))
      entry = _Entry(value, self._now_ms(), 0)
      published = self._publish(key, lock_key, token, entry, policy) if owns_lease.is_set() else False
      if use_lease and lease and not published:
        raise CacheLeaseLostError("Cache refresh lease was lost before publish")
      if not use_lease or lease is None or published:
        self._remember(key, entry, policy)
      return CacheResult(value, "miss", entry.computed_at_ms)
    finally:
      stop_renewal.set()
      if renewal:
        renewal.join(timeout=1)
      if owns_lease.is_set():
        self._release_lease(lock_key, token)

  def _start_background_refresh(self, key: str, policy: CachePolicy, loader: Callable[[], T], use_lease: bool) -> None:
    with self._in_flight_lock:
      if key in self._in_flight:
        return
      future: Future[CacheResult[Any]] = Future()
      self._in_flight[key] = future

    def run() -> None:
      try:
        future.set_result(self._refresh(key, policy, loader, use_lease))
      except Exception as error:
        future.set_exception(error)
      finally:
        with self._in_flight_lock:
          self._in_flight.pop(key, None)

    Thread(target=run, daemon=True).start()

  def get(self, policy: CachePolicy, key: object) -> CacheResult[Any] | None:
    """Return a fresh or usable stale snapshot without invoking a loader."""
    if not self._enabled(policy):
      return None
    cache_key = self._key(policy, key)
    return self._read_local(cache_key, policy) or self._read_redis(cache_key, policy)

  def cooldown_remaining_seconds(self, namespace: str, key: object) -> float:
    cache_key = self._key(CachePolicy(namespace, 1, 1), {"cooldown": key})
    local_deadline = self._cooldowns.get(cache_key, 0)
    remote = self._redis_operation(lambda client: client.get(cache_key))
    try:
      remote_deadline = int(remote) if remote is not None else 0
    except (TypeError, ValueError):
      remote_deadline = 0
    deadline = max(local_deadline, remote_deadline)
    return max(0, (deadline - self._now_ms()) / 1000)

  def set_cooldown(self, namespace: str, key: object, seconds: float) -> None:
    duration_ms = max(1, int(seconds * 1000))
    cache_key = self._key(CachePolicy(namespace, 1, 1), {"cooldown": key})
    deadline = self._now_ms() + duration_ms
    self._cooldowns[cache_key] = max(self._cooldowns.get(cache_key, 0), deadline)
    self._redis_operation(
      lambda client: client.eval(
        "local current=tonumber(redis.call('GET', KEYS[1]) or '0'); if current >= tonumber(ARGV[1]) then return current end; redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]); return tonumber(ARGV[1])",
        1,
        cache_key,
        str(deadline),
        str(duration_ms),
      )
    )

  def get_or_load(self, policy: CachePolicy, key: object, loader: Callable[[], T]) -> CacheResult[T]:
    if not self._enabled(policy):
      return CacheResult(self._load(loader), "miss", self._now_ms())
    cache_key = self._key(policy, key)
    local_entry = None if policy.force_refresh else self._read_local(cache_key, policy)
    if local_entry is not None and local_entry.state == "hit":
      return CacheResult(local_entry.value, "hit", local_entry.computed_at_ms)
    remote_entry = None if policy.force_refresh else self._read_redis(cache_key, policy)
    if remote_entry is not None and remote_entry.state == "hit":
      return CacheResult(remote_entry.value, "hit", remote_entry.computed_at_ms)
    stale_entry = local_entry if local_entry and local_entry.state == "stale" else remote_entry
    use_lease = self._redis() is not None
    if stale_entry is not None:
      self._start_background_refresh(cache_key, policy, loader, use_lease)
      return CacheResult(stale_entry.value, "stale", stale_entry.computed_at_ms)
    with self._in_flight_lock:
      future = self._in_flight.get(cache_key)
      if future is None:
        future = Future()
        self._in_flight[cache_key] = future
        owner = True
      else:
        owner = False
    if not owner:
      self._record(shared=1)
      try:
        result = future.result(timeout=self._load_deadline_seconds)
      except FutureTimeoutError as error:
        raise TimeoutError("Cache shared loader deadline exceeded") from error
      return CacheResult(result.value, "shared", result.computed_at_ms)
    self._record(misses=1)
    try:
      result = self._refresh(cache_key, policy, loader, use_lease)
      future.set_result(result)
      return result
    except Exception as error:
      future.set_exception(error)
      raise
    finally:
      with self._in_flight_lock:
        self._in_flight.pop(cache_key, None)


_default_cache: ServerCache | None = None
_default_cache_lock = Lock()


def get_default_cache() -> ServerCache:
  global _default_cache
  with _default_cache_lock:
    if _default_cache is None:
      _default_cache = ServerCache()
    return _default_cache


def get_or_load(policy: CachePolicy, key: object, loader: Callable[[], T]) -> CacheResult[T]:
  return get_default_cache().get_or_load(policy, key, loader)
