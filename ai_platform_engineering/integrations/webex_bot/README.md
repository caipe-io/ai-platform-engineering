# Webex bot

The bot resolves linked users and invokes the existing BFF chat stream with
on-behalf-of user tokens. Room/DM policy and thread ownership run before dispatch.

## Native app assistants

- Apps must opt into the Webex client in their assistant manifest. Unsupported
  native assistants are omitted from bot discovery and rejected at invocation.
- Configure `WEBEX_LINK_HMAC_SECRET` (at least 32 bytes) on bot and BFF, alongside
  the existing OBO client credentials. Do not log either secret or the user token.
- The bot signs the trusted room/thread context and exact outgoing JSON bytes.
  Missing configuration leaves Dynamic Agents requests unchanged; native
  dispatch fails closed until both sides are configured.
- Native apps independently verify the host's short-lived assistant proof and
  retain their own data permissions. Group support is a separate app capability.
- Existing AG-UI rendering, message size/edit limits and thread IDs are retained.
- Configure new-thread agent selection through the existing route/DM preference.
  Existing threads remain pinned until an explicit, backed-up migration updates
  their stored agent/thread-owner metadata and clears the in-memory owner cache.

The complete gateway/app contract is in `ui/app-sdk/README.md`.

For routing, identity linking, and deployment configuration, see the
[integration guide](../../../docs/docs/integrations/webex-bot.md).

## Reply limits

- `WEBEX_MESSAGE_MAX_EDITS`: 1–20 edits per message; defaults to 10. One edit is
  reserved for completion or errors. Use 20 only with a confirmed higher API limit.
- `CAIPE_UI_BASE_URL`: public browser URL for full-response links; falls back to
  `WEBEX_LINKING_BASE_URL`. Example: `https://chat.example.com`.
- `APP_NAME`: deployment name used in reply footers and link labels.

Streaming updates require 240 new characters and a one-second interval. Replies
fit within 7,439 UTF-8 bytes, including the footer. Oversized replies keep the
original text prefix, reserving at least 100 bytes for the link and expanding that
reservation to fit the actual URL. No model call is made for truncation.

New successful turns persist full user/assistant text through the existing
OBO-authenticated messages API. A truncated reply links to `/chat/<conversation-id>`
only after that write succeeds. Existing conversation permissions still apply;
Webex space membership does not grant browser access. Older metadata-only turns
are not backfilled. Missing/invalid public URLs or failed writes produce an
explicit link-unavailable notice.

### Linking completion feedback

- Bot-issued SSO links carry the configured bot ID; the OAuth start route signs it into the existing ten-minute state cookie. The verified callback notifies that bot's DM using the authenticated Webex profile's person ID, never a room/person supplied in a URL.
- App connection actions may append a local `return_to` path to `/api/auth/webex-link/start`; it is signed with the OAuth state and offered as a return action on the completion screen. External URLs, API paths, and encoded redirect tricks are rejected.
- The account screen reloads saved identity state without HTTP caching and gives the next step to retry a DM. Identity linked does not imply agent access granted.
- Confirmation delivery uses the existing bot-admin service credentials and notification scope. A delivery failure shows a warning but does not undo a saved link.
- The reported unsaved-setting behavior was not reproduced against a live deployment here. Tests check awaited save, error classification, stale UI state, and retry paths; deployment validation should also reload settings in a fresh browser session.
