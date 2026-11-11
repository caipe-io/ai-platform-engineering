# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Read meeting occurrence metadata from the Webex SDK conversation APIs."""

import asyncio
import base64
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Literal, Sequence
from urllib.parse import parse_qsl, urljoin, urlsplit

import httpx

U2C_CATALOG_URL = "https://u2c.wbx2.com/u2c/api/v1/catalog"
REQUEST_TIMEOUT = 30.0
DISCOVERY_TIMEOUT = 90.0
MAX_REQUESTS = 240
MAX_CATALOG_PAGES = 20
MAX_CONVERSATIONS = 500
MAX_ACTIVITY_PAGES = 40
ACTIVITY_PAGE_SIZE = 100
ACTIVITY_WORKERS = 4
CONVERSATION_QUEUE_SIZE = 8
MAX_CONTINUATION_LENGTH = 512 * 1024
CONTINUATION_TTL = 24 * 60 * 60
MAX_BOUNDARY_IDS = 2 * ACTIVITY_PAGE_SIZE
_SERIES_ID = re.compile(r"[0-9a-fA-F]{32}")
_ACTUAL_ID = re.compile(r"(?P<series>[0-9a-fA-F]{32})_I_\d+")
_UUID = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
_CONVERSATION_PATH = re.compile(rf"/conversation/api/v1/conversations/{_UUID}")
_CATALOG_PATH = "/conversation/api/v1/conversations"
_BASE_PATH = "/conversation/api/v1"
_SDK_QUERY = {
    "personRefresh": "true",
    "uuidEntryFormat": "true",
    "activitiesLimit": 0,
    "participantsLimit": 0,
}
_CATALOG_QUERY_KEYS = frozenset({
    *_SDK_QUERY, "paginate", "membershipsType", "conversationsLimit", "maxDate",
    "cursor", "ackFilter", "participantAckFilter", "globalId", "includeParticipants",
})


URLKind = Literal["site", "meeting_info", "base", "catalog", "conversation", "activities", "u2c"]


def _validated_url(url: str, kind: URLKind) -> str:
    """Validate the destination, including its resource path, before adding auth."""
    try:
        if len(url) > 4096:
            raise ValueError("Webex discovery URL is too long")
        parts = urlsplit(url)
        port = parts.port
    except ValueError as error:
        raise ValueError("Invalid Webex discovery URL") from error
    host = (parts.hostname or "").lower()
    if (
        parts.scheme != "https" or not host or parts.username is not None
        or parts.password is not None or port not in (None, 443)
        or parts.fragment or "%" in parts.path or "\\" in url
        or not re.fullmatch(r"[a-z0-9.-]+", host)
    ):
        raise ValueError("Invalid Webex discovery URL")
    if kind in ("site", "meeting_info"):
        valid_path = parts.path in ("", "/") if kind == "site" else parts.path == "/wbxappapi/v1/meetingInfo"
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.webex\.com", host) or not valid_path or parts.query:
            raise ValueError("Invalid Webex site URL")
        return f"https://{host}" if kind == "site" else url
    if not (host.endswith(".wbx2.com") or host.endswith(".webex.com")):
        raise ValueError("Untrusted Webex discovery host")
    path = parts.path.rstrip("/")
    valid = {
        "base": path == _BASE_PATH and not parts.query,
        "catalog": path == _CATALOG_PATH,
        "conversation": bool(_CONVERSATION_PATH.fullmatch(path)) and not parts.query,
        "activities": bool(_CONVERSATION_PATH.fullmatch(path.removesuffix("/activities"))) and path.endswith("/activities"),
        "u2c": url == U2C_CATALOG_URL,
    }[kind]
    if not valid:
        raise ValueError("Invalid Webex discovery resource path")
    if kind == "catalog":
        keys = [key for key, _ in parse_qsl(parts.query, keep_blank_values=True)]
        if len(keys) != len(set(keys)) or any(key not in _CATALOG_QUERY_KEYS for key in keys):
            raise ValueError("Invalid Webex catalog continuation query")
    return url.rstrip("/") if not parts.query else url


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else None


