# CAIPE UI

Next.js BFF and web UI for CAIPE. The UI talks to Dynamic Agents through
server-side API routes, manages MongoDB-backed chat state, and exposes admin
surfaces for models, MCP servers, skills, credentials, RBAC, audit logs, and
platform health.

## Quick Start

From the repository root:

```bash
make caipe-ui-dev
```

Or run directly:

```bash
cd ui
npm install
npm run dev
```

Open http://localhost:3000.

## Runtime Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DYNAMIC_AGENTS_URL` | `http://localhost:8100` in local dev, `http://dynamic-agents:8100` in production | Server-side Dynamic Agents runtime URL |
| `MONGODB_URI` | unset | Enables MongoDB-backed conversations and admin state |
| `PROMETHEUS_URL` | unset | Server-side Prometheus-compatible query URL for Admin metrics and health. In HA deployments, use a deduplicating query frontend such as Thanos rather than a load-balanced service over independent Prometheus replicas. |
| `RAG_SERVER_URL` | unset | Server-side RAG API URL |
| `NEXTAUTH_SECRET` | unset | Required for authenticated deployments |
| `SSO_ENABLED` | `false` | Enables OIDC-backed auth |

Browser chat traffic goes through the BFF routes under
`/api/v1/chat/stream/*`; the browser does not call the Dynamic Agents service
directly.

### Agent Builder harness controls

- Deep Agents retains its model, tools, knowledge, skills, and Advanced controls.
- Engine-backed agents use an operator profile for their execution model. Schema-declared harness options appear under Advanced.
- Tools appear only when the harness declares supported tool bindings. Both current Claude SDK and AgentCore adapters report builder tool bindings unavailable.
- An optional writing-assistant model powers AI Suggest without changing the agent's execution model.
- `/api/dynamic-agents` requires `model` for Deep Agents. Engine-backed metadata may omit it; switching back to Deep Agents requires a valid model.
- Saved Deep Agents settings remain in metadata while another harness is selected and are excluded from its execution blueprint.

See [Agent Creation UI Architecture](../docs/docs/specs/2026-08-17-harness-engine/agent-creation-ui.md) for Phase 1 behavior and the Phase 2 contract.

## Development Commands

```bash
npm run lint
npm test
npm run build
```

For Docker Compose:

```bash
COMPOSE_PROFILES=caipe-ui,dynamic-agents,caipe-mongodb docker compose -f ../docker-compose.dev.yaml up --build
```

## App Structure

```text
ui/src/app/                 Next.js App Router pages and API routes
ui/src/components/          React components
ui/src/components/chat/     Chat UI and Dynamic Agents timeline
ui/src/components/dynamic-agents/
                            Agent, model, MCP server, and workflow management
ui/src/components/admin/    Admin and RBAC surfaces
ui/src/lib/                 BFF utilities, clients, auth, RBAC helpers
ui/src/store/               Zustand stores
ui/src/types/               Shared TypeScript types
```

## Current Chat Flow

The chat header shows the conversation title above the agent name. Long titles
and names truncate independently, with their full text available on hover.

The Agents list shows the execution harness logo beside each name. App-defined
agents use their app's logo instead; hovering identifies the app or harness.

The themed conversation picker below New Chat defaults to All chats and offers
Web chats, API chats, Autonomous runs, Scheduled runs, and Webhook runs in that
order, with icons and search. Automation choices appear when their platform
features are enabled. The selected view persists in browser storage; webhook
entries open each task's delivery timeline.

Collapsible agent and folder group names use 16px text; their chat counts remain
smaller secondary labels. Long names truncate with the full name on hover.

History rows use the Inline actions layout: 56px desktop rows, with title and
date/live status above the agent name and hover actions. Rows do not grow on hover.
The app/harness logo sits at the avatar's lower-right corner, offset outward to
keep the avatar glyph visible. Folder, rename, share, and
archive actions appear when that row is hovered or contains keyboard focus;
touch devices and an active rename keep them visible. Coarse pointers receive
larger touch targets on an additional action line. Scheduled and autonomous task
details appear in the avatar tooltip instead of a separate badge row.
Personal folders apply to regular chats, not run history.
The date uses the conversation's last update time, including messages and edits;
its tooltip shows the full local timestamp.

1. The user selects or opens a conversation in the UI.
2. The BFF validates auth/RBAC and forwards stream requests to Dynamic Agents.
3. Dynamic Agents streams AG-UI/SSE events back through the BFF.
4. The UI stores conversation messages and stream events in MongoDB-backed state.
5. MCP tools are reached through configured MCP server rows, usually via AgentGateway.

## Existing AgentCore agents

- **Agent Builder → Execution harness → Add existing AgentCore agent** is available to callers authorized
  to administer platform configuration. It registers an existing Harness or
  Runtime ARN as an immutable shared operator profile and selects that connection
  in the current Builder. Existing draft fields are preserved; save the agent to apply it.
- Assign instructions, ownership and access in the Builder. Registration does
  not copy AWS tools, permissions or history and does not provision AWS resources.
- Connection IDs start with `existing-`. The AWS Region must match the ARN.
  AWS invocation permission is checked when chatting using Engine credentials.
- See the [Harness Engine connection contract](../ai_platform_engineering/harness_engine/README.md#connect-an-existing-agentcore-deployment)
  for lifecycle and authorization details.

## Related Docs

- [UI overview](../docs/docs/ui/index.md)
- [UI configuration](../docs/docs/ui/configuration.md)
- [Dynamic Agents API](../docs/docs/api/dynamic-agents-mcp.md)
- [Helm chart reference](../docs/docs/installation/helm-charts/ai-platform-engineering/caipe-ui.md)

Native app chat panels may pass `showAgentHeader: false` when their own toolbar already identifies the assistant. The default is `true`, preserving the agent identity row in regular chat.

Native panels can supply `feedbackPrompt` (`message`, `actionLabel`, optional `trailingText`) to replace the default disclaimer with an inline action opening the existing host feedback form. This respects `reportProblemEnabled`; when reporting is disabled, the standard disclaimer remains. The audit logging notice is shown by default; native panels can use `showAuditNotice: false` to omit that footer text without changing audit logging.

Chat feedback offers an unchecked option to attach the latest question and response. It captures a snapshot when the form opens, limits each message to 6,000 characters with a truncation marker, and excludes tools and attachments. The reporter can edit the preview before submission; unchecking omits the excerpt from the request. Consent resets when the form closes.

### Browser chat authentication

First-party browser chat uses the same-origin session cookie for start, resume,
status and cancel. The BFF resolves the session's role and forwards its server-side
access token to the selected runtime. The browser does not attach a bearer token.

- Session-authenticated stream requests require `Origin` to match `NEXTAUTH_URL`
  (or the request origin when unset). An expired or missing session requires sign-in.
  The explicitly enabled non-production anonymous development provider retains its existing behavior.
- Explicit bearer credentials retain precedence, including when a cookie is also
  present. Invalid credentials never fall back to the cookie. API callers keep
  their bearer identity and do not inherit browser administrator privileges.
- Conversation-write, agent-use and app installation admission checks remain in
  force for every operation. Keep admin-only app policies unchanged.
