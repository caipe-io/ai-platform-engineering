---
sidebar_position: 6
---

# User Interfaces

Choose the interface that fits the way you work. All interfaces send requests
through the same agent and access-control model, so a person's permissions do
not change when they move from the web UI to a bot or the CLI.

## CAIPE UI

The CAIPE UI is a Next.js application with a BFF layer. It handles browser auth,
admin settings, chat persistence, and streaming through Dynamic Agents.

```bash
COMPOSE_PROFILES=caipe-ui,dynamic-agents,caipe-mongodb docker compose -f docker-compose.dev.yaml up
```

Open:

```text
http://localhost:3000
```

Use **Chat** to choose an agent, send a request, and review the response,
tool calls, approvals, and generated files. Use **Agent Builder** when you need
to create or configure the agent itself.

## Slack And Webex

Slack and Webex bot surfaces route user messages through the UI/BFF. The BFF
applies access checks, creates or resumes conversations, and streams through
Dynamic Agents.

| Surface | Key URL setting |
|---|---|
| Slack bot | `CAIPE_API_URL` |
| Webex bot | `CAIPE_API_URL` |

The bot must be configured by an administrator. A bot can only discover and
invoke agents and tools allowed by its configured identity and route policy.

## CLI

The [agent-chat-cli](../tools-utils/agent-chat-cli.md) provides an interactive
terminal client for agent and A2A conversations. It is useful for scripting,
testing an agent, or working without a browser.

## Tool Access

Dynamic Agents call MCP servers directly or through AgentGateway. MCP authz is
enforced by the configured runtime path, including OpenFGA-backed AgentGateway
checks when RBAC is enabled.
