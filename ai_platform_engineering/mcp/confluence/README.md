# 🧠 Confluence MCP Server

## Setup MCP Server in Streamable HTTP Mode
- Setup UV

```bash
# On macOS and Linux.
curl -LsSf https://astral.sh/uv/install.sh | sh
```
- uv venv
```bash
uv venv && source .venv/bin/activate
```
- uv sync
```bash
uv sync
```
- Copy .env.example to .env
- Setup .env
```bash
ATLASSIAN_EMAIL=
CONFLUENCE_API_URL=
ATLASSIAN_TOKEN=
MCP_MODE=http
MCP_HOST=0.0.0.0
MCP_PORT=18000
```

For caller-connected OAuth, AgentGateway forwards the provider token on
`X-CAIPE-Provider-Token`. Configure `CONFLUENCE_API_URL` with the complete REST
base, including `/wiki/rest/api`. For Cloud OAuth, use
`https://api.atlassian.com/ex/confluence/<cloud-id>/wiki/rest/api`.

The read-only `search_content` tool uses the supported CQL search endpoint.
It returns visible content with source URLs, supports bounded pagination and
can include page bodies. The connected account needs the search/content read
scopes required by [the search API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/).
Legacy space listing and the newer space API have different endpoint and scope
requirements; a successful connection does not qualify every advertised tool.

```bash
set -a; source .env; set +a && uv run python mcp_confluence/server.py
```

## MCP Inspector Tool

The **MCP Inspector** is a utility for inspecting and debugging MCP servers. It provides a visual interface to explore generated tools, models, and APIs.

### Installation

To install the MCP Inspector, use the following command:

```bash
npx @modelcontextprotocol/inspector
```

### Usage

Run the inspector in your project directory to analyze the generated MCP server:

```bash
npx @modelcontextprotocol/inspector
```

This will launch a web-based interface where you can:

- Explore available tools and their operations
- Inspect generated models and their schemas
- Test API endpoints directly from the interface

For more details, visit the [MCP Inspector Documentation](https://modelcontextprotocol.io/legacy/tools/inspector).

## 📚 Additional References

- [OpenAPI MCP Codegen](https://github.com/cnoe-io/openapi-mcp-codegen)
