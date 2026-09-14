---
sidebar_position: 7
---

# Slack Integration API

This page describes the **Slack integration** surface area: Next.js UI Backend API (Backend-for-Frontend) routes under `ui/src/app/api`, and the **Slack Bolt** bot (`ai_platform_engineering/integrations/slack_bot`) as a non-HTTP reference.

---

## Slack User Bootstrapping Dashboard API (admin)

Admin-only JSON APIs used by the CAIPE admin UI to inspect Slack-linked identities, metrics, and to revoke a link. The primary UI for Slack identity state is now the Admin **Users** tab and user detail modal; this listing route is kept as an API surface for operational views. There is no admin re-link endpoint — re-linking happens automatically the next time the user messages the bot (auto-bootstrap / JIT), never via an admin-minted link.

### GET `/api/admin/slack/users`

**Auth:** Session (NextAuth) — admin role required | **Service:** UI Backend API

Returns a **paginated** list of Slack users merged from Keycloak (`slack_user_id` attribute) and optional orphans from `slack_user_metrics`.

**Query parameters**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `page` | integer | `1` | Page number (≥ 1). |
| `page_size` | integer | `20` | Page size (1–100). |
| `status` | string | `all` | Filter: `all`, `linked`, `unlinked`. |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "keycloak_user_id": "user-id-example-1",
        "username": "jdoe",
        "email": "jdoe@example.com",
        "display_name": "Jane Doe",
        "slack_user_id": "U012ABCDEF",
        "link_status": "linked",
        "enabled": true,
        "teams": ["Platform"],
        "last_interaction": "2026-03-25T14:22:01.000Z",
        "obo_success_count": 42,
        "obo_fail_count": 1,
        "active_channels": ["C01ABC", "C02DEF"]
      },
      {
        "keycloak_user_id": "",
        "slack_user_id": "U099ZZZZ",
        "link_status": "unlinked",
        "teams": [],
        "last_interaction": "2026-03-20T09:00:00.000Z",
        "obo_success_count": 0,
        "obo_fail_count": 3,
        "active_channels": ["C01ABC"]
      }
    ],
    "total": 2,
    "page": 1,
    "page_size": 20,
    "has_more": false
  }
}
```

**Errors**

| Status | Body (typical) |
|--------|----------------|
| `401` | `{ "success": false, "error": "Authentication required" }` |
| `403` | `{ "success": false, "error": "Admin access required - must be member of admin group" }` |
| `400` | Invalid `page` / `page_size` |

---

### DELETE `/api/admin/slack/users/[id]`

**Auth:** Session (admin) | **Service:** UI Backend API

Removes the `slack_user_id` Keycloak user attribute for the given Keycloak user (revokes the link).

**Path parameters**

| Name | Description |
|------|-------------|
| `id` | Keycloak user ID. |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "revoked": true,
    "keycloak_user_id": "user-id-example-1"
  }
}
```

**Errors:** `401`, `403` as above.

---

## Channel-to-Team and Channel-to-Resource Mapping

The legacy `/api/admin/slack/channel-mappings` CRUD API has been retired. Use the team management Slack Channels tab for channel→team ownership and the OpenFGA ReBAC Slack Channels panel for channel→agent/tool/KB grants. Runtime authorization is based on `channel_team_mappings` plus `slack_channel_grants`.

---

## Slack Bot Event Handlers (reference)

Slack Bolt registrations in `app.py`. These are **not** HTTP routes; payloads follow Slack’s Events API / Socket Mode shapes (`body.event`, etc.).

