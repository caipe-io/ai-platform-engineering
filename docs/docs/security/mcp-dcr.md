# MCP dynamic client registration

The Keycloak chart ships version 26.8.1 with MCP dynamic client registration
(DCR) off by default. An operator can enable DCR for a public MCP server by
configuring that server's exact HTTPS resource URL:

```yaml
keycloak:
  image:
    tag: "26.8.1"
  mcpDcr:
    enabled: true
    resourceUrl: "https://example.com/api/tome/mcp"
    # Helm replaces lists. Retain these defaults and append any additional
    # first-party clients that need the platform API audience.
    platformClientIds:
      - caipe-ui
      - caipe-cli
      - caipe-platform
      - caipe-slack-bot
      - caipe-webex-bot
      - caipe-scheduler-runner
      - caipe-webex-bot-admin
      - caipe-rag-ingestor
```

For existing 26.3 installations, follow the
[Keycloak upgrade guide](https://www.keycloak.org/docs/26.8.1/upgrading/)
and back up the database before upgrading the chart. The Deployment uses
`Recreate` so old and new versions do not run concurrently against the same
database. A rollback after schema migration requires restoring the database
backup along with the previous image.

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

The first-party `caipe-platform-api` scope is excluded from public OIDC
`scopes_supported` metadata. Generic clients may request all advertised scopes
while registering; advertising this restricted scope would cause registration
to fail with `403 insufficient_scope`. First-party scope assignments and audience
mappers are retained, and anonymous clients still cannot explicitly request it.
The reconcile job applies this setting to both new and existing realms.

An opt-in integration check creates and deletes disposable realms to validate
new-scope creation, existing-scope reconciliation, first-party assignments and
DCR rejection of the platform scope. Set `KEYCLOAK_DCR_TEST_BASE_URL` and
`KEYCLOAK_DCR_TEST_ADMIN_TOKEN` for an approved Keycloak test target, then run:

```bash
uv run pytest tests/integration/test_keycloak_mcp_dcr_discovery.py
```
