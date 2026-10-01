# Slack Thin Bot BFF Delegation Plan

## Goal

Move Slack runtime identity and team-resolution decisions out of the Slack bot and into
the Web UI BFF. The Slack bot should remain a transport adapter: verify Slack events,
resolve an application-level identity/team through the BFF, mint or receive an OBO token,
and invoke AgentGateway.

## Current State

- The Slack bot resolves Slack users through Keycloak Admin API helpers.
- The Slack bot resolves channel-to-team mappings through MongoDB and local TTL caches.
- OBO token exchange is already scoped and can stay in the bot for the first slice.
- Runtime channel/agent ReBAC should use the integration access-check route from #1455.

## Target Runtime Contract

### `POST /api/integrations/slack/identity/resolve`

Request:

```json
{
  "workspace_id": "T123456789",
  "slack_user_id": "U123456789",
  "slack_email": "alice@example.com"
}
```

Response:

```json
{
  "keycloak_user_id": "alice-sub",
  "email": "alice@example.com",
  "linked": true,
  "link_required": false
}
```

### `POST /api/integrations/slack/channels/resolve-team`

Request:

```json
{
  "workspace_id": "T123456789",
  "channel_id": "C123456789",
  "keycloak_user_id": "alice-sub"
}
```

Response:

```json
{
  "allowed": true,
  "team_slug": "platform-engineering",
  "reason": "allowed"
}
```

## Migration Slices

1. Add BFF endpoints and tests while keeping the existing bot path unchanged.
2. Add Slack bot client helpers for the BFF endpoints behind a feature flag.
3. Flip the bot runtime path to BFF delegation and keep Keycloak Admin/Mongo fallback disabled by default.
4. Remove Slack bot Keycloak Admin and MongoDB runtime credential requirements after validation.

## Acceptance Checklist

- [ ] The bot no longer needs Keycloak Admin credentials for runtime identity resolution.
- [ ] The bot no longer needs MongoDB credentials for channel/team resolution.
- [ ] BFF endpoints deny by default and do not require admin UI authorization for normal runtime bot calls.
- [ ] OBO token exchange either stays in the bot or is explicitly moved into the identity/team BFF response.
- [ ] Helm values, secrets examples, and RBAC docs reflect the reduced bot credential surface.

Tracked by [#1456](https://github.com/caipe-io/ai-platform-engineering/issues/1456).
