# Cloudability MCP Server

MCP server for the IBM Apptio Cloudability API.

## Environment

Use either a Cloudability API key:

```bash
CLOUDABILITY_API_KEY=...
```

or an Apptio OpenToken:

```bash
APPTIO_OPENTOKEN=...
APPTIO_ENVIRONMENT_ID=...
```

Optional:

```bash
CLOUDABILITY_API_URL=https://api.cloudability.com/v3
CLOUDABILITY_REGION=us
```

## Run

```bash
MCP_MODE=http MCP_HOST=0.0.0.0 MCP_PORT=8000 uv run python -m mcp_cloudability
```

## Grid FinOps Integration

Use the ready-made Grid app config to seed a FinOps dynamic agent with both
LiteLLM and Cloudability tools:

```bash
CAIPE_APP_CONFIG_FILE=./config/app-config.finops.yaml \
  docker compose -f docker-compose.dev.yaml \
  -f docker-compose/docker-compose.finops.dev.yaml \
  --profile caipe-ui up --build
```

The FinOps agent uses LiteLLM for LLM/token/model spend and Cloudability for
budgets, views, portfolio resources, allocation, and broader cloud-cost data.

For Helm, enable the standalone MCP service and point the seeded Grid FinOps
agent at the in-cluster endpoint:

```yaml
cloudabilityMcp:
  enabled: true
  existingSecret: cloudability-mcp-secret

caipe-ui:
  appConfig:
    mcp_servers:
      - id: cloudability
        name: Cloudability
        description: Apptio Cloudability budgets, views, portfolio, and cloud cost data
        transport: http
        endpoint: http://ai-platform-engineering-cloudability-mcp:8000/mcp/
        enabled: true
```
