# mcp-agent-auth

Shared authentication middleware for CAIPE MCP servers.

This package is the repository's **custom middleware solution** for local and
embedded MCP servers. It gives every FastMCP HTTP server the same auth contract
without forcing each MCP to re-implement JWT parsing and JWKS validation.

## Supported modes

- `MCP_AUTH_MODE=none` — pass-through; useful for tests only
- `MCP_AUTH_MODE=shared_key` — validates `Authorization: Bearer <token>` against
  `MCP_SHARED_KEY`
- `MCP_AUTH_MODE=oauth2` — validates JWTs against `JWKS_URI`, `AUDIENCE`, and
  `ISSUER`

In OAuth2 mode, `OAUTH2_CLIENT_ID` optionally defines a comma-separated client
ID allow-list. When configured, a token must contain a non-empty `cid` claim in
the allow-list. When unset or empty, client ID filtering is disabled and a
token without `cid` is accepted after the other JWT checks pass.

## Local development carve-out

Set `MCP_TRUSTED_LOCALHOST=true` to bypass auth for requests that originate from
the real loopback peer (`127.0.0.1`, `::1`, or unix socket). This is intended
for `mcp dev` workflows where engineers run an MCP directly on localhost.

Keep this **off in production**.

## Optional per-MCP RBAC check

Most standalone MCPs are already protected by AgentGateway ext_authz/OpenFGA. For
those, leave the PDP extension disabled.

For embedded MCPs that do **not** sit behind AgentGateway, you can enable an
extra Keycloak PDP check after JWT validation:

```bash
MCP_AUTH_MODE=oauth2
MCP_PDP_ENABLED=true
MCP_PDP_RESOURCE=mcp_jira
MCP_PDP_SCOPE=invoke
MCP_PDP_AUDIENCE=mcp_jira
MCP_PDP_TOKEN_ENDPOINT=https://keycloak/realms/caipe/protocol/openid-connect/token
```

This sends a UMA decision request for `mcp_jira#invoke` and caches the result
for a short TTL.

## FastMCP usage

```python
from fastmcp import FastMCP
from starlette.middleware import Middleware
from mcp_agent_auth.middleware import MCPAuthMiddleware

mcp = FastMCP("Jira MCP Server")
mcp.run(
    transport="http",
    host="0.0.0.0",
    port=8000,
    middleware=[Middleware(MCPAuthMiddleware)],
)
```

## Security notes

- JWT verification pins `algorithms`, `iss`, and `aud`
- JWKS keys are cached and refreshed on unknown `kid`
- Tokens are never stored raw in the PDP decision cache; cache keys use SHA-256
- `alg=none` and unknown-key attacks are rejected
- The localhost bypass checks the **actual TCP peer**, not `X-Forwarded-For`
