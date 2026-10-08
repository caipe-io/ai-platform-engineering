# SharePoint MCP server

Read-only Model Context Protocol server for one configured SharePoint Online
site. It uses Microsoft Graph with an application identity and never exposes
write tools.

## Security model

- `GET /documents/{drive_id}/{item_id}/folder` previews current direct PDF/PPTX
  children without downloading content or traversing subfolders. It uses the
  same authentication and configured-site boundary as document streams.
  Counts/sizes include all supported direct files; valid responses never truncate.
  Maximum: ten documents, aggregate original bytes bounded by
  `SHAREPOINT_MAX_DOCUMENT_BYTES`, 1000 scanned direct entries, and a 40-second
  preview deadline. Over-limit previews return `within_limits: false` and no
  document list; clients must not ingest a partial set. Shortcuts are excluded.
  With `?select_files=true`, the same authenticated route returns **all direct file
  metadata within the 1000-entry scan bound**, even when the whole folder exceeds
  ingestion limits. This is for choosing an explicit file subset, not permission
  to ingest the whole list. No file bodies are downloaded. Clients must enforce
  count/byte limits on the initial selected subset, recording existing unchecked IDs
  as exclusions. Later direct files become eligible on future runs. Listings expose
  Graph version tags so successfully ingested unchanged files can be skipped before
  enforcing the ten-document per-run limit. No source records are rewritten by discovery.

- The server is hard-scoped to `SHAREPOINT_SITE_URL`; tools cannot select a
  different tenant, hostname, or site.
- Microsoft credentials stay in the server environment. They are not tool
  arguments, MCP responses, or logs.
- Every tool is annotated read-only and uses only Microsoft Graph `GET`
  operations.
- Text-tool reads are size-bounded and limited to textual formats. Separate
  authenticated document routes stream PPTX/PDF bytes without MCP payloads.
  Pre-authenticated download URLs are never returned to the caller.
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
| `SHAREPOINT_MAX_DOCUMENT_BYTES` | no | `2147483648` | Original PPTX/PDF streaming ceiling (2 GiB), maximum 4 GiB |
| `SHAREPOINT_MAX_RENDERED_PDF_BYTES` | no | `268435456` | Microsoft-rendered PDF ceiling (256 MiB), maximum 1 GiB |
| `SHAREPOINT_DOCUMENT_TIMEOUT_SECONDS` | no | `600` | Total document stream deadline, maximum 1800 seconds |
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
| `sharepoint_get_document_manifest` | Version, size, source URL, and relative streaming paths for a PPTX/PDF in the configured site |
| `sharepoint_list_lists` | List SharePoint lists |
| `sharepoint_list_items` | Read list rows and selected internal fields |

Collection tools return `count`, `has_more`, and `next_cursor`. Pass
`next_cursor` back as `cursor` to fetch the next page.

## PPTX/PDF preparation for TOME

- `GET /documents/{drive_id}/{item_id}/metadata`: manifest, never credentials or a signed download URL.
- `GET /documents/{drive_id}/{item_id}/content`: original bytes, streamed in bounded chunks.
- `GET /documents/{drive_id}/{item_id}/content?format=pdf`: Microsoft Graph's PPTX-to-PDF conversion.
- `GET /documents/catalog/libraries?limit=50&cursor=...`: a bounded library page for TOME's picker.
- `GET /documents/catalog/items?drive_id=...&folder_item_id=...&limit=50&cursor=...`: folder browsing; use `query` instead of `folder_item_id` to search a library. Returns folders and PDF/PPTX metadata only, never file bytes or signed URLs.
- All document/catalog routes require `MCP_AUTH_MODE=shared_key` or `oauth2` and its normal bearer authentication. They fail closed when auth mode is `none`, even behind AgentGateway. For shared-key use, inject `MCP_SHARED_KEY` through the existing secret mechanism. `/healthz` is public and contains no site data.
- Drive IDs must belong to the configured site; folders and remote shortcuts are rejected. Redirects are limited to known Microsoft download hosts, and Graph bearer tokens are never forwarded to redirected storage.
- This does not lift the text tool's 10 MB limit or add binary blobs to MongoDB/MCP/LLM messages. TOME stages and prepares the content on its existing workspace filesystem; see the [TOME README](../../agents/tome/README.md#sharepoint-document-preparation).
- Graph conversion can fail or return an empty PDF for a valid deck. TOME offers an offline LibreOffice fallback; never assume every deck is convertible.
- TOME's source picker, manual ingest and scheduled ingest use the same authenticated service and stable selected IDs. Configure `TOME_SHAREPOINT_API_URL` (without `/mcp`) and `TOME_SHAREPOINT_API_TOKEN` on **both the UI and TOME agent**. The normal `/mcp` tools remain available to dynamic agents; TOME uses bounded catalog/streaming HTTP routes on that same MCP service.
- The application's site access is shared: anyone permitted to edit project sources can browse the configured site. Project wiki access continues to use TOME's existing authorization. Use only a site whose app-readable content is intended for those users.
- SharePoint site-page body extraction and DOCX/XLSX extraction are not included.

### Read-only real-document probe

`scripts/probe_documents.py` starts a temporary authenticated loopback server and
exercises the real streaming/preparation path. It never invokes an LLM or writes
wiki pages. Run in an environment with both MCP and TOME dependencies, including
LibreOffice for local rendering:

```bash
python scripts/probe_documents.py \
  --output /tmp/example-document-probe \
  --include-largest --renderer graph_then_local
```

The output directory must be new. Credentials default to the MCP environment;
`--credentials-file` accepts a private local file with the four `SHAREPOINT_*`
settings. Reports contain file names/IDs and counts, not credentials or document
bodies; protect the report and prepared files as sensitive source data.

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
