# mcp-webex-meetings

Local MCP server that exposes the Webex Meetings / Transcripts / Recordings REST
API as MCP tools. It mostly mirrors the official Webex Meetings MCP
(`https://mcp.webexapis.com/mcp/webex-meeting`), with two local fallback helpers
for stale/expired-series debugging.

## Authentication

Per-user OAuth bearer, forwarded through MCP request headers.

The dynamic-agents runtime resolves a caller-scoped Webex `provider_connection`
from the Credentials > Connected Apps store and injects the token on
`X-CAIPE-Provider-Token`. AgentGateway rewrites that header into
`Authorization: Bearer <user-token>` before forwarding to this MCP server.
For local/direct development, this MCP server also accepts
`X-CAIPE-Provider-Token` directly.

This MCP server simply pulls the inbound `authorization` header off the
incoming request and forwards it to `https://webexapis.com/v1/...`. No token
storage, no Mongo access, no refresh logic; that is all handled by the runtime
and credential service.

The built-in Webex OAuth connector requests the meeting schedule, participant,
recording, transcript, and related Webex scopes required by these tools. Users
with a Webex connection created before those scopes were added must reconnect
the app so Webex can grant the expanded scope set.

## Tools

Mirrors Cisco's official Meetings MCP tool surface, plus local fallback helpers:

- `webex_list_meetings` - list/search meetings with date filters
- `webex_userhub_calendar` - best-effort User Hub calendar read for upcoming external-calendar occurrences
- `webex_resolve_meeting_link` - resolve a Webex join/calendar link through `/v1/meetings` with secrets removed
- `webex_get_meeting_status` - get a meeting + optional participants
- `webex_create_meeting` - schedule a meeting
- `webex_update_meeting` - patch a meeting
- `webex_delete_meeting` - delete a scheduled meeting
- `webex_list_recordings` - list recordings
- `webex_list_transcripts` - list transcripts (and optionally inline-download
  text), with a User Hub fallback for recordings shared with the caller

There is currently no `webex_get_meeting_summary` tool because Webex does not
publish a public meeting-summary REST endpoint. Use
`webex_list_transcripts(download=true)` and summarize the transcript instead.

`webex_userhub_calendar` intentionally uses the same per-user OAuth token against
the Webex User Hub calendar feed, for example
`https://cisco.webex.com/webappng/api/v1/mymeetings/calendarView`. Treat it as a
best-effort fallback when public `/v1/meetings` rows look stale or expired: it can
surface Office365/Google-backed future occurrences that the public Webex schedule
API does not expose as `scheduledMeeting` rows.

When supplied, `from_iso` and exclusive `to_iso` bound the upstream request via
`startDate` and inclusive `endDate`. Each date edge overlaps by one day because
User Hub calendars may use local timezones; exact timestamp filtering removes
the overlap from the returned rows. Without `to_iso`, User Hub chooses its own
default window. Callers scanning larger ranges should use bounded segments and
deduplicate occurrences; a response at `max_results` may be incomplete.

The calendar request mirrors the User Hub web client: `meetingListType=All`,
`hidePastMeeting=false`, and `showMeetings=1`. `showMeetings` asks the feed to
include meeting entries rather than returning only calendar-shell metadata.
Calendar reads currently start at `offset=0` and request at most 500 rows; the
tool then applies the requested ISO time window and title filter locally.

User Hub timestamps include an IANA timezone such as
`America/Los_Angeles`. The MCP image includes the timezone database and
normalizes those local wall-clock values to UTC. If timezone metadata cannot be
resolved, the timestamp is omitted rather than returned as an ambiguous value.

## Recording-occurrence transcript recovery

If a successful date-filtered public transcript listing is empty, the tool
queries the caller's recordings in the same date window and retries the public
transcript API with distinct occurrence IDs (not series IDs). This does not
run for explicit `meeting_id` or title/start User Hub lookups, or after a failed
public API request. The same caller-scoped token is used throughout.

Recovery is best effort: one recording page (at most 100 rows), at most 10
distinct occurrence lookups, 30 seconds for recovery, and at most `max_results`
deduplicated transcripts. `recordingOccurrenceLookup` reports the checked count,
limit hits, and timeout; `source=recording_occurrence_lookup` identifies recovered
results. An empty result is not an exhaustive absence check. API authorization
errors remain errors, not empty results. Downloads retain their existing
per-request timeout and occur after recovery.

## Shared/cohost transcript fallback

The public `/v1/meetingTranscripts` API can omit a transcript that the signed-in
user can play and download in User Hub, including some recordings shared with a
cohost. `webex_list_transcripts` enables `userhub_fallback` by default. It can use
an exact `meeting_id`, or `meeting_title` plus `meeting_start` when the public API
never exposes an instance ID:

1. Derive the site host from public metadata, or use the supplied `site_url`.
2. Search the site-specific User Hub recording list, following offset pagination.
3. Match the recording detail's `meetingInstanceId` to an exact supplied ID,
   or verify the title/time lookup against independently fetched instance timing.
4. Download the transcript URL returned by the authenticated recording stream.

The caller's existing OAuth token is used throughout; no browser cookies or
server-side token storage are needed. Set `site_url` only when automatic site
derivation is unavailable, or set `userhub_fallback=false` to disable this path.

User Hub endpoints are not part of Webex's public REST API. Keep this behavior as
a guarded fallback and expect Webex may change its response shape or paths.

Recording-list pagination uses pages of 100 and stops at the reported total,
an empty/short page, or 1,000 rows. Title/time discovery filters by normalized
title (including removal of User Hub's timestamp suffix) and recording creation
times within two days. An empty neighborhood never falls back to older rows.
At most 100 candidate recording details and one public meeting detail per
distinct candidate instance are inspected.

The two-day discovery window does not establish an occurrence match. Public
metadata must identify an actual `meeting` instance starting within 12 hours
before or after the requested start, including the boundary. Only when public
metadata returns 401, 403, or 404 can a recording created within that same window
anchor a shared instance. Multiple matching instance IDs are ambiguous and return
no transcript. Later segments of the same matched instance remain eligible.
`occurrenceStart` is returned only when actual
instance timing was independently verified; `startTime` remains recording
creation time. Exact-ID lookups verify each stream's instance ID and allow late
or undated recording segments without title/time inference.

For safety, supplied and derived site URLs must be HTTPS Webex hosts, transcript
download URLs must also be hosted by Webex, and returned meeting objects have
password/host-key fields removed recursively.

## Tests

```bash
uv run pytest tests/test_userhub_transcripts.py
```

## Run locally

```bash
uv run python server.py --transport streamable-http --port 8000 --host 0.0.0.0
```

Tools are then reachable at `http://localhost:8000/mcp/`.
