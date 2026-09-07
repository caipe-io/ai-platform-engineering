# Using RBAC in Practice

How to bring up the stack, log in as different roles, verify denials, run the demo, and answer the questions you'll inevitably get from teammates. For the architecture and request flows, see [Architecture](./architecture.md) and [Workflows](./workflows.md).

---

## Start the Stack

```bash
COMPOSE_PROFILES='rbac,caipe-ui,caipe-mongodb' \
  docker compose -f docker-compose.dev.yaml up -d

# Confirm Keycloak is healthy before logging in
docker compose -f docker-compose.dev.yaml ps keycloak
```

## Conversation History Compatibility

Chat API routes accept both UUID conversation IDs and bounded legacy opaque IDs.
This keeps history created before server-owned UUID generation readable and
manageable. The identifier is only used for an exact record lookup; the normal
conversation authorization check still runs after the record is loaded for
every read, update, archive, restore, bookmark, share, and message operation.

Keycloak admin console: `http://localhost:7080/admin` (admin / admin)

When the `rbac` profile is selected, `caipe-ui` has an optional `depends_on`
health dependency on `keycloak`. This keeps UI startup seed/scope sync from
racing Keycloak realm import while preserving non-RBAC UI runs where Keycloak is
not selected.

The local `.env` mirrors the Grid RBAC defaults that affect auth behavior:
`KEYCLOAK_FORCE_IDP_REDIRECT=true`, `OIDC_GROUP_CLAIM=members,groups`,
deployment-specific access/admin group settings, and the RAG ingestor
`INGESTOR_OIDC_*` client-credentials settings. The compose `keycloak-init` service passes
`KEYCLOAK_FORCE_IDP_REDIRECT` through to `charts/ai-platform-engineering/charts/keycloak/scripts/init-idp.sh`, so a
fresh `rbac` profile start configures the same IdP-only app-realm login path as
the Helm deployment. `OIDC_GROUP_CLAIM` and upstream access/admin group settings
feed identity sync and team membership reconciliation; RAG runtime authorization
does not map AD/OIDC groups directly to datasource roles.

On login, `OIDC_REQUIRED_GROUP` is still the Web UI admission gate, but product
authorization is OpenFGA. A user who passes that group is automatically
reconciled to `member organization:<org_key>` plus read access to
`system_config:platform_settings`, restoring baseline Chat, RAG health/query
entry, and built-in skill catalog access after the OpenFGA cutover. A user in
`OIDC_REQUIRED_ADMIN_GROUP` is reconciled to durable OpenFGA admin tuples. Users
outside `OIDC_REQUIRED_GROUP` are not bootstrapped.

### Identity Group Sync Preview

Open **Admin → Teams & Users → Identity Groups** to review upstream OIDC claim
groups before applying any team changes. **Suggest from my groups** uses the
server-side cached groups from the current admin session and shows a dry-run
summary. When all detected groups are already represented, the preview stays
read-only and lists the detected groups with counts for detected, already
represented, and unmatched groups instead of showing an empty "nothing happened"
state. Unmatched groups mean no enabled sync rule matched that upstream group.

Use **Manual dry-run** only to test a hand-entered upstream group name and one
example member email. Manual preview sends the group to the backend dry-run API
with the configured provider so the server evaluates the real enabled sync rules,
current teams, and current membership sources. It does not apply changes.

The baseline Users tab is self-scoped for non-admins: the list API returns only
the caller's own Keycloak row when OpenFGA allows
`admin_surface:users#can_read`, and the detail modal opens records through
`user_profile:<id>#can_read`. Team owners and team admins can manage membership
and Knowledge Base grants for teams where they hold a scoped team role; unrelated
teams and platform-wide user operations remain admin-only. The baseline Metrics &
Health category exposes Health to members through
`admin_surface:health#can_read`; Metrics and Authorization Insights require
administrator access. Baseline members also get scoped Insights (Statistics and
Feedback) plus configured-only Slack and Webex integration views. Those views
return only the member's own web activity and connected resources available to
the member or one of their teams. The Settings → Skills tab
shows configured Skill Hubs read-only through `admin_surface:skills#can_read`;
adding, refreshing, editing, or deleting hubs requires
`admin_surface:skills#can_manage`.

For local ReBAC testing, the browser authenticates to the Web UI backend, the
backend enforces OpenFGA for KB/Data Sources/RAG MCP screens, and then
`caipe-ui` forwards the Keycloak bearer token to RAG. RAG validates the token
against Keycloak and repeats OpenFGA checks for direct API/MCP requests. Non-admin
datasource lists and search/MCP invocations are constrained to the caller's
readable `data_source:<id>` relationships before the proxy call and again in
RAG. Grant Data Sources tab administration through **Settings → Knowledge Bases**, which writes
`team:<slug>#member manager admin_surface:rag_datasources`. Configure individual
datasource read/ingest/admin grants through **Settings → Knowledge Bases** or the
Team Knowledge Base assignment UI; both write
`team:<slug>#member reader|ingestor|manager data_source:<datasource_id>`.
Team owners/admins may update grants for their own team. Platform admins still
need the concrete OpenFGA `data_source:<id>#can_ingest` or
`#can_manage` decision for datasource operations such as re-ingest; session
`role=admin` is not a bypass.

### Local Dev Auth Provider

For local development without Keycloak/SSO, the Web UI uses a dedicated dev auth
provider instead of scattering one-off bypass checks through route handlers. The
provider is enabled only outside production when all of these are true:

```bash
SSO_ENABLED=false
ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED=true
CAIPE_UNSAFE_RBAC_BYPASS=true
```

When enabled, `ui/src/lib/auth/dev-auth-provider.ts` supplies a stable local
admin principal (`anonymous@local`, `sub=anonymous-local-dev`) to Web UI API
middleware, admin tab gates, and RAG proxy calls. Authorization helpers still
emit the prominent **No Auth** warning, and the top bar shows the **No Auth**
indicator. Treat all UI and RAG operations in this mode as admin-capable, and
never enable it in staging or production.

`CAIPE_UNSAFE_RBAC_BYPASS=true` remains an emergency PDP bypass for development,
but new UI auth paths should consume the dev auth provider rather than checking
the env var directly.

> **Heads-up: `caipe-ui` host port is hard-pinned to `3000`.** Keycloak's `caipe-ui` client only allow-lists `http://localhost:3000/*` as a redirect URI (see `deploy/keycloak/realm-config.json`). Remapping the UI breaks the OIDC redirect dance and login fails with `Invalid redirect_uri`. The spec-102 e2e lane (`make test-rbac-up`) honours this — it remaps Mongo (`28017`) to a `28xxx` band, but leaves `caipe-ui:3000` and Keycloak (`7080/7443`) untouched. See [spec 102 quickstart › E2E port band](../../specs/102-comprehensive-rbac-tests-and-completion/quickstart.md#e2e-port-band) for the full table and env-var contract.

---

## Optional Test Users (`caipe` realm)

Shared and production realms should not contain sample password users. The
Keycloak Helm chart disables them by default with `keycloak.demoUsers.enabled=false`.
Enable demo users only in an isolated local/CI RBAC test stack.

| Username | Password | Roles | Boundary to test |
|----------|----------|-------|-----------------|
| `admin-user` | `admin` | admin, chat_user | Full admin UI access |
| `standard-user` | `standard` | chat_user, team_member | Chat only, no admin UI |
| `kb-admin-user` | `kbadmin` | chat_user, team_member, kb_admin | RAG management |
| `denied-user` | `denied` | (none) | 403 on all protected routes |
| `org-b-user` | `orgb` | chat_user (tenant: globex) | Tenant isolation — sees only Globex data |

---

## Default Local Logins (`setup-caipe.sh`, no upstream IdP)

`setup-caipe.sh` is the integration-test harness for the published Helm charts:
it must bring the **full RBAC stack up with zero Cisco config and zero external
SSO**. The in-chart Keycloak realm ships no human password users, so a vanilla
install would have nobody who can sign in. To keep the default loginable — and
to let you exercise **both** RBAC paths out of the box — the script
auto-provisions two local Keycloak users:

