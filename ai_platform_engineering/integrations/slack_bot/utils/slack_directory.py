"""Provider-owned Slack directories for authenticated BFF picker requests."""

from __future__ import annotations

import hashlib
import logging
import math
import os
import re
import threading
import time
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from dataclasses import dataclass, field
from typing import Any, Callable

import requests
from pymongo.errors import PyMongoError

logger = logging.getLogger(__name__)
DIRECTORY_SCOPE = "slack:directory:read"
DIRECTORY_TTL_SECONDS = 24 * 60 * 60
CHANNEL_WAIT_SECONDS = 2.0
STANDARD_EMOJI = """eyes eye eye_speech_bubble white_check_mark x warning rotating_light fire rocket wave
raised_hands pray thumbsup +1 thumbsdown -1 clap heart blue_heart green_heart yellow_heart purple_heart
red_circle large_green_circle large_yellow_circle information_source question grey_question heavy_check_mark
heavy_multiplication_x bell mega loudspeaker memo pushpin paperclip link hourglass_flowing_sand stopwatch
construction hammer_and_wrench wrench gear bug lock unlock shield robot_face technologist male-technologist
female-technologist see_no_evil hear_no_evil speak_no_evil thinking_face face_with_monocle slightly_smiling_face
neutral_face confused sob tada sparkles""".split()


class SlackDirectoryError(RuntimeError):
  def __init__(self, message: str, status: int = 502, retry_after: int | None = None) -> None:
    super().__init__(message)
    self.status = status
    self.retry_after = retry_after


@dataclass
class DirectoryProgress:
  pages_scanned: int = 0
  members_seen: int = 0
  active_seen: int = 0
  updated_at: int = 0


@dataclass
class DirectorySnapshot:
  rows: list[dict[str, Any]] = field(default_factory=list)
  fetched_at: int = 0
  started_at: int = 0
  updated_at: int = 0
  refreshing: bool = False
  last_error: str | None = None
  pages_scanned: int = 0
  members_seen: int = 0
  active_seen: int = 0
  progress: DirectoryProgress | None = None


def _now_ms() -> int:
  return int(time.time() * 1000)


def _limit(params: dict[str, str], default: int, maximum: int) -> int:
  try:
    value = int(params.get("limit", ""))
  except ValueError:
    return default
  return min(value, maximum) if value > 0 else default


def _fuzzy_score(value: str, query: str) -> float:
  value = value.lower()
  if not value or not query:
    return math.inf
  if value == query:
    return 0
  if value.startswith(query):
    return 10 + len(value) - len(query)
  word = re.search(r"(^|[\s._+\-])" + re.escape(query), value)
  if word:
    return 20 + word.start()
  index = value.find(query)
  if index >= 0:
    return 40 + index
  previous = -1
  gap = 0
  for char in query:
    index = value.find(char, previous + 1)
    if index < 0:
      return math.inf
    gap += index - previous - 1
    previous = index
  return 80 + gap + len(value) - len(query)


def _user_score(user: dict[str, Any], query: str) -> float:
  terms = user["search_terms"]
  score = min(*(_fuzzy_score(term, query) for term in terms), _fuzzy_score(" ".join(terms), query))
  if math.isfinite(score):
    return score
  parts = query.split()
  scores = [min(_fuzzy_score(term, part) for term in terms) for part in parts]
  return 60 + sum(scores) if len(parts) > 1 and all(map(math.isfinite, scores)) else math.inf


def _normalize_user(user: dict[str, Any]) -> dict[str, Any] | None:
  if not user.get("id") or user.get("deleted"):
    return None
  profile = user.get("profile") or {}
  display = profile.get("display_name_normalized") or profile.get("display_name")
  real = profile.get("real_name_normalized") or profile.get("real_name") or user.get("real_name")
  name = user.get("name")
  label = display or real or name or user["id"]
  row: dict[str, Any] = {"id": user["id"], "label": label, "is_bot": bool(user.get("is_bot") or user.get("is_app_user"))}
  for key, value in {"name": name, "display_name": display, "real_name": real, "avatar": profile.get("image_32") or profile.get("image_24")}.items():
    if value:
      row[key] = value
  if any("workflow" in str(term).lower() for term in (name, label, display, real, profile.get("title")) if term):
    row["is_workflow"] = True
  row["search_terms"] = list(
    dict.fromkeys(
      str(value).strip()
      for value in (
        user["id"],
        user.get("team_id"),
        name,
        label,
        display,
        real,
        " ".join(filter(None, (profile.get("first_name"), profile.get("last_name")))),
        profile.get("first_name"),
        profile.get("last_name"),
        profile.get("title"),
        profile.get("email"),
      )
      if value and str(value).strip()
    )
  )
  return row


