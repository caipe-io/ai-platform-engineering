---
sidebar_position: 1
---

# Run with Docker Compose

Use Docker Compose for a local CAIPE stack with the UI, Dynamic Agents, MCP
servers, MongoDB, RBAC services, and optional RAG/tracing components.

## Prerequisites

- Docker or Docker Desktop
- Git
- An LLM provider key

## Configure

```bash
git clone https://github.com/caipe-io/ai-platform-engineering.git
cd ai-platform-engineering
cp .env.example .env
```

Edit `.env` with your provider key:

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=<token>
```

The checked-in example starts the default OSS stack:

```bash
COMPOSE_PROFILES=mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor
```

`mcp-servers` starts the packaged MCP server containers. Add credentials only
for the MCP servers you plan to use, for example:

```bash
GITHUB_PERSONAL_ACCESS_TOKEN=<token>
ARGOCD_TOKEN=<token>
ARGOCD_API_URL=https://argocd.example.com
```

For full provider details see [Configure LLMs](configure-llms.md). For service
credentials see [Configure Agent Secrets](configure-agent-secrets.md).

## Start

```bash
docker compose up
```

Open the UI at **http://localhost:3000**. The Dynamic Agents API is exposed at
**http://localhost:8100** and is also proxied through the UI API routes.

To update `.env` to the latest published CAIPE release before starting Compose:

```bash
./setup-caipe.sh update-compose-release
```

To let the setup helper update `.env` and start Compose:

```bash
./setup-caipe.sh --docker-compose
```

## Profiles

| Profile | Description |
|---------|-------------|
| `mcp-servers` | Packaged MCP server containers |
| `caipe-ui-prod` | Production CAIPE UI image |
| `caipe-mongodb` | MongoDB for UI state, Dynamic Agents, RBAC metadata, and checkpoints |
| `rbac` | Local Keycloak, OpenFGA, AgentGateway, and config bridge |
| `dynamic-agents` | Dynamic Agents runtime used by chat, skills, and custom agents |
| `rag` | Vector RAG services |
| `web_ingestor` / `web-ingestor` | Web datasource ingestion worker |
| `slack-bot` | Slack bot integration service |
| `webex-bot` | Webex bot integration service |
| `tracing` | Langfuse tracing stack |

Examples:

```bash
# Default stack from .env
docker compose up

# Render selected services without starting them
docker compose config --services

# Add tracing
docker compose --profile tracing up

# Add graph RAG
docker compose --profile graph_rag up

# Add the web ingestion worker
docker compose --profile web_ingestor up

# Build local images from source
docker compose -f docker-compose.dev.yaml up --build
```

## First-Install RBAC Defaults

If the first launch reports Keycloak reconciliation errors, failed migrations
with `OPENFGA_HTTP is not set`, or missing Keycloak admin credentials, make
sure `.env` contains the local RBAC defaults:

```bash
KEYCLOAK_ADMIN_CLIENT_ID=caipe-platform
KEYCLOAK_ADMIN_CLIENT_SECRET=caipe-platform-dev-secret
OPENFGA_HTTP=http://openfga:8080
OPENFGA_STORE_NAME=caipe-openfga
AUTHZ_SERVICE_URL=http://caipe-ui:3000
```

Then recreate the services that consume those settings:

```bash
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor" \
docker compose --env-file .env -f docker-compose.yaml up -d --force-recreate caipe-ui dynamic-agents keycloak-init
```

If Keycloak or OpenFGA were initialized with bad settings, reset only the local
auth/RBAC volumes. Keep MongoDB if you want to preserve CAIPE data:

```bash
docker compose --env-file .env -f docker-compose.yaml down
docker volume ls | grep -E 'keycloak_postgres_data|openfga_postgres_data'
docker volume rm <keycloak_postgres_data_volume> <openfga_postgres_data_volume>
docker compose --env-file .env -f docker-compose.yaml up -d
```

## Tracing

The `tracing` profile starts Langfuse v3.

```bash
docker compose --profile tracing up
```

Open Langfuse at **http://localhost:3001**, create an account, copy the keys,
then add them to `.env`:

```bash
ENABLE_TRACING=true
LANGFUSE_PUBLIC_KEY=<public-key>
LANGFUSE_SECRET_KEY=<secret-key>
LANGFUSE_HOST=http://langfuse-web:3000
```

Restart the stack after changing tracing settings.

## Next Steps

- [Configure LLMs](configure-llms.md)
- [Configure Agent Secrets](configure-agent-secrets.md)
- [Run with KinD](../kind/setup.md)
- [Deploy with Helm](../helm/setup.md)
