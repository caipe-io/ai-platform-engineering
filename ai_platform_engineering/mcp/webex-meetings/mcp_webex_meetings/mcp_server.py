# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

import functools
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from fastmcp.server.dependencies import get_http_headers
from mcp.shared.exceptions import McpError
from mcp.types import INTERNAL_ERROR, INVALID_PARAMS, ErrorData
from pydantic import BaseModel, ConfigDict, Field

WEBEX_API_BASE = "https://webexapis.com/v1"
USERHUB_DEFAULT_SITE = "https://cisco.webex.com"
USERHUB_CALENDAR_PATH = "/webappng/api/v1/mymeetings/calendarView"
USERHUB_RECORDINGS_PATH = "/webappng/api/v1/recordings"
USERHUB_RECORDINGS_PAGE_SIZE = 100
USERHUB_RECORDINGS_MAX_RESULTS = 1000
USERHUB_RECORDING_DETAIL_LIMIT = 100
USERHUB_RECORDING_SUFFIX = re.compile(r"-\d{8}\s+\d{4}(?:-\d+)?$")
SENSITIVE_KEY_SUBSTRINGS = ("password", "hostkey")

logger = logging.getLogger(__name__)


# Auth helper
def _bearer_from_request() -> str:
    """Pull the per-user Webex bearer token out of the inbound MCP request.

    Normal AgentGateway traffic arrives here as ``Authorization: Bearer ...``
    after the gateway rewrites ``X-CAIPE-Provider-Token``. Direct/local runtime
    calls may pass ``X-CAIPE-Provider-Token`` through unchanged, so accept that
    as a fallback and wrap it as a bearer token before forwarding to Webex.
    """
    # FastMCP strips non-standard/security-sensitive headers by default; opt in.
    headers = get_http_headers(include={"authorization", "x-caipe-provider-token"})
    auth = headers.get("authorization") or headers.get("Authorization")
    provider_token = (
        headers.get("x-caipe-provider-token")
        or headers.get("X-CAIPE-Provider-Token")
    )
    if not auth and provider_token:
        token = provider_token.strip()
        auth = token if token.lower().startswith("bearer ") else f"Bearer {token}"
    if not auth:
        raise McpError(
            ErrorData(
                code=INVALID_PARAMS,
                message=(
                    "No per-user Webex token on inbound MCP request. "
                    "Configure this server with a caller-scoped Webex "
                    "provider_connection credential source."
                ),
            )
        )
    return auth


# Pydantic arguments
class ListMeetings(BaseModel):
    from_iso: Annotated[
        str | None,
        Field(
            description=(
                "ISO-8601 lower bound for meeting start time, e.g. '2026-05-01T00:00:00Z'."
            ),
            default=None,
        ),
    ] = None
    to_iso: Annotated[
        str | None,
        Field(
            description="ISO-8601 upper bound for meeting start time.",
            default=None,
        ),
    ] = None
    host_email: Annotated[
        str | None,
        Field(
            description=(
                "Restrict to meetings hosted by this Webex user. Caller must be "
                "an admin or the user themselves to use this filter."
            ),
            default=None,
        ),
    ] = None
    meeting_type: Annotated[
        Literal["meetingSeries", "scheduledMeeting", "meeting"] | None,
        Field(
            description=(
                "meetingSeries=recurring template; scheduledMeeting=one occurrence; "
                "meeting=actual instance with state."
            ),
            default=None,
        ),
    ] = None
    max_results: Annotated[
        int,
        Field(description="Max meetings to return (1-100).", default=20, ge=1, le=100),
    ] = 20

    model_config = ConfigDict(
        json_schema_extra={
            "description": "List/search Webex meetings the authenticated user can see."
        }
    )


class UserHubCalendar(BaseModel):
    from_iso: Annotated[
        str | None,
        Field(
            description=(
                "Optional ISO-8601 lower bound for occurrence start time. "
                "Filtering is applied client-side after reading User Hub calendar rows."
            ),
            default=None,
        ),
    ] = None
    to_iso: Annotated[
        str | None,
        Field(
            description=(
                "Optional ISO-8601 upper bound for occurrence start time. "
                "Filtering is applied client-side after reading User Hub calendar rows."
            ),
            default=None,
        ),
    ] = None
    title: Annotated[
        str | None,
        Field(
            description="Optional case-insensitive title/subject substring filter.",
            default=None,
        ),
    ] = None
    site_url: Annotated[
        str,
        Field(
            description=(
                "Webex site base URL for the signed-in user's User Hub calendar, "
                "for example 'https://cisco.webex.com'."
            ),
            default=USERHUB_DEFAULT_SITE,
        ),
    ] = USERHUB_DEFAULT_SITE
    meeting_list_type: Annotated[
        str,
        Field(
            description=(
                "User Hub meetingListType query value. Use 'All' for the broadest "
                "calendar view, including external calendar-backed rows."
            ),
            default="All",
        ),
    ] = "All"
    max_results: Annotated[
        int,
        Field(description="Maximum calendar rows to request (1-500).", default=200, ge=1, le=500),
    ] = 200

    model_config = ConfigDict(
        json_schema_extra={
            "description": (
                "Read the signed-in user's Webex User Hub calendar feed. "
                "Best-effort fallback for Office365/Google-backed future "
                "occurrences that may not appear as public Webex scheduledMeeting rows."
            )
        }
    )


