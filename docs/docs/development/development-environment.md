# Development Environment

Use Docker Compose for full-stack local development and run focused services
directly when iterating on one component.

## Common Stack

```bash
COMPOSE_PROFILES=caipe-ui,dynamic-agents,caipe-mongodb,mcp-netutils docker compose -f docker-compose.dev.yaml up
```

Open:

```text
http://localhost:3000
```

## UI

```bash
cd ui
npm install
npm run dev
```

Set:

```bash
DYNAMIC_AGENTS_URL=http://localhost:8100
MONGODB_URI=mongodb://admin:changeme@localhost:27017/caipe?authSource=admin
```

## Dynamic Agents

```bash
cd ai_platform_engineering/dynamic_agents
uv run pytest
```

## MCP Servers

Packaged MCP servers live under `ai_platform_engineering/mcp/<name>/`. The
Helm chart deploys them through `mcp-*` aliases.

## Quality Gates

```bash
uv run ruff check
uv run pytest

cd ui
npm run lint
npm run build
```
