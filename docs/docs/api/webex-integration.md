# Webex Bot Integration

The Webex bot is a CAIPE messaging entry point that mirrors Slack RBAC behavior
with Webex **spaces** in place of Slack channels. It uses Keycloak for identity,
OBO token exchange for user delegation, MongoDB for space/team metadata, and
OpenFGA for relationship-based resource grants.

## Runtime Flow

1. The bot uses Webex WDM/Mercury websocket delivery when
   `WEBEX_INTEGRATION_BOT_ACCESS_TOKEN` is configured, fetches full message
   detail from the Webex API, and normalizes the payload into a space message
   event. The raw room UUID is the canonical CAIPE/OpenFGA space ID; the
   Webex public `Y2lz...` room ID is retained only for Webex API calls.
2. The bot ignores malformed, self, and bot-originated events.
3. The Webex `personId` is resolved to a Keycloak user through `webex_user_id`.
4. The Webex space is resolved to a CAIPE team through `webex_space_team_mappings`.
5. The bot exchanges its service-account token for a user-scoped OBO token with
   the active team scope.
6. The route resolver reads OpenFGA tuples for
   `webex_space:<workspace_alias>--<space_id>` and joins MongoDB route metadata
   from `webex_space_agent_routes`.
7. The bot calls the CAIPE UI BFF Webex access-check API before dispatching.
8. Agent execution starts only after identity, team, route, and ReBAC checks pass.
9. Denials and agent responses are posted back to the original Webex thread with
   `parentId=<incoming message id>`.

The bot fails closed for unlinked users, unmapped spaces, OBO failures, disabled
routes, missing OpenFGA grants, malformed space/person identifiers, and PDP
outages.

## Admin APIs

The Web UI backend exposes Webex administration under:

| API | Purpose |
| --- | --- |
| `GET /api/admin/webex/spaces` | List registered Webex spaces and team mappings |
| `GET /api/admin/webex/available-spaces` | Discover spaces through the server-side Webex token |
| `POST /api/admin/webex/spaces/onboard` | Idempotently wire one Webex space to a team, Dynamic Agent, OpenFGA grant, route metadata, and bot runtime reload |
| `GET/PUT /api/admin/webex/spaces/{workspaceId}/{spaceId}/resources` | Read or replace Webex space resource grants |
| `GET/PUT/DELETE /api/admin/webex/spaces/{workspaceId}/{spaceId}/routes` | Read, update, or remove route metadata |
| `POST /api/admin/webex/spaces/{workspaceId}/{spaceId}/access-check` | Runtime PDP check used by the bot |
| `GET /api/admin/webex/spaces/{workspaceId}/{spaceId}/diagnostics` | Show OpenFGA/Mongo/runtime drift |
| `GET/POST /api/admin/webex/runtime/status` | Inspect running bot route cache and mode |
| `POST /api/admin/webex/runtime/reload` | Clear route cache for one or all spaces |
| `POST /api/admin/webex/runtime/sync-from-config` | Upsert static config routes into Mongo/OpenFGA |
| `GET/DELETE /api/admin/webex/users/{id}` | Inspect or remove `webex_user_id` links |
| `GET/PUT /api/admin/teams/{id}/webex-spaces` | Bind Webex spaces to a CAIPE team |

All admin routes use the same Admin UI gates as Slack. Browser code never calls
Webex APIs directly; the BFF performs discovery and bot runtime admin calls
server-side. The one-shot onboarding endpoint is the preferred control-plane
entrypoint for default teams and agents because it converges MongoDB metadata,
Keycloak team scope setup, OpenFGA tuples, route metadata, and runtime cache
invalidation in one idempotent request.

## OpenFGA Model

Webex uses first-class OpenFGA types:

- `webex_workspace:<alias>`
- `webex_space:<alias>--<space_id>`

The workspace alias comes from `WEBEX_WORKSPACE_ALIAS` or `WEBEX_WORKSPACE_ID`.
Runtime code does not trust workspace identifiers from incoming Webex payloads
when selecting the policy namespace.

Use the raw Webex room UUID as `<space_id>`, for example
`6f91b070-531a-11f1-926d-6fd3c20dfdc4`. When Webex returns a public room ID such
as `Y2lz...`, the bot decodes `ciscospark://us/ROOM/<uuid>` and uses only the raw
UUID in MongoDB and OpenFGA.

## Configuration

Non-secret configuration belongs in Helm values or compose environment:

- `WEBEX_WORKSPACE_ALIAS` or `WEBEX_WORKSPACE_ID`
- `KEYCLOAK_URL`
- `KEYCLOAK_REALM`
- `OPENFGA_HTTP`
- `OPENFGA_STORE_NAME`
- `WEBEX_AGENT_ROUTES_MODE`
- `WEBEX_ADMIN_API_ENABLED`
- `WEBEX_ADMIN_JWT_ISSUER`
- `WEBEX_ADMIN_JWKS_URL`
- `WEBEX_ADMIN_API_AUDIENCE`

Sensitive values belong in Kubernetes Secrets, ExternalSecrets, or local `.env`
only:

- `WEBEX_INTEGRATION_BOT_ACCESS_TOKEN`
- `WEBEX_WEBHOOK_SECRET` or `WEBEX_SIGNING_SECRET`
- `KEYCLOAK_WEBEX_BOT_CLIENT_SECRET`
- `WEBEX_BOT_ADMIN_CLIENT_SECRET`
- `MONGODB_URI`

Do not put real Webex tokens, Keycloak client secrets, or MongoDB credentials in
chart values or documentation.

## Diagnostics

Use **Admin → Integrations → Webex** to inspect:

- active space-to-team mappings
- route listen mode, priority, and enabled state
- OpenFGA `webex_space` grants
- Mongo/OpenFGA drift
- bot runtime route-cache status
- reload and sync-from-config results

Common denial reasons:

| Reason | Meaning |
| --- | --- |
| `WEBEX_USER_NOT_LINKED` | Webex person is not linked to a Keycloak user |
| `WEBEX_SPACE_TEAM_NOT_FOUND` | Space has no active CAIPE team mapping |
| `WEBEX_WORKSPACE_UNCONFIGURED` | No trusted workspace alias/id is configured |
| `WEBEX_OBO_FAILED` | Keycloak token exchange or active-team scoping failed |
| `WEBEX_ROUTE_DENIED` | No enabled OpenFGA-backed route can handle the message |
| `missing_space_grant` | The Webex space lacks the selected resource grant |
| `pdp_unavailable` | UI BFF/OpenFGA decision path is unavailable |