class ResolveMeetingLink(BaseModel):
    web_link: Annotated[
        str,
        Field(
            description=(
                "Full Webex join/calendar link to resolve through the official "
                "/v1/meetings?webLink=... API."
            )
        ),
    ]
    max_results: Annotated[
        int,
        Field(description="Maximum matching Webex meeting rows to return (1-100).", default=10, ge=1, le=100),
    ] = 10

    model_config = ConfigDict(
        json_schema_extra={
            "description": (
                "Resolve a Webex meeting link to official Webex meeting metadata, "
                "with password/host-key fields removed."
            )
        }
    )


class GetMeetingStatus(BaseModel):
    meeting_id: Annotated[str, Field(description="Webex meeting ID.")]
    include_participants: Annotated[
        bool,
        Field(
            description="If true, also fetch the meeting participant list.",
            default=False,
        ),
    ] = False

    model_config = ConfigDict(
        json_schema_extra={
            "description": (
                "Get a single Webex meeting's metadata; optionally include "
                "participants via /v1/meetingParticipants."
            )
        }
    )


class CreateMeeting(BaseModel):
    title: Annotated[str, Field(description="Meeting title (max 128 chars).")]
    start: Annotated[str, Field(description="ISO-8601 start time, e.g. '2026-05-08T14:00:00Z'.")]
    end: Annotated[str, Field(description="ISO-8601 end time.")]
    agenda: Annotated[str | None, Field(default=None, description="Meeting agenda text.")] = None
    invitees: Annotated[
        list[str] | None,
        Field(
            default=None,
            description="List of invitee email addresses.",
        ),
    ] = None
    recurrence: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "RFC 5545 RRULE string, e.g. 'FREQ=WEEKLY;BYDAY=MO;COUNT=10'."
            ),
        ),
    ] = None
    password: Annotated[
        str | None,
        Field(default=None, description="Optional meeting password."),
    ] = None
    enabled_auto_record_meeting: Annotated[
        bool,
        Field(
            default=False,
            description="Auto-record the meeting (transcripts require recording).",
        ),
    ] = False

    model_config = ConfigDict(
        json_schema_extra={
            "description": "Schedule a new Webex meeting. Sends invites to invitees."
        }
    )


class UpdateMeeting(BaseModel):
    meeting_id: Annotated[str, Field(description="Webex meeting ID to update.")]
    title: Annotated[str | None, Field(default=None)] = None
    start: Annotated[str | None, Field(default=None)] = None
    end: Annotated[str | None, Field(default=None)] = None
    agenda: Annotated[str | None, Field(default=None)] = None
    password: Annotated[str | None, Field(default=None)] = None
    invitees: Annotated[
        list[str] | None,
        Field(
            default=None,
            description=(
                "Replacement invitee list; sends update emails to added/removed users."
            ),
        ),
    ] = None
    enabled_auto_record_meeting: Annotated[bool | None, Field(default=None)] = None

    model_config = ConfigDict(
        json_schema_extra={
            "description": "Update an existing Webex meeting (PUT semantics)."
        }
    )


class DeleteMeeting(BaseModel):
    meeting_id: Annotated[str, Field(description="Webex meeting ID to delete.")]
    send_email: Annotated[
        bool,
        Field(default=True, description="Send cancellation emails to invitees."),
    ] = True

    model_config = ConfigDict(
        json_schema_extra={"description": "Delete a scheduled Webex meeting."}
    )


class ListRecordings(BaseModel):
    meeting_id: Annotated[
        str | None,
        Field(default=None, description="Filter recordings to a single meeting."),
    ] = None
    from_iso: Annotated[str | None, Field(default=None)] = None
    to_iso: Annotated[str | None, Field(default=None)] = None
    max_results: Annotated[int, Field(default=20, ge=1, le=100)] = 20

    model_config = ConfigDict(
        json_schema_extra={
            "description": "List Webex recordings the user has access to."
        }
    )


