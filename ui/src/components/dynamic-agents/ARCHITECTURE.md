# Dynamic Agents UI Architecture

Dynamic Agents are the primary agent runtime for the CAIPE UI. This folder owns
the agent builder, model/MCP server configuration panels, and runtime context
views used by chat.

## Frontend Flow

```text
Chat page
  -> BFF stream routes under /api/v1/chat/stream/*
  -> Dynamic Agents service
  -> streamed AG-UI/SSE events
  -> chat store
  -> DynamicAgentTimeline and context panels
```

The browser calls the BFF, not the Dynamic Agents service directly. This keeps
session, RBAC, service-account, and AgentGateway decisions on the server side.

## Key Files

| File | Purpose |
|---|---|
| `DynamicAgentEditor.tsx` | Create and edit dynamic agent definitions |
| `DynamicAgentsTab.tsx` | List and manage available agents |
| `MCPServersTab.tsx` | Register, probe, and manage MCP server connections |
| `SubagentPicker.tsx` | Configure delegation to other dynamic agents |
| `DynamicAgentContext.tsx` | Show runtime context, tools, subagents, and MCP status |
| `AgentAvatar.tsx` | Shared dynamic-agent avatar rendering |
| `ui/src/components/chat/DynamicAgentChatPanel.tsx` | Chat panel for streamed agent runs |
| `ui/src/components/chat/DynamicAgentTimeline.tsx` | Timeline rendering for tools, content, warnings, and subagents |
| `ui/src/lib/dynamic-agent-client.ts` | BFF-facing streaming client helpers |
| `ui/src/lib/chat-agent-selection.ts` | Resolves a usable default chat agent |

## Runtime State

- Conversations and messages are stored through the UI BFF.
- Dynamic Agents persists checkpoint and file state in MongoDB.
- Per-message stream events are kept separate from durable runtime status so
  each new user turn can clear transient events without losing configuration
  warnings such as failed MCP servers.

## Remote A2A Streaming

- Registry entries expose an optional **Stream responses** checkbox; missing values behave as off.
- The SDK negotiates streaming against the Agent Card. Unsupported agents use complete responses.
- AG-UI `CUSTOM/TOOL_OUTPUT` and custom SSE `tool_output` map to `onToolOutput`.
- Tool output snapshots reach the chat store and timeline while the tool remains running. Subagent namespaces and tool-call IDs isolate concurrent calls.
- Running output panels expand automatically; completed results use the existing tool completion flow.

## Adding Stream UI Features

1. Add or extend event types in `ui/src/lib/streaming/types.ts`.
2. Update `ui/src/lib/da-timeline-manager.ts` when timeline grouping changes.
3. Update `DynamicAgentTimeline.tsx` or `DynamicAgentContext.tsx` to render the
   new state.
4. Add focused tests for the parsing or rendering behavior.

## Related Backend Docs

- `ai_platform_engineering/dynamic_agents/ARCHITECTURE.md`
- `ai_platform_engineering/dynamic_agents/SSE_EVENTS.md`