| User | Email (default) | In `BOOTSTRAP_ADMIN_EMAILS`? | Result |
|------|-----------------|------------------------------|--------|
| **Admin** | `admin@caipe.local` | yes | org-admin: admin UI + OpenFGA super-admin tuple on first login |
| **Standard** | `user@caipe.local` | no | non-admin: baseline chat access, denied the admin UI |

Because the default realm has no app-specific realm roles and no admission group
gate, the only difference between the two is membership in
`BOOTSTRAP_ADMIN_EMAILS` — making `user@caipe.local` a faithful "standard user
denied admin" test subject. Both are provisioned whenever **all** of the
following hold (no flag required):

- the RBAC runtime is enabled (`--rbac-runtime`),
- a non-IP DNS domain is set (`--domain=<host>`, e.g. the default
  `caipe.local.me`) so the OIDC issuer is browser-reachable, and
- **no upstream IdP is brokered** (no `IDP_ISSUER` in a `--ui-env-file`/`--env-file`).

What it wires up automatically (all derived from `--domain`, no `.env` needed):

| Setting | Value | Where |
|---------|-------|-------|
| `OIDC_ISSUER` | `https://<domain>/realms/caipe` | `caipe-ui` config |
| `NEXTAUTH_URL` | `https://<domain>` | `caipe-ui` config |
| `openfga-authz-bridge` token issuer | `https://<domain>/realms/caipe` | authz-bridge |
| `NEXTAUTH_SECRET` + `caipe-ui` client secret | generated / `caipe-ui-dev-secret` | `caipe-ui-secret` |
| `BOOTSTRAP_ADMIN_EMAILS` | local **admin** email only | `caipe-ui` config |
| Admin realm user | `admin@caipe.local` (password printed at end) | `caipe-local-admin` Secret |
| Standard realm user | `user@caipe.local` (password printed at end) | `caipe-local-user` Secret |

The admin email is fed into `BOOTSTRAP_ADMIN_EMAILS`, so on first login the BFF
JWT callback grants it org-admin and reconciles the OpenFGA super-admin tuple —
giving you a working admin session to exercise RBAC end-to-end. The standard user
is deliberately left out of `BOOTSTRAP_ADMIN_EMAILS`, so it logs in with baseline
access only and is denied the admin UI. Both credentials are printed in the
post-install summary and persisted (idempotent re-runs reuse them):

```bash
kubectl get secret caipe-local-admin -n caipe -o jsonpath='{.data.password}' | base64 -d
kubectl get secret caipe-local-user  -n caipe -o jsonpath='{.data.password}' | base64 -d
```

Or re-print both logins (email + password + UI URL) any time without scrolling
back through the install log:

```bash
./setup-caipe.sh creds
```

Flags:
- `--no-local-admin` (skip the admin — only when brokering an upstream IdP or
  GitHub social login), `--local-admin=<email>`, `--local-admin-password=<pw>`.
- `--no-local-user` (skip the non-admin user), `--local-user=<email>`,
  `--local-user-password=<pw>`.

> This path is for **local/CI integration testing only**. Shared and production
> realms should broker a real upstream IdP and must not rely on local password
> users.

---

## Verify Role Enforcement

```bash
# Login as denied-user, try to hit a protected API directly
TOKEN=$(curl -s -X POST http://localhost:7080/realms/caipe/protocol/openid-connect/token \
  -d "grant_type=password&client_id=caipe-ui&client_secret=caipe-ui-dev-secret&username=denied-user&password=denied" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/.well-known/agent.json
# → 200 (public endpoint)

curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/rag/v1/query
# → 403 (AgentGateway ext_authz/OpenFGA denies)
```

---

## Verify ReBAC Transition Mode

Use the engineer-facing enforcement comparison endpoint to prove stale
resource-specific realm roles do not allow access once a resource type is
marked `rebac_enforced`. This migration check is not exposed in the admin UI.

```bash
curl -s -X POST http://localhost:3000/api/rbac/enforcement-comparison \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": {"type":"user","id":"alice"},
    "resource": {"type":"agent","id":"incident-agent"},
    "action": "use",
    "realm_roles": ["agent_user:incident-agent"]
  }' | python3 -m json.tool
```

Expected result for `agent=rebac_enforced`: `legacy.allowed=false`,
`legacy.ignored_roles=["agent_user:incident-agent"]`, and
`effective.source="rebac"`.

To inspect the live OpenFGA policy graph, open **Admin → Security & Policy →
OpenFGA → Policy Graph**. The default **Team/resource relationships** layer keeps
the graph team-centered: select a team scope, then select resources from the live
palette to draw the relevant tuple edges. Use **Effective access for selected
user** only after choosing a user, and use **Authorization model topology** as a
diagnostic model view. The UI does not overlay every layer at once; each mode is
scoped to one operator question. In the model view, resource-type nodes appear
first, and selecting resources in the palette expands compact relation and
permission stacks for the matching resource types. Concrete live resource cards
stay in the team/resource and effective-access layers, so the topology remains an
overview instead of a wall of repeated relation nodes. The graph uses the universal
resource catalog/action model, so new resource types appear in the palette and
topology without adding graph-specific constants.

---

## Demo Walkthrough — Prove Every Gate

This script exercises **all three RBAC outcomes** at AgentGateway: `200` (ext_authz allow), `403` (ext_authz deny), `401` (jwtAuth reject). It's the cleanest live demo of the system because it shows you *which layer* fired in each case.

```bash
# 1) Get a real chat_user token from Keycloak (no UI involved)
TOKEN=$(curl -s -X POST http://localhost:7080/realms/caipe/protocol/openid-connect/token \
  -d 'grant_type=password' \
  -d 'client_id=caipe-ui' \
  -d 'client_secret=caipe-ui-dev-secret' \
  -d 'username=standard-user' \
  -d 'password=standard' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# 2) Inspect the claims — prove iss, aud, roles match AG's jwtAuth expectations
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool \
  | grep -E '"(iss|aud|exp|realm_access)"'

# 3) Call AG with a valid token → ext_authz allows → proxied to RAG MCP
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST http://localhost:4000/rag/v1/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"hello"}'
# → HTTP 200 (jwtAuth passed, OpenFGA allows)

# 4) Call AG with a denied-user token → ext_authz evaluates → 403
DENIED=$(curl -s -X POST http://localhost:7080/realms/caipe/protocol/openid-connect/token \
  -d 'grant_type=password&client_id=caipe-ui&client_secret=caipe-ui-dev-secret' \
  -d 'username=denied-user&password=denied' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $DENIED" \
  http://localhost:4000/rag/v1/query
# → HTTP 403 (jwtAuth passed — denied-user is authenticated — but OpenFGA denies)

# 5) Call AG with a forged token → jwtAuth rejects before ext_authz even runs
FORGED_JWT="not.a.real.jwt"
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $FORGED_JWT" \
  http://localhost:4000/rag/v1/query
# → HTTP 401 (signature verification fails against JWKS)

# 6) Show live config as AG sees it
curl -s http://localhost:15000/config | python3 -m json.tool | head -40
```