class ListTranscripts(BaseModel):
    meeting_id: Annotated[
        str | None,
        Field(default=None, description="Filter transcripts to a single meeting."),
    ] = None
    from_iso: Annotated[str | None, Field(default=None)] = None
    to_iso: Annotated[str | None, Field(default=None)] = None
    meeting_title: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "Meeting title used with meeting_start to locate a User Hub "
                "recording when no public meeting instance ID is available."
            ),
        ),
    ] = None
    meeting_start: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "ISO-8601 occurrence start used with meeting_title for the "
                "User Hub recording fallback."
            ),
        ),
    ] = None
    max_results: Annotated[int, Field(default=20, ge=1, le=100)] = 20
    download: Annotated[
        bool,
        Field(
            default=False,
            description=(
                "If true, also download each transcript's body (may be slow) "
                "and inline it as `body` on each item. Feed straight into "
                "mcp_pod_meeting.parse_webex_vtt."
            ),
        ),
    ] = False
    download_format: Annotated[
        Literal["vtt", "txt"],
        Field(default="vtt", description="Body format when download=true."),
    ] = "vtt"
    userhub_fallback: Annotated[
        bool,
        Field(
            default=True,
            description=(
                "Use the signed-in user's User Hub recording access when the "
                "public transcript API cannot return a transcript."
            ),
        ),
    ] = True
    site_url: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "Optional Webex site base URL for the User Hub fallback. When "
                "omitted, derive it from the meeting's Webex link."
            ),
        ),
    ] = None

    model_config = ConfigDict(
        json_schema_extra={
            "description": (
                "List Webex meeting transcripts the user can see; optionally "
                "inline-download each transcript body."
            )
        }
    )


# Error wrapper
def _handle_errors(func):
    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except McpError:
            raise
        except httpx.TimeoutException as e:
            logger.error(f"webex_meetings timeout: {e}")
            raise McpError(ErrorData(code=INTERNAL_ERROR, message="Webex API timeout."))
        except httpx.HTTPStatusError as e:
            logger.error(f"webex_meetings http {e.response.status_code}: {e.response.text[:300]}")
            raise McpError(
                ErrorData(
                    code=INTERNAL_ERROR,
                    message=(
                        f"Webex API HTTP {e.response.status_code}: "
                        f"{e.response.text[:300]}"
                    ),
                )
            )
        except httpx.RequestError as e:
            logger.error(f"webex_meetings request error: {e}")
            raise McpError(ErrorData(code=INTERNAL_ERROR, message=f"Webex request error: {e}"))
        except ValueError as e:
            raise McpError(ErrorData(code=INVALID_PARAMS, message=str(e)))
        except Exception as e:
            logger.exception("webex_meetings unhandled exception")
            raise McpError(
                ErrorData(
                    code=INTERNAL_ERROR,
                    message=f"Unhandled error in webex_meetings tool: {e}",
                )
            )

    return wrapper


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _normalize_userhub_site_url(site_url: str | None) -> str:
    raw = (site_url or USERHUB_DEFAULT_SITE).strip() or USERHUB_DEFAULT_SITE
    if "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host:
        raise ValueError("site_url must be an HTTPS Webex site URL.")
    if host != "webex.com" and not host.endswith(".webex.com"):
        raise ValueError("site_url must point to a Webex site host, e.g. https://cisco.webex.com.")
    return f"https://{parsed.netloc}"


def _webex_link_from_text(value: Any) -> str | None:
    if not value:
        return None
    for token in str(value).replace("\n", " ").split():
        candidate = token.strip(" <>[]()'\".,;")
        parsed = urlparse(candidate)
        host = (parsed.hostname or "").lower()
        if parsed.scheme in {"http", "https"} and (
            host == "webex.com" or host.endswith(".webex.com")
        ):
            return candidate
    return None


def _userhub_time_to_iso(value: Any) -> tuple[str | None, str | None, str | None]:
    if isinstance(value, dict):
        raw_datetime = value.get("dateTime") or value.get("datetime")
        timezone_name = value.get("timeZone") or value.get("timezone")
    elif isinstance(value, str):
        raw_datetime = value
        timezone_name = None
    else:
        return None, None, None

    if not raw_datetime:
        return None, timezone_name, None

    raw_text = str(raw_datetime)
    normalized = raw_text.replace(" ", "T", 1) if " " in raw_text and "T" not in raw_text else raw_text
    parsed: datetime | None = None
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
            try:
                parsed = datetime.strptime(raw_text, fmt)
                break
            except ValueError:
                continue

    if parsed is None:
        logger.error("User Hub returned an invalid datetime: %s", raw_text)
        return None, timezone_name, raw_text
    if parsed.tzinfo is not None:
        return parsed.astimezone(timezone.utc).isoformat(), timezone_name, raw_text
    if timezone_name:
        try:
            zoned = parsed.replace(tzinfo=ZoneInfo(timezone_name))
            return zoned.astimezone(timezone.utc).isoformat(), timezone_name, raw_text
        except (ZoneInfoNotFoundError, TypeError, ValueError):
            logger.error("User Hub returned an unavailable timezone: %s", timezone_name)
            return None, timezone_name, raw_text
    logger.error("User Hub returned a timezone-less datetime: %s", raw_text)
    return None, timezone_name, raw_text


def _organizer_email(organizer: Any) -> str | None:
    if not isinstance(organizer, dict):
        return None
    for key in ("email", "emailAddress", "mail", "userName"):
        value = organizer.get(key)
        if value:
            return str(value)
    return None


