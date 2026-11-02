---
sidebar_position: 3
---

# Configuration

## Core Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DYNAMIC_AGENTS_URL` | Yes for chat | Server-side Dynamic Agents URL |
| `MONGODB_URI` | Yes for persistence | MongoDB connection string |
| `MONGODB_DATABASE` | No | MongoDB database name, default `caipe` |
| `NEXTAUTH_URL` | Yes when auth enabled | Public UI URL for auth callbacks |
| `CAIPE_MCP_ENABLED` | No | Expose the Platform MCP endpoint when `true`; defaults to `false` |
| `CAIPE_MCP_INTERNAL_ORIGIN` | No | Fixed HTTP(S) origin for MCP calls back into the UI; defaults to `NEXTAUTH_URL` |
| `NEXTAUTH_SECRET` | Yes when auth enabled | Session encryption secret |
| `SSO_ENABLED` | No | Enable SSO flow |
| `SKIP_AUTH` | No | Local development auth bypass |
| `RAG_SERVER_URL` | No | RAG backend URL |

When Platform MCP is enabled, set `NEXTAUTH_URL` to the public UI origin.
The endpoint uses that value for OAuth discovery and never derives URLs from
incoming host headers. Set `CAIPE_MCP_INTERNAL_ORIGIN` to a fixed UI origin
reachable from the server if requests should avoid the public ingress. OAuth
discovery also requires `OIDC_ISSUER`.

### Agent notifications through Platform MCP

With the notification framework (#2993) installed, agents can call
`caipe_notification_raise` through `POST /api/mcp`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "caipe_notification_raise",
    "arguments": {
      "conversation_id": "example-chat",
      "event_id": "example-pause-1",
      "event_type": "input_required"
    }
  }
}
```

- Use the caller's user OAuth identity and a real saved CAIPE chat they own.
  Service accounts and someone else's chat are rejected. The tool forwards
  credentials to `POST /api/notifications/agent-events`; that route owns validation,
  ownership enforcement, and rate limiting. No shared publisher secret is needed.
- Supported events: `input_required`, `completed`, and `failed`. Reuse `event_id`
  on retries; use a new ID for a later pause or attempt. Do not repeat an event
  the runtime already emitted automatically.
- The host supplies generic text and the return link. Recipients, message content,
  delivery channels, and external destinations cannot be provided by the agent.
- User preferences and channel opt-ins still apply. `queued` means accepted,
  not delivered; `disabled` means the framework or event preference disabled it.
  Backend failures appear as MCP tool errors. Without #2993, calls report a
  missing-route error rather than claiming an alert was sent.
- This tool only raises a notification. It does not pause execution, create an
  approval, or resume a run. App-specific backend publishers keep using their
  own registered notification types and installation-bound service accounts.
- For CAIPE-managed agents, register this host's `/api/mcp` as an HTTP MCP server
  through the existing MCP registry and assign only `caipe_notification_raise`
  in the agent's tool allowlist. Do not grant the unrelated agent-management
  write tools just to enable notifications. Forward the runtime's caller user
  token; do not configure a service-account or static-secret fallback for this
  owner-only tool. Enabling Platform MCP alone does not assign tools to agents.

## Local Development

```bash
cd ui
npm install

DYNAMIC_AGENTS_URL=http://localhost:8100 \
MONGODB_URI=mongodb://admin:changeme@localhost:27017/caipe?authSource=admin \
NEXTAUTH_URL=http://localhost:3000 \
NEXTAUTH_SECRET=development-secret-change-me \
SKIP_AUTH=true \
npm run dev
```

## Docker Compose

```bash
COMPOSE_PROFILES=caipe-ui,dynamic-agents,caipe-mongodb docker compose -f docker-compose.dev.yaml up
```

The compose files wire `DYNAMIC_AGENTS_URL` and `MONGODB_URI` for the packaged
services. Override them in `.env` only when pointing at external services.

## Helm

```yaml
caipe-ui:
  config:
    DYNAMIC_AGENTS_URL: http://ai-platform-engineering-dynamic-agents:8001
    MONGODB_DATABASE: caipe
  existingSecret: caipe-runtime-secrets
```

`existingSecret` or `externalSecrets` should provide sensitive values such as
`MONGODB_URI`, OAuth client secrets, and `NEXTAUTH_SECRET`.
