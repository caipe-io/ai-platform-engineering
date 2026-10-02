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