def _epoch_ms(value: datetime) -> int:
    return int(value.timestamp() * 1000)


def _last_activity(value: Any) -> datetime | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value <= 0:
            return None
        try:
            return datetime.fromtimestamp(value / 1000, timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    return _timestamp(value)


@dataclass
class _ActivityCursor:
    url: str
    max_date: int
    seen: set[str] = field(default_factory=set)
    done: bool = False


@dataclass
class _Discovery:
    client: httpx.AsyncClient
    bearer: str
    lower: datetime
    upper: datetime
    site_url: str
    meeting_series_id: str | None
    max_results: int
    items: dict[str, dict[str, Any]] = field(default_factory=dict)
    completed: set[str] = field(default_factory=set)
    excluded: set[str] = field(default_factory=set)
    warnings: list[str] = field(default_factory=list)
    next_catalog_urls: list[str] = field(default_factory=list)
    catalog_frontier: list[str] | None = None
    pending_activities: dict[str, _ActivityCursor] = field(default_factory=dict)
    seen_conversations: set[str] = field(default_factory=set)
    series_lookup_pending: bool = False
    semaphore: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(4))
    requests: int = 0
    stopped: bool = False

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    async def request(
        self, url: str, kind: URLKind,
        stage: str, *, params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], httpx.Response] | None:
        try:
            _validated_url(url, kind)
        except ValueError:
            self.warn(f"{stage}: rejected an untrusted discovery URL.")
            return None
        async with self.semaphore:
            if self.stopped:
                return None
            if self.requests >= MAX_REQUESTS:
                self.stopped = True
                self.warn("Discovery request limit reached; results are incomplete.")
                return None
            self.requests += 1
            try:
                response = await self.client.request(
                    "POST" if body is not None else "GET", url,
                    headers={"Authorization": self.bearer, "Accept": "application/json"},
                    params=params, json=body, timeout=REQUEST_TIMEOUT, follow_redirects=False,
                )
            except httpx.HTTPError:
                self.warn(f"{stage}: Webex request failed; results are incomplete.")
                return None
        if response.status_code != 200:
            self.warn(f"{stage}: Webex returned HTTP {response.status_code}; results are incomplete.")
            return None
        try:
            payload = response.json()
        except ValueError:
            self.warn(f"{stage}: Webex returned an invalid response; results are incomplete.")
            return None
        if not isinstance(payload, dict):
            self.warn(f"{stage}: Webex returned an invalid response; results are incomplete.")
            return None
        return payload, response

    def add_activity(self, activity: dict[str, Any]) -> bool:
        obj = activity.get("object")
        if not isinstance(obj, dict):
            return True
        is_summary = activity.get("verb") == "update" and obj.get("objectType") == "locusSessionSummary"
        is_share = activity.get("verb") == "share" and obj.get("objectType") == "meetingContainer"
        if not (is_summary or is_share):
            return True
        actual = obj.get("meetingInstanceId")
        match = _ACTUAL_ID.fullmatch(actual) if isinstance(actual, str) else None
        if match is None:
            return True
        series = match.group("series")
        if self.meeting_series_id and series.lower() != self.meeting_series_id.lower():
            return True
        start = _timestamp(obj.get("startTime") if is_summary else obj.get("published"))
        if start is None:
            return True
        if not self.lower <= start < self.upper:
            if is_summary:
                self.excluded.add(actual)
                self.items.pop(actual, None)
            return True
        if actual in self.excluded or (not is_summary and actual in self.completed):
            return True
        item: dict[str, Any] = {
            "id": actual, "meetingSeriesId": series, "meetingType": "meeting",
            "start": start.isoformat(), "source": "space_activity", "siteUrl": self.site_url,
        }
        if is_summary:
            end = _timestamp(activity.get("published"))
            if end is not None and end >= start:
                item.update(end=end.isoformat(), state="ended")
            self.completed.add(actual)
        if actual not in self.items and len(self.items) >= self.max_results:
            self.stopped = True
            return False
        self.items[actual] = item
        return True

    def queue_activity(self, conversation_url: str) -> None:
        try:
            conversation_url = _validated_url(conversation_url, "conversation")
        except ValueError:
            self.warn("Activities: rejected an untrusted conversation URL.")
            return
        if conversation_url in self.seen_conversations:
            return
        self.seen_conversations.add(conversation_url)
        self.pending_activities[conversation_url] = _ActivityCursor(
            conversation_url, _epoch_ms(min(datetime.now(timezone.utc), self.upper + timedelta(days=1))),
        )

    async def activities(self, state: _ActivityCursor) -> None:
        conversation_url = state.url
        try:
            conversation_url = _validated_url(conversation_url, "conversation")
        except ValueError:
            self.warn("Activities: rejected an untrusted conversation URL.")
            return
        # Session completion may be published after the requested start-time window.
        lower_ms = _epoch_ms(self.lower)
        for _ in range(MAX_ACTIVITY_PAGES):
            result = await self.request(
                f"{conversation_url}/activities", "activities", "Activities",
                params={**_SDK_QUERY, "limit": ACTIVITY_PAGE_SIZE, "includeChildren": "true", "maxDate": state.max_date},
            )
            if result is None:
                return
            payload, _ = result
            rows = payload.get("items")
            if not isinstance(rows, list):
                self.warn("Activities: missing activity list; results are incomplete.")
                return
            if not rows:
                state.done = True
                return
            dates: list[int] = []
            new_ids: set[str] = set()
            reached_creation = False
            for row in rows:
                if self.stopped:
                    return
                if not isinstance(row, dict):
                    continue
                published = _timestamp(row.get("published"))
                if published is not None:
                    dates.append(_epoch_ms(published))
                activity_id = row.get("id")
                if isinstance(activity_id, str) and activity_id not in state.seen:
                    if not self.add_activity(row):
                        return
                    new_ids.add(activity_id)
                    # Commit progress only after the row was handled. On a
                    # result cap the rejected row is retried by the next call.
                    state.seen.add(activity_id)
                reached_creation |= row.get("verb") == "create" and isinstance(row.get("object"), dict) and row["object"].get("objectType") == "conversation"
            if self.stopped or reached_creation:
                state.done = reached_creation and not self.stopped
                return
            if not dates:
                self.warn("Activities: no usable pagination dates; results are incomplete.")
                return
            oldest = min(dates)
            if oldest < lower_ms:
                state.done = True
                return
            if oldest > state.max_date or (oldest == state.max_date and not new_ids and len(rows) >= ACTIVITY_PAGE_SIZE):
                self.warn("Activities: pagination did not advance; results are incomplete.")
                return
            # Retain the boundary millisecond so tied activity timestamps are not skipped.
            # An underfilled page contains every row at its oldest timestamp.
            next_date = oldest - 1 if len(rows) < ACTIVITY_PAGE_SIZE else oldest
            if next_date != state.max_date:
                state.seen = {
                    row["id"] for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)
                    and (published := _timestamp(row.get("published"))) is not None
                    and _epoch_ms(published) == next_date
                }
            state.max_date = next_date
        self.warn("Activity page limit reached; results are incomplete.")


