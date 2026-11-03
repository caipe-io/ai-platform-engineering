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

## Live page retrieval

- `confluence_list_spaces(limit=5, cursor=None)` lists bounded space metadata
  via CQL instead of the retired space-list route. Follow `next_cursor`.
- `confluence_search(cql, limit=5, cursor=None)` returns caller-visible metadata.
  Follow `next_cursor`; search success does not prove that a body was read.
- `confluence_get_page(page_id)` reads storage XHTML using v1 CQL with
  `content.body.storage` expansion, compatible with classic read/search scopes.
  This path avoids the v2 page API's separate granular scope requirement.
- `confluence_get_page_chunk(page_id, content_revision, offset, limit=6000)`
  continues the read. Each JSON text block is at most 8,000 UTF-8 bytes.
  MCP emits one compact text block without duplicating structured content.
  Concatenate every body chunk in order until `next_offset` is null. Restart
  from the first chunk if the revision changes. A final chunk is only the tail.
- `get_pages` now returns bounded CQL metadata. Body expansion requires one
  page ID and returns the first bounded chunk. Numeric space filters and
  unsupported legacy filters fail explicitly; use `confluence_search` with
  a space key, for example `type=page AND space="EXAMPLE"`.
- Legacy `get_spaces` filters its current bounded metadata batch; keep following
  the cursor when a filtered batch is empty. Unsupported expansions/filters
  fail explicitly.
- OAuth calls preserve `/wiki/rest/api` at the API gateway and match the
  configured site in accessible resources, or use `ATLASSIAN_OAUTH_CLOUD_ID`.
  Resolution failures never fall back to tenant URLs or service credentials.
- Only GET requests retry transport failures and HTTP 429/502/503/504, at most
  twice. Authentication/permission failures and writes are not retried.
- Missing bodies, invalid JSON and HTML login pages are errors. HTTP 401 does
  not prove a missing user page permission: verify route, token grants and
  connector consent. App configuration and browser sign-in do not prove the
  current access token's grants. This code does not broaden page permissions.

Deploy this maintained server and wire agents to these tools before testing.
An externally configured Confluence MCP server is unaffected by this patch.
See [Atlassian CQL search](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/)
and [v2 page scopes](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/).