| Handler type | Registration | Description | Payload (brief) | Response / side effects |
|--------------|--------------|-------------|-----------------|-------------------------|
| Event | `@app.event("app_mention")` | Invokes CAIPE when the bot is @mentioned in a configured channel. | `event.channel`, `event.user`, `event.text`, `thread_ts` / `ts` | Streams a Dynamic Agents reply in thread; may post “Retry” blocks on failure. |
| Event | `@app.event("message")` | Router for DMs, Q&A mode, bot alerts, and subtypes filter. | `event.channel_type`, `event.channel`, `event.user`, `event.text`, `bot_id` | Dispatches to DM handler, Q&A, or AI alert pipeline; ignores edited/deleted subtypes. |
| (internal) | `handle_dm_message` | DMs to the bot (from `message` when `channel_type == "im"`). | IM `event` | `stream_response`; retry UI on errors. |
| (internal) | `handle_qanda_message` | Auto-reply in channels with Q&A enabled. | Channel `event` | `stream_response`; may mark thread “skipped” (overthink). |
| Event | `@app.event("reaction_added")` | Placeholder. | `reaction` event | No-op. |
| Event | `@app.event("reaction_removed")` | Placeholder. | `reaction` event | No-op. |
| Error | `@app.error` | Global error logging. | `error`, `body` | Logs exception. |

---

## Slack Bot Action Handlers (reference)

| Handler type | Registration | Description | Payload (brief) | Response / side effects |
|--------------|--------------|-------------|-----------------|-------------------------|
| Action | `@app.action({"action_id": "hitl_form_.*"})` | Human-in-the-loop form interactions. | Interactive payload with `actions`, `user`, `channel` | `HITLCallbackHandler.handle_interaction`. |
| Action | `@app.action("caipe_feedback")` | Thumbs up/down on bot messages. | `actions[0].value`, `message.ts` | `submit_feedback_score`; ephemeral follow-up or refinement buttons. |
| Action | `@app.action("caipe_feedback_more_detail")` | Request more detailed answer. | `value` → `channel_id\|thread_ts` | Submits score; triggers follow-up Dynamic Agents stream. |
| Action | `@app.action("caipe_feedback_less_verbose")` | Request shorter answer. | `value` → `channel_id\|thread_ts` | Submits score; triggers concise Dynamic Agents stream. |
| Action | `@app.action("caipe_retry")` | Retry after transient failure. | `value` → `channel_id\|thread_ts` | Rebuilds thread context; `stream_response`. |
| Action | `@app.action("caipe_feedback_wrong_answer")` | Opens modal for correction. | `trigger_id`, `value` | `views_open` with correction modal. |
| Action | `@app.action("caipe_feedback_other")` | Opens modal (other feedback). | Same pattern | `views_open`. |
| View | `@app.view("caipe_wrong_answer_modal")` | Modal submit for wrong answer / other. | `view.state.values`, `private_metadata` | `submit_feedback_score` with comment; Dynamic Agents correction stream. |

---

## RBAC Middleware (reference)

### Global Bolt middleware — `@app.middleware` → `rbac_global_middleware`

**Enabled when:** `SLACK_RBAC_ENABLED=true`.

| Step | Behavior |
|------|----------|
| Identity | Reads Slack user id from `body.event.user`, `body.user.id`, or `body.user_id`. |
| Resolve | Async: `resolve_slack_user` → Keycloak user by `slack_user_id` attribute; resolves the channel's effective CAIPE team before downstream OpenFGA-backed checks. |
| Unlinked | Attempts `auto_bootstrap_slack_user` (email-match, or JIT-provision if `SLACK_JIT_CREATE_USER=true`); if that also fails, the user is treated as unlinked — minimum-access fallback with `chat_postEphemeral`/`chat_postMessage` "contact your admin" messaging when `channel` is present; then **`next()`** — downstream handlers still run. |
| Deny | Team/role mismatch → ephemeral denial; **`return` without `next()`** — handler chain stops. |
| OK | Sets `context["keycloak_user_id"]`, `context["platform_team_id"]`, optional `context["slack_channel_id"]`; calls `next()`. |

> **Note:** The middleware docstring mentions OBO token exchange; the **enrichment function** in `app.py` focuses on Slack identity and team context. OBO exchange is implemented in `obo_exchange.py` for callers that obtain a user token and call `exchange_token`.