def _conversation_bases(payload: dict[str, Any]) -> list[str]:
    """Use the SDK catalog's selected conversation service, not unrelated hosts."""
    links = payload.get("serviceLinks")
    value = links.get("conversation") if isinstance(links, dict) else None
    if not isinstance(value, str):
        return []
    try:
        return [_validated_url(value, "base")]
    except ValueError:
        return []


async def _catalog(discovery: _Discovery, page_limit: int) -> AsyncIterator[str]:
    if discovery.catalog_frontier is None:
        result = await discovery.request(U2C_CATALOG_URL, "u2c", "Service catalog", params={"format": "hostmap"})
        if result is None:
            return
        bases = _conversation_bases(result[0])
        if not bases:
            discovery.warn("Service catalog: no conversation service was returned; results are incomplete.")
            return
        discovery.catalog_frontier = [f"{base}/conversations" for base in bases]
    pending = discovery.catalog_frontier
    visited: set[str] = set()
    while pending and not discovery.stopped:
        if len(visited) >= page_limit or len(discovery.seen_conversations) >= MAX_CONVERSATIONS:
            if len(discovery.seen_conversations) >= MAX_CONVERSATIONS:
                discovery.warn("Conversation limit reached; results are incomplete.")
            elif page_limit == MAX_CATALOG_PAGES:
                discovery.warn("Conversation page limit reached; results are incomplete.")
            break
        # Keep the in-flight page in the frontier until its rows and successors
        # have been captured. Cancellation before that point safely retries it.
        url = pending[0]
        if url in visited:
            discovery.warn("Conversation catalog: pagination repeated; results are incomplete.")
            pending.pop(0)
            continue
        visited.add(url)
        result = await discovery.request(
            url, "catalog", "Conversation catalog",
            params=None if urlsplit(url).query else {**_SDK_QUERY, "paginate": "true", "membershipsType": "memberships"},
        )
        if result is None:
            return
        payload, response = result
        rows = payload.get("items")
        if not isinstance(rows, list):
            discovery.warn("Conversation catalog: missing conversation list; results are incomplete.")
            return
        earliest = datetime.min.replace(tzinfo=timezone.utc)
        rows = sorted(
            (row for row in rows if isinstance(row, dict)),
            key=lambda row: _last_activity(row.get("lastReadableActivityDate")) or earliest,
            reverse=True,
        )
        new_urls: list[str] = []
        for row in rows:
            if "ONE_ON_ONE" in (row.get("tags") or []):
                continue
            last_activity = _last_activity(row.get("lastReadableActivityDate"))
            if last_activity is not None and last_activity < discovery.lower:
                continue
            conversation_url = row.get("url")
            if not isinstance(conversation_url, str):
                continue
            try:
                conversation_url = _validated_url(conversation_url, "conversation")
            except ValueError:
                discovery.warn("Conversation catalog: rejected an untrusted conversation URL.")
                continue
            if conversation_url not in discovery.seen_conversations:
                if len(discovery.pending_activities) >= MAX_CONVERSATIONS:
                    raise ValueError("Conversation continuation exceeds its bounded work limit.")
                discovery.queue_activity(conversation_url)
                new_urls.append(conversation_url)
        # Record all rows and the next-page frontier before yielding to a worker.
        # Queued, in-flight and not-yet-queued rows therefore survive cancellation.
        pending.pop(0)
        next_url = response.links.get("next", {}).get("url")
        if isinstance(next_url, str):
            try:
                next_url = _validated_url(urljoin(url, next_url), "catalog")
            except ValueError:
                discovery.warn("Conversation catalog: rejected an untrusted pagination URL.")
            else:
                if next_url in visited:
                    discovery.warn("Conversation catalog: pagination repeated; results are incomplete.")
                elif next_url not in pending:
                    pending.append(next_url)
        for base in payload.get("additionalUrls", []) if isinstance(payload.get("additionalUrls"), list) else []:
            if not isinstance(base, str):
                continue
            try:
                additional = f"{_validated_url(base, 'base')}/conversations"
            except ValueError:
                discovery.warn("Conversation catalog: rejected an untrusted federation URL.")
                continue
            if additional not in visited and additional not in pending:
                pending.append(additional)
        if len(pending) > 20:
            raise ValueError("Conversation continuation exceeds its bounded federation limit.")
        for conversation_url in new_urls:
            if discovery.stopped:
                break
            yield conversation_url


