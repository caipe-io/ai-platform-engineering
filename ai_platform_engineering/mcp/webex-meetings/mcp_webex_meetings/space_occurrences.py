# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Read meeting occurrence metadata from the Webex SDK conversation APIs."""

import asyncio
import re
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

    def add_activity(self, activity: dict[str, Any]) -> None:
        obj = activity.get("object")
        if not isinstance(obj, dict):
            return
        is_summary = activity.get("verb") == "update" and obj.get("objectType") == "locusSessionSummary"
        is_share = activity.get("verb") == "share" and obj.get("objectType") == "meetingContainer"
        if not (is_summary or is_share):
            return
        actual = obj.get("meetingInstanceId")
        match = _ACTUAL_ID.fullmatch(actual) if isinstance(actual, str) else None
        if match is None:
            return
        series = match.group("series")
        if self.meeting_series_id and series.lower() != self.meeting_series_id.lower():
            return
        start = _timestamp(obj.get("startTime") if is_summary else obj.get("published"))
        if start is None:
            return
        if not self.lower <= start < self.upper:
            if is_summary:
                self.excluded.add(actual)
                self.items.pop(actual, None)
            return
        if actual in self.excluded or (not is_summary and actual in self.completed):
            return
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
            self.warn("Meeting result limit reached; results are incomplete.")
            return
        self.items[actual] = item

    async def activities(self, conversation_url: str) -> None:
        try:
            conversation_url = _validated_url(conversation_url, "conversation")
        except ValueError:
            self.warn("Activities: rejected an untrusted conversation URL.")
            return
        # Session completion may be published after the requested start-time window.
        cursor = _epoch_ms(min(datetime.now(timezone.utc), self.upper + timedelta(days=1)))
        lower_ms = _epoch_ms(self.lower)
        seen: set[str] = set()
        for _ in range(MAX_ACTIVITY_PAGES):
            result = await self.request(
                f"{conversation_url}/activities", "activities", "Activities",
                params={**_SDK_QUERY, "limit": ACTIVITY_PAGE_SIZE, "includeChildren": "true", "maxDate": cursor},
            )
            if result is None:
                return
            payload, _ = result
            rows = payload.get("items")
            if not isinstance(rows, list):
                self.warn("Activities: missing activity list; results are incomplete.")
                return
            if not rows:
                return
            dates: list[int] = []
            new_ids: set[str] = set()
            reached_creation = False
            for row in rows:
                if not isinstance(row, dict):
                    continue
                published = _timestamp(row.get("published"))
                if published is not None:
                    dates.append(_epoch_ms(published))
                activity_id = row.get("id")
                if isinstance(activity_id, str) and activity_id not in seen:
                    new_ids.add(activity_id)
                    self.add_activity(row)
                reached_creation |= row.get("verb") == "create" and isinstance(row.get("object"), dict) and row["object"].get("objectType") == "conversation"
            if self.stopped or reached_creation:
                return
            if not dates:
                self.warn("Activities: no usable pagination dates; results are incomplete.")
                return
            oldest = min(dates)
            if oldest < lower_ms:
                return
            if oldest > cursor or (oldest == cursor and not new_ids and len(rows) >= ACTIVITY_PAGE_SIZE):
                self.warn("Activities: pagination did not advance; results are incomplete.")
                return
            # Retain the boundary millisecond so tied activity timestamps are not skipped.
            # An underfilled page contains every row at its oldest timestamp.
            cursor = oldest - 1 if len(rows) < ACTIVITY_PAGE_SIZE else oldest
            seen.update(new_ids)
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


