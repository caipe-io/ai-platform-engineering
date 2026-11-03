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

## Optional Webex DM identity auto-linking

Explicit platform SSO + Webex OAuth linking remains the default.

| Bot environment setting | Default | Purpose |
|---|---|---|
| `WEBEX_DM_AUTO_LINK_ENABLED` | `false` | Explicit opt-in for existing-account matching in DMs. |
| `WEBEX_DM_AUTO_LINK_ALLOWED_ORG_ID` | unset | Required trusted organization; raw UUID or encoded Webex organization ID. |

- Use the same approved organization as the UI's `WEBEX_LINK_ALLOWED_ORG_ID`.
  Keep explicit OAuth linking configured for fallback, unlink, and relink.
- Bot and UI must share `MONGODB_URI` / `MONGODB_DATABASE`, the same Keycloak
  realm, and the existing Keycloak admin credentials needed for identity updates.
  The selected configured bot's `tokenEnv` supplies the Webex provider token.
- Enable only when organization administrators control verified email ownership
  and account lifecycle. Protect directory emails, verification, and `webex_*`
  attributes from user modification; the supplied realm uses `ADMIN_EDIT`.
- The authenticated Webex People API must return the sender's exact immutable
  person ID, human profile type, approved organization, and exactly one email.
  Message text, event email fields, and onboarding emails never establish identity.
- Require one exact, verified, enabled existing Keycloak account. Recheck under
  the shared identity lock; reject ambiguity, missing data, conflicting bindings,
  and prior unlink suppression. Matching never creates accounts.

DM `all_users` admission, bot/agent routing, OBO, and resource authorization are
separate checks. Matching binds existing routes without changing their agent or
status, creating an allowlist entry, or granting access. Group messages and
bots with disabled DMs never trigger matching. Successful setup is acknowledged
once before continuing the original DM through the normal access checks.

### Unlink, audit, and storage

- Self-service unlink and admin revoke suppress automatic matching for both the
  Webex person and platform account. A successful explicit OAuth link clears the
  suppression for that person/account. No positive identity cache is retained.
- Keycloak `webex_user_id` remains the identity attribute. `webex_link_method`
  records `provider_email` or `sso`; `webex_linked_at` records successful setup.
- `/admin/webex/bots` reports `auto_link.enabled` and `auto_link.configured`
  without secrets. Structured audit events record successful and rejected
  attempts under `webex#identity_auto_link`, with hashed subjects and a stable
  outcome in `resource_ref`. No email or provider credential is audited.
- Bot and UI share the `webex_identity_write_locks` mutex (`identity-write`).
  Durable, realm-scoped records in `webex_identity_bindings` protect ownership
  even if directory search lags: `binding:<realm>:<person>`,
  `account:<realm>:<user>`, and `blocked:<realm>:<person>`.
- Permitted DMs with provider message IDs reserve `message:<realm>:<bot>:<id>`
  before dispatch when auto-linking is configured. Concurrent retries and replicas
  cannot dispatch that ID twice. A crash after reservation requires a new user
  message; the original is not automatically replayed.

### Interrupted-write recovery

- Deploy UI and bot together; all writers must participate in this protocol.
  Out-of-band identity attribute edits are unsupported.
- Contention retries for up to two seconds, then fails closed. Lookup failures
  before any writes release the mutex so explicit SSO remains available.
- Locks have **no TTL**. A timed-out Keycloak write can still commit, so an
  uncertain mutation retains its lock. Repeated `WEBEX_LINK_BUSY` responses
  require operator reconciliation.
- Stop all identity writers and wait for outstanding requests. Compare Keycloak
  attributes, reciprocal ownership, suppression records, and existing DM routes;
  finish or reverse the interrupted operation consistently. Only then remove the
  orphan `identity-write` lock and restart writers. Never remove a live lock.
- Do not delete ownership or suppression records as routine cleanup. Message
  reservations can be retained indefinitely. Any retention policy must exceed
  the provider replay window; deleting a reservation permits older replays.