def _query_binding(discovery: _Discovery) -> dict[str, Any]:
    return {
        "from": discovery.lower.isoformat(), "to": discovery.upper.isoformat(),
        "site": discovery.site_url, "series": discovery.meeting_series_id,
    }


def _encode_continuation(discovery: _Discovery) -> str | None:
    work = [state for state in discovery.pending_activities.values() if not state.done]
    if discovery.catalog_frontier == [] and not work and not discovery.series_lookup_pending:
        return None
    if len(work) > MAX_CONVERSATIONS or any(len(state.seen) > MAX_BOUNDARY_IDS for state in work):
        raise ValueError("Meeting discovery continuation exceeds its bounded work limit.")
    value = {
        "v": 1, "expires": int(time.time()) + CONTINUATION_TTL, **_query_binding(discovery),
        "catalog": discovery.catalog_frontier, "series_lookup": discovery.series_lookup_pending,
        "activities": [{"url": state.url, "max_date": state.max_date, "seen": sorted(state.seen)} for state in work],
    }
    encoded = base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
    if len(encoded) > MAX_CONTINUATION_LENGTH:
        raise ValueError("Meeting discovery continuation exceeds the 512 KiB limit; narrow the date range.")
    return encoded


def _restore_continuation(discovery: _Discovery, token: str) -> None:
    try:
        if not isinstance(token, str) or not token or len(token) > MAX_CONTINUATION_LENGTH or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
            raise ValueError()
        value = json.loads(base64.b64decode(token + "=" * (-len(token) % 4), altchars=b"-_", validate=True))
        if not isinstance(value, dict) or set(value) != {"v", "expires", "from", "to", "site", "series", "catalog", "series_lookup", "activities"}:
            raise ValueError()
        if type(value["v"]) is not int or value["v"] != 1 or type(value["expires"]) is not int or not time.time() < value["expires"] <= time.time() + CONTINUATION_TTL + 1:
            raise ValueError()
        if any(value[key] != expected for key, expected in _query_binding(discovery).items()):
            raise ValueError()
        frontier, work, series_lookup = value["catalog"], value["activities"], value["series_lookup"]
        if frontier is not None and (not isinstance(frontier, list) or len(frontier) > 20 or any(not isinstance(url, str) for url in frontier)):
            raise ValueError()
        if not isinstance(work, list) or len(work) > MAX_CONVERSATIONS or type(series_lookup) is not bool:
            raise ValueError()
        if discovery.meeting_series_id and frontier != [] or series_lookup and not discovery.meeting_series_id:
            raise ValueError()
        frontier = [_validated_url(url, "catalog") for url in frontier] if frontier is not None else None
        restored: dict[str, _ActivityCursor] = {}
        for row in work:
            if not isinstance(row, dict) or set(row) != {"url", "max_date", "seen"}:
                raise ValueError()
            url = _validated_url(row["url"], "conversation")
            cursor, seen = row["max_date"], row["seen"]
            if type(cursor) is not int or not _epoch_ms(discovery.lower) - 1 <= cursor <= _epoch_ms(discovery.upper + timedelta(days=1)):
                raise ValueError()
            if not isinstance(seen, list) or len(seen) > MAX_BOUNDARY_IDS or any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", item) for item in seen):
                raise ValueError()
            if url in restored:
                raise ValueError()
            restored[url] = _ActivityCursor(url, cursor, set(seen))
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError) as error:
        raise ValueError("Invalid, expired or mismatched meeting discovery continuation.") from error
    discovery.catalog_frontier = frontier
    discovery.pending_activities = restored
    discovery.seen_conversations = set(restored)
    discovery.series_lookup_pending = series_lookup


