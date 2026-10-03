---
sidebar_position: 1
---

# Run with Docker Compose

Use Docker Compose for a local CAIPE stack with the UI, Dynamic Agents, MCP
servers, a MongoDB-compatible database, RBAC services, and optional RAG/tracing
components. MongoDB is the default; DocumentDB is opt-in.

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

### Seed application resources

Compose mounts `config/app-config.yaml` into the UI. To keep local settings out
of Git:

```bash
cp config/app-config.yaml config/app-config.local.yaml
```

Set the override in `.env`:

```bash
CAIPE_APP_CONFIG_FILE=./config/app-config.local.yaml
```

The file can seed models, MCP servers, agents, workflows, and RAG datasources.
For example:

```yaml
rag_sources:
  - source_type: web_url
    url: https://docs.example.com
    name: example-docs
    search_with_teams: [primary]
    settings:
      crawl_mode: sitemap
      max_pages: 500
```

Seeded datasources are visible but read-only in the UI. `search_with_teams`
controls who can query their content independently from source management.
Change the YAML and restart the UI to update or remove them. Connector
credentials remain in `.env` or the deployment secret store.

External Apps are enabled by default with an empty deployment-owned catalog.
Add packages and installations to `config/agentic-apps.yaml`, or point
`AGENTIC_APPS_CONFIG_FILE` at another catalog file, then restart the UI.

Schedules are not available in the Docker Compose path. The scheduler creates
Kubernetes CronJobs, so use the local KinD/Kubernetes path when scheduled runs
are required:

```bash
./setup-caipe.sh --create-cluster --no-ingress --port-forward-mode
```

The installer enables the scheduler and External Apps by default in that path;
use `ENABLE_SCHEDULER=false` or `--no-apps` for an intentional opt-out.

## Start

```bash
docker compose up
```

Open the UI at **http://localhost:3000**. The Dynamic Agents API is exposed at
**http://localhost:8100** and is also proxied through the UI API routes.

### First-time setup wizard

On a new deployment, the setup wizard checks the runtime and walks an admin
through a first working agent:

1. Select or add an LLM model and verify provider access.
2. Choose a starter recipe.
3. Connect optional user credentials such as GitHub or Notion. OAuth
   connectors must be configured by the operator before they appear.
4. Add a remote MCP server from the catalog, or configure a custom endpoint,
   then select the server for the starter agent.
5. Optionally enable a knowledge base and platform capabilities.
6. Create the agent and run the end-to-end smoke test.

The wizard never stores OAuth tokens in its setup state. Connections remain in
the credential service and can be relinked from **Credentials → Connected
Apps**. The current catalog uses operator-configured OAuth connectors;
arbitrary custom endpoints still require their authentication to be configured
in the MCP editor. Generic dynamic client registration (DCR) is not yet
assumed for custom endpoints.

To update `.env` to the latest published CAIPE release before starting Compose:

```bash
./setup-caipe.sh update-compose-release
```

To let the setup helper update `.env` and start Compose:

```bash
./setup-caipe.sh --docker-compose
```

The setup script asks before using sudo. Use `--no-sudo` to forbid it or `--allow-sudo` to permit it without a consent prompt. See [sudo consent](../kind/setup.md#sudo-consent) for automation and fallback behavior.

Choose the MIT-licensed DocumentDB provider instead:

```bash
./setup-caipe.sh --docker-compose --database=documentdb
```

## Profiles

| Profile | Description |
|---------|-------------|
| `mcp-servers` | Packaged MCP server containers |
| `caipe-ui-prod` | Production CAIPE UI image |
| `caipe-mongodb` | MongoDB for UI state, Dynamic Agents, RBAC metadata, and checkpoints |
| `caipe-documentdb` | Opt-in DocumentDB provider for the same MongoDB-compatible state |
| `rbac` | Local Keycloak, OpenFGA, AgentGateway, and config bridge |
| `dynamic-agents` | Dynamic Agents runtime used by chat, skills, and Agent Builder |
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
