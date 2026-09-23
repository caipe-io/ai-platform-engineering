# Platform MCP

The Platform MCP lets agents inspect and propose authorized changes to CAIPE
agents, skills, workflows, and schedules. Changes are durable and never apply
from a proposal alone. `apply_platform_change` is treated as a human-approval
tool by the Dynamic Agents runtime, and the BFF re-checks the initiating user's
current access before applying it.

The server is intentionally stateless. It forwards the initiating user's token
to `CAIPE_API_URL`; the UI/BFF owns persistence, validation, OpenFGA checks,
conflict detection, and audit history.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CAIPE_API_URL` | `http://caipe-ui:3000` | Internal UI/BFF base URL |
| `MCP_MODE` | `streamable-http` | `stdio`, `sse`, `http`, or `streamable-http` |
| `MCP_HOST` | `0.0.0.0` | HTTP bind address |
| `MCP_PORT` | `8000` | HTTP port |
| `HTTP_TIMEOUT` | `30` | BFF request timeout in seconds |

For HTTP deployments, normal MCP authentication still uses `Authorization`.
When execution runs as a service account, Dynamic Agents additionally forwards
the human initiator in `X-CAIPE-Initiator-Token`; this MCP always prefers that
identity for control-plane requests.

## External clients

Claude Code and other MCP clients can use the deployed AgentGateway endpoint at
`/mcp/platform` with the user's normal bearer token. For a local stdio client,
run `mcp-server-platform --transport stdio` and set `CAIPE_API_URL` plus a
short-lived user token in `CAIPE_ACCESS_TOKEN`.

The client may inspect and propose a change in one turn. Applying a proposal is
a separate tool call and must remain subject to the client's normal tool-use
confirmation. Agent creation, deletion, ownership, visibility, sharing, and
credential changes stay in the canonical admin UI.
