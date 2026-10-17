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

The themed conversation picker below New Chat defaults to All chats and offers
Web chats, API chats, Autonomous runs, Scheduled runs, and Webhook runs in that
order, with icons and search. Automation choices appear when their platform
features are enabled. The selected view persists in browser storage; webhook
entries open each task's delivery timeline.

1. The user selects or opens a conversation in the UI.
2. The BFF validates auth/RBAC and forwards stream requests to Dynamic Agents.
3. Dynamic Agents streams AG-UI/SSE events back through the BFF.
4. The UI stores conversation messages and stream events in MongoDB-backed state.
5. MCP tools are reached through configured MCP server rows, usually via AgentGateway.

## Related Docs

- [UI overview](../docs/docs/ui/index.md)
- [UI configuration](../docs/docs/ui/configuration.md)
- [Dynamic Agents API](../docs/docs/api/dynamic-agents-mcp.md)
- [Helm chart reference](../docs/docs/installation/helm-charts/ai-platform-engineering/caipe-ui.md)

## Insights caching

Statistics sections, skill metrics, and Feedback use the shared server cache after
checking the caller's current authorization. Equivalent full admins share results;
personal and simulated views use separate scopes.

- Set `CAIPE_CACHE_REDIS_URL` to use the platform Redis cache. Without it, the same
  helpers provide bounded process-local caching and request coalescing.
- `ADMIN_STATS_CACHE_TTL_MS` and `ADMIN_FEEDBACK_CACHE_TTL_MS` default to `60000`.
  Set either to `0` to disable its cache.
- Results can be served for up to five minutes while refreshing or during a brief
  dependency failure. `refresh=true` requests a coordinated refresh.
- `x-caipe-cache`, `x-caipe-computed-at`, and `x-caipe-cache-age` describe the data
  returned. Authenticated responses use `Cache-Control: private, no-store`.
- Feedback accepts relative `range` presets (`1h`, `12h`, `24h`, `7d`, `30d`,
  `90d`) or exact `from`/`to` timestamps. Counts, summaries, and filter options
  have independent entries so changing page does not repeat those queries.

Database queries have a 15-second execution limit. Expensive cache loaders are
bounded by the shared helper, including when Redis is unavailable.

See the [local synthetic benchmark](../docs/docs/evaluations/insights-cache-benchmark.md)
for the dataset, results, and reproduction commands.