async def _catalog(
    discovery: _Discovery, catalog_urls: Sequence[str] | None, page_limit: int,
) -> AsyncIterator[str]:
    if catalog_urls is None:
        result = await discovery.request(U2C_CATALOG_URL, "u2c", "Service catalog", params={"format": "hostmap"})
        if result is None:
            return
        bases = _conversation_bases(result[0])
        if not bases:
            discovery.warn("Service catalog: no conversation service was returned; results are incomplete.")
            return
        pending = [f"{base}/conversations" for base in bases]
    else:
        pending = list(dict.fromkeys(catalog_urls))
    visited: set[str] = set()
    conversations: dict[str, datetime | None] = {}
    while pending and not discovery.stopped:
        if len(visited) >= page_limit:
            if page_limit == MAX_CATALOG_PAGES:
                discovery.warn("Conversation page limit reached; results are incomplete.")
            break
        url = pending.pop(0)
        if url in visited:
            discovery.warn("Conversation catalog: pagination repeated; results are incomplete.")
            continue
        visited.add(url)
        result = await discovery.request(
            url, "catalog", "Conversation catalog",
            params=None if urlsplit(url).query else {**_SDK_QUERY, "paginate": "true", "membershipsType": "memberships"},
        )
        if result is None:
            continue
        payload, response = result
        rows = payload.get("items")
        if not isinstance(rows, list):
            discovery.warn("Conversation catalog: missing conversation list; results are incomplete.")
            continue
        earliest = datetime.min.replace(tzinfo=timezone.utc)
        rows = sorted(
            (row for row in rows if isinstance(row, dict)),
            key=lambda row: _last_activity(row.get("lastReadableActivityDate")) or earliest,
            reverse=True,
        )
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
            if conversation_url in conversations:
                continue
            conversations[conversation_url] = last_activity
            yield conversation_url
            if len(conversations) >= MAX_CONVERSATIONS:
                discovery.warn("Conversation limit reached; results are incomplete.")
                break
        if len(conversations) >= MAX_CONVERSATIONS:
            break
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
        discovery.warn("Conversation federation limit reached; results are incomplete.")
    discovery.next_catalog_urls = pending[:20]


async def list_space_meeting_occurrences(
    client: httpx.AsyncClient, bearer: str, from_dt: datetime, to_dt: datetime,
    site_url: str, meeting_series_id: str | None = None, max_results: int = 200,
    *, conversation_urls: Sequence[str] | None = None,
    catalog_urls: Sequence[str] | None = None, catalog_page_limit: int = MAX_CATALOG_PAGES,
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
    site_url = _validated_url(site_url if "://" in site_url else f"https://{site_url}", "site")
    discovery = _Discovery(
        client, bearer, from_dt.astimezone(timezone.utc), to_dt.astimezone(timezone.utc),
        site_url, meeting_series_id, max_results,
    )
    queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=CONVERSATION_QUEUE_SIZE)

    async def produce() -> None:
        urls = list(conversation_urls) if conversation_urls is not None else None
        if urls is None and meeting_series_id:
            # The meetingInfo route is a metadata lookup, not meeting registration.
            result = await discovery.request(
                f"{site_url}/wbxappapi/v1/meetingInfo", "meeting_info", "Meeting space", body={
                    "supportHostKey": False, "supportCountryList": False,
                    "meetingUUID": meeting_series_id, "disableWebRedirect": True,
                },
            )
            urls = []
            if result is not None:
                conversation_url = result[0].get("conversationUrl")
                if isinstance(conversation_url, str):
                    urls.append(conversation_url)
                else:
                    discovery.warn("Meeting space: no conversation URL was returned; results are incomplete.")
        if urls is None:
            async for conversation_url in _catalog(discovery, catalog_urls, min(catalog_page_limit, MAX_CATALOG_PAGES)):
                await queue.put(conversation_url)
        else:
            for conversation_url in dict.fromkeys(urls):
                if discovery.stopped:
                    break
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
                    await discovery.activities(conversation_url)
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
    items = sorted(discovery.items.values(), key=lambda item: (item["start"], item["id"]), reverse=True)
    return {
        "items": items, "complete": not discovery.warnings, "warnings": discovery.warnings,
        "next_catalog_urls": discovery.next_catalog_urls, "has_more": bool(discovery.next_catalog_urls),
    }
