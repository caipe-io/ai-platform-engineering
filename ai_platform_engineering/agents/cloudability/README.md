# Cloudability Agent

Cloudability A2A agent backed by a Cloudability MCP server.

## Configuration

Set one of the supported authentication modes:

```bash
CLOUDABILITY_API_KEY=...
```

or:

```bash
APPTIO_OPENTOKEN=...
APPTIO_ENVIRONMENT_ID=...
```

Optional API settings:

```bash
CLOUDABILITY_API_URL=https://api.cloudability.com/v3
CLOUDABILITY_REGION=us
```

## Local MCP

```bash
cd mcp
MCP_MODE=http MCP_HOST=0.0.0.0 MCP_PORT=8000 uv run python -m mcp_cloudability
```

The HTTP MCP endpoint is available at `/mcp/`.