The three outcomes (200, 403, 401) map directly onto the distinct layers in the [per-request authorization diagram](./workflows.md#per-request-authorization-end-to-end): **ext_authz allow**, **ext_authz deny**, and **jwtAuth reject**.

---

## Enable Dynamic Agents Auth

`AUTH_ENABLED` controls the legacy Dynamic Agents user-context dependency. The
layered execution PDP also requires validated bearer identity at runtime and an
OpenFGA store with agent-use tuples. To test the full path:

```bash
# .env
AUTH_ENABLED=true
OIDC_ISSUER=http://localhost:7080/realms/caipe
OIDC_CLIENT_ID=caipe-ui
OIDC_REQUIRED_GROUP=caipe-users
DA_REQUIRE_BEARER=true
OPENFGA_HTTP=http://openfga:8080
OPENFGA_STORE_NAME=caipe-openfga
```

Dynamic Agents no longer uses `OIDC_REQUIRED_DYNAMIC_AGENTS_GROUP` or
admin-only UI checks as an authorization gate. The top navigation shows
**Agents** whenever Dynamic Agents are enabled with MongoDB storage, and the
`/dynamic-agents` page renders for any admitted authenticated user. The page
shows Agents, MCP Servers, and LLM Models for admitted users, and also shows
Conversations for callers with OpenFGA admin audit-log access. API calls remain
OpenFGA-filtered: non-admins can create private agents, create/onboard MCP servers when they hold an owned-server relationship,
and read seeded LLM models through `llm_model#can_read`. Seeded LLM models grant
admitted organization members `reader` and organization admins `manager` so the
model picker works without legacy session roles. Seeded and AgentGateway-synced
MCP servers grant admitted organization members read/use and invoke access, while
bootstrap admins receive `mcp_server:agentgateway#can_manage` so they can run
AgentGateway discovery/sync. System MCP servers and system LLM models are
config-driven and remain immutable even when the caller can read them.
If sync finds a legacy direct MCP row whose endpoint matches the AgentGateway
target upstream, it migrates that row in place to the AgentGateway route instead
of leaving a name collision; only genuinely different endpoints remain as manual
conflicts. Sync also refreshes OpenFGA organization-member grants for MCP rows
that are already AgentGateway-managed, so re-running sync repairs visibility for
admins and non-admins after a model/config change.

Use `OPENFGA_STORE_ID` instead of store-name discovery when your environment
pins the store id. With these settings, `POST /api/v1/chat/stream/start`,
`POST /api/v1/chat/invoke`, `POST /api/v1/chat/stream/resume`, and
`POST /api/v1/chat/stream/cancel` require `user:<sub> can_use agent:<agent_id>`
at the Web UI backend, and runtime start/invoke/resume repeat that check inside
Dynamic Agents.
If existing team data was seeded with email principals, both layers fallback to
`user:<email> can_use agent:<agent_id>` after the subject check fails.
The v1 chat routes also require write access to the target conversation using
implicit Mongo owner identity first and explicit OpenFGA `conversation:<id>`
relationships for non-owner access. Browser cookie sessions are converted back
into `Authorization: Bearer <accessToken>` when proxying to the dynamic-agents
runtime.

The RBAC Audit tab records OpenFGA results as `OpenFGA ReBAC`. Filter by type
`OpenFGA ReBAC` to see `webui_backend` `dynamic_agent#use` checks, Dynamic Agents
runtime `dynamic_agent#use` checks, AgentGateway bridge `mcp#can_call` checks, and
admin graph/check/relationship activity from the OpenFGA ReBAC panel. The Admin UI
reads audit-service, so this view works without Jaeger. To keep the
default feed useful, routine `admin_ui#view` checks are hidden unless the user
explicitly selects the `Authorization` type filter. The same default filter
applies to `admin_ui#audit.view` checks generated while viewing the audit page.

Use **Admin → Security & Policy → OpenFGA ReBAC → Access Manager** to check and
author access from one catalog-driven form without hand-writing tuple strings.
Pick a subject type (`team`, named `user`, Slack channel, Webex space, external
group, or service account), search/select the concrete subject, then pick any
universal ReBAC resource type from the catalog and one of that type's supported
actions. The panel shows the derived `can_*` check preview, a staged change-set
preview, and the operator-facing permission cheatsheet for base relationships.
Common debug paths include `team:<slug>#member can_use agent:<id>`,
`slack_channel:<workspace>--<channel> can_call tool:<server>/<tool>`, and
`user:<sub> can_call mcp_gateway:list`. When a check is denied and the current
operator has admin rights, **Grant this access** creates and applies a staged
change set for the selected base relationship, then re-runs the check. When a
check is allowed, admins can use **Revoke this access** from the same panel.

Use **Admin → Security & Policy → OpenFGA ReBAC → Default FGA Grants** to manage
the default OpenFGA grant profiles for organization members and admins. These
profiles are templates: saving or reconciling them materializes concrete
OpenFGA tuples, such as `user:<sub> reader admin_surface:users`, during login or
all-user reconciliation. The card below it, **OpenFGA Store: Catalog & Live
Relationships**, is read-only and shows the live authorization store available
to operators: resource types and supported actions from the ReBAC catalog,
discovered runtime resources, grouped relationship families, and all OpenFGA
tuples fetched through pagination. Use this when you need to audit what
relationships exist in the store, regardless of whether they came from login
defaults, team/resource grants, or direct admin changes.

Use **Admin → Security & Policy → OpenFGA ReBAC → Diagnostics** to compare one
Keycloak subject against the default member and admin OpenFGA baselines. This is
the fastest way to verify first-login or bootstrap tuple repair: a normal member
should match the member baseline for `organization:<org>#can_use`,
`user_profile:<sub>#can_read`, and read-only
`admin_surface:<users|teams|skills|slack|webex|feedback|stats|health>#can_read`, while admin-only
checks such as `organization:<org>#can_manage` should drift from the member
baseline but match the admin baseline.

Use the subtle **View as** control beside the Admin heading to
preview the Admin console as a real OpenFGA principal. The modal searches users by
email/name/Keycloak subject and teams by name/slug, with a `member`/`admin`
userset relation for team previews. The preview is read-only: tab visibility is
evaluated as the selected `user:<sub>` or `team:<slug>#relation`, but the browser
session remains the signed-in admin and all mutation controls are disabled.
Configured Slack channels, Webex spaces, Statistics, and Feedback are scoped to
that same simulated subject, including concrete resources it owns or receives
through a team grant. Use this to answer "what would this manager see?" before granting
or revoking relationships in Access Manager.

Use **Admin → Security & Policy → OpenFGA ReBAC → Policy Graph** to inspect the
same relationships visually without starting from the full tuple blast radius.
The graph starts with teams and team usersets only; direct user nodes remain
hidden unless the user filter is applied. Use named-user search for normal
operators, or enter `user:*` / `user:<uuid>` and click **Use subject** when you
need a raw OpenFGA subject; the same scope and subject controls are available
above the canvas in the viewport-contained full-screen graph dialog. The
resource palette is searchable and multi-selectable: select any catalog-backed
resource such as agents, tools, knowledge bases, Slack channels, Webex spaces,
MCP servers, or `mcp_gateway:list`, or use
**Select all shown** / **Unselect all shown** against the current palette search
results. Selected catalog resources render on the canvas even before they have
existing OpenFGA relationships, so admins can drag/connect staged grants from a
clean starting point. Conversation resources are intentionally represented as
the typed wildcard `conversation:*` instead of one node per chat history to keep
the catalog and graph operationally readable. Slack channel → team and Webex
space → team ownership edges are shown as dashed, read-only routing metadata
from MongoDB mappings; they explain dispatch context but are not revocable
OpenFGA tuples from the graph editor. Knowledge-base entries use the canonical
RAG datasource display name when the RAG catalog is reachable, while the immutable
`knowledge_base:<datasource_id>` object remains visible as secondary text for
audits. The raw node and edge inventory sits below the graph and is collapsed by
default so operators can keep the canvas focused while still auditing the
underlying tuple list when needed.

### Authz Audit Storage

Authorization audit is owned by `audit-service`. UI, Dynamic Agents, bots, and
the OpenFGA bridge post JSON event batches to the service; the service owns
local/S3 storage and the Admin → Security & Policy → RBAC Audit read path. In
local dev the service uses local disk unless configured for S3. The dev compose
stack does not start a separate trace backend.

See [Architecture › Component 5: Dynamic Agents](./architecture.md#component-5-dynamic-agents--the-workshop-floor) for the full env var table and what each one does.

### Slack and Webex Onboarding

Slack channel and Webex space setup use the same guided admin path:
**Discover → Configure → Apply → Verify**. The discovery step lists Slack
bot-member channels and Webex bot-visible spaces with row-level readiness labels:

- **Setup completed** means the channel/space is already known to CAIPE; selecting
  it refreshes grants and routes.
- **Needs setup** means the bot can see the channel/space, but CAIPE still needs
  to import it, bind a team, grant the selected Dynamic Agent, and create route
  metadata.
- **Blocked** means the selected row is missing a team or Dynamic Agent and cannot
  be applied yet.

Use the outcome button (`Set up selected Slack channels` or `Set up selected
Webex spaces`) after every selected row has a team and Dynamic Agent. The apply
step flips successfully applied discovery rows back to **Setup completed** in the
table, so admins can see the setup state change without opening a separate result
dialog. Use **Refresh setup status** to re-run discovery and reconcile the row
colors against the latest bot-member/bot-visible state. The operation is intentionally
upsert-only: existing UI-managed or config-synced route metadata is preserved
while missing grants and default routes are ensured.

Slack bulk migrations can reuse the running Slackbot's loaded static channel
config as a convenience only. **Use existing Slackbot channel agents as defaults**
is checked by default in the Slack onboarding default selector. When checked,
discovery calls the Slack bot admin config-defaults endpoint and preselects each
row's Dynamic Agent from the legacy channel config when that agent still exists
in CAIPE. If the legacy agent is missing, or the admin unchecks the box, the row
falls back to the saved onboarding Dynamic Agent, then to the first enabled
Dynamic Agent alphabetically. A channel that only exists in legacy Slackbot YAML
still shows **Needs setup** until CAIPE has the team mapping, OpenFGA grants, and
route metadata required by the RBAC runtime.

---

## Backfill OpenFGA Relationships

After enabling the Dynamic Agent execution gate, run the OpenFGA relationship
backfill so existing team/resource assignments and the configured default agent
are represented in the OpenFGA graph.

Dry-run first:

```bash
MONGODB_URI=mongodb://localhost:27017 \
MONGODB_DATABASE=caipe \
OPENFGA_HTTP=http://localhost:8080 \
OPENFGA_STORE_NAME=caipe-openfga \
APPLY=false \
npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-universal-rebac.ts
```

Review the JSON summary for planned tuples, skipped identifiers, unmapped users,
and `defaultAgent`. If a dynamic default agent is configured, the active model
must allow `user:*` on `agent.can_use` and the summary should include the
default-agent grant.

The Web UI now also keeps that default-agent grant warm during normal operation:
saving **Settings → Default Agent** writes `user:* user agent:<id>` for the new
default and removes the prior default grant, while login bootstrap and the
chat-available agent picker repair the current configured default if the tuple is
missing. The picker also repairs `user:* user agent:<id>` for enabled Dynamic
Agents whose visibility is `global`, so non-admin users can see global agents
through OpenFGA even if the historical backfill has not run yet. The backfill
remains useful for one-time reconciliation and provenance, but users should not
need a manual OpenFGA grant to see the configured default or global Dynamic
Agents.

Before applying in an environment that already has team members, make sure users
have logged in at least once through CAIPE so `users.keycloak_sub` is populated.
The backfill uses that persisted Keycloak subject for `user:<sub>
member/admin team:<slug>` tuples; email is only a compatibility fallback.

Apply once:

```bash
MONGODB_URI=mongodb://localhost:27017 \
MONGODB_DATABASE=caipe \
OPENFGA_HTTP=http://localhost:8080 \
OPENFGA_STORE_NAME=caipe-openfga \
APPLY=true \
npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-universal-rebac.ts
```

The script records completion in MongoDB `rbac_migrations` with
`_id=openfga_relationship_backfill_v1`. Re-running with `APPLY=true` exits
without rewriting when that completed record exists. Use `FORCE=true` only when
intentionally reconciling again.

The migration writes:

- `user:<sub> member/admin team:<slug>` from team members.
- Team resource tuples for agents, tools, knowledge bases, skills, and tasks.
- `user:* can_use agent:<default_agent_id>` when the configured default is a
  dynamic agent.
- Mongo provenance in `team_membership_sources` and `rebac_relationships`.

Then backfill per-agent MCP tool restrictions so existing Dynamic Agents match
the enforcement that new agent create/update calls write automatically:

```bash
# Dry-run first
MONGODB_URI=mongodb://localhost:27017 \
MONGODB_DATABASE=caipe \
npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-agent-tool-openfga.ts

# Apply after reviewing planned tuples. Apply mode reconciles existing
# agent-scoped tool tuples, including deleting stale wildcard grants that are
# no longer present in dynamic_agents.allowed_tools.
MONGODB_URI=mongodb://localhost:27017 \
MONGODB_DATABASE=caipe \
OPENFGA_HTTP=http://localhost:8080 \
OPENFGA_STORE_NAME=caipe-openfga \
npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-agent-tool-openfga.ts --apply
```

This reconciles `agent:<agent_id> can_call tool:<server>/<tool>` tuples from
each agent's `allowed_tools`; empty tool arrays become `tool:<server>/*`, and
OpenFGA tuples for removed tools are deleted during apply mode.

### Admin Migration Cards

Admins can run schema-versioned migrations from **Admin → System → Migrations**.
The runtime seeds a DB-managed `migration_manifest`, compares it with
`data_schema_versions`, and shows every MongoDB collection with its current
recorded version. Collections without a `data_schema_versions` row show
`unknown`; collections that have a registered migration target also show the
runtime target version. By default the version grid shows only collections that
need migration; use **Show collections without pending migrations** to reveal the
full DB inventory. When unversioned schema areas exist, the tab shows a
version-only bootstrap hint. **Select all version-only migrations** initializes
the selected `data_schema_versions` rows to `v1` without modifying any collection
documents, giving future release migrations a known baseline. The authenticated
header alert links admins back to this tab when either blocking migrations are
pending or version metadata needs initialization. The migration list below the
version grid shows only active pending/failed migrations by default. Use
**Show completed migrations** to review completed cards backed by
`schema_migrations`. Admins can select individual pending migrations or use
**Select all pending migrations**, run **Dry run selected**, copy the bulk
confirmation phrase `APPLY SELECTED MIGRATIONS`, and apply the selected
migrations in manifest order. Single migration cards still support their
per-migration dry-run and exact confirmation flow.
If an environment upgrades across multiple releases, every required migration
whose target version is newer than the collection's current DB version is
surfaced.

Developers adding a MongoDB collection must update
`ui/src/lib/rbac/migrations/schema-area-classifications.ts` in the same change.
Each schema area must be classified as `baseline_v1`, `migration`, `metadata`, or
`intentionally_unversioned`; the registry guardrail test fails when a migration
target lacks a classification. Use `baseline_v1` for new collections that do not
need a data migration yet, and add a proper migration definition when persisted
data shape or authorization semantics change.

Bootstrap admins see a persistent **Migrations required** alert beside the header
connection status while blocking required migrations are pending, or
**Version metadata needed** when collections need the v1 metadata baseline. These
alerts are not dismissible; they clear when migrations complete or version
metadata is initialized. A bootstrap admin can record a break-glass override from
the migration tab by entering a reason. Overrides are stored in
`migration_overrides`, are time-boxed, and change the blocking migration alert to
**Migration override active** until the schema catches up or the override expires.

Release notes notifications are managed from **Admin → System → Settings →
Release notes**. Admins can enable the notification, set the active release
version, show a toast reminder, preview the dialog, and use **Show this on next
login for every user** to bump the announcement revision. Dismissals are stored
by announcement ID, so a new revision is shown again even when users dismissed a
previous revision. Admins can optionally show an **Open Migration Assistant**
action that deep-links to the Migrations tab; non-admins see feature notes only
and can permanently dismiss the active announcement.

### Keycloak Invariants Panel

**Admin → Security & Policy → Keycloak** renders both the runtime reconciliation
state and a **Keycloak Invariants** section that validates the realm against the
specific provisioning steps owned by `init-idp.sh`,
`init-token-exchange.sh`, and the BFF startup migration. Each invariant is a
named pass / fail / unknown check with a remediation hint:

> **Phase 3 demolition note (spec 2026-05-24-derive-team-from-channel).**
> The `team-scope` family of invariants, the targeted "Reconcile
> active-team scope" heal surface, the `team-scope matrix` view, the
> `team_personal.dm_mode_known_limitation` advisory, the
> `audience.<client>.single_team_default` invariant, the
> `KEYCLOAK_RBAC_ACTIVE_TEAM_SLUG` env var, the
> `POST /api/admin/keycloak/active-team-scope` route, and the
> `Reconcile active-team scope` picker have all been deleted. The
> `active_team` mechanism never shipped to production, so no realm
> has legacy `team-*` scopes to clean up. Team identity is now derived
> from `channel_team_mappings` at request time and Keycloak no longer
> participates.

**Plain-English explainer tooltip.** The machine IDs are accurate but
cryptic to a human (e.g. `obo.token_exchange.shared_audience.affirmative`,
`obo.users_impersonate.exists`). Every row renders a
small `HelpCircle` affordance next to its description; hovering it (or
focusing it via the keyboard) opens a tooltip with a decoded title and a
two- to four-sentence body explaining **what the check verifies**, **why
it matters**, and **what breaks if it fails**. The decoder lives at
`ui/src/components/admin/invariant-explanations.ts` and is unit-tested
against every ID family emitted by `keycloak-invariants.ts` so a
generic "no explanation registered" fallback should never reach
production. The decoded title is also embedded in the affordance's
`aria-label`, so screen reader and keyboard users get the same context
without needing to fire the hover.

The wording style policy is **"keep both technical and plain-English"**.
Every tooltip body keeps the technical names — `OBO`, `token exchange`,
`scope-permission`, `policy` / `type=client`, `AFFIRMATIVE` /
`UNANIMOUS`, `service account`, `client scope`, team `slug`, `protocol
mapper`, `caipe-platform`, `RFC 8693` — so
engineers can grep them and so the prose matches the raw invariant ID
already rendered in monospace right below the description. But each
unavoidable term is given a one-shot plain-English gloss on first
mention in the same body, in the shape `term (plain-English
definition)` — for example "OBO (on-behalf-of, i.e. the bot acting as
a real user)", "slug (a short, URL-safe team name like `platform` or
`eti-sre-admin`)", "protocol mapper (a small Keycloak rule that
injects an extra claim — a labeled field — into the issued token)".
Each body opens with a plain-English "This row checks that…" / "This
is an *advisory* row…" / "Same as…" lead sentence and closes with a
plain-English "what breaks if it's red" sentence. The
`technical-term + plain-English gloss pairings` block in
`invariant-explanations.test.ts` pins ~15 of these pairings as
regression tests, so a future copy edit that strips the plain-English
half (e.g. just leaves "OBO" without "(on-behalf-of, …)") fails CI
before it ships.

**Plain-English explainer tooltips also cover migration warnings.**
The Keycloak panel surfaces the amber "Bootstrap admin reconciliation
failed for N email(s)" bar (when one or more entries in
`BOOTSTRAP_ADMIN_EMAILS` couldn't be seeded as realm admins) and a
general "Warnings" bar for any other reconciliation issue. Both
surfaces follow the same explainer pattern as the invariant rows:

- Each individual warning row carries a `?` HelpCircle next to the
  raw text; hovering it shows a 2- to 4-sentence body explaining
  what the warning means, why it fires, and **what the system did
  instead**. The body is followed by a "How to fix:" line with a
  concrete action, including example env-var values.
- The "Bootstrap admin reconciliation failed" header has its own
  `?` HelpCircle that explains the *concept* — what
  `BOOTSTRAP_ADMIN_EMAILS` is for, why a brand-new deployment with
  an empty Keycloak realm depends on it to avoid being locked out,
  and that failed rows are non-blocking — independent of any
  specific failed email.

The decoder lives at `ui/src/components/admin/warning-explanations.ts`
and is pattern-matched (not exact-match) so the captured fields
(email, error text) get interpolated into the explanation. New
warning families added to `keycloak-rbac-reconciliation.ts` or
`keycloak-bootstrap-admins.ts` must also add a matching
`WarningPattern` entry, and the unit tests in
`warning-explanations.test.ts` pin every pattern; otherwise admins
get a safe generic fallback that points the next engineer at the
file to extend.

- **Reconcile now** — the BFF migration `keycloak_rbac_mapping_reconciliation_v1`
  knows how to repair OBO permission strategy / policy attachment / service-account
  impersonation role drift. Two affordances drive the same migration:
  - **Reconcile all** at the top of the card fixes every failing
    `remediation: reconcile_now` invariant in one transaction. It also retries
    bootstrap admin email resolution and OpenFGA tuple seeding in the same pass.
  - **Fix** next to a specific failing row runs the identical migration but
    surfaces an inline "Fixing…" indicator on the originating row so admins can
    triage long lists without losing context.
- **Manual** — the invariant requires a direct edit in the Keycloak Admin
  Console. Today this only fires for *strict policy shape* checks: every
  attached policy on the shared `users.impersonate` and `token-exchange`
  scope-permissions must be `type=client` with a non-empty `clients` allow-list.
  A `js` / `role` / empty-`clients` policy gives an admin a permissive single
  PERMIT under the AFFIRMATIVE decision strategy, so the panel asks an operator
  to remove it explicitly rather than auto-rewriting.
**Admin-only header alert.** Admins do not have to be on the Keycloak tab
to notice a regression. The right-hand cluster of the global `AppHeader`
renders a single admin-only `Alerts: <N>` pill whenever one or more
admin-side conditions are active. Today those conditions are:

- **Keycloak connection/admin issue** — Keycloak is configured but either
  the service is unreachable, the Web UI backend's Keycloak Admin API token
  is forbidden, or reconciliation is failing before invariants can be
  evaluated (red severity). The Keycloak tab labels these separately so a
  `403 Forbidden` admin-permission failure is not shown as a network outage.
- **Migrations required** — one or more blocking migrations are pending
  (red severity).
- **Keycloak invariants failing** — at least one realm invariant is
  failing (amber severity).
- **Version metadata needed** — collections need v1 initialization
  (amber severity).
- **Migration override active** — non-blocking override is in effect
  (amber severity).

The pill collapses what used to be four separate chips so the right-hand
cluster stays compact even when several subsystems flag issues
simultaneously. Specifically:

- It renders **only for admin users** (`useAdminRole` short-circuits both
  the client polling hook and the pill itself; non-admin sessions never
  call the summary endpoint).
- The Keycloak health hook polls
  `/api/admin/keycloak/migration-health/summary` every 60 s. The endpoint
  shares an in-process 60 s TTL cache, so repeated polls do not trigger a
  Keycloak Admin API round-trip and the existing full-fat panel is
  unaffected.
- **Color follows severity:** if any active source is red the whole pill
  is red, otherwise it is amber. The icon is a single `AlertTriangle`
  regardless of source.
- **Total count** is the sum of each source's count
  (`blocking_required_count`, `invariants.failing`,
  `version_bootstrap_required_count`, and `1` for sourceless conditions
  like "Keycloak admin API authorization failed", "Keycloak unreachable",
  or "override active").
- **Hover / aria-label** shows a per-source breakdown
  (`Migrations required: 2 · Keycloak invariants failing: 4 · …`) so a
  screen reader or hover user can see the individual contributions before
  even opening the popover.
- **Click opens a popover** listing every active alert as its own row,
  each with a severity dot (red / amber), the source label, the source's
  count, and a chevron. Each row is a **`<button>` that navigates
  programmatically** via `useRouter().push()` and then closes the
  popover (`setAlertsPopoverOpen(false)`) — *not* an `<a>` element.
  This is a deliberate fix for the "clicking the alert doesn't do
  anything" regression: when the rows were anchors inside the popover,
  Radix Popover's outside-click listener would unmount the floating
  layer on `mousedown`, taking the `<a>` with it before the browser
  could dispatch the click and follow the href, so the user saw the
  popover dismiss but the route never changed. Programmatic navigation
  side-steps that race entirely. The unsaved-changes guard is preserved
  manually: if `hasUnsavedChanges` is true we route through
  `requestNavigation(href)` (which raises the discard dialog) instead
  of pushing directly. Destinations are source-specific —
  Keycloak sources → `?cat=security&tab=keycloak`, migration sources →
  `?cat=security&tab=migrations`. The earlier "single deep-link to the
  highest-severity source" behavior was removed: it silently hid the
  lower-severity alerts and produced confusing no-ops when the user
  was already on the destination tab.

The summary endpoint returns only the booleans and counts the pill
needs; it does not leak the full `keycloak_values` payload to anything
that polls the header. Admins still navigate into the Keycloak tab for a
fresh, uncached, fully-detailed read.

**Copy buttons for filing tickets.** Every error surface in the panel is
copyable rather than screenshot-only, so admins can paste exact diagnostic
strings into a Jira / Slack / on-call ticket without retyping:

- **Copy diagnostics** (top of the card) copies the full
  `keycloak_invariants` + `bootstrap_admins` + migration health payload as
  pretty-printed JSON.
- Each failing invariant row has a Copy icon that copies a stable, plain-text
  block (`description`, `id`, `status`, `group`, `source`, `remediation`,
  `detail`) suitable for pasting into a bug report.
- The error, warning, bootstrap admin failure, and "Reconcile applied" banners
  each have a Copy icon that copies just that banner's text or JSON payload.
- All Copy buttons work over plain HTTP / non-secure contexts via a
  `document.execCommand("copy")` fallback in addition to
  `navigator.clipboard.writeText`.

The invariant set currently covers:

| Group | Examples |
| --- | --- |
| OBO | `obo.token_exchange.*.affirmative`, `obo.token_exchange.shared_audience.{slack,webex}_policy_attached`, `obo.users_impersonate.affirmative`, `obo.users_impersonate.policies_strict`, `obo.users_impersonate.<bot>_policy_attached`, `obo.bot.<bot>.token_exchange_policy_attached`, `obo.bot.<bot>.users_impersonate_policy_attached` |
| Bot service accounts | `service_account.<bot>.impersonation_role` |

Phase 3 of spec 2026-05-24-derive-team-from-channel removed the entire
team-scope invariant family (`team_scope.<scope>.*`), the matrix view
that surfaced it (`KeycloakTeamScopeMatrix.tsx`), and the
`team_personal.dm_mode_known_limitation` advisory. The `active_team`
mechanism never shipped to production, so no realm has legacy `team-*`
scopes to clean up — the panel no longer renders a team-scope section
at all.

The evaluator is a pure function over the read-only inspection in
`ui/src/lib/rbac/keycloak-admin.ts#getKeycloakRbacDiagnosticValues`, so it
never adds round-trips to Keycloak beyond what the existing health probe
already does, and the same checks run identically in unit tests (see
`ui/src/lib/rbac/__tests__/keycloak-invariants.test.ts`). If you add a new
invariant, register it in `ui/src/lib/rbac/keycloak-invariants.ts` and add a
case to the unit tests; the panel will pick it up automatically.

The messaging additions add four cards:

- **Slack channel ReBAC grants** backfills active `slack_channel_grants` and
  route-owned `slack_channel_agent_routes` into OpenFGA tuples such as
  `slack_channel:<workspace>--<channel> user agent:<id>` and records
  `rebac_relationships` provenance.
- **Webex space ReBAC grants** mirrors that behavior for active
  `webex_space_grants` and `webex_space_agent_routes`, writing tuples such as
  `webex_space:<workspace>--<space> user agent:<id>`.
- **Messaging team mapping reconciliation** repairs missing denormalized
  `teams.slack_channels` and `teams.webex_spaces` entries from active
  `channel_team_mappings` and `webex_space_team_mappings` rows.
- **Messaging ReBAC indexes** creates the Webex messaging lookup and TTL
  indexes needed by Webex space mapping, route, grant, and link-nonce flows.

Verify the default-agent path:

```text
Check user:<any-authenticated-subject> can_use agent:<default_agent_id>
```

Expected result: allowed for the configured dynamic default agent; unrelated
agents remain denied unless the user has a direct or team-derived grant.

---

## Slack Identity Linking

**Auto mode (default):**

1. Send any message to the bot
2. Bot silently fetches your Slack email, matches it to your Keycloak account, links automatically
3. Subsequent messages: OBO exchange happens automatically — zero user action required

**Unknown email (no matching Keycloak user):**

1. If `SLACK_JIT_CREATE_USER=true` (default): the bot JIT-provisions a federated-only Keycloak shell user and links it silently — zero user action required.
2. If JIT is disabled, the domain isn't allow-listed, or JIT fails: the user is treated as unlinked (minimum-access fallback) and told to contact an admin. There is no interactive link-to-onboard path — a signed link would be redeemable by whoever holds it, not provably the intended Slack user, so it was removed as a security hole.

The full sequence (**JIT user creation** for unknown emails, what happens server-side) is in [Workflows › Slack identity linking](./workflows.md#slack-identity-linking-auto-bootstrap--jit).

---

## Slack Channel Setup

Use **Admin → Integrations → Slack → Channel Setup** when onboarding an existing Slack bot workspace. The panel is split into five subtly tinted sections so operators can follow the path from discovery to verification to import:

1. **Step 1: Discover and Setup** — use **Find Bot-Member Slack Channels** to find channels where the Slack bot is already a member, select the channels to import, and override the team or Dynamic Agent per selected channel.
2a. **Step 2a: Verify Slack Channel ReBAC** — select the channel, inspect its team scope, OpenFGA reachability, tuple counts, runtime route candidates, and fix common drift.
2b. **Step 2b: Specify agent priority** — create or edit channel-agent associations, listen mode, and priority for the selected channel.
3. **Onboarding Default Selection** — choose only the team/agent values
   preselected in the onboarding form.
5. **Advanced Setup - Import/Sync with Slackbot** — inspect bot runtime state, reload caches, preview YAML import, and apply static Slackbot route config.

Use **Admin → Teams → Slack Channels** when assigning bot-member channels to a
specific team. That tab auto-loads Slack discovery through `users.conversations`, so
the available list shows channels where the bot is already present. It requests the
first 50 matches on load, keeps search visible so admins can narrow large
workspaces, and uses **Load more** for additional pages. **Refresh bot channels**
invalidates the cache and re-runs discovery. The manual ID entry stays as a
fallback for private or newly-created channels that Slack discovery cannot return
yet.

If the Team or Dynamic Agent dropdown is empty, create the missing object in the
admin UI and reload the page. There is no implicit channel default at runtime:
each channel still needs an explicit setup action from discovery or the route
editor.

Non-admin users who have `can_manage` on one or more concrete Slack channels see
the same **Admin → Integrations → Slack** tab as a self-service channel settings
view. The list is filtered to channels they can read or manage, and the bulk
onboarding/runtime-sync sections are hidden; route edits still go through the
per-channel OpenFGA `can_manage` API checks.

For runtime onboarding of new Slack channels, set `SLACK_AUTO_ASSIGN_UNMAPPED_CHANNELS=true` on the Slack bot together with `SLACK_DEFAULT_TEAM_SLUG` and `SLACK_DEFAULT_AGENT_ID`. On the first message from an unmapped group channel, the bot creates the same channel-team mapping, OpenFGA channel-agent tuple, and route metadata for the configured defaults. Keep this off unless the default team and agent are intentionally broad enough for newly invited channels.

## Slack Bot Runtime Sync

Use **Admin → Integrations → Slack → Advanced Setup - Import/Sync with Slackbot** for advanced operations: inspect the running Slack bot's route mode/cache, **Reload Bot Cache** after UI edits, or import static Slack bot YAML config into MongoDB/OpenFGA.

The legend explains the status cards and buttons inline: **Route mode** shows whether the bot is reading database routes, YAML routes, or both; **Static config** counts routes loaded from YAML; **Route cache** shows cached runtime routes and TTL; **Refresh Runtime Status** reloads those numbers; **Reload Bot Cache** makes the running bot pick up UI route edits; **Preview YAML Import** dry-runs the YAML import; and **Import from YAML Config** writes YAML routes into CAIPE/OpenFGA.

The sync flow is upsert-only:

- **Preview YAML Import** shows how many routes would be planned from the bot's loaded static config.
- **Import from YAML Config** creates missing `slack_channel_agent_routes` rows, updates matching channel/agent route metadata, and ensures the channel-agent OpenFGA tuple exists.
- Existing UI-managed associations that are not present in static config are left in place.

Use **Step 1: Discover and Setup → Find Bot-Member Slack Channels** when the bot is already invited to Slack
channels that are not listed in static config. The UI uses Slack
`users.conversations`, then renders the association table in section 1.
Newly discovered channels are selected by default; already-managed channels are
shown but left unselected unless there are no new channels. Admins can select or
clear individual rows and choose the team and Dynamic Agent for each selected
channel.
This flow preserves existing UI-managed and config-synced route metadata; it
only imports selected channel rows, writes each selected row's channel-team
mapping, ensures channel-agent OpenFGA grants, ensures the selected team-agent
grant, reloads the
running Slack bot route cache when the admin API is reachable, and creates
missing default routes when route creation is enabled.

The discovery table marks a channel **Setup completed** only when CAIPE has both
a team assignment and an active grant for it. A channel that merely exists in
MongoDB but is missing setup still shows **Needs setup** and remains selected so
the onboarding action can finish the missing pieces.

The two workflows are complementary: run **Import from YAML Config** for explicit YAML
routes, and run **Find Bot-Member Slack Channels** to bootstrap bot-member channels
that the static config does not enumerate.

The Web UI backend must be configured with `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SLACK_BOT_ADMIN_URL`, and `SLACK_BOT_ADMIN_AUDIENCE`. The Keycloak init job enables client credentials on `caipe-ui` and adds the `caipe-slack-bot-admin` audience mapper. The Slack bot must have `SLACK_ADMIN_API_ENABLED=true`, `SLACK_ADMIN_JWT_ISSUER`, `SLACK_ADMIN_JWKS_URL` when an internal JWKS URL is needed, `SLACK_ADMIN_JWT_AUDIENCE`, and `SLACK_ADMIN_ALLOWED_CLIENT_IDS` configured. Keep the Slack bot admin API internal to the cluster; it is not a browser-facing API.

If Slack replies with `I couldn't start your CAIPE session for this channel` and bot logs show `Client not allowed to exchange`, verify the `caipe-slack-bot-token-exchange` policy is attached to all three Keycloak permissions: `caipe-slack-bot` token-exchange, users `impersonate`, and the `CAIPE_PLATFORM_AUDIENCE` target client's token-exchange permission (`caipe-platform` by default). Re-run `keycloak-init` / `keycloak-init-token-exchange` after deploying the init-script fix so existing Slack and Webex policy associations are merged instead of overwritten.

---

## Webex Spaces

Webex spaces are administered through **Admin → Integrations → Webex** and
**Admin → Teams → Webex Spaces**. They mirror Slack channel ReBAC with
Webex-specific names and storage.

Non-admin users with `can_manage` on at least one concrete Webex space also see
**Admin → Integrations → Webex** as a self-service space settings view. It lists
only spaces they can read or manage and keeps admin-only discovery/runtime-sync
operations hidden; diagnostics and repair actions continue to call the
per-space OpenFGA-protected APIs.

### Configure the Bot

Set non-secret config in chart values or compose env:

```bash
WEBEX_WORKSPACE_ALIAS=CAIPE
KEYCLOAK_URL=http://keycloak:8080
KEYCLOAK_REALM=caipe
OPENFGA_HTTP=http://openfga:8080
OPENFGA_STORE_NAME=caipe-openfga
WEBEX_AGENT_ROUTES_MODE=db_prefer
WEBEX_THREAD_CONTEXT_ENABLED=true
WEBEX_THREAD_CONTEXT_MAX_MESSAGES=10
WEBEX_THREAD_CONTEXT_MAX_CHARS=4000
WEBEX_ADMIN_API_ENABLED=true
WEBEX_ADMIN_API_AUDIENCE=caipe-webex-bot-admin
```

When `WEBEX_INTEGRATION_BOT_ACCESS_TOKEN` is present, the bot starts its Webex
WDM websocket listener at process startup. No public webhook URL is required for
local development.

Store secrets in Kubernetes Secrets, ExternalSecrets, or local `.env`:

```bash
WEBEX_INTEGRATION_BOT_ACCESS_TOKEN=...
WEBEX_WEBHOOK_SECRET=...
KEYCLOAK_WEBEX_BOT_CLIENT_SECRET=...
WEBEX_BOT_ADMIN_CLIENT_SECRET=...
MONGODB_URI=...
```

`KEYCLOAK_URL`, `OPENFGA_HTTP`, and Webex workspace alias/id are ConfigMap
values. Bot tokens, webhook secrets, client secrets, and MongoDB credentials are
secrets.

### Webex Space Setup

Use **Admin → Integrations → Webex** when onboarding Webex spaces for the bot.
The tab follows a simplified Webex operator flow:

1. **Step 1: Discover and Setup** finds spaces the bot can see through
   `GET /api/admin/webex/available-spaces?refresh=1`, which calls Webex
   `/v1/rooms` with `WEBEX_INTEGRATION_BOT_ACCESS_TOKEN`. Use **Find Webex
   Spaces with Bot Integration**, select the spaces to import, and choose the
   team and Dynamic Agent per space.
2. **Step 2a: Verify Webex Space ReBAC** selects an onboarded space and runs
   the same OpenFGA/route diagnostics the Webex runtime depends on.
3. **Onboarding Default Selection** sets only the team and Dynamic Agent
   preselected during discovery-based onboarding.
4. **Advanced Setup - Import/Sync with Webex Bot** shows runtime route mode,
   static config counts, cache state, thread-context limits, and a legend
   explaining refresh, cache reload, preview, and YAML import actions.

Discovery onboarding converges through `POST /api/admin/webex/spaces/defaults`:
CAIPE records active
`webex_space_team_mappings`, denormalises the `webex_spaces` display list on the
team document, ensures the `webex_space` OpenFGA grant for the selected Dynamic
Agent, creates missing route metadata when enabled, and invalidates the Webex
bot route cache. Existing route metadata is preserved.

Webex public room IDs (`Y2lz...`) decode to
`ciscospark://us/ROOM/<uuid>`. CAIPE uses the raw UUID as the visual and
canonical `space_id` in MongoDB and OpenFGA, then re-encodes the public room ID
only when it sends messages through the Webex API.

### Grant Agents Through Onboarding

1. Open **Admin → Integrations → Webex**.
2. Use **Step 1: Discover and Setup** for bot-visible spaces.
3. Choose the team and Dynamic Agent before applying.

The UI writes `webex_space:<workspace_alias>--<raw_room_uuid> user agent:<agent_id>`
to OpenFGA and creates default dispatch metadata in `webex_space_agent_routes`.
The Webex panel no longer exposes a separate manual priority editor; route
metadata is created through onboarding/default convergence or repaired from the
diagnostics panel. MongoDB metadata is valid only while the matching OpenFGA tuple exists.
At runtime the bot reads OpenFGA route tuples with an `agent:` object-type
filter, then joins the matching MongoDB route metadata.

The **Step 2a: Verify Webex Space ReBAC** panel checks the selected space using the same
OpenFGA tuple read shape that runtime dispatch uses. If a space has no routeable
agent, diagnostics shows **Fix missing association with `agent:<id>`** when a
default Dynamic Agent is available. Clicking it does not create a route
automatically; it prompts the admin to add the agent manually through the
space's route editor. The route editor no longer exposes `listen` or `priority`
as editable fields — every route it creates is fixed to `listen: mention`,
priority `100`, since Webex's Mercury transport only ever delivers `@mention`
events to group spaces. If a diagnostics fetch reports `fetch failed`, check
that the UI server can reach OpenFGA with `OPENFGA_HTTP` and the expected
`OPENFGA_STORE_ID`.

Runtime denials, account-link prompts, and Dynamic Agent responses are sent as
threaded replies by preserving the incoming Webex message ID and using it as the
Webex `parentId`.

### Runtime Reload and Sync

Use **Advanced Setup - Import/Sync with Webex Bot** from the Webex Spaces panel
after editing routes or when migrating static config. The BFF uses `WEBEX_BOT_ADMIN_URL`,
`WEBEX_BOT_ADMIN_CLIENT_ID`, `WEBEX_BOT_ADMIN_CLIENT_SECRET`, and
`WEBEX_BOT_ADMIN_AUDIENCE` to call the internal Webex bot admin API with a
Keycloak client-credentials token.

### Common Denials

| Reason | Fix |
| --- | --- |
| `WEBEX_USER_NOT_LINKED` | Complete the Webex account-link flow so `webex_user_id` maps to a Keycloak user |
| `WEBEX_WORKSPACE_UNCONFIGURED` | Set `WEBEX_WORKSPACE_ALIAS` or `WEBEX_WORKSPACE_ID` |
| `WEBEX_SPACE_TEAM_NOT_FOUND` | Map the space to a team in Admin → Teams |
| `WEBEX_OBO_FAILED` | Check Keycloak Webex bot client secret and token-exchange policy attachment |
| `WEBEX_ROUTE_DENIED` | Add an enabled route for the selected space and agent |
| `missing_space_grant` | Ensure the `webex_space` OpenFGA tuple exists for the requested agent/resource |
| `pdp_unavailable` | Check CAIPE UI BFF, OpenFGA, and Webex bot route diagnostics |

Bot replies use plain-language versions of these denials. For example,
`WEBEX_OBO_FAILED` is shown as `I couldn't start your CAIPE session for this
Webex space`; use the reason code in logs and diagnostics for operator
troubleshooting.

If `WEBEX_OBO_FAILED` logs show `403 Forbidden`, verify the
`caipe-webex-bot-token-exchange` Keycloak policy is attached to all three
permissions: `caipe-webex-bot` token-exchange, users `impersonate`, and
the `CAIPE_PLATFORM_AUDIENCE` target client's token-exchange permission
(`caipe-platform` by default). (Phase 3 of spec
2026-05-24-derive-team-from-channel removed the per-team
`active_team` claim mechanism, so token-exchange now mints a
team-agnostic OBO token and the previous "active_team mismatch"
class of failure no longer exists. If logs reference an `active_team`
mismatch on a current build, the Webex bot binary is older than the
realm — upgrade the bot.)

If the bot replies `I could not complete the request. Please try again.` after
`WEBEX_DISPATCH_ALLOWED`, check the Webex bot logs for the downstream BFF
status. Webex dispatch creates or reuses a `client_type=webex` CAIPE
conversation before calling `/api/v1/chat/stream/start`; a `404 Conversation not
found` means that conversation upsert step did not run or failed.

Use `spaces.accessMode: all_spaces` only when that bot's configured default team
and agent are intentionally safe for every newly observed group space. Use
`allowlist` when an administrator must approve each space.

---

## Running the Test Suite

The comprehensive RBAC test matrix (helper unit tests + matrix-driver tests + Playwright e2e) lives under `tests/rbac/` and is owned by spec 102. Quick reference:

```bash
# Lint everything (matrix YAML, jest, ruff)
make test-rbac-lint

# Boot the full stack with the e2e port band (UI:3000, mongo:28017)
make test-rbac-up

# Run helper unit tests + the YAML-driven matrix tests (Python + Jest)
make test-rbac-pytest
make test-rbac-jest

# Run Playwright e2e (requires the stack from `make test-rbac-up`)
RBAC_E2E=1 make test-rbac-e2e

# Tear down (removes volumes)
make test-rbac-down
```

Full details — port band rationale, the `E2E_COMPOSE_ENV` contract, and how the rules-as-data matrix in `tests/rbac/rbac-matrix.yaml` flows into both pytest and Jest — are in [spec 102 quickstart](../../specs/102-comprehensive-rbac-tests-and-completion/quickstart.md).

For `caipe-ui` unit coverage, run `npm test -- --coverage --runInBand` from
`ui/`. The Jest coverage scope tracks the UI/BFF code that can be exercised
deterministically in unit tests and excludes heavyweight browser-only graph,
timeline, RAG ingestion, and external admin-client shells that belong in
integration or browser tests.

---

## Common Questions

**Q: Why does the UI still work if Keycloak is down?**

The UI and all services cache the JWKS public key. Signature validation is local — no Keycloak call needed per request. Sessions already in flight remain valid until their `exp`. Only new logins (which need Keycloak's auth endpoint) fail.

**Q: What is `BOOTSTRAP_ADMIN_EMAILS` and when should I remove it?**

It's the short initial-admin email list used by the CAIPE UI BFF to resolve or create Keycloak users and seed durable OpenFGA admin relationships. Existing SSO users keep their current Keycloak `sub`; users who have not logged in yet get passwordless verified placeholders that the IdP broker can auto-link on first login. The same env var remains a temporary break-glass fallback, so remove it after Admin → Security & Policy → Keycloak shows the bootstrap admins resolved and steady-state Identity Group Sync/team admin grants are configured.

**Q: Why are there both `access_token` and `obo_jwt` on `UserContext`?**

UI-sourced requests carry the user's own access token (`access_token`). Slack-sourced requests carry an OBO token (`obo_jwt` from the `X-OBO-JWT` header) — this preserves the delegator/delegatee distinction for audit purposes. The agent runtime prefers `obo_jwt` over `access_token` when forwarding to MCP tools.

**Q: What happens when the JWT expires mid-session?**

NextAuth holds the refresh token and silently refreshes before expiry. If the refresh fails (revoked session, Keycloak unavailable), the next API call returns 401 and the client redirects to login. OBO tokens issued by the Slack bot are short-lived; the bot re-exchanges on each message.

**Q: Can I add a custom role and enforce it at AgentGateway?**

Yes for application/UI roles. In Keycloak Admin: Realm Roles → Create. Add it to `default-roles-caipe` if it should be universal. Add an IdP mapper if it should come from an upstream group. For AgentGateway authorization, model the access as OpenFGA relationships instead of editing CEL rules.

**Q: How does the Skills Catalog API authenticate non-browser callers?**

Two paths bypass Keycloak:

- **Catalog API key** (`X-Caipe-Catalog-Key` header, used by `caipe-skills.py` and the skills gateway): the BFF assigns the synthetic subject `catalog-key-user@local`. In read mode `filterSkillsByOpenFga` returns `default` (filesystem) + `hub` + globally-visible `agent_skills` without querying OpenFGA — no per-skill tuples exist for machine callers. In use mode it falls through to normal per-skill `can_use` checks.
- **Local skills JWT** (`Authorization: Bearer <HS256>` from `/api/skills/token`): the BFF derives `session.sub` from the token's `email` claim and runs full OpenFGA evaluation — `default` skills pass through; `agent_skills` require a `can_read` tuple.

Both paths require a populated `session.sub`; without it `filterSkillsByOpenFga` short-circuits to an empty result.

**Q: Where do I look to change something?**

See [the file map](./file-map.md). Every auth-relevant file is listed with what changing it actually does.