class SlackDirectoryService:
  """Share complete snapshots across handler threads; refresh independently of HTTP requests."""

  def __init__(self, *, request_get: Callable[..., Any] = requests.get, collection_factory: Callable[..., Any] | None = None) -> None:
    self._request_get = request_get
    self._collection_factory = collection_factory
    self._lock = threading.RLock()
    self._channel_lock = threading.Lock()
    self._channel_refreshes: dict[tuple[str, str], Future[DirectorySnapshot]] = {}
    self._entries: dict[tuple[str, str], DirectorySnapshot] = {}
    self._cooldowns: dict[tuple[str, str], float] = {}
    self._ttl_memo: tuple[float, float] | None = None

  def _token(self) -> str:
    token = (os.environ.get("SLACK_INTEGRATION_BOT_TOKEN") or os.environ.get("SLACK_BOT_TOKEN") or "").strip()
    if not token:
      raise SlackDirectoryError("Slack bot credentials are not configured on the bot service", 503)
    return token

  def _key(self, kind: str, token: str) -> tuple[str, str]:
    workspace = os.environ.get("SLACK_WORKSPACE_ALIAS", "")
    return kind, hashlib.sha256(f"{workspace}:{token}".encode()).hexdigest()

  def _call(self, token: str, method: str, params: dict[str, str]) -> dict[str, Any]:
    key = (hashlib.sha256(token.encode()).hexdigest(), method)
    for attempt in range(4):
      with self._lock:
        remaining = self._cooldowns.get(key, 0) - time.time()
      if remaining > 0:
        time.sleep(remaining)
      try:
        response = self._request_get(f"https://slack.com/api/{method}", params=params, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        if response.status_code == 429:
          try:
            delay = max(float(response.headers.get("Retry-After", "1")), 1)
            if not math.isfinite(delay):
              delay = 1
          except TypeError, ValueError:
            delay = 1
          with self._lock:
            self._cooldowns[key] = time.time() + delay
          if attempt < 3:
            continue
          raise SlackDirectoryError(f"Slack API rate limited {method}", 429)
        response.raise_for_status()
        payload = response.json()
      except (requests.RequestException, ValueError) as exc:
        logger.warning("Slack directory request failed: method=%s exception=%s", method, type(exc).__name__)
        raise SlackDirectoryError(f"Slack directory request failed ({method})") from exc
      if not isinstance(payload, dict):
        raise SlackDirectoryError(f"Slack returned invalid data ({method})")
      if payload.get("ok") is not True:
        if method == "users.lookupByEmail" and payload.get("error") == "users_not_found":
          return {"ok": True}
        raise SlackDirectoryError(f"Slack API error: {payload.get('error', 'unknown')}")
      return payload
    raise SlackDirectoryError("Slack request exhausted retries", 429)

  def _load_users(self, token: str, entry: DirectoryProgress) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    cursor = ""
    for page in range(500):
      data = self._call(token, "users.list", {"limit": "200", "cursor": cursor})
      members = data.get("members") or []
      for member in members:
        row = _normalize_user(member)
        if row:
          rows[row["id"]] = row
      with self._lock:
        entry.pages_scanned = page + 1
        entry.members_seen += len(members)
        entry.active_seen = len(rows)
        entry.updated_at = _now_ms()
      cursor = (data.get("response_metadata") or {}).get("next_cursor", "")
      if not cursor:
        return sorted(rows.values(), key=lambda row: row["label"].casefold())
    raise SlackDirectoryError("Slack user directory exceeded the page limit; previous complete snapshot retained")

  def _load_emoji(self, token: str, _entry: DirectoryProgress) -> list[dict[str, Any]]:
    data = self._call(token, "emoji.list", {"include_categories": "true"})
    rows = {name: {"name": name} for name in STANDARD_EMOJI}
    for category in data.get("categories") or []:
      for name in [*(category.get("emoji_names") or []), *(category.get("emojis") or [])]:
        if name:
          rows.setdefault(name, {"name": name})
    for name, value in (data.get("emoji") or {}).items():
      if not isinstance(value, str):
        raise SlackDirectoryError("Slack returned an invalid emoji value; previous complete snapshot retained")
      rows[name] = {"name": name, **({"alias_for": value[6:]} if value.startswith("alias:") else {"url": value})}
    return sorted(rows.values(), key=lambda row: row["name"].casefold())

  def _refresh(self, kind: str, token: str, *, force: bool = False) -> DirectorySnapshot:
    key = self._key(kind, token)
    with self._lock:
      entry = self._entries.setdefault(key, DirectorySnapshot())
      if entry.refreshing or (not force and entry.last_error and _now_ms() - entry.updated_at < 30_000) or (not force and entry.fetched_at and _now_ms() - entry.fetched_at < DIRECTORY_TTL_SECONDS * 1000):
        return entry
      entry.refreshing = True
      entry.started_at = entry.updated_at = _now_ms()
      progress = DirectoryProgress(updated_at=entry.started_at)
      entry.progress = progress

    def run() -> None:
      try:
        loader = self._load_users if kind == "users" else self._load_emoji
        rows = loader(token, progress)
        with self._lock:
          entry.rows = rows
          entry.fetched_at = entry.updated_at = _now_ms()
          entry.last_error = None
          entry.pages_scanned = progress.pages_scanned
          entry.members_seen = progress.members_seen
          entry.active_seen = len(rows)
      except (SlackDirectoryError, requests.RequestException) as exc:
        logger.warning("Slack directory refresh failed: kind=%s error=%s", kind, exc)
        with self._lock:
          entry.last_error = str(exc)
          entry.updated_at = _now_ms()
      finally:
        with self._lock:
          entry.refreshing = False
          entry.progress = None

    threading.Thread(target=run, daemon=True, name=f"slack-directory-{kind}").start()
    return entry

  def _lookup(self, kind: str, params: dict[str, str]) -> dict[str, Any]:
    token = self._token()
    q = params.get("q", "").strip()
    if kind == "emoji":
      q = q.strip(":").lower()
    limit = _limit(params, 50 if kind == "users" else 25, 100 if kind == "users" else 50)
    bot_kind = "bots" if params.get("kind") == "bots" else "all"
    query: dict[str, Any] = {"q": q, "limit": limit}
    if kind == "users":
      query["kind"] = bot_kind
      if not q:
        return {"users": [], "cached": False, "fetched_at": _now_ms(), "query": query}
      query["mode"] = "email" if re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", q) else "list"
      if query["mode"] == "email":
        user = self._call(token, "users.lookupByEmail", {"email": q}).get("user")
        row = _normalize_user(user) if user else None
        rows = [row] if row and (bot_kind != "bots" or row.get("is_bot") or row.get("is_workflow")) else []
        return {"users": [{k: v for k, v in row.items() if k != "search_terms"} for row in rows], "cached": False, "fetched_at": _now_ms(), "query": query}
    entry = self._refresh(kind, token, force=params.get("refresh") == "1")
    with self._lock:
      rows = entry.rows
      fetched_at = entry.fetched_at
      error = entry.last_error
      refreshing = entry.refreshing
    if not fetched_at:
      return {kind: [], "total_matches": 0, "total_visible": 0, "cached": False, "warming": True, "fetched_at": 0, "error": error, "query": query}
    if kind == "users" and bot_kind == "bots":
      rows = [row for row in rows if row.get("is_bot") or row.get("is_workflow")]
    total = len(rows)
    if q:
      scored = [(row, _user_score(row, q.lower()) if kind == "users" else min(_fuzzy_score(row["name"], q), _fuzzy_score(row.get("alias_for", ""), q))) for row in rows]
      rows = [row for row, _score in sorted((pair for pair in scored if math.isfinite(pair[1])), key=lambda pair: (pair[1], pair[0].get("label", pair[0].get("name", "")).casefold()))]
    public = [{k: v for k, v in row.items() if k != "search_terms"} for row in rows[:limit]]
    return {kind: public, "total_matches": len(rows), "total_visible": total, "cached": True, "refreshing": refreshing, "fetched_at": fetched_at, "query": query}

  def users(self, params: dict[str, str]) -> dict[str, Any]:
    return self._lookup("users", params)

  def emoji(self, params: dict[str, str]) -> dict[str, Any]:
    return self._lookup("emoji", params)

  def status(self) -> dict[str, Any]:
    try:
      token = self._token()
    except SlackDirectoryError as exc:
      return {"configured": False, "bot_admin": {"reachable": True}, "users": self._status("users", DirectorySnapshot(last_error=str(exc))), "emoji": self._status("emoji", DirectorySnapshot(last_error=str(exc)))}
    entries = {kind: self._refresh(kind, token) for kind in ("users", "emoji")}
    with self._lock:
      return {"configured": True, "bot_admin": {"reachable": True}, **{kind: self._status(kind, entry) for kind, entry in entries.items()}}

  def _status(self, kind: str, entry: DirectorySnapshot) -> dict[str, Any]:
    fresh = bool(entry.fetched_at and _now_ms() - entry.fetched_at < DIRECTORY_TTL_SECONDS * 1000)
    result = {
      "status": "warming" if entry.refreshing else "ready" if fresh else "stale" if entry.fetched_at else "empty",
      f"{kind}_indexed": len(entry.rows),
      "fetched_at": entry.fetched_at or None,
      "updated_at": entry.updated_at or None,
      "started_at": entry.started_at or None,
      "ttl_seconds": DIRECTORY_TTL_SECONDS,
      "last_error": entry.last_error,
    }
    if kind == "users":
      result.update(active_users_indexed=len(entry.rows), pages_scanned=entry.pages_scanned, members_seen=entry.members_seen)
      if entry.progress:
        result["refresh_progress"] = {"pages_scanned": entry.progress.pages_scanned, "members_seen": entry.progress.members_seen, "active_seen": entry.progress.active_seen}
    return result

  def _channel_ttl(self) -> float:
    if self._ttl_memo and time.time() - self._ttl_memo[0] < 30:
      return self._ttl_memo[1]
    raw: Any = None
    try:
      collection = self._collection_factory("platform_config") if self._collection_factory else None
      if collection is not None:
        raw = (collection.find_one({"_id": "platform_settings"}) or {}).get("slack_discovery_cache_ttl_minutes")
    except PyMongoError:
      logger.warning("Slack discovery TTL database unavailable; using environment/default")
    for candidate in (raw, os.environ.get("SLACK_DISCOVERY_CACHE_TTL_MINUTES"), 60):
      try:
        minutes = float(candidate) if candidate is not None and candidate != "" else -1
        if math.isfinite(minutes) and minutes >= 0:
          seconds = min(math.floor(minutes), 1440) * 60
          self._ttl_memo = time.time(), seconds
          return seconds
      except TypeError, ValueError:
        continue
    return 3600

  def channels(self, params: dict[str, str]) -> dict[str, Any]:
    token = self._token()
    key = self._key("channels", token)
    ttl = self._channel_ttl()
    with self._channel_lock:
      entry = self._entries.get(key)
      hit = bool(params.get("refresh") != "1" and ttl > 0 and entry and _now_ms() - entry.fetched_at < ttl * 1000)
      if not hit:
        pending = self._channel_refreshes.get(key)
        if pending is None:
          pending = Future()
          self._channel_refreshes[key] = pending
          threading.Thread(target=self._refresh_channels, args=(key, token, ttl, pending), daemon=True, name="slack-directory-channels").start()
    if not hit:
      try:
        entry = pending.result(timeout=CHANNEL_WAIT_SECONDS)
      except FutureTimeoutError as exc:
        raise SlackDirectoryError("Slack channel directory refresh is still in progress", 503, retry_after=1) from exc
    assert entry is not None
    q = params.get("q", "").strip().lower()
    cursor = params.get("cursor", "")
    limit = _limit(params, 200, 500)
    filtered = [row for row in entry.rows if q in row["name"].lower()]
    after = [row for row in filtered if not cursor or row["name"].casefold() > cursor.casefold()]
    page = after[:limit]
    more = len(after) > limit
    return {
      "channels": page,
      "total_matches": len(filtered),
      "total_visible": len(entry.rows),
      "next_cursor": page[-1]["name"] if more else None,
      "has_more": more,
      "cached": hit,
      "fetched_at": entry.fetched_at,
      "scope": "member_only",
      "endpoint": "users.conversations",
      "query": {"q": q, "member_only": True, "limit": limit},
    }

  def _refresh_channels(self, key: tuple[str, str], token: str, ttl: float, pending: Future[DirectorySnapshot]) -> None:
    try:
      rows: dict[str, dict[str, Any]] = {}
      cursor = ""
      for _page in range(50):
        data = self._call(token, "users.conversations", {"limit": "200", "exclude_archived": "true", "types": "public_channel,private_channel", "cursor": cursor})
        for row in data.get("channels") or []:
          if row.get("is_archived") or row.get("is_member") is False:
            continue
          rows[row["id"]] = {"id": row["id"], "name": row.get("name") or row["id"], "is_private": bool(row.get("is_private")), "is_member": True, "num_members": row.get("num_members", 0)}
        cursor = (data.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
          break
      if cursor:
        raise SlackDirectoryError("Slack channel directory exceeded the page limit; previous complete snapshot retained")
      entry = DirectorySnapshot(rows=sorted(rows.values(), key=lambda row: row["name"].casefold()), fetched_at=_now_ms())
      with self._channel_lock:
        if ttl > 0:
          self._entries[key] = entry
        else:
          self._entries.pop(key, None)
        pending.set_result(entry)
        del self._channel_refreshes[key]
    except Exception as exc:
      with self._channel_lock:
        pending.set_exception(exc)
        if self._channel_refreshes.get(key) is pending:
          del self._channel_refreshes[key]