def _normalize_userhub_calendar_item(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        return {"raw": item}

    start_iso, start_tz, start_raw = _userhub_time_to_iso(
        item.get("startTime") or item.get("start") or item.get("startDateTime")
    )
    end_iso, end_tz, end_raw = _userhub_time_to_iso(
        item.get("endTime") or item.get("end") or item.get("endDateTime")
    )
    subject = item.get("subject") or item.get("title") or item.get("meetingName")
    location = item.get("location")
    organizer = item.get("organizer") or item.get("host") or item.get("hostInfo")

    return {
        "id": item.get("id") or item.get("meetingId") or item.get("confId"),
        "seriesId": (
            item.get("seriesId")
            or item.get("meetingSeriesId")
            or item.get("recurrenceId")
        ),
        "subject": subject,
        "source": item.get("externalType") or item.get("source"),
        "start": start_iso,
        "end": end_iso,
        "timezone": start_tz or end_tz,
        "startRaw": start_raw,
        "endRaw": end_raw,
        "location": location,
        "webLink": (
            item.get("webLink")
            or item.get("joinLink")
            or item.get("joinUrl")
            or item.get("meetingLink")
            or _webex_link_from_text(location)
        ),
        "organizerEmail": _organizer_email(organizer),
        "organizer": organizer,
        "occurrenceType": item.get("occurrenceType") or item.get("recurrenceType"),
        "isCancelled": item.get("isCancelled") or item.get("cancelled"),
        "isAllDay": item.get("isAllDay"),
        "originalStartTime": item.get("originalStartTime"),
    }


def _sanitize_sensitive(obj: Any) -> Any:
    if isinstance(obj, dict):
        clean: dict[str, Any] = {}
        for key, value in obj.items():
            key_lower = key.lower()
            if any(part in key_lower for part in SENSITIVE_KEY_SUBSTRINGS):
                continue
            clean[key] = _sanitize_sensitive(value)
        return clean
    if isinstance(obj, list):
        return [_sanitize_sensitive(value) for value in obj]
    return obj


def _extract_items(payload: Any, depth: int = 0) -> list[Any] | None:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict) or depth >= 4:
        return None
    for key in ("items", "data", "meetings", "meetingList", "calendarItems", "entries"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    # User Hub has returned both top-level arrays and nested result/data
    # wrappers over time. Walk only known wrapper keys so an unrelated nested
    # list cannot be mistaken for calendar rows.
    for key in ("data", "result", "body", "calendar", "meetingList"):
        value = payload.get(key)
        nested = _extract_items(value, depth + 1)
        if nested is not None:
            return nested
    return None


def _userhub_calendar_params(args: UserHubCalendar) -> dict[str, Any]:
    params: dict[str, Any] = {
        "meetingListType": args.meeting_list_type,
        "offset": 0,
        "limit": args.max_results,
        "hidePastMeeting": "false",
        "showMeetings": 1,
    }
    from_dt = _parse_iso_datetime(args.from_iso)
    if from_dt is not None:
        params["startDate"] = from_dt.date().isoformat()
    return params


def _derive_userhub_site_url(
    meeting: dict[str, Any] | None,
    explicit_site_url: str | None,
) -> str:
    if explicit_site_url:
        return _normalize_userhub_site_url(explicit_site_url)
    if isinstance(meeting, dict):
        for key in ("siteUrl", "webLink", "joinLink", "joinUrl", "meetingLink"):
            value = meeting.get(key)
            if not value:
                continue
            try:
                return _normalize_userhub_site_url(str(value))
            except ValueError:
                continue
    return USERHUB_DEFAULT_SITE


def _userhub_recording_params(
    *,
    offset: int,
    limit: int,
    keyword: str | None,
) -> dict[str, Any]:
    return {
        "filterType": "",
        "startDate": "",
        "endDate": "",
        "keyword": keyword or "",
        "orderBy": "createTime",
        "orderType": "DESC",
        "offset": offset,
        "limit": limit,
        "includeUpload": "true",
        "decryptAccessPwd": "false",
        "queryMediaDetectInfo": "true",
        "fromPage": "true",
    }


def _userhub_recording_time(recording: dict[str, Any]) -> datetime | None:
    raw = recording.get("gmtCreateTime")
    if not raw:
        return None
    text = str(raw).strip().replace(" ", "T", 1)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _userhub_recording_name_matches(recording_name: Any, meeting_title: str) -> bool:
    normalized_recording = USERHUB_RECORDING_SUFFIX.sub(
        "", str(recording_name or "").strip()
    )
    return normalized_recording.casefold() == meeting_title.strip().casefold()


def _select_userhub_recording_candidates(
    recordings: list[dict[str, Any]],
    *,
    meeting_title: str | None,
    meeting_start: datetime | None,
) -> list[dict[str, Any]]:
    candidates = recordings
    if meeting_title:
        candidates = [
            recording
            for recording in candidates
            if _userhub_recording_name_matches(
                recording.get("recordName"), meeting_title
            )
        ]
    if meeting_start:
        nearby_with_distance = [
            (abs(recording_time - meeting_start), recording)
            for recording in candidates
            if (recording_time := _userhub_recording_time(recording)) is not None
            and abs(recording_time - meeting_start) <= timedelta(days=2)
        ]
        nearby_with_distance.sort(key=lambda item: item[0])
        nearby = [recording for _, recording in nearby_with_distance]
        if nearby:
            candidates = nearby
    return candidates[:USERHUB_RECORDING_DETAIL_LIMIT]


def _validated_webex_download_url(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("User Hub recording does not contain a transcript URL.")
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or (
        host != "webex.com" and not host.endswith(".webex.com")
    ):
        raise ValueError("User Hub returned a non-Webex transcript URL.")
    return value


async def _list_userhub_recordings(
    client: httpx.AsyncClient,
    *,
    bearer: str,
    site_url: str,
    keyword: str | None,
) -> list[dict[str, Any]]:
    headers = {"Authorization": bearer, "Accept": "application/json"}
    recordings: list[dict[str, Any]] = []
    offset = 0
    while offset < USERHUB_RECORDINGS_MAX_RESULTS:
        page_size = min(
            USERHUB_RECORDINGS_PAGE_SIZE,
            USERHUB_RECORDINGS_MAX_RESULTS - offset,
        )
        response = await client.get(
            f"{site_url}{USERHUB_RECORDINGS_PATH}",
            params=_userhub_recording_params(
                offset=offset,
                limit=page_size,
                keyword=keyword,
            ),
            headers=headers,
        )
        response.raise_for_status()
        payload = response.json()
        page = payload.get("recordings", []) if isinstance(payload, dict) else []
        page = [item for item in page if isinstance(item, dict)]
        recordings.extend(page)
        total = payload.get("totalCount") if isinstance(payload, dict) else None
        offset += len(page)
        if not page or len(page) < page_size:
            break
        if isinstance(total, int) and offset >= total:
            break
    return recordings


async def _userhub_transcripts_for_meeting(
    client: httpx.AsyncClient,
    *,
    bearer: str,
    site_url: str,
    meeting_id: str | None,
    meeting_title: str | None,
    meeting_start: datetime | None,
    max_results: int,
    download: bool,
) -> list[dict[str, Any]]:
    recordings = await _list_userhub_recordings(
        client,
        bearer=bearer,
        site_url=site_url,
        keyword=meeting_title,
    )
    candidates = _select_userhub_recording_candidates(
        recordings,
        meeting_title=meeting_title,
        meeting_start=meeting_start,
    )
    if meeting_title and not candidates:
        recordings = await _list_userhub_recordings(
            client,
            bearer=bearer,
            site_url=site_url,
            keyword=None,
        )
        candidates = _select_userhub_recording_candidates(
            recordings,
            meeting_title=meeting_title,
            meeting_start=meeting_start,
        )
    headers = {
        "Authorization": bearer,
        "Accept": "application/json",
        "clientType": "web",
    }
    items: list[dict[str, Any]] = []
    matched_meeting_id = meeting_id
    for recording in candidates:
        recording_uuid = recording.get("recordUUID")
        if not isinstance(recording_uuid, str) or not recording_uuid:
            continue
        try:
            detail_response = await client.get(
                f"{site_url}{USERHUB_RECORDINGS_PATH}/{recording_uuid}/stream",
                headers=headers,
            )
            detail_response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "User Hub recording detail failed for %s: HTTP %s",
                recording_uuid,
                exc.response.status_code,
            )
            continue
        detail = detail_response.json()
        if not isinstance(detail, dict):
            continue
        detail_meeting_id = detail.get("meetingInstanceId")
        if not isinstance(detail_meeting_id, str) or not detail_meeting_id:
            continue
        if matched_meeting_id is not None and detail_meeting_id != matched_meeting_id:
            continue
        download_info = (
            detail.get("downloadRecordingInfo", {}).get("downloadInfo", {})
            if isinstance(detail.get("downloadRecordingInfo"), dict)
            else {}
        )
        try:
            transcript_url = _validated_webex_download_url(
                download_info.get("transcriptURL")
            )
        except ValueError:
            continue
        if matched_meeting_id is None:
            matched_meeting_id = detail_meeting_id

        start_time = _userhub_recording_time(recording)
        item: dict[str, Any] = {
            "id": recording_uuid,
            "meetingId": matched_meeting_id,
            "meetingTopic": meeting_title or detail.get("recordName"),
            "startTime": start_time.isoformat() if start_time else None,
            "status": "available",
            "recordingId": recording_uuid,
            "source": "userhub",
            "coHost": detail.get("coHost"),
            "shareToMe": detail.get("shareToMe"),
        }
        if download:
            download_headers = {
                "Authorization": bearer,
                "Accept": "*/*",
                "Referer": (
                    f"{site_url}/webappng/hub/recording/"
                    f"{recording_uuid}/playback"
                ),
            }
            recording_token = detail.get("recordingToken")
            if isinstance(recording_token, str) and recording_token:
                download_headers["RecordingToken"] = recording_token
            try:
                transcript_response = await client.get(
                    transcript_url,
                    headers=download_headers,
                )
                transcript_response.raise_for_status()
                item["body"] = transcript_response.text
                item["bodyFormat"] = "txt"
            except httpx.HTTPStatusError as exc:
                item["body"] = None
                item["bodyError"] = f"HTTP {exc.response.status_code}"
        items.append(item)
        if len(items) >= max_results:
            break
    return items


# Tool registration
def register_tools(server) -> None:
    """Register all Webex Meetings tools on the FastMCP server."""

    logger.info("Registering webex_meetings tools (REST proxy)")

    async def _request(
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Any:
        bearer = _bearer_from_request()
        headers = {
            "Authorization": bearer,
            "Accept": "application/json",
        }
        if json is not None:
            headers["Content-Type"] = "application/json"
        # New client per call so each request is fully independent and we
        # don't leak the Authorization header across users.
        async with httpx.AsyncClient(base_url=WEBEX_API_BASE, timeout=30.0) as client:
            resp = await client.request(method, path, params=params, json=json, headers=headers)
            resp.raise_for_status()
            if resp.status_code == 204 or not resp.content:
                return {"ok": True}
            ctype = resp.headers.get("content-type", "")
            if "application/json" in ctype:
                return resp.json()
            return {"ok": True, "body": resp.text}

    async def _userhub_calendar_request(site_url: str, params: dict[str, Any]) -> Any:
        bearer = _bearer_from_request()
        headers = {
            "Authorization": bearer,
            "Accept": "application/json",
        }
        base_url = _normalize_userhub_site_url(site_url)
        async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
            resp = await client.get(USERHUB_CALENDAR_PATH, params=params, headers=headers)
            resp.raise_for_status()
            try:
                return resp.json()
            except ValueError as e:
                raise ValueError(
                    "User Hub calendar endpoint did not return JSON. "
                    "Check that site_url is the user's Webex site, e.g. https://cisco.webex.com."
                ) from e

    @server.tool(name="webex_list_meetings")
    @_handle_errors
    async def list_meetings(args: ListMeetings) -> dict[str, Any]:
        """List/search Webex meetings."""
        params: dict[str, Any] = {"max": args.max_results}
        if args.from_iso:
            params["from"] = args.from_iso
        if args.to_iso:
            params["to"] = args.to_iso
        if args.host_email:
            params["hostEmail"] = args.host_email
        if args.meeting_type:
            params["meetingType"] = args.meeting_type
        return await _request("GET", "/meetings", params=params)

    @server.tool(name="webex_userhub_calendar")
    @_handle_errors
    async def userhub_calendar(args: UserHubCalendar) -> dict[str, Any]:
        """Read the user's Webex User Hub calendar feed."""
        params = _userhub_calendar_params(args)
        payload = await _userhub_calendar_request(args.site_url, params=params)
        raw_items = _extract_items(payload)
        if raw_items is None:
            shape = (
                {"type": "dict", "keys": sorted(payload.keys())[:20]}
                if isinstance(payload, dict)
                else {"type": type(payload).__name__}
            )
            return {
                "items": [],
                "rawCount": 0,
                "filteredCount": 0,
                "siteUrl": _normalize_userhub_site_url(args.site_url),
                "meetingListType": args.meeting_list_type,
                "unexpectedShape": shape,
                "note": (
                    "User Hub calendar feed is best-effort/internal and may include "
                    "external calendar rows not present in public Webex schedule APIs."
                ),
            }

        from_dt = _parse_iso_datetime(args.from_iso)
        to_dt = _parse_iso_datetime(args.to_iso)
        if args.from_iso and from_dt is None:
            raise ValueError("from_iso must be an ISO-8601 datetime with timezone, e.g. 2026-06-12T00:00:00Z.")
        if args.to_iso and to_dt is None:
            raise ValueError("to_iso must be an ISO-8601 datetime with timezone, e.g. 2026-06-26T00:00:00Z.")
        title_filter = (args.title or "").casefold()
        normalized_items: list[dict[str, Any]] = []
        for raw_item in raw_items:
            normalized = _normalize_userhub_calendar_item(raw_item)
            subject = str(normalized.get("subject") or "")
            if title_filter and title_filter not in subject.casefold():
                continue
            start_dt = _parse_iso_datetime(normalized.get("start"))
            if start_dt is not None:
                if from_dt is not None and start_dt < from_dt:
                    continue
                if to_dt is not None and start_dt >= to_dt:
                    continue
            normalized_items.append(normalized)

        normalized_items.sort(key=lambda item: item.get("start") or "")
        return {
            "items": normalized_items,
            "rawCount": len(raw_items),
            "filteredCount": len(normalized_items),
            "siteUrl": _normalize_userhub_site_url(args.site_url),
            "meetingListType": args.meeting_list_type,
            "note": (
                "User Hub calendar feed is best-effort/internal and may include "
                "Office365/Google-backed occurrences that are not exposed as public "
                "Webex scheduledMeeting rows. Resolve Webex links separately before "
                "treating a calendar row as official Webex metadata."
            ),
        }

    @server.tool(name="webex_resolve_meeting_link")
    @_handle_errors
    async def resolve_meeting_link(args: ResolveMeetingLink) -> dict[str, Any]:
        """Resolve a Webex link through the official meetings API."""
        parsed = urlparse(args.web_link)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in {"http", "https"} or (
            host != "webex.com" and not host.endswith(".webex.com")
        ):
            raise ValueError("web_link must be a Webex HTTP(S) URL.")

        payload = await _request(
            "GET",
            "/meetings",
            params={"webLink": args.web_link, "max": args.max_results},
        )
        sanitized = _sanitize_sensitive(payload)
        if isinstance(sanitized, dict):
            sanitized["queryWebLink"] = args.web_link
            sanitized["note"] = (
                "Resolved through the official Webex /v1/meetings API; "
                "password and host-key fields were removed."
            )
            return sanitized
        return {
            "items": sanitized,
            "queryWebLink": args.web_link,
            "note": (
                "Resolved through the official Webex /v1/meetings API; "
                "password and host-key fields were removed."
            ),
        }

    @server.tool(name="webex_get_meeting_status")
    @_handle_errors
    async def get_meeting_status(args: GetMeetingStatus) -> dict[str, Any]:
        """Get a single Webex meeting's metadata + optional participants."""
        meeting = await _request("GET", f"/meetings/{args.meeting_id}")
        if args.include_participants:
            try:
                participants = await _request(
                    "GET",
                    "/meetingParticipants",
                    params={"meetingId": args.meeting_id, "max": 100},
                )
                meeting["participants"] = participants.get("items", participants)
            except McpError:
                # Participants list is best-effort; not every meeting state has them.
                meeting["participants"] = []
        return meeting

    @server.tool(name="webex_create_meeting")
    @_handle_errors
    async def create_meeting(args: CreateMeeting) -> dict[str, Any]:
        """Schedule a new Webex meeting."""
        body: dict[str, Any] = {
            "title": args.title,
            "start": args.start,
            "end": args.end,
            "enabledAutoRecordMeeting": args.enabled_auto_record_meeting,
        }
        if args.agenda is not None:
            body["agenda"] = args.agenda
        if args.invitees:
            body["invitees"] = [{"email": e} for e in args.invitees]
        if args.recurrence:
            body["recurrence"] = args.recurrence
        if args.password:
            body["password"] = args.password
        return await _request("POST", "/meetings", json=body)

    @server.tool(name="webex_update_meeting")
    @_handle_errors
    async def update_meeting(args: UpdateMeeting) -> dict[str, Any]:
        """Update an existing Webex meeting (PUT semantics)."""
        # Webex PUT requires the full body; fetch current first, then merge.
        current = await _request("GET", f"/meetings/{args.meeting_id}")
        body: dict[str, Any] = {
            "title": args.title or current.get("title"),
            "start": args.start or current.get("start"),
            "end": args.end or current.get("end"),
        }
        for src_field, body_field in (
            ("agenda", "agenda"),
            ("password", "password"),
            ("enabled_auto_record_meeting", "enabledAutoRecordMeeting"),
        ):
            value = getattr(args, src_field)
            if value is not None:
                body[body_field] = value
            elif body_field in current:
                body[body_field] = current[body_field]
        if args.invitees is not None:
            body["invitees"] = [{"email": e} for e in args.invitees]
        elif "invitees" in current:
            body["invitees"] = current["invitees"]
        return await _request("PUT", f"/meetings/{args.meeting_id}", json=body)

    @server.tool(name="webex_delete_meeting")
    @_handle_errors
    async def delete_meeting(args: DeleteMeeting) -> dict[str, Any]:
        """Delete a scheduled Webex meeting."""
        params = {"sendEmail": "true" if args.send_email else "false"}
        return await _request(
            "DELETE", f"/meetings/{args.meeting_id}", params=params
        )

    @server.tool(name="webex_list_recordings")
    @_handle_errors
    async def list_recordings(args: ListRecordings) -> dict[str, Any]:
        """List Webex meeting recordings."""
        params: dict[str, Any] = {"max": args.max_results}
        if args.meeting_id:
            params["meetingId"] = args.meeting_id
        if args.from_iso:
            params["from"] = args.from_iso
        if args.to_iso:
            params["to"] = args.to_iso
        return await _request("GET", "/recordings", params=params)

    @server.tool(name="webex_list_transcripts")
    @_handle_errors
    async def list_transcripts(args: ListTranscripts) -> dict[str, Any]:
        """List transcripts, with a User Hub fallback for shared recordings."""
        params: dict[str, Any] = {"max": args.max_results}
        if args.meeting_id:
            params["meetingId"] = args.meeting_id
        if args.from_iso:
            params["from"] = args.from_iso
        if args.to_iso:
            params["to"] = args.to_iso
        requested_meeting_start = _parse_iso_datetime(args.meeting_start)
        if args.meeting_start and requested_meeting_start is None:
            raise ValueError(
                "meeting_start must be an ISO-8601 datetime with timezone."
            )
        has_userhub_locator = bool(
            args.meeting_id or (args.meeting_title and requested_meeting_start)
        )
        userhub_only_lookup = bool(
            not args.meeting_id and args.meeting_title and requested_meeting_start
        )
        public_error: httpx.HTTPStatusError | None = None
        if userhub_only_lookup:
            listing = {"items": []}
        else:
            try:
                listing = await _request("GET", "/meetingTranscripts", params=params)
            except httpx.HTTPStatusError as exc:
                if not (
                    args.userhub_fallback
                    and has_userhub_locator
                    and exc.response.status_code in {401, 403, 404}
                ):
                    raise
                public_error = exc
                listing = {"items": []}
        items = listing.get("items", []) if isinstance(listing, dict) else []
        if args.download and items:
            bearer = _bearer_from_request()
            async with httpx.AsyncClient(
                base_url=WEBEX_API_BASE, timeout=60.0
            ) as client:
                for item in items:
                    tid = item.get("id")
                    if not tid:
                        continue
                    try:
                        # NOTE: Webex's transcript download endpoint returns
                        # 406 Not Acceptable if you send a strict text/vtt or
                        # text/plain Accept header. Send Accept: */* and let
                        # the server pick (it returns text either way).
                        r = await client.get(
                            f"/meetingTranscripts/{tid}/download",
                            params={"format": args.download_format},
                            headers={
                                "Authorization": bearer,
                                "Accept": "*/*",
                            },
                        )
                        r.raise_for_status()
                        item["body"] = r.text
                        item["bodyFormat"] = args.download_format
                    except httpx.HTTPStatusError as e:
                        item["body"] = None
                        item["bodyError"] = (
                            f"HTTP {e.response.status_code}: {e.response.text[:200]}"
                        )
            listing["items"] = items

        public_has_result = bool(items) and (
            not args.download or any(item.get("body") for item in items)
        )
        if public_has_result or not args.userhub_fallback or not has_userhub_locator:
            return listing

        meeting: dict[str, Any] | None = None
        if args.meeting_id:
            try:
                meeting_payload = await _request(
                    "GET", f"/meetings/{args.meeting_id}"
                )
                if isinstance(meeting_payload, dict):
                    meeting = meeting_payload
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "Could not load public meeting metadata for User Hub fallback: "
                    "HTTP %s",
                    exc.response.status_code,
                )

        site_url = _derive_userhub_site_url(meeting, args.site_url)
        meeting_title = args.meeting_title or (
            str(meeting.get("title")) if meeting and meeting.get("title") else None
        )
        meeting_start = requested_meeting_start or _parse_iso_datetime(
            str(meeting.get("start")) if meeting and meeting.get("start") else None
        )
        bearer = _bearer_from_request()
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                fallback_items = await _userhub_transcripts_for_meeting(
                    client,
                    bearer=bearer,
                    site_url=site_url,
                    meeting_id=args.meeting_id,
                    meeting_title=meeting_title,
                    meeting_start=meeting_start,
                    max_results=args.max_results,
                    download=args.download,
                )
        except (httpx.HTTPStatusError, httpx.RequestError, ValueError) as exc:
            logger.warning("User Hub transcript fallback failed: %s", exc)
            if public_error is not None:
                raise public_error
            listing["userHubFallback"] = {
                "attempted": True,
                "siteUrl": site_url,
                "error": type(exc).__name__,
            }
            return listing

        if fallback_items:
            return {
                "items": fallback_items,
                "source": "userhub",
                "userHubFallback": {
                    "attempted": True,
                    "siteUrl": site_url,
                    "matched": len(fallback_items),
                },
            }
        listing["userHubFallback"] = {
            "attempted": True,
            "siteUrl": site_url,
            "matched": 0,
        }
        return listing

    # NOTE: webex_get_meeting_summary was removed. The Cisco /v1/meetings/summaries
    # endpoint we mirrored doesn't exist on the public Webex REST API. Webex
    # parses the path as /v1/meetings/{id}/ where id="summaries" and 400s with
    # "Invalid meeting id". The agent should rely on webex_list_transcripts
    # (download=true) + LLM summarization for now. Re-add this tool once Cisco
    # publishes a real public AI-summary endpoint.

    logger.info("Registered webex_meetings tools")
