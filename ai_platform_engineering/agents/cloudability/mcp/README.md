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