### Decorator — `require_permission` (`rbac_middleware.py`)

| Aspect | Detail |
|--------|--------|
| Purpose | Async decorator for handlers that need Keycloak Authorization Services (`check_permission`). |
| Args | `resource`, `scope`, optional `tenant_id` (default `default`). |
| Token | Expects `access_token` and `user_sub` in kwargs; uses `context["obo_token"]` / `access_token` for tenant (`org` claim). |
| On deny | Returns human-readable string for Slack ephemeral; logs via `log_authz_decision`. |
| Team gate | If `context["rbac_enabled"]` and `platform_team_id`, verifies team membership before downstream authorization. |

### Keycloak PDP — `keycloak_authz.py`

| Function | Description |
|----------|-------------|
| `check_permission(RbacCheckRequest)` | POST to realm token endpoint: `grant_type=urn:ietf:params:oauth:grant-type:uma-ticket`, `audience=KEYCLOAK_RESOURCE_SERVER_ID`, `permission={resource}#{scope}`, `response_mode=decision`. Returns `RbacCheckResult(allowed, reason)`. |
| `get_effective_permissions` | UMA ticket with `response_mode=permissions` for RPT-style permission listing. |

**Env (typical):** `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_RESOURCE_SERVER_ID`, `KEYCLOAK_CLIENT_SECRET`.

### OBO token exchange — `obo_exchange.py`

| Function | Description |
|----------|-------------|
| `exchange_token(subject_token)` | RFC 8693 token exchange to bot client (`KEYCLOAK_BOT_CLIENT_ID` / `KEYCLOAK_BOT_CLIENT_SECRET`). Returns `OboToken` (`access_token`, `expires_in`, …). |
| `downstream_auth_headers(access_token, team_id?)` | `Authorization: Bearer …` plus optional `X-Team-Id` for RAG/agents. |

### Audit — `audit.py`

| Function | Description |
|----------|-------------|
| `log_authz_decision(...)` | Emits JSON log line on logger `caipe.rbac.audit` with: `ts`, `tenant_id`, `subject_hash` (SHA-256 of salted sub), `capability` (`resource#scope`), `component`, `outcome` (`allow`/`deny`), `reason_code`, `pdp`, `correlation_id`, optional `actor_hash`, `resource_ref`. |

### Identity linker — `identity_linker.py` (bot-side)

| Function | Description |
|----------|-------------|
| `auto_bootstrap_slack_user(slack_user_id)` | Fetches the Slack profile email; if a Keycloak user with that email exists, merges the `slack_user_id` attribute; else, if `SLACK_JIT_CREATE_USER=true` and the domain passes `SLACK_JIT_ALLOWED_EMAIL_DOMAINS`, JIT-provisions a federated-only Keycloak shell user; else returns `None`. |
| `resolve_slack_user` | Lookup Keycloak user by `slack_user_id` attribute; returns `None` if disabled or missing. |

There is no interactive/bearer-link onboarding path: a signed link is redeemable by whoever holds it, not provably by the intended Slack user, so it is not offered as a fallback. If neither email-match nor JIT resolves a Keycloak user, the request proceeds under a minimum-access unlinked identity with "contact your admin" messaging (rate-limited by `SLACK_LINKING_PROMPT_COOLDOWN`).

---

## Related environment variables

| Variable | Used by |
|----------|---------|
| `SLACK_RBAC_ENABLED` | Bot global RBAC middleware |
| `SLACK_JIT_CREATE_USER` | Enables JIT shell-user provisioning for unmatched emails (default `true`) |
| `SLACK_JIT_ALLOWED_EMAIL_DOMAINS` | Optional comma-separated allowlist restricting which email domains may be JIT-provisioned |
| `SLACK_LINKING_PROMPT_COOLDOWN` | Rate limit (seconds) between unlinked-access nudges to the same user |
| `KEYCLOAK_*` | Admin API + AuthZ + OBO (`keycloak_authz.py`, `obo_exchange.py`) |