async def list_space_meeting_occurrences(
    client: httpx.AsyncClient, bearer: str, from_dt: datetime, to_dt: datetime,
    site_url: str, meeting_series_id: str | None = None, max_results: int = 200,
    *, conversation_urls: Sequence[str] | None = None,
    catalog_urls: Sequence[str] | None = None, catalog_page_limit: int = MAX_CATALOG_PAGES,
    continuation: str | None = None,
) -> dict[str, Any]:
    """Enumerate actual occurrences without returning chat or participant content.

    Supplying a series resolves its space from meetingInfo and filters exact actual
    ID prefixes. Without a series, the SDK conversation catalog supplies spaces.
    """
    if from_dt.tzinfo is None or to_dt.tzinfo is None or from_dt >= to_dt:
        raise ValueError("Discovery requires increasing timezone-aware date bounds")
    if to_dt - from_dt > timedelta(days=365):
        raise ValueError("Discovery date range cannot exceed 365 days")
    if meeting_series_id is not None and _SERIES_ID.fullmatch(meeting_series_id) is None:
        raise ValueError("A valid meeting series ID is required")
    if not 1 <= max_results <= 1000:
        raise ValueError("max_results must be between 1 and 1000")
    if not 1 <= catalog_page_limit <= 20:
        raise ValueError("catalog_page_limit must be between 1 and 20")
    if catalog_urls is not None:
        if len(catalog_urls) > 20 or meeting_series_id is not None or conversation_urls is not None:
            raise ValueError("Catalog continuations require at most 20 URLs and an unscoped catalog lookup")
        catalog_urls = [_validated_url(url, "catalog") for url in catalog_urls]
    if continuation is not None and (catalog_urls is not None or conversation_urls is not None):
        raise ValueError("Use one continuation format at a time.")
    site_url = _validated_url(site_url if "://" in site_url else f"https://{site_url}", "site")
    discovery = _Discovery(
        client, bearer, from_dt.astimezone(timezone.utc), to_dt.astimezone(timezone.utc),
        site_url, meeting_series_id, max_results,
    )
    discovery.catalog_frontier = list(dict.fromkeys(catalog_urls)) if catalog_urls is not None else (
        [] if meeting_series_id or conversation_urls is not None else None
    )
    discovery.series_lookup_pending = meeting_series_id is not None and conversation_urls is None
    if continuation is not None:
        _restore_continuation(discovery, continuation)
    elif conversation_urls is not None:
        if len(conversation_urls) > MAX_CONVERSATIONS:
            raise ValueError("Too many conversation URLs.")
        for conversation_url in conversation_urls:
            discovery.queue_activity(conversation_url)
    queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=CONVERSATION_QUEUE_SIZE)

    async def produce() -> None:
        if discovery.series_lookup_pending:
            # The meetingInfo route is a metadata lookup, not meeting registration.
            result = await discovery.request(
                f"{site_url}/wbxappapi/v1/meetingInfo", "meeting_info", "Meeting space", body={
                    "supportHostKey": False, "supportCountryList": False,
                    "meetingUUID": meeting_series_id, "disableWebRedirect": True,
                },
            )
            if result is not None:
                conversation_url = result[0].get("conversationUrl")
                if isinstance(conversation_url, str):
                    discovery.queue_activity(conversation_url)
                    discovery.series_lookup_pending = False
                else:
                    discovery.warn("Meeting space: no conversation URL was returned; results are incomplete.")
        for conversation_url in list(discovery.pending_activities):
            if discovery.stopped:
                break
            await queue.put(conversation_url)
        if discovery.catalog_frontier != []:
            async for conversation_url in _catalog(discovery, min(catalog_page_limit, MAX_CATALOG_PAGES)):
                await queue.put(conversation_url)
        # Only publish EOF after normal producer completion. Cancellation must
        # not wait on a full queue whose consumers have also been cancelled.
        for _ in range(ACTIVITY_WORKERS):
            await queue.put(None)

    async def consume() -> None:
        while True:
            conversation_url = await queue.get()
            try:
                if conversation_url is None:
                    return
                if not discovery.stopped:
                    state = discovery.pending_activities[conversation_url]
                    await discovery.activities(state)
                    if state.done:
                        discovery.pending_activities.pop(conversation_url)
            finally:
                queue.task_done()

    try:
        async with asyncio.timeout(DISCOVERY_TIMEOUT):
            async with asyncio.TaskGroup() as tasks:
                for _ in range(ACTIVITY_WORKERS):
                    tasks.create_task(consume())
                tasks.create_task(produce())
    except TimeoutError:
        discovery.warn("Discovery time limit reached; results are incomplete.")
    except ExceptionGroup as error:
        if all(isinstance(item, ValueError) for item in error.exceptions):
            raise ValueError(str(error.exceptions[0])) from error
        raise
    discovery.next_catalog_urls = discovery.catalog_frontier or []
    next_continuation = _encode_continuation(discovery)
    items = sorted(discovery.items.values(), key=lambda item: (item["start"], item["id"]), reverse=True)
    return {
        "items": items, "complete": not discovery.warnings, "warnings": discovery.warnings,
        "next_catalog_urls": discovery.next_catalog_urls, "has_more": next_continuation is not None,
        "next_continuation": next_continuation,
    }
