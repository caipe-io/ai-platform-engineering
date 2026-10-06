# SharePoint MCP server

Read-only Model Context Protocol server for one configured SharePoint Online
site. It uses Microsoft Graph with an application identity and never exposes
write tools.

## Security model

- The server is hard-scoped to `SHAREPOINT_SITE_URL`; tools cannot select a
  different tenant, hostname, or site.
- Microsoft credentials stay in the server environment. They are not tool
  arguments, MCP responses, or logs.
- Every tool is annotated read-only and uses only Microsoft Graph `GET`
  operations.
- File reads are size-bounded and limited to textual formats. Pre-authenticated
  download URLs are never returned to the caller.
- Put remote deployments behind CAIPE AgentGateway, or configure
  `MCP_AUTH_MODE=shared_key`/`oauth2` for direct endpoint authentication.

## Microsoft Entra setup

Use an Entra app with Microsoft Graph **application** permissions:

1. Prefer `Sites.Selected` and have an administrator grant the app `read` on
   only the intended SharePoint site.
2. Use `Sites.Read.All` only when the server genuinely needs tenant-wide read
   access.
3. Create a client secret or workload credential and store it in a secret
   manager.

This server uses the OAuth 2.0 client-credentials flow with
`https://graph.microsoft.com/.default`. It does not use a browser redirect URI
or a per-user Grid OAuth provider.

## Configuration

| Variable | Required | Default | Description |
|---|---:|---:|---|
| `SHAREPOINT_TENANT_ID` | yes | — | Entra tenant UUID |
| `SHAREPOINT_CLIENT_ID` | yes | — | Entra application/client UUID |
| `SHAREPOINT_CLIENT_SECRET` | yes | — | Application secret; inject from a secret manager |
| `SHAREPOINT_SITE_URL` | yes | — | Fixed `https://*.sharepoint.com/sites/...` or `/teams/...` URL |
| `SHAREPOINT_REQUEST_TIMEOUT_SECONDS` | no | `30` | Graph request timeout, up to 120 seconds |
| `SHAREPOINT_MAX_DOWNLOAD_BYTES` | no | `2000000` | Maximum text-file download size, up to 10 MB |
| `MCP_MODE` | no | `streamable-http` | `streamable-http`, `http`, `sse`, or `stdio` |
| `MCP_HOST` | no | `127.0.0.1` | HTTP bind address |
| `MCP_PORT` | no | `8000` | HTTP bind port |

Omit URL fragments such as `#` from `SHAREPOINT_SITE_URL`.

## Tools

| Tool | Purpose |
|---|---|
| `sharepoint_get_site` | Confirm the configured site and return metadata |
| `sharepoint_list_document_libraries` | List site document libraries |
| `sharepoint_list_drive_items` | Browse a library root or folder |
| `sharepoint_search_drive_items` | Search within one document library |
| `sharepoint_get_drive_item` | Get file or folder metadata |
| `sharepoint_read_text_file` | Read bounded text, Markdown, CSV, JSON, XML, YAML, or log content |
| `sharepoint_list_lists` | List SharePoint lists |
| `sharepoint_list_items` | Read list rows and selected internal fields |

Collection tools return `count`, `has_more`, and `next_cursor`. Pass
`next_cursor` back as `cursor` to fetch the next page.

## Run locally

```bash
cd ai_platform_engineering/mcp/sharepoint
cp env.example .env.mcp
# Replace placeholders in .env.mcp; never commit that file.
make run MCP_MODE=HTTP MCP_HOST=127.0.0.1
```

The Streamable HTTP endpoint is `http://127.0.0.1:8000/mcp`.

Example tool workflows:

1. Call `sharepoint_get_site`, then
   `sharepoint_list_document_libraries({"limit": 20})`.
2. Use a returned drive ID with
   `sharepoint_list_drive_items({"drive_id": "...", "limit": 20})`, then
   call `sharepoint_get_drive_item` or `sharepoint_read_text_file`.
3. Call `sharepoint_list_lists`, then
   `sharepoint_list_items({"list_id": "...", "field_names": ["Title"]})`.

## Add to Grid

Deploy the server where AgentGateway can reach it. In **MCP Servers → Add**:

- Transport: **Streamable HTTP**
- AgentGateway target: the route for this deployment
- Endpoint URL: `http://mcp-sharepoint:8000/mcp` inside Compose/Kubernetes, or
  the HTTPS `/mcp` URL of your deployment
- Credentials: none for Microsoft Graph; the server already owns the app-only
  credential. Configure caller authentication at AgentGateway or with
  `MCP_AUTH_MODE`.

Do not configure the Microsoft client secret as a Grid OAuth provider: this is
an app-only client-credentials integration, not an authorization-code flow.

For Helm, enable `tags.mcp-sharepoint=true` and provide an existing Secret named
`mcp-sharepoint-secret` (or override `mcp-sharepoint.mcpSecrets.secretName`) with
the four required `SHAREPOINT_*` keys. The umbrella chart registers the
`/mcp/sharepoint` AgentGateway target automatically.

## Test

```bash
uv sync --all-groups
uv run ruff check .
uv run pytest
```
