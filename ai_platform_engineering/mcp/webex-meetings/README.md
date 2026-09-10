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

The calendar request mirrors the User Hub web client: `meetingListType=All`,
`hidePastMeeting=false`, and `showMeetings=1`. `showMeetings` asks the feed to
include meeting entries rather than returning only calendar-shell metadata.
Calendar reads currently start at `offset=0` and request at most 500 rows; the
tool then applies the requested ISO time window and title filter locally.

User Hub timestamps include an IANA timezone such as
`America/Los_Angeles`. The MCP image includes the timezone database and
normalizes those local wall-clock values to UTC. If timezone metadata cannot be
resolved, the timestamp is omitted rather than returned as an ambiguous value.

## Shared/cohost transcript fallback

The public `/v1/meetingTranscripts` API can omit a transcript that the signed-in
user can play and download in User Hub, including some recordings shared with a
cohost. `webex_list_transcripts` enables `userhub_fallback` by default. It can use
an exact `meeting_id`, or `meeting_title` plus `meeting_start` when the public API
never exposes an instance ID:

1. Derive the site host from public metadata, or use the supplied `site_url`.
2. Search the site-specific User Hub recording list, following offset pagination.
3. Match the title and occurrence time, then adopt and verify the recording
   detail's `meetingInstanceId` across transcript segments.
4. Download the transcript URL returned by the authenticated recording stream.

The caller's existing OAuth token is used throughout; no browser cookies or
server-side token storage are needed. Set `site_url` only when automatic site
derivation is unavailable, or set `userhub_fallback=false` to disable this path.

User Hub endpoints are not part of Webex's public REST API. Keep this behavior as
a guarded fallback and expect Webex may change its response shape or paths.

Recording-list pagination uses pages of 100 and stops at the reported total,
an empty/short page, or 1,000 rows. Matching first filters by normalized title
(including removal of User Hub's timestamp suffix), then chooses recordings
within two days of the requested occurrence start. At most 100 candidate detail
records are inspected.

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
