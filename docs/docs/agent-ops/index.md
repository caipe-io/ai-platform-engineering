# AgentOps

CAIPE AgentOps covers testing, release, deployment, and operations for Dynamic
Agents and MCP tool servers.

## Build Artifacts

| Component | Image family |
|---|---|
| UI/BFF | `ghcr.io/caipe-io/caipe-ui` |
| Dynamic Agents | `ghcr.io/caipe-io/caipe-dynamic-agents` |
| MCP servers | `ghcr.io/caipe-io/mcp-<name>` or external MCP image |
| Slack bot | `ghcr.io/caipe-io/caipe-slack-bot` |
| Webex bot | `ghcr.io/caipe-io/caipe-webex-bot` |
| Audit service | `ghcr.io/caipe-io/caipe-audit-service` |

## Validation

| Area | Typical checks |
|---|---|
| Python | `uv run ruff check`, `uv run pytest` |
| UI | `npm run lint`, `npm run build` |
| Helm | `helm lint`, `helm template` |
| Compose | `docker compose config --quiet` |

## Runtime Operations

- Dynamic Agents expose health and readiness endpoints.
- MCP servers are deployed through `mcp-*` Helm aliases.
- AgentGateway can route MCP traffic and enforce OpenFGA-backed authorization.
- MongoDB stores UI data, dynamic-agent checkpoints, and route metadata.
