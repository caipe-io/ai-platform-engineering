"""Bot-token-owned Webex space discovery for the internal admin API."""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode, urlparse

import requests

from .webex_bot_catalog import configured_webex_bot
from .webex_ids import canonicalize_webex_space_id

logger = logging.getLogger("caipe.webex_bot.webex_space_discovery")

DEFAULT_CACHE_TTL_SECONDS = 3600
MAX_CACHE_TTL_SECONDS = 86400
MAX_WEBEX_PAGES = 50
MAX_PAGE_SIZE = 500

RequestGet = Callable[..., requests.Response]


@dataclass(frozen=True)
class WebexSpaceDiscoveryResult:
    spaces: list[dict[str, Any]]
    cache_hit: bool
    fetched_at: int


@dataclass
class _CacheEntry:
    spaces: list[dict[str, Any]]
    fetched_at: int


class WebexSpaceDiscovery:
    """Discover and cache group spaces visible to one explicit bot."""

    def __init__(self, *, request_get: RequestGet = requests.get) -> None:
        self._request_get = request_get
        self._cache: dict[str, _CacheEntry] = {}
        self._last_errors: dict[str, str] = {}

    def list_spaces(
        self,
        *,
        bot_id: str,
        refresh: bool = False,
        cache_ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS,
    ) -> WebexSpaceDiscoveryResult:
        bot = configured_webex_bot(bot_id)
        if bot is None:
            raise ValueError(f"Unknown Webex bot: {bot_id}")
        token = os.environ.get(bot.token_env, "").strip()
        if not token:
            raise RuntimeError(f'Webex bot "{bot.name}" is not configured')

        ttl = max(0, min(cache_ttl_seconds, MAX_CACHE_TTL_SECONDS))
        now = int(time.time() * 1000)
        cached = self._cache.get(bot.id)
        if (
            not refresh
            and ttl > 0
            and cached is not None
            and now - cached.fetched_at < ttl * 1000
        ):
            return WebexSpaceDiscoveryResult(
                spaces=list(cached.spaces),
                cache_hit=True,
                fetched_at=cached.fetched_at,
            )

        try:
            spaces = self._fetch_all_rooms(token)
        except requests.RequestException as exc:
            self._last_errors[bot.id] = str(exc)
            raise
        self._last_errors.pop(bot.id, None)
        fetched_at = int(time.time() * 1000)
        if ttl > 0:
            self._cache[bot.id] = _CacheEntry(spaces=spaces, fetched_at=fetched_at)
        else:
            self._cache.pop(bot.id, None)
        return WebexSpaceDiscoveryResult(
            spaces=list(spaces),
            cache_hit=False,
            fetched_at=fetched_at,
        )

    def status(self) -> dict[str, Any]:
        return {
            "bots": {
                bot_id: {
                    "spaces_indexed": len(entry.spaces),
                    "fetched_at": entry.fetched_at,
                    "last_error": self._last_errors.get(bot_id),
                }
                for bot_id, entry in self._cache.items()
            },
            "last_errors": dict(self._last_errors),
        }

    def inspect_space(self, *, bot_id: str, space_id: str) -> dict[str, Any]:
        """Verify bot membership and return provider-owned publication metadata."""

        canonical_id = canonicalize_webex_space_id(space_id)
        result = self.list_spaces(bot_id=bot_id)
        space = next(
            (
                candidate
                for candidate in result.spaces
                if str(candidate.get("id") or "") == canonical_id
            ),
            None,
        )
        if space is None:
            raise ValueError("The configured Webex bot is not a member of this space")
        bot = configured_webex_bot(bot_id)
        if bot is None:
            raise ValueError(f"Unknown Webex bot: {bot_id}")
        token = os.environ.get(bot.token_env, "").strip()
        if not token:
            raise RuntimeError(f'Webex bot "{bot.name}" is not configured')
        provider_room_id = str(space.get("webex_room_id") or space["id"])
        return {
            "bot_id": bot.id,
            "space_id": canonical_id,
            "space_name": str(space.get("name") or canonical_id),
            "member_count": self._fetch_room_member_count(token, provider_room_id),
        }

    def _fetch_all_rooms(self, token: str) -> list[dict[str, Any]]:
        spaces: list[dict[str, Any]] = []
        url: str | None = (
            "https://webexapis.com/v1/rooms?max=100&sortBy=lastactivity"
        )
        for _page in range(MAX_WEBEX_PAGES):
            if not url:
                break
            response = self._request_get(
                url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
            items = payload.get("items", []) if isinstance(payload, dict) else []
            if isinstance(items, list):
                for item in items:
                    normalized = _normalize_room(item)
                    if normalized is not None:
                        spaces.append(normalized)
            url = _next_page_url(response, payload)

        spaces.sort(key=lambda space: str(space["name"]).casefold())
        return spaces

    def _fetch_room_member_count(self, token: str, room_id: str) -> int:
        member_count = 0
        url: str | None = "https://webexapis.com/v1/memberships?" + urlencode(
            {"roomId": room_id, "max": 1000}
        )
        for _page in range(MAX_WEBEX_PAGES):
            if not url:
                return member_count
            response = self._request_get(
                url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
            items = payload.get("items", []) if isinstance(payload, dict) else []
            if not isinstance(items, list):
                raise RuntimeError("Webex returned an invalid memberships response")
            member_count += len(items)
            url = _next_page_url(response, payload)
        if url:
            raise RuntimeError("Webex space membership exceeds the inspection limit")
        return member_count


def _normalize_room(candidate: object) -> dict[str, Any] | None:
    if not isinstance(candidate, dict):
        return None
    room_id = str(candidate.get("id") or "").strip()
    room_type = str(candidate.get("type") or "group").strip().lower()
    if not room_id or room_type == "direct":
        return None
    canonical_id = canonicalize_webex_space_id(room_id)
    return {
        "id": canonical_id,
        **({"webex_room_id": room_id} if canonical_id != room_id else {}),
        "name": str(candidate.get("title") or room_id).strip() or room_id,
        "type": room_type or "group",
        "is_locked": bool(candidate.get("isLocked")),
    }


def _next_page_url(response: requests.Response, payload: object) -> str | None:
    next_link = response.links.get("next", {}).get("url")
    if not next_link and isinstance(payload, dict):
        links = payload.get("link")
        if isinstance(links, list):
            for link in links:
                if (
                    isinstance(link, dict)
                    and str(link.get("rel") or "").lower() == "next"
                ):
                    next_link = link.get("href")
                    break
    if not isinstance(next_link, str):
        return None
    parsed = urlparse(next_link)
    if parsed.scheme != "https" or parsed.hostname != "webexapis.com":
        logger.warning("Ignoring unsafe Webex pagination URL")
        return None
    return next_link
