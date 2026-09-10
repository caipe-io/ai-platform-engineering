---
sidebar_position: 2
---

# Features and Components

The CAIPE UI is an operational interface for chat, Dynamic Agents, skills,
knowledge bases, credentials, RBAC, audit logs, and platform health.

## Main Surfaces

| Surface | Purpose |
|---|---|
| Chat | Conversation history, streaming responses, feedback, and file/tool timelines |
| Agents | Create and manage Dynamic Agents, models, MCP servers, subagents, and workflows |
| Skills | Browse, import, run, scan, and revise reusable skill templates |
| Knowledge Bases | Ingest sources, run search, and inspect graph data when RAG is enabled |
| Credentials | Connect user and service credentials for MCP-backed tools |
| Admin | Platform settings, users, teams, RBAC, audit, metrics, and health |

## Global Search and Command Palette

- Select the **Search** control in the top-right application header, or press **Command+K** on macOS and
  **Ctrl+K** on Windows or Linux.
- Navigation results are built from the same feature flags and admin tab gates
  as the sidebar. Hidden or disabled destinations are not added to the index.
- Resource results use existing user-scoped BFF endpoints. Their authorization
  checks run before data reaches the palette.
- Use Up/Down Arrow to select a result and Enter to open it.

Initial resource coverage:

| Resource | Authorization source | Destination |
|---|---|---|
| Agents | OpenFGA `agent#use` filtering | Agent editor |
| Conversations | Ownership, sharing, and OpenFGA discovery filtering | Chat thread |
| Skills | Skill catalog OpenFGA read filtering | Skill workspace |
| Workflows | Workflow visibility and OpenFGA read filtering | Workflows |

Deferred resource types:

- Knowledge Base collections: add after the collection page supports a stable
  item deep link.
- Schedules, MCP servers, and models: add after their list APIs expose
  user-scoped search contracts and stable item deep links.
- A dedicated search service is intentionally deferred. The palette performs
  small parallel queries against authoritative APIs and tolerates a partial
  endpoint failure.

## Chat

- Conversations are stored in MongoDB when `MONGODB_URI` is configured.
- Each conversation targets a Dynamic Agent through `agent_id`.
- The BFF streams AG-UI/SSE events from Dynamic Agents through
  `/api/v1/chat/stream/*`.
- Runtime events render as content, tool calls, warnings, subagents, and status
  updates in the chat timeline.

## Dynamic Agents

- Agents define prompts, model choice, MCP server access, built-in tools,
  subagents, visibility, and team sharing.
- Admin users can seed config-driven agents and models through Helm app config.
- Agent runs persist checkpoint and file state in MongoDB through the Dynamic
  Agents backend.

## MCP Servers

- MCP server rows can use direct endpoints or AgentGateway-routed endpoints.
- The UI can discover AgentGateway targets and normalize endpoint paths.
- Probe actions verify connectivity and credentials before an agent uses a tool.

## Skills

- Built-in templates are read-only by default.
- Users can clone templates into editable copies.
- Skill scan history and safety results are stored in MongoDB.
- Runnable skills launch chat conversations against a resolved Dynamic Agent.

## Admin and Health

- Health probes cover the UI/BFF, Dynamic Agents, MongoDB, Keycloak, OpenFGA,
  AgentGateway, RAG, web ingestor, and migrations when configured.
- Audit surfaces read from the audit service and MongoDB-backed RBAC records.
- Platform settings include default agent/model choices and runtime feature
  controls.
