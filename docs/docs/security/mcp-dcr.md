# MCP dynamic client registration

MCP dynamic client registration (DCR) is off in the Keycloak chart by default. An
operator can enable it for a public MCP server after upgrading Keycloak to 26.8.1
or newer and configuring that server's exact HTTPS resource URL:

```yaml
keycloak:
  image:
    tag: "26.8.1"
  mcpDcr:
    enabled: true
    resourceUrl: "https://example.com/api/tome/mcp"
    # Add any other first-party clients that need the platform API audience.
    platformClientIds: [caipe-ui, caipe-cli, caipe-platform]
```

For a hosted app, include its public path in `resourceUrl`, for example
`https://example.com/apps/example/api/tome/mcp`. It must exactly match the
`resource` value in the app's protected-resource metadata. Enable the app's
resource-audience check at the same time. For Tome, set
`TOME_MCP_REQUIRE_RESOURCE_AUDIENCE=true`.

The Keycloak reconcile job creates the `caipe-mcp-dcr` resource client and
scope, enables resource indicators, and requires PKCE for anonymous public
registrations. The MCP client requests `caipe-mcp-dcr` and the server's URL as
the OAuth `resource`. Keycloak then issues an access token whose audience is
the MCP URL. Tokens without that audience are rejected by Tome's MCP route.

To stop DCR clients from using the platform audience when they omit `resource`,
the reconcile job moves the `caipe-platform` audience mapper out of the
realm-wide `profile` scope. It attaches a new `caipe-platform-api` scope to
the known CAIPE UI, CLI, platform, bot, scheduler, and RAG ingestor clients.
Before enabling DCR, add any other first-party clients that need platform API
access to `platformClientIds`; keep the built-in client IDs your deployment
uses. Existing anonymous DCR clients should be
reviewed or revoked during rollout. Turning DCR off later does not undo this
audience migration or revoke already registered clients.
