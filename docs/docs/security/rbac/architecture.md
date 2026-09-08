# RBAC Architecture

Component-by-component reference. Each section describes **what it owns**, **what it does NOT own**, and **the env vars / config files / extension points** you'd touch to change its behavior.

> Read [the index](./index.md) first if you want the big-picture mental model and the JWT primer.
> Read [Workflows](./workflows.md) for the request-flow sequence diagrams that tie all of this together.

---

## Helm Runtime Packaging

The `0.5.0` umbrella chart can own the RBAC runtime stack for demo and managed environments:

- `tags.keycloak=true` enables the Keycloak subchart, realm import, and IdP/token-exchange init hooks. The imported realm follows `keycloak.realm.name` by rewriting the packaged realm JSON's realm name, Keycloak default-role name, and realm-role container ids at render time.
- The Keycloak subchart packages the `caipe` login theme by default and mounts it as a ConfigMap under `/opt/keycloak/themes/caipe`. Deployments can customize branding with `keycloak.theme.brandName`, `keycloak.theme.colors.`*, or full `keycloak.theme.files.*` overrides; `keycloak.theme.existingConfigMap` remains available for externally managed theme ConfigMaps.
- `openfga.enabled=true` enables the OpenFGA service and the CAIPE authorization model loader hook. The loader can still write explicit emergency tuples through `openfga.init.seedTuples`, but production RBAC installs should bootstrap human admins through the Web UI BFF email reconciler so operators do not have to hardcode Keycloak UUIDs in Helm values.
- `openfgaAuthzBridge.enabled=true` enables the gRPC `ext_authz` bridge that validates the bearer JWT again, extracts the verified `sub`, and translates AgentGateway checks into OpenFGA checks.
- `agentgateway.enabled=true` enables the standalone AgentGateway proxy chart. `global.agentgateway.enabled=true` is still the Gateway API route-resource path for clusters using the AgentGateway controller model.
- The local and Helm standalone AgentGateway provider MCP targets preserve the caller's Keycloak bearer for listener JWT validation and OpenFGA `mcp_gateway:list` authorization, then inject provider tokens such as `GITHUB_PERSONAL_ACCESS_TOKEN` and `GITLAB_PERSONAL_ACCESS_TOKEN` as backend auth only on the upstream MCP hop. Helm installs should mount those values from Secrets or ExternalSecrets through `agentgateway.extraEnv`/`agentgateway.extraEnvFrom`; this keeps provider PATs out of browser/session traffic while satisfying upstream MCP servers' `Authorization` requirements.

Production installs must still supply ExternalSecrets and persistent datastore settings; the chart defaults are conservative and disabled by default.

**Persistent RBAC datastores.** By default the Keycloak subchart uses an embedded H2 database and OpenFGA uses an in-memory store — both lose **all identity, realm, and authorization state on pod restart**, which makes RBAC unusable for anything beyond a throwaway demo. To persist RBAC state, point both at PostgreSQL:

- **Keycloak** reads non-secret connection settings from `keycloak.env` (`KC_DB=postgres`, `KC_DB_URL`, `KC_DB_USERNAME`) and the DB password from a Secret via `keycloak.db.passwordSecret.name`/`.key` (rendered as a `secretKeyRef` on `KC_DB_PASSWORD`, so the password never lands in values or release data). With `KC_DB` set, the per-pod `persistence` PVC is unnecessary.
- **OpenFGA** uses `openfga.datastore.engine=postgres` with `openfga.datastore.uriSecretRef.name`/`.key` supplying the `postgres://…` connection string to both the deployment and the `migrate` Job.

`setup-caipe.sh` wires this automatically: it deploys a single shared `bitnami/postgresql` instance (`caipe-postgres`) with one role+database per consumer (`keycloak`, `openfga`, optional `litellm`), persists generated passwords in the `caipe-postgres-credentials` Secret, and emits the consumer-facing `caipe-keycloak-db` / `caipe-openfga-db` Secrets. This is the default for RBAC installs; `--no-shared-postgres` falls back to the ephemeral H2/in-memory stores.

---

## Component 1: Keycloak — HR & The Front Desk

> **Badge analogy:** HR issues ID badges. The front desk verifies them on entry. Every other door in the building trusts the badge's chip — they don't call HR each time. When a contractor arrives via a partner agency (Duo SSO), the front desk checks with the agency once, creates an internal record, and issues a standard building badge. From that point on, the contractor uses the same badge as everyone else.

**Technically:** Keycloak acts as an OIDC Authorization Server and IdP broker. It proxies login to Duo SSO via an OIDC client, mirrors external group claims into identity attributes for sync, and issues its own signed JWT — so downstream services only ever need to trust one issuer. CAIPE authorization decisions are no longer encoded as Keycloak realm roles.

### Realm Roles (configured realm, default `caipe`)


| Role                     | Default? | Purpose                                     |
| ------------------------ | -------- | ------------------------------------------- |
| `default-roles-<realm>`  | Yes      | Keycloak composite default role.            |
| `offline_access`         | Yes      | Keycloak protocol role for refresh/offline. |
| `uma_authorization`      | Built-in | Keycloak protocol role; not CAIPE authz.    |


There are no CAIPE business/resource realm roles. A CAIPE admin is represented as `user:<sub> admin organization:<org_key>` in OpenFGA, optionally via `team:<slug>#admin admin organization:<org_key>`. `BOOTSTRAP_ADMIN_EMAILS` is only a break-glass fallback until those durable organization tuples exist.

#### Resource-scoped roles (legacy)

Legacy role names such as `chat_user`, `admin`, `admin_user`, `team_member:*`, `kb_reader:*`, `agent_user:*`, and `tool_user:*` are cleanup targets only. New installs do not create them, and new authorization code must not check them.


Relationships are created and assigned by:

- `init-idp.sh` (runs in the `keycloak-init` job) is the first-run bootstrap escape hatch. It uses direct Keycloak admin credentials before the Web UI backend is healthy, which avoids a bootstrap cycle where BFF startup needs Keycloak config that only the BFF can create. It should keep only baseline app-realm prerequisites, IdP broker login bootstrap, optional demo personas (`KEYCLOAK_SEED_DEMO_USERS=true`), and operational master-realm settings such as admin-console `frontendUrl`. It also ensures `offline_access` is present on the configured realm's `default-roles-<realm>` composite and enables Keycloak's realm-level `users-management-permissions` feature with bootstrap admin credentials so the later BFF migration does not need broad `manage-realm` privilege. `init-token-exchange.sh` uses the same bootstrap-admin path to grant both Slack and Webex bot service accounts the `realm-management` `impersonation` role before the lower-privilege BFF reconciliation runs. Because `init-token-exchange.sh` runs in the always-on `init-token-exchange` job (gated on `tokenExchange.enabled`, default true) rather than the `auth-reconcile` job (gated on `idp.enabled`, default false), it also reconciles the OBO target — it enables management permissions on the `CAIPE_PLATFORM_AUDIENCE` client (`caipe-platform`), attaches both bot client policies (`caipe-slack-bot-token-exchange-policy`, `caipe-webex-bot-token-exchange-policy`) to that client's `token-exchange` scope-permission, and pins the `AFFIRMATIVE` decision strategy. This makes a fresh in-chart / local-Keycloak install (no upstream IdP) pass the bot OBO health invariants without depending on the IdP-gated `auth-reconcile` path; the equivalent logic in `init-idp.sh` remains for upstream-IdP installs and both paths are idempotent.
- The Web UI backend runs a startup Keycloak RBAC reconciliation migration (`keycloak_rbac_mapping_reconciliation_v1`) in TypeScript. MongoDB `teams` remain the source of truth; the migration repairs bot OBO token-exchange permissions for the `CAIPE_PLATFORM_AUDIENCE` target client, assigns bot service-account impersonation roles, pins the `AFFIRMATIVE` decision strategy on every scope-permission with bot client policies attached, resolves `BOOTSTRAP_ADMIN_EMAILS` to Keycloak user ids, creates passwordless verified placeholders for bootstrap emails that have not logged in yet, writes durable OpenFGA super-admin tuples, and records status in `migration_manifest`, `schema_migrations`, and `data_schema_versions`. When the BFF token cannot enable `users-management-permissions` itself, it falls back to reading the already-enabled permission created by the init hook and continues with policy repair. (Phase 3 of spec 2026-05-24-derive-team-from-channel removed the per-team and personal client-scope branches, the orphan-scope deletion step, and the audience-default selection step — team identity now flows through `channel_team_mappings`, not Keycloak.)
- Slack/Webex bot onboarding can still repair OBO prerequisites on-demand, but the BFF startup migration is the canonical environment-wide reconciliation path after bootstrap. Its last run, counts, warnings, and errors are exposed through Admin → Security & Policy → Keycloak via `GET /api/admin/keycloak/migration-health`, plus the persistent header migration status indicator. The same endpoint also performs a read-only Keycloak inspection for the tile details modal, returning actual realm values such as the OBO token-exchange permission strategy, attached OBO policies, and bot service-account impersonation roles. When the migration is behind or failed, the Keycloak tab's **Reconcile now** button invokes the same typed migration apply path for `keycloak_rbac_mapping_reconciliation_v1` and refreshes the persisted health result. Every Keycloak scope-permission that ends up with bot-specific client policies attached — the `caipe-platform` target-audience `token-exchange` perm, each bot client's own `token-exchange` perm (`caipe-slack-bot`, `caipe-webex-bot`), **and** the realm-level `users.impersonate` perm — must use `AFFIRMATIVE` decision strategy. With Keycloak's default `UNANIMOUS` strategy, adding the second bot's per-client policy makes the first bot's OBO fail with `Client not allowed to exchange` / `Client not allowed to impersonate` because the other bot's `clients=[...]` policy votes DENY for it. The `kc_attach_policy_to_scope_permission` helper in `init-idp.sh` and the matching `attach_policy_to_scope_permission` helper in `init-token-exchange.sh` both force `AFFIRMATIVE` on every attach so this regression cannot reappear when a new bot client is onboarded. The same invariants — plus a defense-in-depth "every attached policy is `type=client` with a non-empty `client_ids` allow-list" check — are evaluated server-side by `ui/src/lib/rbac/keycloak-invariants.ts#evaluateKeycloakInvariants`, exposed through `GET /api/admin/keycloak/migration-health` as `keycloak_invariants.items`, and rendered as a named pass/fail/unknown list in the Admin → Security & Policy → Keycloak tile. The evaluator is a pure function over the existing read-only inspector output, so the same checks gate every realm regardless of whether it was bootstrapped by `init-idp.sh` or by an operator using the Keycloak Admin Console. The inspector hydrates each `type=client` policy by calling `/authz/resource-server/policy/client/<id>` and resolves the returned UUIDs to operator-meaningful `clientId` strings via a single batched `/clients` round-trip per probe — this is necessary because Keycloak's `associatedPolicies` summary endpoint returns `config: {}` on client-type policies, so the allow-list is invisible to a naive inspector. The hydration step also lets the panel surface the policy's resolved `client_ids` (e.g. `clients=[caipe-slack-bot]`) inline whenever a policy is flagged, so admins don't have to leave the panel to identify the right policy in the Keycloak Admin Console.
- Production `caipe-ui`, `caipe-platform`, and Slack/Webex bot OBO client secrets are Keeper-backed Kubernetes Secrets/ExternalSecrets rather than values embedded in rendered ConfigMaps. `keycloak.uiClient.secretRef` or `keycloak.uiClient.externalSecret` feeds `KEYCLOAK_UI_CLIENT_SECRET` to the Keycloak init/reconcile hook, which updates the existing `caipe-ui` client through the Admin API so NextAuth's `OIDC_CLIENT_SECRET` stays aligned across upgrades and rotations. `keycloak.platformClient.secretRef` / `keycloak.platformClient.externalSecret` feeds `KEYCLOAK_PLATFORM_CLIENT_SECRET` the same way to replace the dev placeholder shipped in `realm-config.json` for the `caipe-platform` confidential client (the on-behalf-of / token-exchange target audience). Bot OBO secrets use the same single-source-of-truth pattern through `keycloak.tokenExchange.externalSecret` and `keycloak.webexTokenExchange.externalSecret`. Setting `keycloak.strictClientSecrets: true` adds a runtime guard at the end of `init-idp.sh` (covering `caipe-ui` + `caipe-platform`) and `init-token-exchange.sh` (covering `caipe-slack-bot` + `caipe-webex-bot`) that issues a `client_credentials` token request for each known dev placeholder secret and fails the Helm install if Keycloak still accepts any of them — preventing "operator forgot to set the secretRef" silent regressions. See [secrets-bootstrap → Production hardening](./secrets-bootstrap.md#production-hardening--strict-client-secret-mode) for the recommended adoption order.
- The Admin UI **Team Resources panel** (`Admin → Teams → selected team → Resources` tab, spec 104 Story 4) — checking an agent or tool box calls `PUT /api/admin/teams/[id]/resources`, which:
  1. Writes base relationship intent to OpenFGA before Mongo persistence: `team:<slug>#member user agent:<id>`, `team:<slug>#admin manager agent:<id>`, and `team:<slug>#member caller tool:<prefix|*>`.
  2. Resolves current team members to Keycloak `sub` values and writes OpenFGA `user:<sub> member team:<slug>` membership tuples when possible.
  3. Persists the selection on the team document in Mongo (`team.resources = { agents, agent_admins, tools, tool_wildcard }`).
  The Resources tab covers Use+Manage per agent and per-MCP-server tool grants plus a single "All tools" wildcard checkbox. Mongo persistence happens **after** OpenFGA reconciliation so a PDP outage doesn't leave Mongo ahead of the enforcement store.
- The Admin UI **Team Slack Channels panel** (`Admin → Teams → <team> → Slack Channels` tab, spec 098 US9) — bind Slack channels to a team so the bot resolves the channel's effective team via `channel_team_mappings`. Slack runtime agent access is configured separately in the OpenFGA ReBAC Slack Channels panel, where admins grant a channel access to selected Dynamic Agents. `PUT /api/admin/teams/[id]/slack-channels` is an idempotent full-replace: it deactivates this team's previous mappings that aren't in the new payload (only when `team_id` still matches — never touches another team's rows), upserts the active set, and denormalises a thin `slack_channels` array onto the team document for the team-card chip count. The UI offers a live `users.conversations` discovery picker (server-side `SLACK_BOT_TOKEN` only; lists only channels where the bot is already a member; the in-process cache TTL is admin-configurable via the **Discovery cache** popover next to the *Find Bot-Member Slack Channels* button on `Admin → Integrations → Slack`, default 60 minutes, range `0`–`1440`, `0` disables caching; the same popover exposes a *Refresh from Slack now* button that drops the snapshot for ad-hoc bot-membership changes) plus a manual ID entry fallback for when the bot isn't in the channel yet.
- The Admin UI **Team Webex Spaces panel** (`Admin → Teams → <team> → Webex Spaces` tab, spec 2026-05-18 Webex RBAC parity) — binds Webex spaces to a team through `webex_space_team_mappings`. Runtime agent access is configured separately in the OpenFGA ReBAC Webex Spaces panel. `PUT /api/admin/teams/[id]/webex-spaces` is an idempotent full-replace, preserves mappings owned by other teams, and denormalises `webex_spaces` onto the team document for display.
- Identity group sync — upstream Okta/AD group ids map to `external_group:<provider>/<group_id>` and then to CAIPE teams, for example `external_group:okta/00g... member team:platform`. Application code consumes the resulting team relationships; it does not check upstream group strings directly.

`BOOTSTRAP_ADMIN_EMAILS` is an explicit break-glass/initial-admin list and the source for durable email-based bootstrap seeding. The Web UI BFF resolves each email to a Keycloak `sub` during `keycloak_rbac_mapping_reconciliation_v1`; existing SSO users are left untouched, while missing users get a passwordless verified Keycloak placeholder that the IdP broker can auto-link on first login. For each resolved subject, the BFF writes the default member baseline tuples, `caller` on `mcp_gateway:list` for AgentGateway's coarse MCP ext_authz gate, `admin` on `organization:<org_key>`, `manager` on `system_config:platform_settings`, `manager` on `mcp_server:agentgateway`, and `manager` tuples for the built-in admin surfaces, including baseline surfaces such as `admin_surface:teams` and `admin_surface:credentials`. Keep the list small, audit it in Admin → Security & Policy → Keycloak, and replace it with team/group-mediated admin relationships when steady-state Identity Group Sync is configured.

Local no-SSO development uses a dedicated dev auth provider rather than route-local bypass checks. When `SSO_ENABLED=false`, `ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED=true`, and `CAIPE_UNSAFE_RBAC_BYPASS=true` outside production, `ui/src/lib/auth/dev-auth-provider.ts` supplies the stable `anonymous@local` / `anonymous-local-dev` admin principal to API middleware, admin tab gates, RAG proxy calls, and admin-surface checks. This keeps local development on the same auth-context contract as real OIDC sessions while making the insecure mode visible through logs and the UI **No Auth** indicator.

#### When Authorization Relationships Are Created

Keycloak realm roles are **not created for CAIPE permissions**. New deployments keep Keycloak focused on identity and login:

- **Organization access** is `user:<sub> member|admin|auditor organization:<org_key>` or team-mediated variants. The release migration `organization_membership_backfill_v1` writes direct `member organization:<org_key>` tuples for existing Mongo users with a stable Keycloak `sub`, restoring baseline `chat#invoke`/RAG `query` access after the OpenFGA cutover.
- **Login bootstrap access** is repaired on each successful CAIPE login. If the user passes `OIDC_REQUIRED_GROUP`, the Web UI BFF reads the Mongo-backed default OpenFGA grant profile bundle from `openfga_baseline_profiles` (falling back to the built-in defaults) and writes the selected member profile tuples such as `user:<sub> member organization:<org_key>`, `user:<sub> reader system_config:platform_settings`, `user:<sub> owner user_profile:<sub>`, `user:<sub> caller mcp_gateway:list`, and selected read-only `admin_surface` grants. The `mcp_gateway:list` tuple is required before AgentGateway proxies any MCP probe or tool-call traffic. If the user also matches `OIDC_REQUIRED_ADMIN_GROUP` or `BOOTSTRAP_ADMIN_EMAILS`, login bootstrap adds the selected admin profile tuple set, including `admin organization:<org_key>`, `manager system_config:platform_settings`, `manager mcp_server:agentgateway`, and selected `admin_surface` manager grants for both baseline surfaces (for example `teams`, `credentials`, and `skills`) and privileged surfaces (for example `openfga` and `migrations`). Stored built-in profiles are normalized with newly required default grants so existing environments pick up added baseline admin-surface permissions after upgrade. Admins can update the global Org Member / Org Admin default grant profiles, create custom profiles, and assign member/admin profile overrides to teams in Admin → Security & Policy → OpenFGA → Default FGA Grants. These profiles are templates that materialize concrete OpenFGA tuples during login or all-user reconciliation. The same workspace includes OpenFGA Store: Catalog & Live Relationships, a read-only catalog of resource types, action checks, discovered resources, and paginated live OpenFGA tuples so operators can audit the full authorization store beyond the default login templates. Tuple Inspector filter inputs are apply-only; complete tuple identifiers are sent to OpenFGA as exact read filters, while partial text stays a post-read contains filter for ad-hoc inspection. A team override **replaces** the global profile for matching team users for that role; if several teams provide overrides, their selected profile grants are unioned. The result is materialized as direct user OpenFGA tuples during login or all-user reconciliation so self-profile grants and existing `can_*` checks remain deterministic. This is an OpenFGA reconciliation step, not a runtime realm-role fallback; users who fail the OIDC admission group are never bootstrapped.
- **Team membership** is `user:<sub> member|admin team:<slug>`.
- **Resource access** is team-mediated where possible, for example `team:<slug>#member user agent:<id>` or `team:<slug>#member reader knowledge_base:<id>`.
- **Runtime checks** use derived `can_*` permissions from those base relationships.

Rule of thumb: **Keycloak owns identity and JWT claims; OpenFGA owns who is related to which organization, team, or resource.**

### Web UI BFF RBAC Caches

The Web UI backend uses short-lived in-process caches to keep repeated navigation from turning into repeated OpenFGA, MongoDB, and platform-health probes:

- OpenFGA store discovery is cached per BFF process. `OPENFGA_STORE_ID` still wins when set; otherwise the process discovers `OPENFGA_STORE_NAME` once and reuses that store id for tuple reads, tuple writes, and checks.
- Selected JSON API responses such as admin tab gates, platform health, authorization stats, dynamic-agent availability, and platform config are cached by request URL plus caller headers. This keeps one browser refresh or a 1000-user benchmark from fanning out identical backend probes.
- Cache entries are short-lived, bounded, and process-local. They are an availability/performance optimization only; Keycloak JWT validation, OpenFGA relationship data, MongoDB records, and the downstream services remain the sources of truth.
- Endpoints that need fresh data can bypass the cache with `refresh=true`, and mutating routes still perform live authorization and persistence work.

The user-facing Connections & Secrets surface is hidden unless credential
features are enabled and the signed-in Keycloak subject has
`can_use_credentials organization:<org_key>` in OpenFGA (granted by organization
`member` or `admin`). Specific secret metadata, use, share, manage, and audit
operations are still governed by `secret_ref:<id>` relationships. The Admin →
Settings → Credentials tab is stricter: it is also
feature-flagged and requires organization-admin access
(`can_manage organization:<org_key>`), not only the read-only
`admin_surface:credentials` baseline grant.

The Web UI backend now uses shared object-level OpenFGA checks for UI-owned resource surfaces whenever the authorization model has a concrete resource type. `list` and `discover` map to `can_discover`, runtime/content access maps to `can_read` or `can_use`, mutations map to `can_write`, sharing maps to `can_share`, and platform configuration maps to `can_manage` on `system_config:<key>`. Dynamic Agent create requires a stable Keycloak `sub`; private agents write `user:<creator_sub> owner agent:<id>`, and team-owned agents require OpenFGA `team:<slug>#can_use` before creation (Mongo team membership is not a fallback). Creation writes durable relationships before MongoDB persistence: `user:<creator_sub> owner agent:<id>`, `organization:<org>#admin manager agent:<id>`, `team:<slug>#member user agent:<id>`, `team:<slug>#admin manager agent:<id>`, and the agent-to-tool caller tuples. The Agent editor's "Share with Teams" multi-select extends the same two-tuple pair (`team:<slug>#member user agent:<id>` plus `team:<slug>#admin manager agent:<id>`) to every additional shared team; `POST /api/dynamic-agents` and `PUT /api/dynamic-agents` resolve each entry against the teams collection (legacy Mongo `_id` is accepted for backward compat but normalized to the canonical slug before persistence and OpenFGA writes), drop the owner-team duplicate, and feed both `nextSharedTeamSlugs` and `previousSharedTeamSlugs` into `reconcileAgentRelationships` so unchecking a team in the editor genuinely emits delete tuples instead of leaving a dangling grant. The `agent_shared_team_grants_backfill_v1` migration replays this normalisation against every existing agent so the multi-select that pre-dated the 2026-05-27 fix retroactively writes the missing canonical tuples. Dynamic Agent update/delete paths check the concrete `agent:<id>` object before MongoDB writes or tuple reconciliation. Chat agent pickers (`/api/dynamic-agents/available`) and subagent pickers (`/api/dynamic-agents/available-subagents`) load enabled candidates and filter through `agent#can_use`; conversation creation also checks `agent#can_use` before storing a selected agent. LLM model list and edit routes use `llm_model#can_read`/`#can_write`/`#can_delete`; config-driven system models get `organization:<org>#member reader llm_model:<id>` and `organization:<org>#admin manager llm_model:<id>` tuples during seed and remain immutable. Skill config reads no longer prefilter by MongoDB `visibility`, `owner_id`, `shared_with_teams`, or legacy realm roles; they load candidates and let `skill#can_discover`/`skill#can_read` decide. Workflow configs are mapped to the existing OpenFGA `task` namespace until the authorization model grows a first-class `workflow` type. Dynamic Agent built-in tool metadata at `GET /api/dynamic-agents/builtin-tools` is **not** OpenFGA-gated: it returns a static catalog of supported built-in tool *types* (web_search, file_io, etc.), is read by every authenticated user who can open the Create Agent wizard, and per-tool authorization happens at MCP invocation time. The route requires only an authenticated session and forwards the caller's bearer token to dynamic-agents (which enforces `DA_REQUIRE_BEARER`). Earlier revisions gated this on `tool:dynamic-agents-builtin#can_discover`, but no seed/migration path ever wrote that tuple so every caller (including admins) was denied with 403; that pseudo-resource is now retired.

The Admin → Security & Policy → OpenFGA policy graph is a visibility surface for these same base relationships. Team-scoped graph queries include both `team:<slug>#member` and `team:<slug>#admin` usersets, so management grants such as `team:<slug>#admin manager agent:<id>` and `team:<slug>#admin manager admin_surface:<surface>` appear alongside member grants. The default graph remains a clean team/resource workspace: team and userset nodes are always visible, and resource nodes are shown when selected from the live catalog. Operators can switch graph layers to inspect stored OpenFGA tuples, read-only Slack/Webex routing metadata, subject-scoped effective `can_*` access paths, or authorization-model topology derived from the universal resource/action model. These layers are user-facing alternatives, not one combined overlay. Effective access is intentionally user-centered and requires a selected user before rendering broad inherited access. Model topology shows resource-type anchors first; selecting catalog resources expands only the matching type's relation and permission stacks, not concrete live resource cards. The UI resource palette and connection defaults read from the live catalog, so newly introduced resource types such as `secret_ref`, `policy`, `audit_log`, or `llm_model` appear without adding another graph-specific resource list.

Conversations use a hybrid ownership model to avoid creating high-cardinality owner tuples for every private chat. Private ownership is implicit from MongoDB (`owner_subject` for normalized records, legacy `owner_id` email fallback for old records). Explicit OpenFGA relationships remain the enforcement store for cross-boundary sharing and admin surfaces. The Web UI backend now fetches non-deleted conversation candidates without MongoDB team-sharing prefilters, then applies the same implicit-or-explicit conversation check on chat list/detail routes, Dynamic Agent v1 stream/invoke/resume/cancel proxy routes, and conversation metadata updates. This lets Slack OBO requests write their own thread conversations and bookkeeping metadata without requiring explicit owner tuples while still allowing OpenFGA-only conversation grants to appear in the UI. The Admin → System → Migrations tab seeds a DB-managed `migration_manifest` from the runtime bundle, shows the active runtime migration release beside per-collection `data_schema_versions`, hides completed migrations by default, and runs the release migration handlers, including `conversation_owner_identity_v1` for `owner_subject`/`owner_identity_version=2`, `organization_membership_backfill_v1` for direct baseline organization membership, universal team-resource OpenFGA backfill, Dynamic Agent tool tuple reconciliation, Dynamic Agent organization-admin inheritance backfill, Dynamic Agent shared-team grants backfill (`agent_shared_team_grants_backfill_v1`, writes the missing `team:<slug>#member can_use agent:<id>` tuples for every existing agent's `shared_with_teams`), Slack channel and Webex space ReBAC grant backfills, messaging team mapping reconciliation, RBAC index creation, and Webex messaging ReBAC index creation. Migration runs are recorded in `schema_migrations`; blocking required migrations and the migration status API are admin-only surfaces.

Conversation secondary views and mutations now use the same model: shared, search, and trash routes fetch candidates and filter through the implicit-or-explicit OpenFGA helper; pin, archive, restore, and share actions require the concrete conversation relationship instead of raw `owner_id` equality. Skill nested routes and import overwrite paths also load candidates by id and require `skill#read`, `skill#write`, or `skill#admin` as appropriate; legacy skill visibility fields remain metadata only. Workflow run list/start/poll/update/delete/resume/cancel operations authorize against the parent workflow config through the temporary `task` namespace mapping. MCP server list/probe/update/delete and team RAG tool list/read/write/delete use concrete `mcp_server` and `tool` OpenFGA resource checks without a legacy session role bypass; MCP server create requires a stable Keycloak `sub`, writes `mcp_server` owner/team tuples before Mongo persistence, and delete removes associated OpenFGA tuples before deleting the Mongo row. Credential management adds `admin_surface:credentials` for connector administration and global secret metadata management, plus concrete `secret_ref` authorization for user metadata, use, share, manage, and audit decisions. The user-facing page separates `My Secrets` and `My Connections`, while the Admin Credentials tab owns OAuth provider configuration and all-user secret metadata actions. Browser API routes may create or rotate secret material, but raw credential retrieval is restricted to bearer-authenticated service callers using the credential-service audience.

Knowledge Base UI routes are enforced at the Web UI backend before proxying to the RAG server. `caipe-ui` authenticates the browser session, applies the coarse `rag` route gate, checks concrete `ingestion_source:<id>` operations for connector management, filters datasource list responses by `data_source#can_read`, constrains search/MCP invocations to the caller's readable datasource IDs, and then forwards the Keycloak bearer token to RAG. RAG validates the token signature, issuer, audience, and expiry against Keycloak, then repeats OpenFGA checks for direct API/MCP requests using the caller's Keycloak `sub`. Human Keycloak realm roles and per-KB realm roles do not grant RAG access. **Owner** controls configuration, reload, transfer, and deletion through `ingestion_source`; **Search** writes query-only `reader` relationships on `knowledge_base`, inherited by `data_source`. The separate organization capabilities govern whether a user may create a datasource or invoke Search at all.

The Teams dialog Knowledge Bases tab reads `team_kb_ownership` through `/api/admin/teams/[id]/kb-assignments`. During the migration window, if no ownership row exists it treats legacy `teams.resources.knowledge_bases` entries as read-level assignments so older team resource grants still render instead of appearing empty.

**Org-admin super-grant on KB / Search / Data Sources / Graph / MCP Tools (PR 1, 2026-05-27).** Any caller that holds `user:<sub> can_manage organization:<org_key>` in OpenFGA is **always allowed** on every Knowledge Base sidebar surface. The Web UI backend implements this with an explicit `bypassForOrgAdmin: true` option passed to `requireResourcePermission` / `filterResourcesByPermission` for `knowledge_base:<id>` reads (per-KB gate, datasource list filter, readable-datasource enumerator) and a matching org-admin short-circuit in `constrainSearchBody` so admins are not subject to filter injection. This is policy: once you are org admin, you cannot be excluded from one specific KB while staying org admin. To restore pure per-resource checks (no super-grant), set `RAG_ADMIN_BYPASS_DISABLED=true`. Non-admins continue to need explicit per-KB / per-team tuples. The release migration `admin_surface_rag_datasources_admin_grant_v1` backfills `user:<sub> manager admin_surface:rag_datasources` for every previously-bootstrapped org admin so the `rag` + `admin` short-circuit in `api-middleware.ts` is fail-safe and not solely inheritance-dependent.

**Slack admin-surface backfill (issue #1513).** The Slack Channels admin panel (`/api/admin/slack/channels`) uses `admin_surface:slack#can_manage` for onboarding and advanced controls. Slack is a baseline read surface, while the admin baseline additionally writes `user:<sub> manager admin_surface:slack`. To cover org admins bootstrapped before that manager seed who have not re-logged-in, the release migration `admin_surface_slack_admin_grant_v1` (schema area `admin_surfaces`, v2 → v3) walks OpenFGA for existing `user:<sub> admin organization:<key>` admins and writes the matching admin-surface manager tuple. Idempotent and depends on `admin_surface_rag_datasources_admin_grant_v1`.

**Graph tab and datasource-scoped reads.** The Graph tab at `/knowledge-bases/graph` consults `useKbTabGates`; a direct link with no readable knowledge base renders `NoKbAccessEmpty` without mounting the graph client. Data-graph reads resolve the caller's readable `data_source` objects in the RAG server and constrain Neo4j by `_datasource_id`, including both endpoints of returned relations. The deployment-global ontology does not carry datasource provenance, so its REST and MCP read paths fail closed for bounded callers and remain available only to callers with unrestricted datasource access. Restricted callers see the source-scoped Data view; org admins may also open Ontology. Provenance-aware ontology filtering remains tracked by `docs/docs/specs/2026-05-27-per-kb-ontology-graph-filtering/spec.md`.

**Share/assign paths mirror `data_source` + `user:*` public datasources (2026-06-03).** Two correctness fixes to the RAG access model:

* **KB→`data_source` access (now via `parent_kb` inheritance).** Query-time enforcement reads `data_source:<id>#can_read`, but share/assign surfaces write `knowledge_base:<id>` tuples — so a KB-only grant once made a datasource *discoverable* but not *searchable*. PR 3/PR 4 patched this with a **mirror** (`mirrorKnowledgeBaseDiffToDataSource`) that duplicated every `knowledge_base` grant onto the parallel `data_source` object. **That mirror has been removed** (spec 2026-06-03, release 0.5.8): `data_source` now inherits read/ingest/manage from its knowledge_base via the `parent_kb` tuple-to-userset edge — see "**`data_source` → `knowledge_base` inheritance**" below. Team grants are written once on `knowledge_base:<id>` plus one structural `data_source:<id> parent_kb knowledge_base:<id>` edge at creation; no per-team tuples are duplicated onto `data_source`. The one-time `data_source_grants_backfill_v1` migration is superseded by `parent_kb_inheritance_backfill_v1` (one edge per existing datasource).
* **`user:*` public datasources.** The `reader` relation on both `knowledge_base` and `data_source` now accepts the typed wildcard `user:*` (added to `deploy/openfga/model.fga` and the Helm-packaged JSON model). The new admin route `POST /api/admin/rag/public-datasources` writes `user:* reader` on both objects (and `GET` reports state from the `data_source` tuple). This is the supported mechanism for keeping pre-RBAC ("public") datasources broadly readable without maintaining an everyone-team roster. The route is gated by `admin_surface` admin (`withOpenFgaAdminAuth`) — making a datasource world-readable is a privileged action and is not delegated to team admins. Surfaced in **Settings → Knowledge Bases / RAG Team Access** ("Public datasources" section), which also now lists a team's current per-datasource grants with per-row revoke.

**`data_source` and `mcp_tool` OpenFGA types + reconcilers + BFF list filter (PR 4, 2026-05-27).** `deploy/openfga/model.fga` and the Helm-packaged JSON authorization model include two RAG resource types; local Docker Compose mounts the same chart JSON model used by Helm so there is only one JSON artifact to keep current:

```text
type data_source     # datasource component inside the Knowledge Base feature,
                     # with per-datasource read and ingest/write grants
type mcp_tool        # RAG custom MCP tools (PUT /v1/mcp/custom-tools/<id>),
                     # distinct from the existing tool:<id> used by AgentGateway
```

Both expose `manager: [user, service_account, team#admin, organization#admin]` so org admins are an explicit edge on the model — not just a runtime bypass. `buildDataSourceRelationshipTupleDiff` and `buildMcpToolRelationshipTupleDiff` (in `ui/src/lib/rbac/openfga-owned-resources.ts`) emit the same shared-teams diff that PR 3 introduced for `knowledge_base`. `mcp_tool` additionally emits the `user` relation on member tuples so team members get `can_call` (mirrors how `mcp_server` invokers are modelled).

The BFF (`ui/src/app/api/rag/[...path]/route.ts`) now writes `mcp_tool:<tool_id>` tuples on a successful `PUT /v1/mcp/custom-tools/<tool_id>` (sourcing the owner team slug from the request body) and filters the `GET /v1/mcp/custom-tools` response by `mcp_tool:<id>#can_read`. Org admins bypass via the PR 1 super-grant; non-admins only see tools they have a tuple on.

Two strictly-additive backfill migrations live in `ui/src/lib/rbac/migrations/registry.ts`:

* `data_source_grants_backfill_v1` mirrors every existing `knowledge_base:<id>` tuple as a parallel `data_source:<id>` tuple, so admins who could read a KB on day zero can still read its data source on day one. No deletes. **(Superseded by `parent_kb` inheritance — see "Unified shareable-resource RBAC" below; retained for the bootstrap window.)**
* `mcp_tool_grants_backfill_v1` walks Mongo `team_rag_tools` and writes the canonical `team:<slug>#member reader mcp_tool:<id>` + `team:<slug>#member user mcp_tool:<id>` + `team:<slug>#admin manager mcp_tool:<id>` tuples. Tools without a team owner fall through to the `organization#admin → manager` edge.

**Unified shareable-resource RBAC (spec 2026-06-03, release 0.5.8).** A single shared module makes the agent owner-team + share-with-teams pattern canonical and brings RAG datasources and custom MCP tools to parity. Five composable pieces live behind it: the OpenFGA template, a reconciler core (`buildShareableResourceTupleDiff` / `reconcileShareableResource` + the `buildTeamGrantTuples` primitive in `ui/src/lib/rbac/openfga-owned-resources.ts`), a route helper (`handleShareableResourceWrite` in `ui/src/lib/rbac/shareable-resource.ts`), a Pydantic `OwnedResourceMixin` (`ai_platform_engineering/knowledge_bases/rag/common/.../models/rag.py`), and a `<TeamOwnershipFields>` React component (`ui/src/components/rbac/TeamOwnershipFields.tsx`). The agent and knowledge_base reconcilers are thin adapters over the core (their suites pass unchanged). Five structural changes ride along:

* **Audit-only `creator` relation.** `agent`, `knowledge_base`, `data_source`, `mcp_tool`, and `ingestion_source` each define `creator: [user]`. It is written once at create (`user:<sub> creator <type>:<id>`), never deleted, and **referenced by no `can_*`** — provenance only, no authority. A personal RAG source gives its creator an explicit `owner` grant on both `ingestion_source` and `knowledge_base`; transferring it to a management team revokes both personal grants. A source created as team-managed is managed by that team's admins from the start, and its creator tuple remains provenance only. A drift test (`ui/src/lib/rbac/__tests__/shareable-type-drift.test.ts`) fails the build if `creator` ever appears in a permission or the authored/chart models diverge.
* **`data_source` → `knowledge_base` inheritance (`parent_kb`).** `data_source` gains `define parent_kb: [knowledge_base]` and inherits the matching content permissions through the 1:1 edge `data_source:<id> parent_kb knowledge_base:<id>`. **This retires the `mirrorKnowledgeBaseDiffToDataSource` mirror** (deleted from `openfga-owned-resources.ts`). Datasource settings are now the only Search-policy writer; the Admin team panel is a read-only team-centric view and cannot mint legacy `ingestor` or `manager` grants. This keeps Owner, Search, and publication approval in one canonical write path.
* **Independent source configuration policy.** `ingestion_source:<id>` protects connector identity, credentials-adjacent settings, ownership, refresh/retry, and deletion. It deliberately has no inheritance edge to the same-ID `knowledge_base` / `data_source`: an Owner team may configure and reload the connector without being able to query it, while a different **Search** team may query indexed content without being able to replace the URL, channel, JQL, crawl settings, reload it, or change its Owner. Once an `ingestion_source` policy exists it is authoritative; server helpers use the legacy `data_source` grant only for pre-migration records with no source-policy tuples.
* **`can_call` enforcement on custom MCP tool invocation.** The BFF (`ui/src/app/api/rag/[...path]/route.ts`) checks `Check(<principal>, can_call, mcp_tool:<tool_name>)` before forwarding `POST /v1/mcp/invoke` for a custom tool (`<principal>` is `user:<sub>`, or `agent:<id>` for agent-initiated calls via `X-Agent-Id`). Built-in tool names (no `mcp_tool` object) are not gated; org admins bypass. The tool create/update path now persists `owner_team_slug` / `shared_with_teams` / `creator_subject` to `MCPToolConfig` and reconciles owner + shared + creator; **DELETE removes all `mcp_tool:<id>` grants** (`deleteAllMcpToolRelationshipTuples`) so no orphan tuples remain.
* **Persistence (config = source of truth).** `DataSourceInfo` persists the single optional management `owner_team_slug`, personal `owner_subject`, creator provenance, and the independent `search_with_teams` list in Redis. DB-managed connector rows persist the same split in Mongo as `IngestionSourceConfig`; their legacy management `shared_with_teams` list is always empty. OpenFGA is the enforcement projection: management goes to `ingestion_source`, while personal/search-team content access goes to `knowledge_base` and is inherited by `data_source`. Search teams receive `reader` only, never `ingestor` or `manager`; the same team may independently be selected as both Owner and Search. `/api/rag/sources` returns only source configs the caller can read, and `/api/rag/kbs/[id]/sharing` exposes the independent Search set for legacy/direct sources.

**Ownership transfer (spec 2026-06-03, US3) — unified across shareable resource types.** Owner team is immutable on a normal edit but transferable via the editor's "Transfer ownership" affordance for agents, custom MCP tools, knowledge bases / datasources, and ingestion sources. They share `resolveShareableOwnershipWrite` (`ui/src/lib/rbac/shareable-resource.ts`): creator-set-once, the transfer guard (caller must hold `<type>:<id>#can_manage` or be org admin), explicit not-a-member confirmation, first-set membership, and owner/shared-team diff. The old owner team's grants and any temporary personal source-owner grant are revoked rather than orphaned. Each route persists its own config only after policy reconciliation and compensates on downstream failure. The `creator` tuple is never touched, preserving provenance across transfers.

**FGA coverage guarantee (spec 2026-06-04-fga-coverage-guarantee).** "Every current and new resource type is FGA-gated" is enforced as a build-time invariant by four CI guards, so a new type cannot land ungated:

* **Layer 1 — type parity.** The `UniversalRebacResourceType` union derives from a runtime `const` array (`UNIVERSAL_REBAC_RESOURCE_TYPE_NAMES` in `ui/src/types/rbac-universal.ts`). `ui/src/lib/rbac/__tests__/fga-type-coverage.test.ts` asserts the object-type set agrees across the authored model (`deploy/openfga/model.fga`), the deployed chart JSON, the union, and the runtime registry (`UNIVERSAL_REBAC_RESOURCE_TYPES`), modulo a documented subject-only allowlist (`service_account`, `anonymous`). Adding `type foo` to the model fails CI until `foo` is registered or allowlisted. (This guard also surfaced and reconciled the `anonymous` type, which existed in the chart JSON but not the authored model, and registered the previously-missing `data_source` / `mcp_tool` actionable types.)
* **Layer 2 — enforcement manifest.** `ui/src/lib/rbac/fga-enforcement-manifest.ts` classifies every registered type (`rebac_enforced` / `role_gated` / `rebac_shadowed` / `not_gated`) with on-disk enforcement surfaces; `fga-enforcement-manifest.test.ts` rejects any unclassified type, verifies enforced surfaces exist, and only permits `not_gated` for an explicitly documented allowlist (`secret_ref` today). This manifest is the single artifact an auditor reads to answer "is type X gated, and where?".
* **Layer 3 — create-path ownership linter.** `scripts/validate-fga-create-paths.py` (wired into `make test-rbac-lint`) asserts that every ownable type's ownership-write helper (`reconcile*Relationships` / `write_*_ownership`) is both defined and called from production (non-test) code, catching the "persisted a resource but forgot to write ownership tuples" bug.
* **Layer 4 — default-deny backstop.** `ui/src/lib/rbac/__tests__/default-deny-coverage.test.ts` proves, parametrized over the live registry, that a subject with no tuples is denied read/use/manage on every type, that the org-admin bypass does not fire for non-admins, and that `CAIPE_UNSAFE_RBAC_BYPASS` is off by default. A newly-added type is auto-covered.

Two backfills register in the `0.5.8` manifest (`registry.ts`), runnable from the **Migrations** admin tab with dry-run/sample-diff/confirm:

* `parent_kb_inheritance_backfill_v1` writes one `data_source:<id> parent_kb knowledge_base:<id>` edge per existing datasource (supersedes the per-grant `data_source_grants_backfill_v1` mirror). Strictly additive, idempotent.
* `creator_from_owner_backfill_v1` writes `creator` from each existing personal `owner` tuple on the four shareable types, **retaining** `owner` (no access removed).

**Per-KB Search Access panel + reconciler.** A source manager or org admin can grant additional people and teams Search access from `KbSharingPanel`. The page calls `PUT /api/rag/kbs/[id]/sharing`, which diffs the requested audience against the prior set and explicitly removes retired `reader` tuples plus stale legacy `ingestor` tuples. Search-team admins do not receive `manager`; the PUT also cleans manager tuples left by the retired shared-management projection. The panel's Owner is the single source-management owner and is reconciled on `ingestion_source`, not a query owner on `knowledge_base`.

**Reusable publication approval.** Self-service work remains immediate inside a personal or ordinary Owner scope. Publishing beyond that scope separates requested state from effective state:

```text
request → policy plan → publication_requests(pending)
                         │
                         ├─ reject/supersede → effective state unchanged
                         └─ approve → revision check → domain adapter → effective state
```

| Adapter | Approval applies |
|---|---|
| RAG datasource | New Search audiences, company-wide Search removal, and material connector-setting changes |
| RAG collection | New Search audiences and datasource membership or removal in a company-wide collection |
| Slack | Self-service channel onboarding, team assignment, and initial agent route |
| Webex | Self-service space onboarding, team assignment, and initial agent route |

- `publication_requests` stores requested/effective state, a resource revision, risk facts, status, decision history, requester, and delegated reviewers.
- A newer proposal supersedes older pending proposals. Approval acquires a bounded `applying` lease and fails closed on resource-revision drift.
- Approvers need both the live `policy:publication#can_approve` grant and a current reviewer assignment for the request type. Organization admins remain the fallback approvers.
- RAG, Slack, and Webex have separate reviewer lists and can be enabled independently. Organization-wide self-approval is disabled by default. Trusted publishers, company-wide audiences, and team-specific reviewers apply only to RAG.
- Pending counts appear in the header alert menu.
- Scheduled RAG reload and wholesale stale-chunk replacement are unchanged. Approval governs publication policy and material configuration proposals, not the existing refresh pipeline.

**Knowledge sidebar tab gates and empty states (PR 2, 2026-05-27).** The Knowledge Base sidebar (`KnowledgeSidebar`) now consults `GET /api/rbac/kb-tab-gates` and renders any tab the user cannot see as a disabled-with-tooltip control. Org admins (per the PR 1 super-grant) get every tab true with `kb_count=-1` and no empty-state banner. Non-admins get a tab visibility map driven by the count of `knowledge_base:<id>` objects on which they have `can_read` (resolved by listing `/v1/datasources` and filtering via `filterResourcesByPermission` with `bypassForOrgAdmin: false`). When `has_any_kb=false` the sidebar shows a "you don't have access to any knowledge bases yet" banner and the `NoKbAccessEmpty` component replaces the page-level body for Search / Data Sources / Graph / MCP Tools. The same `RAG_ADMIN_BYPASS_DISABLED` kill switch disables the org-admin short-circuit on this route, forcing every caller through the per-resource path. The hook fails closed: until the BFF responds every tab is hidden so the UI never exposes a control the BFF would 403.

**Explicit "data source author" capability (spec 2026-06-03-explicit-ingest-capability).** Creating a *new* data source is a distinct org-level capability, not a permission on an existing datasource. The model adds `organization#ingestor: [team#member, team#admin]` and `organization#can_ingest = ingestor or admin`; org admins opt authoring teams in from the team Knowledge Bases tab. Any caller with `organization#can_ingest` may create a personal source. Assigning an Owner team is optional, but when selected the caller must belong to that exact opted-in team (org admins bypass). All connector and file create endpoints apply this rule. `write_datasource_ownership` then projects one of two Owner states: personal `user:<sub> owner ingestion_source:<id>`, or team member `reader` + team-admin `manager` on `ingestion_source`. Personal sources also write `user:<sub> owner knowledge_base:<id>` so the creator can query directly and through agents. Team-owned sources receive no implicit query grant; explicit Search audiences receive KB `reader` only. Every check fails closed.

**Explicit "search" capability (spec 2026-06-03-explicit-search-capability).** *Using* search is now a distinct, explicitly-granted org-level capability — the feature-level gate, layered **above** the narrower per-tool `mcp_tool#can_call` and per-datasource `data_source#can_read` checks. This closes a leak where a tool shared org-wide (writing `organization#member caller`) let *every* org member invoke it, and where the built-in `search`/`fetch_document` tools (which have no `mcp_tool` object) were never gated at all: holding `can_call` on a shared tool no longer, by itself, permits search. The model adds `organization#searcher: [team#member, team#admin]` and `organization#can_search = searcher or admin`, so only org admins (intrinsically) and members of opted-in teams can search. Org admins opt teams in via the `SearchCapabilityToggle` in the team dialog's Knowledge Bases tab → `PUT/DELETE /api/admin/teams/[id]/search-capability` (org-admin gated, writes/deletes `team:<slug>#member searcher organization:<key>`). The `kb-tab-gates` route gates the Search tab via a direct `organization#can_search` check (`search = can_search`, decoupled from `has_any_kb` — see the tab-gate composition note below). The BFF rag proxy (`requireSearchCapability` in `ui/.../api/rag/[...path]/route.ts`) enforces `can_search` on `/v1/query` and `/v1/mcp/invoke` (built-in + custom tools) **before** the per-tool `can_call` gate; server-side, `authorize_search` (`rag/server/.../rbac.py`) enforces the same on both endpoints as defense-in-depth for direct/agent callers. Org admins bypass (kill-switchable via `RAG_ADMIN_BYPASS_DISABLED`); the per-datasource result ACL (`constrainSearchBody` / `inject_kb_filter`) still narrows results afterward. Every check fails closed. This is an opt-in capability with **no backfill** — a deliberate behavior change so the prior over-broad search default is closed.

**KB tab-gate composition — capability-driven tabs are decoupled from `has_any_kb` (2026-06-04 fix).** The original PR 2 sidebar derived *every* tab from the readable-KB count (`has_any_kb`), so an org admin who granted a team Search or datasource-creation capability but had **not yet assigned any KB** left members with all tabs greyed out — the capability was unreachable, contradicting the toggle's own copy ("results are still limited to the data sources each member can read"). `kb-tab-gates` now composes the non-admin gates as: `search = can_search`; `data_sources = has_any_kb OR can_ingest`; `mcp_tools = has_any_kb OR can_search`; `graph = has_any_kb` (graph stays purely read-driven — it needs readable content). A capability alone is therefore enough to reach its feature even before the first KB is assigned (Data Sources resolves the author-first chicken-and-egg; Search/MCP Tools render with an empty, server-scoped result set). This changes **UI tab visibility only** — the server-side data paths (`requireSearchCapability` + `authorize_search`, `authorize_datasource_create`) re-check the same capabilities and the per-datasource ACL still narrows results, so an enabled-but-empty tab never leaks data. The `KnowledgeSidebar` "ask an admin to share a KB" banner is likewise suppressed when the user holds any explicit capability, so it no longer contradicts the now-enabled tabs.

Slack and Webex bot channel/space team resolution uses Mongo mappings (`channel_team_mappings`, `webex_space_team_mappings`) to find the owning CAIPE team. Membership prechecks are OpenFGA-first: the bot checks `user:<sub> member team:<slug>` and only falls back to legacy `teams.members` when the PDP is not configured or unavailable. A negative OpenFGA decision denies the bot interaction before OBO so users get the friendly "not a member" response. (Phase 3 of spec 2026-05-24-derive-team-from-channel removed the per-team OBO scope mint — the bot now mints a team-agnostic OBO token and the channel→team mapping is the sole source of team identity downstream.)

When a Slack channel route runs **as a service account** (the route's `execution_identity.mode = service_account`), the bot mints a service-account OBO token (`preferred_username = service-account-<clientId>`) and dispatches the agent under it. Dynamic Agents' CAS agent-use check (`require_agent_use_permission`) must namespace that caller as `service_account:<sub>` — not `user:<sub>` — when it POSTs to `/api/authz/v1/decisions`, because the BFF's subject-binding compares the decision `subject` against its own caller resolution (`service-account-` prefix ⇒ `service_account`). Sending `user` for a service-account token fails the bind, returning a meta `403` that the PEP fails closed into a `503`. The subject type is therefore derived from the token's `preferred_username` consistently across the BFF (`jwt-validation.ts`), the Dynamic Agents CAS client (`auth/authz.py`), and the bridge.

RAG accepts both browser user tokens and ingestor client-credentials tokens from Keycloak. For local Docker Compose, `OIDC_DISCOVERY_URL` and `INGESTOR_OIDC_DISCOVERY_URL` may be either the realm base URL (`http://keycloak:7080/realms/caipe`) or the full `.well-known/openid-configuration` URL; the server normalizes both forms before fetching metadata. Keycloak service-account tokens use `preferred_username=service-account-<client>`, so RAG treats that token shape as machine-to-machine and assigns `RBAC_CLIENT_CREDENTIALS_ROLE`; human tokens are identity-only and use OpenFGA for authorization.

#### User-facing Role Cleanup

The Admin UI intentionally separates **team/resource authorization** from **raw Keycloak plumbing**:

- Keycloak system roles (`default-roles-caipe`, `offline_access`, `uma_authorization`) are hidden from the table and role filter because they are OIDC/UMA plumbing, not product permissions.
- Teams are the human-facing source for membership and most resource grants.
- Legacy resource roles (`agent_user:`*, `agent_admin:*`, `tool_user:*`, `kb_reader:*`, `task_user:*`, `skill_user:*`) are stale compatibility data only; cleanup scripts can remove them from local/dev realms.

`GET /api/admin/users` exposes raw Keycloak protocol roles for platform-admin diagnostics. Non-admin callers must hold `admin_surface:users#can_read` and then receive a self-scoped response containing only their own Keycloak user row. `GET /api/admin/users/[id]` checks `user_profile:<id>#can_read`, which is granted by `owner user_profile:<sub>` for self reads and by `organization:<org>#admin` for admins. The baseline Users tab can show "my access" without leaking other users; mutation controls remain admin-only. Product authorization should be read through teams and OpenFGA relationships. Local/dev realms can remove stale legacy CAIPE roles with `scripts/cleanup-local-keycloak-legacy-roles.py`.

Do not delete Keycloak system roles as part of cleanup. They may be required by Keycloak or OIDC flows even though CAIPE hides them from the main admin UX.

### External IdP Brokering (Duo SSO, Okta, or any OIDC provider)

> **Badge analogy:** The partner agency desk. Whether it's Duo SSO, Okta, or any other corporate identity provider, they all speak the same language (OIDC). Keycloak is the single translator — it talks to whichever agency is configured and converts their badges into standard building badges. The rest of the building never needs to know which agency originally issued the contractor's credentials.

Keycloak acts as a **relying party** to the upstream IdP (OIDC). From the user's perspective it's invisible — they see only the upstream IdP login page. From a security perspective:

```
Browser ──OIDC auth code flow──▶ Keycloak
                                      │
                   ──OIDC auth code──▶ Upstream IdP (Duo SSO / Okta / any OIDC)
                                      │
                   ◀── id_token ───────┘  (external claims: email, name, groups)
                        │
                   Preserves external group claims for team sync
                   Issues new Keycloak JWT with identity claims
                        │
Browser ◀── Keycloak JWT ──────────────┘
```

**Supported upstream IdPs** — the `init-idp.sh` script configures any OIDC provider generically via OIDC discovery (`/.well-known/openid-configuration`):


| Provider                  | `IDP_ALIAS` (in realm) | `IDP_ISSUER` example                                                      | Notes                                                                                                  |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Duo SSO                   | `duo-sso`              | `https://sso-xxx.sso.duosecurity.com/oidc/xxx`                            | Uses `firstname`/`lastname` (non-standard); extra IdP mappers handle both `given_name` and `firstname` |
| Okta (OIDC)               | `okta-oidc`            | `https://your-org.okta.com` or `https://your-org.okta.com/oauth2/default` | Standard OIDC claims; groups come from Okta's `groups` claim (requires Okta app config)                |
| Okta (SAML)               | `okta-saml`            | —                                                                         | SAML 2.0; configured as a SAML IdP in Keycloak; attribute mappers needed for groups                    |
| Microsoft Entra ID (OIDC) | `entra-oidc`           | `https://login.microsoftonline.com/{tenant-id}/v2.0`                      | Standard OIDC; groups claim requires Entra app manifest `groupMembershipClaims` config                 |
| Microsoft Entra ID (SAML) | `entra-saml`           | —                                                                         | SAML 2.0; common in enterprise M365 environments                                                       |
| Generic OIDC              | any alias              | any OIDC-compliant issuer URL                                             | Works as long as the provider exposes `/.well-known/openid-configuration`                              |


**To wire up a new IdP**, set these env vars and run `init-idp.sh` (or restart the `init-idp` container — it is idempotent):

```bash
IDP_ALIAS=okta                                 # short alias, used in kc_idp_hint
IDP_DISPLAY_NAME="Okta SSO"                    # shown on Keycloak login page (if visible)
IDP_ISSUER=https://your-org.okta.com           # OIDC issuer URL
IDP_CLIENT_ID=<okta-app-client-id>
IDP_CLIENT_SECRET=<okta-app-client-secret>
IDP_ACCESS_GROUP=caipe-users                   # Okta group → chat_user role (optional)
IDP_ADMIN_GROUP=caipe-admins                   # Okta group → admin role (optional)
KEYCLOAK_ADMIN_FRONTEND_URL=http://localhost:18080  # optional private master-realm admin URL
KEYCLOAK_FORCE_IDP_REDIRECT=true               # disable local app-realm login fallback
OIDC_IDP_HINT=okta                             # auto-redirect browser to this IdP alias
```

`**OIDC_IDP_HINT**` (set in `ui/.env.local`) is passed to Keycloak as `kc_idp_hint` on every auth request. It skips the Keycloak login page entirely and redirects straight to the named IdP. Set it to the same value as `IDP_ALIAS`.

`**KEYCLOAK_FORCE_IDP_REDIRECT=true**` makes the app realm configured-IdP only: `init-idp.sh` sets the browser flow's Identity Provider Redirector `defaultProvider` to `IDP_ALIAS`, marks that redirector as required, and disables the local username/password form. This prevents CAIPE users from seeing the Keycloak login screen even if a client omits `kc_idp_hint`. Keep the `master` realm admin console on its private URL for operational access.

If the upstream OIDC app requires PKCE on the Keycloak broker flow, enable `keycloak.idp.pkce.enabled=true` in Helm. The chart passes `IDP_PKCE_ENABLED=true` and `IDP_PKCE_METHOD=S256` to `init-idp.sh`, which adds `pkceEnabled=true` and `pkceMethod=S256` to the Keycloak OIDC identity-provider config. Leave it disabled when the upstream IdP does not require broker-side PKCE.

`**KEYCLOAK_ADMIN_FRONTEND_URL**` is optional and only affects the `master` realm admin console. Use it when public ingress intentionally exposes only `/realms/caipe` and `/resources`; the `caipe` realm issuer and Duo broker redirect remain on the public Keycloak hostname.

In production, the browser-facing issuer is Keycloak, not the upstream IdP. For the Grid RBAC environment the UI uses:

```bash
OIDC_ISSUER=https://idp.caipe.example.com/realms/caipe
OIDC_CLIENT_ID=caipe-ui
OIDC_IDP_HINT=duo-sso
NEXTAUTH_URL=https://caipe.example.com
```

Duo credentials stay on the Keycloak IdP broker only. The Duo application's redirect URI points to Keycloak's broker endpoint (`https://idp.caipe.example.com/realms/caipe/broker/duo-sso/endpoint`), while the Keycloak `caipe-ui` client allows NextAuth's callback (`https://caipe.example.com/api/auth/callback/oidc`). Keycloak must be started with a public hostname such as `KC_HOSTNAME=https://idp.caipe.example.com` and `KC_PROXY_HEADERS=xforwarded` so discovery metadata and JWT `iss` match the public issuer. A host-specific Docker Compose overlay (kept outside this repo) sets those Keycloak values alongside the UI/RAG/Dynamic Agents `OIDC_ISSUER` overrides; otherwise browser login links can point back at the local dev default (`http://localhost:7080`).

**Claim mapping chain:** The IdP sends `email`, `given_name`/`firstname`, `family_name`/`lastname`, and `groups` claims. Keycloak IdP mappers write identity attributes to the local user record. Group claims are input to the identity-group-to-team sync path, which writes OpenFGA team relationships; they are not translated into CAIPE realm roles.

> The login sequence diagram (one-time login + the silent first-broker-login flow) lives in [Workflows › Login](./workflows.md#login--first-time-broker-login).

### Keycloak Auth Reconciliation Job

Keycloak browser-flow and identity-provider settings are persisted inside Keycloak's database, not in Kubernetes objects. Upgrades can recreate pods and chart resources without automatically reasserting the `Identity Provider Redirector`, local-login disablement, first-broker-login flow, or required-action settings. The durable design is:

- Keep an idempotent `keycloak-auth-reconcile` Job.
- Make it chart-owned, not a Grid-only `extraDeploy` override.
- Run it as an early ArgoCD/Helm sync hook on install and upgrade.
- Use `BeforeHookCreation,HookSucceeded` cleanup.
- Remove any temporary Grid-specific reconcile job once the chart contains the same behavior.
- Reassert realm token/session lifetimes on upgrade: access tokens remain short-lived at 1 hour, SSO idle timeout is 8 hours, and the absolute SSO max lifespan is 24 hours unless overridden through the Keycloak chart values.

A `CronJob` is intentionally avoided. Periodic reconciliation would hide ownership drift and repeatedly exercise Keycloak admin credentials when nothing changed. The desired model is one job pod per install/upgrade event, with idempotent Admin API calls that restore the browser-flow and IdP invariants for every downstream install.

### User Profile & Custom Attributes

Keycloak 26+ enforces a user profile schema. Custom attributes are silently dropped unless declared or `unmanagedAttributePolicy=ADMIN_EDIT` is set on the user profile API. The Helm realm import JSON must not include `unmanagedAttributePolicy` as a top-level realm field because Keycloak 26.3 rejects that `RealmRepresentation` property during import. `init-idp.sh` patches both supported user-profile settings after the server starts:

- Adds `slack_user_id` to the user profile schema with `admin`-only view/edit permissions
- Sets `unmanagedAttributePolicy=ADMIN_EDIT` so other Admin API attribute writes succeed
- Makes `firstName` and `lastName` optional, disables Keycloak's `VERIFY_PROFILE` required-action provider, and clears any assigned `VERIFY_PROFILE` actions from existing users so enterprise SSO users are never stopped at Keycloak's "Update Account Information" form

The Keycloak container exposes login/API traffic on `8080` and management health on `9000`; Helm readiness/liveness probes target the management port.

### Account Linking (Slack)

Two onboarding paths, evaluated in order:

- **Auto-bootstrap** — bot looks up the Slack user's email, finds an existing Keycloak user, writes `slack_user_id` silently. Zero user action required.
- **Just-In-Time user creation** (default ON, `SLACK_JIT_CREATE_USER=true`, spec 103) — when no existing Keycloak user matches, the bot creates a federated-only shell user via `POST /admin/realms/{realm}/users` using the same `caipe-platform` admin credential. Optional domain allowlist via `SLACK_JIT_ALLOWED_EMAIL_DOMAINS`. 409 races are resolved by re-querying.

There is no interactive/bearer-link onboarding path for Slack: a signed link is redeemable by whoever holds it, not provably by the intended Slack user, so it was removed as a security hole. If neither path above resolves a Keycloak user (e.g. `SLACK_JIT_CREATE_USER=false` and no email match), the user is treated as unlinked and told to contact an admin.

The full sequence (JIT request body, error kinds, and post-link OBO flow) is in [Workflows › Slack identity linking](./workflows.md#slack-identity-linking-auto-bootstrap--jit).

### Account Linking (Webex)

Webex uses the same Keycloak identity boundary as Slack but stores the Webex
person identifier in `webex_user_id`. Linking goes through a real Webex OAuth
round trip at `/api/auth/webex-link/start` and `/api/auth/webex-link/callback`
in the Web UI backend — the URL carries no bearer credential, so proof of the
Webex identity comes from the OAuth exchange itself, not from a signed link.
The callback rejects attempts to bind one Webex person ID to multiple
Keycloak users. Admins can unlink a user's Webex identity
(`DELETE /api/admin/webex/users/[id]`); re-linking is done by the user through
the same self-service OAuth flow.

For group spaces, the default Webex bootstrap path keeps signed linking URLs out
of the shared room. The bot posts only a generic thread notice in the group, then
sends the requesting person a 1:1 Adaptive Card with the SSO linking URL. If the
1:1 send fails, the group fallback still avoids posting the signed URL publicly.
Slack-style implicit/profile linking is treated as a user-choice path, not the
default: it should only be enabled when Webex org and verified-email trust checks
can prove the Webex profile maps unambiguously to one Keycloak user.

After linking, the Webex bot exchanges its service-account token for a user OBO
token with the selected active team scope. The Webex bot clients are
`caipe-webex-bot` and `caipe-webex-bot-admin`; the `caipe-ui` client receives the
`webex-bot-admin-audience` mapper so runtime admin calls can use
client-credentials tokens. The full runtime sequence is in
[Workflows › Webex space ReBAC](./workflows.md#webex-space-rebac-and-bot-dispatch).

### Service Accounts (self-service bot identities)

> **Badge analogy:** A contractor badge any team lead can issue from the front
> desk — scoped to specific doors, owned by their team, revocable, and never
> more powerful than the person who issued it. Distinct from the operator-issued
> Slack/Webex bot badges.

Service accounts (spec `2026-05-24` → `2026-06-05-service-accounts`) are
**user-minted, team-owned** bot identities for external/API callers (CI jobs,
webhooks, alerts). Unlike the operator-provisioned Slack/Webex bots, any team
member creates them self-service from **Admin → Settings → Service Accounts**.
Three stores of record, each authoritative for one concern:

| Store | Owns | Authoritative for |
|-------|------|-------------------|
| **Keycloak** | a confidential client (`serviceAccountsEnabled`) per SA | the **credential** (identity) |
| **OpenFGA** | tuples on `service_account:<sub>` | **access** (ownership + scopes) |
| **MongoDB** `service_accounts` | a display doc | **metadata** (name, status, links) |

**Identity chain:** the SA is a dynamically-created Keycloak confidential client
(`caipe-sa-<slug>-<short-rand>`); its service-account-user `sub` (UUID) IS the
OpenFGA subject id. The credential = `client_id` + `client_secret` (Keycloak
client-credentials grant), shown **once** on create/rotate and never persisted
in CAIPE. Rotation regenerates the secret; revocation deletes the client.

**Authorization model** (additive — `service_account` was subject-only before):

```
type service_account
  relations
    define owner_team: [team#member]
    define can_manage: owner_team
```

- Ownership: `team:<team>#member owner_team service_account:<sub>` (exactly one team).
- Management authority derives from ownership — the BFF gates every manage action
  with `check(user:<caller>, can_manage, service_account:<sub>)`.
- Scope grants reuse existing patterns: `service_account:<sub> can_use agent:<id>`
  and `service_account:<sub> can_call tool:<server>/<tool>` (+ `tool:<server>/*`).

**Permission-bound granting:** a creator/editor can only grant the SA scopes they
themselves currently hold (`check(user:<editor>, …)` at write time — defense in
depth on top of the UI's grantable list). Removal is unconditional for any
owning-team member. Granted access is **static** — it does not re-derive from the
creator's later permission changes.

**Subject detection (all FOUR enforcement layers agree):** a token is a service account iff
`preferred_username` starts with `service-account-`; such callers namespace as
`service_account:<sub>`, everyone else as `user:<sub>`. Enforced identically at
(1) the BFF resource-authz (`jwt-validation.ts` / `resource-authz.ts`), (2) the **BFF agent-use check**
(`requireAgentUsePermission` in `openfga-agent-authz.ts` — the gate the SA invoke path `/api/v1/chat/*`
actually hits; for SA subjects it also skips the human-only email-principal and team-union fallbacks),
(3) the Dynamic Agents CAS client (`auth/authz.py`), and (4) the AgentGateway bridge (`bridge/main.py`).
The bridge additionally enforces the **caller-keyed tool check** (see
[Workflows › Caller-Keyed Tool Authorization](./workflows.md#caller-keyed-tool-authorization-service-accounts-fr-012a)),
which only receives the data to run because the gateway's `extAuthz` policy forwards the request body
(`includeRequestBody`). Note: SAs invoke via the **dynamic-agent** path and hold **no** organization-membership grant (keeps them least-privilege
per FR-004 — their reach is exactly their agent/tool scopes).

**Coarse-gate baseline:** SAs also hold `service_account:<sub> caller mcp_gateway:list` (written at create,
deleted at revoke) so they pass AgentGateway's coarse ext_authz gate — humans get this at login bootstrap;
SAs never log in. This required adding `service_account` to `mcp_gateway.caller` in the model.

**Team-deletion guard (FR-025):** a team cannot be deleted while it still owns any
service account — `DELETE /api/admin/teams/[id]` lists
`service_account` objects via `owner_team` and returns `409
TEAM_OWNS_SERVICE_ACCOUNTS` until they are revoked, preventing orphaned
unmanageable identities.

The create + external-call sequences are in
[Workflows › Service Account create & external call](./workflows.md#service-account-create--external-call).
The collection, env, and naming details are in the BFF library README at
`ui/src/lib/README-service-accounts.md` (outside the docs tree).

---

## Component 2: CAIPE UI — The Reception Desk

> **Badge analogy:** The reception desk at each department entrance. When you badge in, it reads your chip (JWT), checks your clearance level for this department, and either waves you through or says "sorry, you don't have access here." It doesn't phone HR — the badge chip already carries everything needed to make the decision.

**Technically:** Next.js App Router with NextAuth (Auth.js v5) for OIDC session management. Every API route handler runs `requireRbacPermission()` which validates the server-side session and enforces role requirements before proxying to backend services.

### Authentication Flow

```
1. Browser visits http://localhost:3000
2. NextAuth detects no session → 302 to Keycloak (OIDC auth code flow)
3. Keycloak → Duo SSO (kc_idp_hint=duo-sso auto-redirects, user never sees KC)
4. Duo SSO login → auth code returned to Keycloak
5. Keycloak issues JWT → NextAuth exchanges code for tokens
6. NextAuth stores small session metadata in the encrypted httpOnly cookie
7. Large OAuth tokens (access, refresh, ID token) stay in the UI server's in-process token cache and are rehydrated server-side
```

**Security note:** The session cookie is httpOnly, Secure, SameSite=Lax, and encrypted with `NEXTAUTH_SECRET`. Large OAuth tokens are kept out of the browser cookie to avoid oversized request headers when Keycloak emits RBAC scopes, groups, or relationship-derived claims. If the UI process restarts and the in-process token cache is lost while a browser still has a valid slim session cookie, the session is marked `AccessTokenMissing` and the token-expiry guard sends the user back through login instead of allowing tokenless backend proxy calls. For multi-replica deployments, use sticky sessions or replace the in-process token cache with a shared store.

### Server-Side Authorization (`api-middleware.ts`)

```typescript
// Every protected API route:
const { user, session } = await getAuthFromBearerOrSession(request);
await requireRbacPermission(session, "rag", "kb.query");
```

The middleware keeps the authenticated session, route-handler context, and
conversation-access MongoDB result explicitly typed. Values that cross those
boundaries use concrete interfaces or `unknown` plus runtime narrowing rather
than an unchecked `any`; this is a compile-time safety constraint and does not
change the authorization decisions described below.

Two authorization paths:

1. **Primary PDP:** `requireRbacPermission()` calls Keycloak Authorization Services with the caller's bearer/session access token and the requested `resource#scope`.
2. **Role-based fallback:** `hasRoleFallback()` checks `realm_access.roles` from the session JWT when the PDP is unavailable or not configured.
3. **Bootstrap admin path:** `isBootstrapAdmin(email)` still provides a temporary break-glass fallback from `BOOTSTRAP_ADMIN_EMAILS`, but the same email list is also reconciled by the BFF into durable OpenFGA tuples. Prefer the durable tuple state shown in Admin → Security & Policy → Keycloak, and remove the email fallback once group/team-admin relationships are configured. `requireMigrationSuperAdmin` (the guard on privileged ReBAC migration endpoints) gates on `user.role === 'admin'` rather than bootstrap email — AD group admins and super-admins team members both satisfy this check once their login bootstrap has run.

**`authMethod` distinguishes the literal auth path taken, since `principalType` cannot (2026-09-01 fix).** `getAuthFromBearerOrSession()` now stamps `session.authMethod: 'bearer' | 'session'` at every return point. This exists because `principalType: 'oidc_user'` is set identically for a genuine browser session (NextAuth cookie) and for an OBO-exchanged Bearer token (Slack bot, Webex bot, or any external script relaying a human user) — it cannot be used to tell those apart. `authMethod` reflects which literal header/cookie the server actually saw and cannot be spoofed by the caller. `POST /api/chat/conversations` uses it to force `client_type: 'api'` (overriding a false `client_type: 'webui'` claim) on any Bearer-authenticated request that doesn't self-declare `'slack'`/`'webex'` — Slack/Webex bot's own Bearer calls are still trusted since we control that first-party code, but an arbitrary external caller can no longer successfully impersonate the browser UI.

Routes that have not yet been rewritten inline no longer remain session-only: the deprecated `withAuth()` compatibility wrapper now uses `getAuthFromBearerOrSession()`, resolves the route family to a least-privilege RBAC policy, and calls `requireRbacPermission()` before invoking the handler. The old generic umbrella is now split for basic user surfaces: profile and identity-link routes use `self_profile#read/write`, user search uses `user_directory#read`, chat/model discovery uses `chat#invoke`, settings use `user_settings#read/write`, feedback uses `feedback#submit`, session files use `user_files#read/write`, AI assist uses `ai_assist#invoke`, credentials use `credential_vault#use`, and platform settings reads use `system_config#read`. Unmatched compatibility routes fall back to `admin_ui#view` for `GET` and `admin_ui#manage` for writes instead of a generic baseline-use capability. These user-surface capabilities map to organization-level OpenFGA relations (`can_read_self`, `can_manage_self`, `can_search_directory`, `can_chat`, `can_submit_feedback`, `can_use_files`, `can_use_ai_assist`, `can_use_credentials`) that derive from existing organization membership/admin relationships so upgrades preserve current access automatically.

**Skill authoring is a member self-service surface (2026-06-04 fix).** The coarse `withAuth` gate for the Skill Builder CRUD (`/api/skills/configs` POST/PUT/DELETE) and for minting the caller's own read-only catalog API keys (`/api/catalog-api-keys`) maps every `skill` capability — `skill#view`, `skill#invoke`, `skill#configure`, and `skill#delete` — to the member-level organization relation **`can_use`** (`member or admin`), not the admin-only `can_manage`. Per-skill mutation and deletion of an *existing* skill are still constrained per-resource by ownership inside the route handlers via `requireResourcePermission({ type: "skill", action: "write" | "delete" })`; the org gate only asserts "the Skill Builder exists for you at all." Before this fix `skill#configure`/`skill#delete` fell through `organizationRelationFor` to `can_manage`, so generic members hit `403 "You do not have permission to perform this action."` when creating a skill. Sharing a skill with a team in the builder uses the same member-accessible `GET /api/dynamic-agents/teams` "teams available for sharing" endpoint as the RAG KB / MCP / Dynamic-Agent editors; members pick from their own teams (org admins from all teams) and the save writes `team:<slug>#member user skill:<id>` grants.

**Catalog credentials are catalog-read principals, not general user sessions.** The BFF accepts a catalog API key only after verifying that it is active, unexpired, has `catalog:read`, and resolves to an existing owner. Locally signed skills JWTs must carry the exact token type, `skills:read` scope, issuer, audience, and subject claims. Both principal types are restricted to `GET /api/skills`; shared RBAC and resource-authorization helpers reject them on all other routes. Catalog results use the credential owner's normal OpenFGA visibility instead of a synthetic-user bypass. `POST /api/skills/token` accepts only an active cookie-backed NextAuth session and requires the member-level `skill#invoke` capability before minting a caller-bound local token.

Credential APIs additionally keep concrete `secret_ref` checks for payload and metadata operations. `credential_vault#use` only opens the credential surface; it does not authorize retrieving or using a specific secret. Slack and Webex runtime access-check APIs likewise require `slack_channel:<workspace>--<channel>#can_read` or `webex_space:<workspace>--<space>#can_read` before they evaluate the requested channel/space grant and target user grant, preventing those endpoints from becoming permission oracles for messaging resources the caller cannot inspect. Platform org admins use the standard resource-authz admin bypass because they already hold global `organization:<org_key>#can_manage`.

For a route-by-route breakdown of which BFF `/api/*` endpoints use resource-scoped PDP, which still rely on the legacy `withAuth` wrapper, and which have a `user.role === 'admin'` bypass, see the [PDP Coverage Audit](./pdp-coverage-audit.md). The audit also documents how to read `audit_event_id` rows and how to add explicit route capabilities.

### Dynamic Agent Execution Gate

Dynamic Agent execution is a data-plane ReBAC decision, not a Keycloak UMA
management-plane decision. The Web UI backend chat proxy routes authenticate the caller,
extract the stable session or bearer-token subject, and check OpenFGA before
proxying execution to Dynamic Agents:

```text
user:<sub> can_use agent:<agent_id>
```

For compatibility with existing team data that was originally keyed by email,
the Web UI backend and Dynamic Agents runtime check the stable subject first and then
fallback to `user:<email> can_use agent:<agent_id>` when the token carries an
email claim. New relationship writers should prefer Keycloak `sub` values.
The UI auth middleware also persists the verified Keycloak subject into
MongoDB `users.keycloak_sub` and `users.metadata.keycloak_sub` during session or
bearer authentication. This gives migrations and admin tooling a durable
email-to-sub mapping without depending on transient session cookies.

For browser sessions, the Web UI backend forwards the Keycloak access token to
Dynamic Agents when it is present so the runtime can bind
`current_user_token` and pass the same bearer to AgentGateway-backed MCP calls.
If the slim NextAuth cookie survives a UI restart but the server-side token
cache is gone, Dynamic Agents proxy routes still forward the signed-in
`X-User-Context` fallback instead of blocking configuration reads, AI review,
or agent save flows. Token-backed AgentGateway tool calls may still require the
user to sign in again before they can be probed or invoked.

`POST /api/v1/chat/stream/start`, `POST /api/v1/chat/invoke`,
`POST /api/v1/chat/stream/resume`, and `POST /api/v1/chat/stream/cancel`
fail closed before any backend call unless the caller can use the selected
agent and can write the target conversation through implicit ownership or an
explicit OpenFGA relationship.

The Web UI backend emits a unified RBAC Audit event for every OpenFGA
agent-use decision, and Python producers such as Dynamic Agents emit the same
structured `openfga_rebac` event for direct bearer-token calls. These producers
do not write audit storage directly. They buffer JSON events and submit batches
to the lightweight `audit-service` (`AUDIT_LOG_BACKEND=service`, default),
which owns the durable local/S3 storage backend and the read API used by the
Admin UI. If `audit-service` is unavailable or audit is intentionally disabled,
producers log a warning and drop the audit batch; authorization itself remains
non-breaking. Both paths use `pdp=openfga`; the checked tuple is stored in a
resource reference shaped like:

```text
user:<sub> can_use agent:<agent_id>
```

This gives operators a single RBAC Audit view for runtime OpenFGA allows,
denies, and PDP-unavailable failures alongside admin ReBAC graph/check actions.
The Admin UI's RBAC Audit type filter uses `All` as a literal unfiltered view
over audit-service events; selecting a specific type narrows the result to
`auth`, `openfga_rebac`, `tool_action`, or `agent_delegation`. The AgentGateway
`openfga-authz-bridge` also posts each external `ext_authz` decision through the
same audit-service write path with `source=openfga_authz_bridge`, so
gateway-level OpenFGA allow/deny/error decisions appear without a trace backend.
`audit-service` is the audit owner; UI, Dynamic Agents, and bridge processes are
producers only.

### Personal DM Experience — Phase 2 (spec 2026-05-24)

Slack DMs and Webex 1:1 spaces dispatch through a personal chain. (The
legacy `active_team` JWT claim has been removed; see Phase 3 demolition
notes above and the deprecated Spec 104 section below.) The BFF owns three new routes,
the Web UI broadens its agent-use check to honor team-union grants, and
both bots intercept text/slash commands before route resolution.

| Surface | Endpoint | Purpose |
|---------|----------|---------|
| Bot → BFF | `POST /api/user/check_agent_access` | Pure PDP probe for the DM dispatch chain. Wraps `evaluateAgentAccess(subject, agent_id)` (direct grant → team-union fallback) and returns `{allowed, reason, path, matched_team_slug}`. No team scope needed on the token. |
| Bot → BFF | `GET /api/user/accessible-agents` | Pagination-friendly list of agents the calling user can `can_use`. Drives `/caipe-list` (Slack) and `list` (Webex). |
| Bot/Web UI → BFF | `GET/PUT /api/user/preferences` | Per-user Web, Slack, and Webex defaults. A `null` surface value uses the resolved platform default returned by the same endpoint. Slack `/caipe-use default` and Webex `use default` clear their own surface value. |
| Web UI | `requireAgentUsePermission` | New `ALLOW_TEAM_UNION` audit reason code. When direct user→agent grants miss, the helper probes the caller's team slugs (`listUserTeamSlugs`) and accepts `team:<slug>#member can_use agent:<id>`. This aligns the Web UI with the bots, which already honored team-mediated grants. |

The bots' DM dispatch chain is:

1. **Thread/space override** (`dm_thread_overrides.OverrideStore` — LRU
   capped at 1000 entries, no TTL, cleared on bot restart or explicit
   `/caipe-use default`).
2. **Saved surface preference** (`slack_default_agent_id` or
   `webex_default_agent_id` via the BFF).
3. **Platform default agent** returned by the BFF when that surface
   preference is `null`.
4. **Deployment `dm_agent_id`** (`SLACK_INTEGRATION_DM_AGENT_ID` /
   `WEBEX_INTEGRATION_DM_AGENT_ID`).
5. **Deployment default fallback.** The platform value comes from
   `platform_config.default_agent_id` (set in Admin → Settings → Default
   Agent), with deployment configuration used when it is unset or
   unreachable. The same platform selection therefore governs Web, Slack,
   and Webex defaults.

Every candidate is re-checked via `POST /api/user/check_agent_access`
before being returned. A stale override that fails the PDP is auto-cleared
with a user-visible notice. A stale saved preference emits a notice but
is NOT auto-cleared (the user may be temporarily off-team). Deployment
defaults fall through silently on deny — org defaults failing is an ops
issue, not something to spam users about. PDP unavailability returns a
clean "try again later" response.

Slack registers `/caipe-help`, `/caipe-list`, and `/caipe-use` Bolt
commands (see `docs/integrations/slack-manifest.md`). Webex parses
plain-text `help` / `list` / `use <agent>` / `use default` via
`text_commands.parse_command_text` and intercepts them in
`handle_webex_message` BEFORE route resolution so an unmapped 1:1 space
still gets a useful response. Both surfaces are rate-limited per user
(default 5 commands per 30s; `SLACK_COMMAND_RATE_LIMIT` /
`WEBEX_COMMAND_RATE_LIMIT`) and reply ephemerally (Slack
`response_type=ephemeral`; Webex DMs the issuer in group spaces, replies
inline in 1:1).

### Credential Exchange Authorization

Connections & Secrets OAuth tokens are never returned to the browser. Browser
users can start or relink OAuth provider connections and can run a server-side
profile check, but `POST /api/credentials/connections/[connection_id]/profile`
refreshes the token inside the BFF and returns only redacted provider profile
metadata or, for Atlassian, redacted accessible-resource metadata when
`/me` returns 403. The same response includes a redacted diagnostics checklist
for the Connections page modal so users can see which validation step passed,
failed, or needs follow-up without receiving token material. The Connections page
also calls
`POST /api/credentials/connections/[connection_id]/refresh` automatically for
the signed-in user's expired or expiring connected providers; that endpoint
persists the refreshed token server-side and returns only non-secret refresh
metadata.

**Per-user scope selection.** Each user may narrow which OAuth scopes their own
connection requests. The My Connections row exposes an "Advanced settings"
panel listing the connector's allowed `scopes` (the connector's `scopes` array
is both the admin-managed upper bound and the default selection — a user can
only narrow within it, never exceed it). The connect route accepts an optional
`?scopes=` selection; `ProviderConnectionService.startConnection` runs the pure
`boundScopes(connectorScopes, requested)` guard — rejecting any scope outside
the connector's allowed set or an empty selection with `400 VALIDATION_ERROR`
so a tampered request cannot escalate, and never minting a zero-scope token.
The choice is carried through the signed OAuth state cookie and persisted as
`requestedScopes` (and `grantedScopes` from the token response `scope` claim)
on the per-user `provider_connections` document. The IdP still encodes the
granted scopes inside the issued token, so the token is valid without the
stored copy; persistence exists so relink pre-fills the user's prior choice
(rather than silently reverting to the full default), the UI can show what a
connection was granted, and the selection is auditable. Existing connections
without these fields and connects that do not open Advanced settings behave
exactly as before (connector default). Changing scopes requires a relink to
take effect; it does not retroactively alter an existing token.

Raw token exchange is reserved for service callers. `POST /api/credentials/exchange`
rejects browser-origin/session requests, verifies the service bearer JWT through
the OIDC JWKS path, requires the credential-service audience header, and can
resolve credentials in two ways:

- `provider_connection_id`: refreshes that specific connection, returning an
  access token only when the JWT subject owns it or has delegated use permission.
- `provider`: lists provider connections owned by the JWT `sub`, selects that
  user's connected provider record, refreshes it, and returns only that user's
  provider access token.

When a caller asks for a specific connection that is not owned by the JWT subject,
the route only returns an access token when the subject has:

```text
user:<service-sub> can_use secret_ref:provider_connection:<connection_id>
```

This keeps Dynamic Agents and MCP runtimes on a narrow service-to-service path
while preserving OpenFGA as the PDP for delegated provider-token use. Dynamic
Agents uses this path behind `USE_IMPERSONATION_TOKENS=true` and forwards every
exchanged provider token to the MCP runtime on `X-CAIPE-Provider-Token`, leaving
the normal `Authorization` header reserved for Keycloak MCP authentication.

Per-provider token handling:

| Provider | MCP auth | Notes |
|----------|----------|-------|
| Atlassian (Jira/Confluence) | Bearer | MCP rewrites the OAuth base URL to `api.atlassian.com/ex/jira/{cloudId}` (cloud-ID auto-resolved & cached) before calling the API. |
| PagerDuty | Bearer (OAuth) **or** `Token token=` (static API key) | MCP picks `Authorization: Bearer <token>` when `X-CAIPE-Provider-Token` is present, otherwise falls back to the static `PAGERDUTY_API_KEY` with the legacy `Token token=` scheme. |
| GitHub / GitLab | Bearer | Upstream expects `Authorization: Bearer <token>`. See the hybrid (per-user OAuth + org PAT fallback) flow below. |
| Knowledge Base (RAG) | Bearer (Keycloak) | The RAG server enforces its own Keycloak/OIDC auth on `/mcp`. Dynamic Agents forwards the caller's **user JWT** (per-user RAG group RBAC); in non-user contexts (background reconcile/probe) it mints a **`caipe-platform` client-credentials** service token. See the hybrid flow below. |

#### GitHub / GitLab hybrid (per-user OAuth with org-PAT fallback)

GitHub and GitLab upstreams authenticate with `Authorization: Bearer <token>`
and historically used a single static org PAT injected at AgentGateway via a
`backendAuth` policy. That made every caller act as the org service account. The
hybrid model lets connected users act as themselves while unconnected callers
transparently fall back to the org token:

1. Dynamic Agents resolves the credential for each `credential_sources` entry.
   When the caller has connected their personal GitHub/GitLab account, it
   exchanges that per-user OAuth token. When no per-user connection resolves, it
   reads the static org PAT from `MCPCredentialSource.fallback_env`
   (`GITHUB_PERSONAL_ACCESS_TOKEN` / `GITLAB_PERSONAL_ACCESS_TOKEN` on the
   Dynamic Agents pod).
2. Either way, the resolved token is forwarded to AgentGateway on
   `X-CAIPE-Provider-Token`.
3. A route-level AgentGateway **transformation** rewrites that header into the
   upstream `Authorization: Bearer` header:
   `'"Bearer " + default(request.headers["x-caipe-provider-token"], "")'`.
   The static `backendAuth` PAT is no longer configured at the gateway — the org
   PAT now lives only on Dynamic Agents as a fallback.

This is a header rewrite (route-level transformation), not the backend-level
`extAuthz` response-header injection that AgentGateway does not support. The
`X-CAIPE-Provider-Token` → `Authorization` transformation is configured in the
standalone static config (`deploy/agentgateway/config.yaml`,
`deploy/agentgateway/config.caipe-rbac.yaml`), the Docker Compose config bridge
(`deploy/agentgateway/config_bridge.py`), and both Helm routing paths
(`templates/agentgateway-static-config.yaml` for static routing,
`templates/agentgateway-mcp.yaml` as an `AgentgatewayPolicy` for the
Gateway-API path).

`GET /api/credentials/inject/atlassian` remains available as a BFF-side injector
contract for future AgentGateway integrations.

#### Knowledge Base (RAG) hybrid (user JWT with `caipe-platform` service-token fallback)

The `knowledge-base` MCP server is backed by the RAG server, which enforces its
own Keycloak/OIDC authentication on `/mcp` (validating issuer, audience —
`caipe-platform` — signature, and expiry). AgentGateway does not forward the
incoming `Authorization` header to MCP backends by default, so the RAG server
previously received no token and returned `HTTP 401`, surfacing in the UI as
`MCP server 'knowledge-base' is unavailable`. The hybrid model supplies the right
identity for each call path:

1. Dynamic Agents resolves a `caller_token` `credential_sources` entry for
   `knowledge-base`. When a per-request user JWT is present (the caller's Keycloak
   token in `current_user_token`, set by `JwtAuthMiddleware`), it forwards that
   user JWT so the RAG server can apply **per-user group RBAC**
   (`team:<slug>#member reader knowledge_base:<id>`).
2. When there is **no** user context — e.g. the background tool reconcile/probe
   (`conv=-`) — Dynamic Agents mints (and caches until ~30 s before expiry) a
   **`caipe-platform` OAuth2 client-credentials** service token via Keycloak
   (`MCP_SERVICE_OIDC_*`, defaulting to `INGESTOR_OIDC_CLIENT_*` / `KEYCLOAK_URL`).
3. Either token is forwarded to AgentGateway on `X-CAIPE-Provider-Token`, and the
   same route-level transformation used by GitHub/GitLab rewrites it into the
   upstream `Authorization: Bearer` header:
   `'"Bearer " + default(request.headers["x-caipe-provider-token"], "")'`.

The transform is configured for the `knowledge-base` route in the standalone
static config (`deploy/agentgateway/config.yaml`,
`deploy/agentgateway/config.caipe-rbac.yaml`), the config bridge
(`deploy/agentgateway/config_bridge.py` —
`DEFAULT_MCP_ROUTE_POLICY_OVERRIDES["knowledge-base"]`), and the Helm static
routing path (`knowledgeBaseTarget` carries `providerTokenAuth: true` in
`_helpers.tpl`). The token-resolution logic lives in
`ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/mcp_client.py`
(`caller_token` kind + `mint_service_client_credentials_token`) and the seed row
ships in `dynamic_agents/services/config.yaml`.

### OpenFGA Relationship Backfill

Existing MongoDB team/resource assignments can be reconciled into OpenFGA with
`scripts/backfill-universal-rebac.ts`. The backfill is a production migration,
not a demo seed: it reads `teams`, `team_membership_sources`,
`users`, `platform_config`, and `dynamic_agents`, then writes idempotent
OpenFGA tuples plus Mongo provenance in `team_membership_sources` and
`rebac_relationships`.
It records first-run status in `rbac_migrations` using the stable migration id
`openfga_relationship_backfill_v1`.

For team membership subjects, the backfill prefers `users.keycloak_sub`, then
`users.metadata.keycloak_sub`, and only falls back to legacy subject fields. If
none of those mappings exist, it may use the member email for compatibility;
operators should run the migration after users have logged in at least once so
the stable subject mapping is available.

The migration materializes team grants such as:

```text
user:<sub> member team:<slug>
user:<sub> admin team:<slug>
team:<slug>#member user agent:<agent_id>
team:<slug>#admin manager agent:<agent_id>
team:<slug>#member caller tool:<tool_prefix>
team:<slug>#member reader knowledge_base:<kb_id>
team:<slug>#member user skill:<skill_id>
team:<slug>#member user task:<task_id>
```

Skill Hub imports use the same `skill:<id>` resource model as locally-authored
skills. Hub skills are projected into stable catalog ids
`hub-<hub_id>-<hub_skill_id>`, so team grants write
`team:<slug>#member user skill:hub-<hub_id>-<hub_skill_id>`. The skills catalog
filters non-admin list responses with `can_read skill:<id>` and content-bearing
runtime responses with `can_use skill:<id>`; admins keep full catalog visibility.
The Skill Hubs admin card can list hub metadata for callers with
`admin_surface:skills#can_read`, but this is operational catalog metadata only.
Which hub skills a user can read or run remains enforced through OpenFGA
`skill:<id>` relationships after the hub has been crawled.
Locally-created team-visible skills and bulk `.zip` imports now reconcile selected
teams into OpenFGA `skill#user` relationships as part of save/import. Skill Hubs
also persist `shared_with_teams`; every force-refresh grants those teams access to
all refreshed hub skill ids, and the `skill_hub_team_grants_backfill_v1` migration
does the same for hub skills that were already crawled before the hub-level team
policy existed.

**Per-skill team shares converge on the shared shareable-resource reconciler
(2026-06-04 fix).** Locally-authored skill create/update now route their team
shares through `reconcileSkillTeamShares` → `reconcileShareableResource` (the
same tuple-core agents, RAG KBs, and MCP tools use, per #1726), with
`objectType: "skill"`, `ownerTeamSlug: null` (skills are user-owned, not
team-owned), and `memberRelations: ["user"]`. This closes two gaps in the old
write-only `grantSkillsToTeams` path: `PUT /api/skills/configs` previously wrote
**nothing** to OpenFGA, so editing `shared_with_teams` (or demoting away from
`team` visibility) updated Mongo but left the old `team:<slug>#member user
skill:<id>` grants in place, and even `POST` only ever wrote — never revoked.
Because the reconciler diffs `previousSharedTeamSlugs` against
`nextSharedTeamSlugs`, un-sharing or re-scoping a skill now emits the delete
tuples for dropped teams instead of orphaning them. Bulk fan-out paths (`.zip`
import, Skill Hub force-refresh) intentionally keep the write-only
`grantSkillsToTeams` helper — they have no previous per-skill state to revoke.
Config (Mongo) stays the source of truth: an OpenFGA failure during reconcile is
logged but never fails the skill save.

GitHub Skill Hub crawl/import uses the hub's validated `credentials_ref` when
configured, otherwise falls back to the server-side `GITHUB_TOKEN` environment
variable on `caipe-ui`. In dev compose, `caipe-ui` receives `GITHUB_TOKEN` from
`.env` or the shell, with `GITHUB_PERSONAL_ACCESS_TOKEN` as a local fallback.

To preserve the default chat path after Dynamic Agent PDP enforcement, the
OpenFGA model allows a typed wildcard subject on `agent.user`, and the
migration writes this tuple when a dynamic default agent is configured:

```text
user:* user agent:<default_agent_id>
```

Default-agent resolution matches the Admin Settings feature: persisted
`platform_config.default_agent_id` first, then the `DEFAULT_AGENT_ID` env
fallback. When neither resolves to a Dynamic Agent, the UI shows the agent
picker instead of starting a chat (no default-agent OpenFGA tuple is produced).
The Slack bot honors the same
`platform_config.default_agent_id` at runtime (via its
`PlatformSettingsReader`, with `SLACK_INTEGRATION_DEFAULT_AGENT_ID` as the
env/YAML fallback), so the one Settings → Platform → Defaults value governs
the Web UI, Slack channel fallback, and Slack DMs. The backfill is still the bulk repair path
for existing environments, but the Web UI also reconciles this typed-wildcard
grant when an admin confirms a default Dynamic Agent, when an admitted user logs in,
and before the chat-available Dynamic Agent picker filters candidates through
OpenFGA. The picker now also repairs the same typed-wildcard grant for every
enabled Dynamic Agent with `visibility: "global"` before filtering. That keeps the
runtime picker OpenFGA-only without requiring an admin to manually provision
default-agent or global-agent tuples.

**Visibility is the source of truth for the wildcard grant (2026-06-04 fix).**
The `user:* user agent:<id>` "everyone can use" grant is now reconciled from
`visibility` on **both** create and edit, closing a `global → team` demote leak:

- `POST /api/dynamic-agents` passes `globalUserAccess: visibility === "global"`.
- `PUT /api/dynamic-agents` passes `globalUserAccess: finalVisibility === "global"`
  **and** `previousGlobalUserAccess: currentVisibility === "global"`, so demoting
  an agent from `global` to `team` (or transferring it while scoping to a team)
  deletes the wildcard tuple instead of leaving everyone with `can_use`.
- The chat-available picker (`GET /api/dynamic-agents/available`) is self-healing:
  it writes the wildcard for `global` agents and **revokes** it for every
  non-global agent that is **not** the configured platform default. `filterTupleDiff`
  drops deletes for tuples that never existed, so this is safe to run on every
  request and cleans up agents demoted before this fix shipped.

Before this fix, a non-default agent flipped from `global` to `team` kept its
`user:* user agent:<id>` grant (Mongo said `team`, OpenFGA still said "everyone"),
so non-owner-team members retained `can_use` and could both see and chat with it.
The platform-default path already revoked its own wildcard on default change,
which is why removing an agent as the platform default correctly restricted it.

#### Default agent is public by design

Selecting an agent in **Settings → Platform → Defaults** writes the
`user:* user agent:<id>` tuple shown above. Every signed-in user (Web UI and
Slack/Webex DMs) is then allowed to `can_use` that agent, regardless of their
team memberships. To keep that contract visible and reversible:

- The platform Defaults picker shows a persistent banner explaining the
  consequence and a confirmation modal before it persists. `PATCH /api/admin/platform-config`
  rejects requests with `400 / PUBLIC_ACCESS_NOT_ACKNOWLEDGED` unless
  `acknowledge_public_access: true` is included alongside a non-null
  `default_agent_id`. Clearing the default (`null`) does not require the ack —
  it only revokes the existing wildcard.
- Each platform-default change emits a structured audit line
  (`[AUDIT] platform_default_agent_changed`) with `actor`, `previous`, `next`,
  and `at` so log shippers can build an audit trail without a new collection.
- `PUT /api/dynamic-agents` rejects demoting `visibility: global → team` on the
  current platform default with `409 / AGENT_IS_PLATFORM_DEFAULT`, and
  `DELETE /api/dynamic-agents` rejects deleting it with the same code. Both
  paths surface a plain-English message pointing the admin back to Settings →
  Platform → Defaults first. The per-agent edit page mirrors
  this by disabling the visibility selector with an inline note when an agent
  is the current platform default.
- The single source of truth for the invariant is
  [ui/src/lib/rbac/platform-default.ts](https://github.com/cisco-eti/ai-platform-engineering/blob/main/ui/src/lib/rbac/platform-default.ts)
  (`isPlatformDefaultAgent(id)`), which reads `platform_config.default_agent_id`
  with the `DEFAULT_AGENT_ID` env var as a fallback.

Per-agent MCP tool restrictions are reconciled separately with
`scripts/backfill-agent-tool-openfga.ts`. That migration reads each dynamic
agent's `allowed_tools` map and reconciles tuples shaped as:

```text
agent:<agent_id> caller tool:<server_id>/<tool_name>
agent:<agent_id> caller tool:<server_id>/*
```

Run it after enabling signed agent context so existing agents have the same
AgentGateway/OpenFGA enforcement as newly-created or edited agents. Apply mode
also removes stale agent-tool tuples that no longer match `allowed_tools`.

Schema-versioned migration `agent_org_admin_inheritance_v1` backfills the
organization-admin inheritance tuple for existing Dynamic Agents:

```text
organization:<org>#admin manager agent:<agent_id>
```

This grants organization admins `can_manage` through the OpenFGA model without
guessing owner teams for legacy agents. New agents get this tuple during create.

Self-service resource creation is PDP-backed. A signed-in user can create a
private Dynamic Agent, MCP server, or RAG data source and receives a direct
`owner` tuple (`user:<sub> owner <resource>:<id>`), which derives read/use/write
and manage permissions in OpenFGA. Config-driven and AgentGateway-synced MCP
servers seed `organization:<org>#member` read/use/invoke tuples and
`organization:<org>#admin manager` tuples, so admitted users can discover and use
system MCP servers while config-driven records remain immutable through the Web UI
mutation APIs. For team-scoped resources, the Web UI backend
first checks `user:<sub> can_use team:<slug>` before creation, then writes
team-scoped tuples so team members can use/read the resource and
`team:<slug>#admin` can manage it. MongoDB stores resource metadata such as
`owner_team_slug`, but OpenFGA remains the authorization source of truth.

### Token Refresh

NextAuth holds the refresh token and silently refreshes the access token before it expires. The bundled Keycloak realm keeps access tokens at 1 hour, sets SSO idle timeout to 8 hours, and uses a 24-hour absolute SSO max lifespan. As long as the user keeps using the app and Keycloak accepts the refresh token, the UI asks Keycloak for a new access token instead of expiring the browser session based on local access-token staleness. If Keycloak rejects refresh (`invalid_grant`), the realm session is revoked, or Keycloak is unavailable, the user is redirected to login. The access token in the session is always the current live token — it's what gets forwarded to backend services.

### Identity Group Sync Hybrid Source Model

Identity Group Sync deliberately has two upstream sources:

1. **OIDC `memberOf` / `groups` claims on login** — Keycloak imports the upstream IdP `groups` claim into the `idp_groups` user attribute and emits it to the `caipe-ui` client as a multivalued `groups` claim in ID token/userinfo responses. Login-claim reconciliation is enabled by default; set `IDENTITY_SYNC_LOGIN_CLAIMS_ENABLED=false` only when a deployment needs to disable it. `auth-config.ts` extracts the signed-in user's group claims and runs a best-effort reconciliation for only that user. This is additive and fast: it refreshes the user's managed `team_membership_sources` and OpenFGA `user:<sub> member team:<slug>` tuples without storing the full group list in the session cookie. Login is not failed if reconciliation cannot run.
2. **Direct Okta directory API for admin dry-runs** — `/api/admin/identity-group-sync/dry-run` can fetch full group inventory from Okta using server-side IdP credentials when `fetch_from_provider=true` and `provider_id` is an Okta provider. This path is the authoritative source for scheduled/admin sync because it can see users who are not actively logging in, detect removals, produce drift findings, and surface users that still need identity linking before tuples can be written.

The claim path is not a replacement for direct directory querying. It improves freshness for the current user while the directory connector remains responsible for complete inventory and removals. Admins can also use `GET /api/admin/identity-group-sync/claim-suggestions` from the Identity Group Sync tab to read the current admin's server-side cached login claim groups, convert them through the same OIDC claim mapper, run existing rules, and review suggested teams for unmatched groups before creating anything. The endpoint intentionally does not call the OIDC userinfo endpoint on demand; if the in-process session claim cache is empty after a UI restart, the admin signs out and back in to refresh the cached claim groups. The UI lets admins filter large AD group sets, select one or more detected groups, and apply a reviewed `teams_to_create` plan to create those CAIPE teams without granting memberships or deleting anything.

Reviewed admin apply flows can materialize missing teams from `teams_to_create` when a reviewed rule has `auto_create_team=true`. Login-time reconciliation is intentionally narrower: it reconciles existing teams only, and never creates teams or grants access to missing teams. Later syncs may remove managed membership sources and matching OpenFGA `user:<sub> member/admin team:<slug>` tuples when a user's IdP claim or group membership disappears, but Identity Group Sync never deletes teams it previously created. Dry-runs include safety warnings for disruptive removals such as admin membership loss, large removal batches, and teams that would be left without active managed identity-sync memberships. Apply requests that include acknowledged removal risks require an explicit `acknowledge_removal_risks=true` review flag before the Web UI backend removes access. These warnings are also the operator signal to inspect orphaned or abandoned resource grants on now-empty teams.

Identity Group Sync admin APIs use the shared `getAuthFromBearerOrSession` path before `requireRbacPermission`, so browser sessions and validated first-party bearer tokens both reach the same OpenFGA organization checks. Keycloak identity and user administration APIs follow the same pattern: list/detail/stats require organization `can_audit`, while self-scoped identity detail reads use `user_profile:<id>#can_read`. Profile updates, team membership edits, and relationship writes require organization `can_manage`. Admin observability APIs for skill statistics and checkpoint persistence statistics require organization `can_audit` before reaching MongoDB-backed metrics; the Prometheus instant/batch proxy and authorization-insights endpoint require `admin_surface:metrics#can_manage`. Baseline members retain the Health tab but do not receive Metrics or Authorization Insights. Skill Hub list metadata requires `admin_surface:skills#can_read`, while hub registration, refresh, update, and deletion remain `admin_ui#admin` operations. This keeps Playwright persona tests and future service-triggered sync previews aligned with the Web UI backend authorization path.

Manual team management is also provenance-aware. Teams created through `/api/admin/teams` are stamped with `source=manual`, `status=active`, and creator/updater metadata. Manual membership edits create or remove non-managed `team_membership_sources` rows (`source_type=manual`, `managed=false`) so automated Okta/AD/OIDC sync can prune only managed sources. The Team Details members tab reads `/api/admin/identity-group-sync/teams/[teamId]/membership-sources`, reconstructs the visible member list from active source rows, and displays each member's manual/synced/stale/pending source labels; the embedded `teams.members[]` array is legacy fallback only. Team-level admins (members with `role=owner` or `role=admin`) can fully manage teams they own — rename and description edits (`PATCH /api/admin/teams/[id]`), team deletion (`DELETE /api/admin/teams/[id]`), realm role assignments (`PUT /api/admin/teams/[id]/roles`), agent/tool resource grants (`PUT /api/admin/teams/[id]/resources`), member add/remove (`POST/DELETE /api/admin/teams/[id]/members`), and OpenFGA reconciliation (`POST /api/admin/teams/[id]/openfga/reconcile`). All six routes share a single `requireTeamMembershipManagementPermission(session, actorEmail, team)` guard in `ui/src/lib/rbac/team-admin-guards.ts` that first tries `requireRbacPermission(session, "admin_ui", "admin")` for the platform-admin bypass and falls back to `isScopedTeamAdmin(actorEmail, team)` for the team-scoped path. Unrelated team edits remain denied unless the caller is a platform admin (issue #1509).

### OpenFGA ReBAC Admin UI

Admins can create and visualize OpenFGA policy/resource relationships at `Admin → Security & Policy → OpenFGA ReBAC`.

The older user-facing `Policy` tab has been removed. It edited CEL tab-visibility
and legacy policy surfaces that are no longer part of the operational model.
Admin tab visibility is now a deterministic Web UI backend gate (`/api/rbac/admin-tab-gates`)
based on session role plus feature flags; resource authorization is modeled in
OpenFGA relationships.

The Admin UI also includes a read-only effective-permissions simulator. Platform
admins can add `simulate_type=user&simulate_id=<keycloak_sub>` or
`simulate_type=team&simulate_id=<slug>&simulate_relation=member|admin` to the
Admin URL through the **View As read-only access preview** control. The browser stays
authenticated as the real admin; the Web UI backend simply evaluates tab gates as
the simulated OpenFGA subject (`user:<sub>` or `team:<slug>#admin`). Simulation is
not Keycloak impersonation, never mints a token for the target principal, and
disables mutation-oriented integration panels while previewing. Configured
Slack channels, Webex spaces, Statistics, and Feedback are filtered through the
simulated subject's effective access, so the preview contains only resources
and activity that principal can access.

The UI is intentionally Web UI backend first:

1. The browser loads a safe catalog from `/api/admin/openfga/catalog` (teams, dynamic agents, MCP tool prefixes, known KB IDs, universal resources, and OpenFGA status).
2. The **Access Manager** combines relationship authoring and effective-access checks in one catalog-driven form. It searches/selects subjects, resources, and actions; previews the derived check relation such as `team:platform#member can_use agent:incident-agent`; and applies admin grant/revoke mutations through the staged ReBAC change-set API.
3. The **Policy Graph** calls `/api/admin/rebac/graph` and renders tuple usersets as typed nodes and edges so relationships across the universal resource catalog are visible without reading raw tuple rows. Admins can switch between a single-team scope and an all-relationships system scope, open a full-screen graph workspace, search/select catalog resources in the palette, drag resources onto the canvas, connect valid nodes to stage grants, select existing edges to stage revokes, and save the reviewed tuple diff through `/api/admin/openfga/tuples`.
4. The **OpenFGA Tuples** tab is the default sub-tab. It calls `/api/admin/openfga/tuples` for capped, filtered reads and admin-only deletes, and can be deep-linked with `openfgaTab=tuples`.

The OpenFGA ReBAC sub-tabs are URL-addressable with `openfgaTab=<tab>` so admins can share links to specific views. Supported values are `tuples`, `graph`, and `access`; old `builder` and `explorer` links open Access Manager, while legacy `rag`, `slack`, and `webex` links canonicalize to Settings or Integrations.

Raw OpenFGA HTTP endpoints stay on the Docker/private service network. The browser never talks to OpenFGA directly, and the Web UI backend only accepts writable tuple shapes that match the CAIPE base model (`user:<sub> member team:<slug>`, `team:<slug>#member user/manager agent:<id>`, `team:<slug>#member caller tool:<prefix>`, and KB base relations). Materialized `can_*` relations are derived by the OpenFGA model for checks and are rejected on tuple writes.

The universal ReBAC catalog lives behind `/api/admin/rebac/catalog`. It returns the complete protected resource vocabulary, per-type action map, and discovered resource instances from teams, users, dynamic agents, AgentGateway's `mcp_gateway:list` gate, MCP servers/tools, KB ownership, Slack mappings, Webex mappings, conversations, and built-in admin/system resources. `/api/admin/rebac/enforcement-status` reports transition state for every resource type (`not_gated`, `role_gated`, `rebac_shadowed`, `rebac_enforced`, or `deprecated`) by merging defaults with `rebac_enforcement_status` overrides. The older OpenFGA admin endpoints use the same session-or-bearer authentication path, and `/api/admin/openfga/catalog` now embeds these universal resources while preserving its legacy `agents`, `tools`, and `knowledge_bases` picker shape.

Policy authoring is staged through `policy_change_sets` instead of direct browser-to-tuple writes. The Web UI backend creates a draft change set, validates every requested grant/revocation against the universal action vocabulary, delegated-scope guardrails, circular-grant checks, and last-admin risk, then applies the validated diff to OpenFGA and records provenance in `rebac_relationships`. The OpenFGA admin tab uses this create/validate/apply sequence for Access Manager edits, graph edits, and tuple revocations so administrators see the staged diff before the write is committed.

Graph and access explanation APIs read OpenFGA tuples and join them with `rebac_relationships` provenance. `/api/admin/rebac/graph` supports all-relationship views and scoped filters for team, subject, resource, and Slack channel, returning source metadata with each edge. `/api/admin/rebac/check` runs the same universal relationship check and explains allow outcomes with the recorded source path or deny outcomes with the missing OpenFGA prerequisite. Access Manager is catalog-driven: operators can search/select team, user, Slack channel, Webex space, external group, or service-account subjects and check any catalog resource type/action, including AgentGateway `mcp_gateway:list` and tool `can_call` paths. Admins can remediate denied results by creating the selected relationship, or revoke allowed results, through the same staged change-set validation/apply path used by the graph editor. The legacy `/api/admin/openfga/graph` endpoint delegates to the universal graph service so older UI code gets the same source-aware graph.

Slack channel ReBAC is managed through `/api/admin/slack/channels` and the per-channel resources/routes/access-check routes under `/api/admin/slack/channels/[workspaceId]/[channelId]`. The `[workspaceId]` value is the configured workspace alias from `SLACK_WORKSPACE_ALIAS` (for example, `CAIPE`), not Slack's opaque `team_id`. Channel management is team-owned: assigning a channel to a team writes `team:<slug>#member user slack_channel:<workspace>--<channel>` and `team:<slug>#admin manager slack_channel:<workspace>--<channel>`, and per-channel resource/route mutations check `can_manage` on that Slack channel instead of requiring global Admin UI permission. The top-level Slack channel list is resource-scoped: a non-admin caller sees only channels where OpenFGA grants `can_read` or `can_manage`, with `can_manage` returned for the UI. The baseline Integrations → Slack tab renders this scoped configured-channel list for members; onboarding and advanced controls still require the Slack admin-surface manage grant. The admin UI exposes the currently enforced Slack runtime path: channel-agent associations write base OpenFGA tuples such as `slack_channel:CAIPE--C0123456789 user agent:<id>`; runtime checks ask for derived `can_use`.

> **Team-cascade sharing model (intentional).** The channel-dispatch
> access-check at `/api/integrations/slack/channels/[workspaceId]/[channelId]/access-check`
> sends `user_subject = "team:<slug>#member"` (the channel's mapped team)
> rather than `user:<sub>`. This is the documented policy: any agent
> associated with a channel that is mapped to a team is callable in that
> channel by **every** member of that team, including members who were
> never granted the agent directly via `user:<sub> can_use agent:<id>`.
> The DM-dispatch chain (`POST /api/user/check_agent_access`) is
> user-scoped and is *not* subject to this cascade. The Slack and Webex
> ReBAC admin panels surface this trade-off both in the top-of-card
> "Sharing model" callout and in a per-channel heads-up under the
> agent-association form. See
> [Workflows → Sharing model: assigning a channel to a team transitively
> shares its agents](./workflows.md#sharing-model-assigning-a-channel-to-a-team-transitively-shares-its-agents)
> for the full rationale.

OpenFGA is the source of truth for whether a Slack channel may invoke a Dynamic Agent. `slack_channel_agent_routes` is retained only for dependent dispatch metadata such as listen mode and priority, and a metadata row is valid only while the matching OpenFGA tuple exists. The Slack bot resolves candidate agents from OpenFGA first, joins optional Mongo route metadata for ordering/listen filters, and never lets a stale Mongo route keep a deleted OpenFGA association alive. Deleting a channel-agent association removes both the OpenFGA tuple and the saved route metadata row. Route misses fail closed; user-visible Slack notices are reserved for explicit invocations, while ambient plain channel messages stay silent even when route diagnostics are recorded. The Admin Slack Channels panel exposes runtime diagnostics for the selected channel so operators can see OpenFGA read failures, stale Mongo metadata, missing tuples, listen-mode mismatches, and the latest Slack runtime audit error without checking container logs. Fix buttons in diagnostics repair common drift by removing stale route metadata when its OpenFGA tuple is gone, or by switching a tuple-backed route to listen to both mentions and plain messages.

Slack bot deployments now default to `SLACK_AGENT_ROUTES_MODE=db_prefer`, so OpenFGA-backed UI-managed routes are preferred when present and static Slack bot config remains the fallback; `config` remains available for static-only environments and `db_only` is available for canaries that should ignore static route bindings. At runtime, the Slack bot maps any incoming Slack `team_id` to `SLACK_WORKSPACE_ALIAS`, resolves the channel's team from `channel_team_mappings`, mints the user's team-scoped OBO token, selects an OpenFGA-backed channel agent, and authorizes the selected agent before dispatch. The request is denied unless both the channel association and the user's team/resource relationship allow the selected agent.

For hands-off channel onboarding, operators may set `SLACK_AUTO_ASSIGN_UNMAPPED_CHANNELS=true` with `SLACK_DEFAULT_TEAM_SLUG` and `SLACK_DEFAULT_AGENT_ID`. When a group-channel message arrives and no active `channel_team_mappings` row exists, the Slack bot writes the configured channel-team mapping, writes `slack_channel:<workspace_alias>--<channel_id> user agent:<default_agent_id>` to OpenFGA, and stores a `slack_channel_agent_routes` metadata row with `listen: mention`. The feature is disabled by default in Helm and fails closed if MongoDB, OpenFGA, the default team, or either required env var is missing; existing active channel mappings are never overwritten.

For migrations, the Slack Channels panel includes **Slack Channel Association Default** backed by `GET`/`POST /api/admin/slack/channels/defaults`. The UI shows the currently configured default team and Dynamic Agent from `SLACK_DEFAULT_TEAM_SLUG` and `SLACK_DEFAULT_AGENT_ID`. Admins may apply those defaults to all managed channels, or use bot-member discovery to select individual channels and override the team and Dynamic Agent per selected row. The Web UI backend writes the selected channel-team mappings, ensures `slack_channel:<workspace_alias>--<channel_id> user agent:<id>`, ensures `team:<slug>#member user agent:<id>` for each selected team/agent pair, ensures the inbound `team:<slug>#member user slack_channel:<workspace>--<channel>` and `team:<slug>#admin manager slack_channel:<workspace>--<channel>` visibility tuples (so the channel actually shows as `Setup completed` in the listing — `/api/admin/slack/channels` filters each row by `can_read` and silently drops channels with no inbound team→channel tuples), and optionally creates matching bootstrap routes in `slack_channel_agent_routes`. Those bootstrap routes are stamped with `source_type: "bootstrap"` and `users.listen: "mention"` so the bot only responds to explicit `@mentions` by default — admins who want it to also see plain channel messages can widen individual routes to `all` from the Step-2a route picker. The same `listen: "mention"` default applies to route rows the Web UI lazily materialises from an OpenFGA tuple that has no Mongo metadata yet (the "ghost route" path in `/api/admin/slack/channels/{workspaceId}/{channelId}/routes`); the equivalent Webex spaces endpoint mirrors this default. This is intentionally an explicit bulk write rather than an OpenFGA wildcard/default subject, so every relationship appears in the tuple store and Policy Graph. The shared helpers `slackChannelTeamVisibilityRelationships` and `webexSpaceTeamVisibilityRelationships` are used by the onboarding writers and the `messaging_team_visibility_v1` migration so admin-PUT, onboarding-defaults, and the backfill path all converge on identical tuple shapes.

The Slack Channels panel also includes **Slack Bot Runtime Sync** for the running bot process. Browser requests still terminate at the Web UI backend: `caipe-ui` checks the signed-in user's `admin_ui#admin` permission, obtains a Keycloak client-credentials token for the Slack bot admin audience, and calls the Slack bot's internal admin API. The Slack bot verifies that token with Keycloak JWKS before returning route-cache status, clearing its in-memory route cache, or upserting static YAML channel-agent routes into `slack_channel_agent_routes` and OpenFGA. Local no-SSO development can opt into an explicit dev-token path with `SLACK_BOT_ADMIN_DEV_AUTH_ENABLED=true` on the Web UI and `SLACK_ADMIN_DEV_AUTH_ENABLED=true` on the bot, with matching dev token values; this bypasses Keycloak only for the internal Slack bot admin API and must not be enabled in shared environments. The sync operation is intentionally **upsert-only**: it creates missing records and updates matching channel/agent metadata, but it does not delete existing UI-managed associations that are absent from static config.

The **Preview YAML Import** dry run returns the full per-channel/agent breakdown of what an import will write — channel name, each agent's listen modes, `user_list`/`bot_list`, overthink, and escalation (VictorOps/emoji/users/delete_admins) — and the Web UI backend annotates each channel with the team it is currently mapped to (from `channel_team_mappings`), flagging channels with no team so admins can see, before importing, which channels will still need a team assignment (via the Onboard tab) to become invokable. The static YAML is treated as a seed: once a channel exists in the DB, the per-channel route editor in the Configured tab can view and edit every field (users/bots enable + listen + allow lists, overthink, and escalation) and round-trips them through `PUT /api/admin/slack/channels/{workspaceId}/{channelId}/routes` without dropping the fields the import wrote. To reduce ID-copying mistakes, the editor uses Web UI backend lookups (`/api/admin/slack/users/lookup` and `/api/admin/slack/emoji`) for Slack user IDs and custom emoji names; those calls keep `SLACK_BOT_TOKEN` server-side, return minimal display fields, and fall back to raw ID/name entry when Slack lookup scopes are missing. Escalation configured on a DB route (not just static YAML) is honored at runtime: the bot's escalation/feedback handlers fall back to `SlackAgentRouteResolver.escalation_for(...)` when a channel has no static binding, so "Get help" works for UI-managed channels.

The **Advanced** tab also exposes a superadmin **VictorOps escalation agent** picker, persisted as `platform_config.slack_victorops_escalation_agent_id` via `PATCH /api/admin/platform-config`. The bot reads it at runtime (DB value first, `SLACK_INTEGRATION_VICTOROPS_AGENT_ID` env/YAML as fallback) when VictorOps escalation fires. Unlike the platform default agent, this setting grants no user access — it is only the agent the bot queries for on-call lookups — so it writes no OpenFGA tuple and requires no public-access acknowledgement.

Webex space ReBAC follows the same team-ownership shape with Webex-specific types and storage:
`webex_space:<workspace_alias>--<space_id> user agent:<id>` is the OpenFGA source
of truth, while `webex_space_agent_routes` stores dependent dispatch metadata
such as listen mode, priority, and enabled state. Team-space assignment writes
`team:<slug>#member user webex_space:<workspace>--<space>` and
`team:<slug>#admin manager webex_space:<workspace>--<space>`, and per-space
grant/route/diagnostic APIs check the derived Webex space permissions. The top-level
Webex space list is also resource-scoped, and the Integrations → Webex tab appears
for non-admin users who can manage at least one concrete `webex_space`. The Webex bot never trusts
workspace identifiers from incoming Webex events; policy namespace selection
comes from `WEBEX_WORKSPACE_ALIAS` or `WEBEX_WORKSPACE_ID`. Route reads use
server-side OpenFGA tuple filters for the selected `webex_space` subject and fail
closed on PDP outages.

Threaded Webex replies are anchored with Webex `parentId`. After an allow decision
and before Dynamic Agent dispatch, the bot may fetch bounded prior thread context
from the Webex Messages API: the root message plus recent replies filtered by the
same `parentId` and capped by `WEBEX_THREAD_CONTEXT_MAX_MESSAGES` /
`WEBEX_THREAD_CONTEXT_MAX_CHARS`. The context is sent only to the already selected
and authorized Dynamic Agent under the user's OBO token; fetch failures do not
weaken authorization and fall back to sending only the current message. Bot replies
include the selected `agent_id` and tell users to continue in the same Webex
thread. Whether the bot processes follow-up posts still depends on route listen
mode: `mention`, `message`, or `all`.

The Webex Spaces panel includes diagnostics and runtime sync through
`/api/admin/webex/*` BFF routes. The Web UI backend obtains a
`caipe-webex-bot-admin` audience token, calls the internal Webex bot admin API,
and the bot verifies that token with Keycloak JWKS. Runtime sync is upsert-only:
it creates or updates configured `webex_space_agent_routes` rows and corresponding
OpenFGA tuples, but it does not delete UI-managed associations absent from static
config. Diagnostics compares tuple-backed agents with Mongo route metadata and
offers one-click repairs for zero-agent spaces, stale metadata, and listen-mode
mismatches; the zero-agent repair creates a default/selected agent association
with `listen: mention` through the same route API used by manual association saves.

For opt-in onboarding, a bot configured with `spaces.accessMode: all_spaces`
and explicit `spaces.defaultTeamSlug` and `spaces.defaultAgentId` creates an explicit
bot-scoped space-team mapping, route metadata row, and OpenFGA tuple for a
previously unmapped space observed by that bot. `allowlist` remains the default
example. Automatic onboarding writes MongoDB before OpenFGA to avoid orphan
grants, rolls back on failure, and never overwrites an existing active space
mapping. The onboarding writer
(`webex-space-onboarding.ts`) also emits the inbound
`team:<slug>#member user webex_space:<workspace>--<space>` and
`team:<slug>#admin manager webex_space:<workspace>--<space>` visibility tuples
so the space surfaces in `/api/admin/webex/spaces` (which filters each row by
`can_read`). Previously-onboarded spaces are backfilled by the same
`messaging_team_visibility_v1` migration that handles Slack channels — both
surfaces share the helper builders so admin-PUT, onboarding-defaults, and
the backfill emit identical tuple shapes.

Future PDP consolidation note: OpenFGA should remain the source of truth for all relationship decisions, but the OpenFGA auth bridge should not be treated as the universal application PDP until it exposes a stable, domain-neutral JSON authorization API in addition to its Envoy `ext_authz` adapter. Until then, keep the bridge focused on network enforcement for AgentGateway/MCP traffic and keep Slack using `/api/admin/slack/channels/[workspaceId]/[channelId]/access-check` for domain-aware dispatch checks. The later consolidation path is to extract shared OpenFGA decision helpers and audit/result shapes first, then optionally let Slack, Web UI backend routes, and the bridge call a common PDP service rather than duplicating tuple logic.

Legacy Keycloak realm roles may still appear in old local data, but they are not an authorization source. `/api/rbac/enforcement-comparison` remains available only as an engineer-facing migration aid for comparing stale role-shaped data with ReBAC decisions for a selected subject/action/resource.

### Key Environment Variables


| Variable                                                      | Purpose                                                                                                                                                            | Security note                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENFGA_RECONCILE_ENABLED`                                   | Enables Team Resources → OpenFGA tuple reconciliation in the Web UI backend                                                                                        | Defaults to `false` so non-RBAC local UI runs do not require OpenFGA; enable only when the OpenFGA profile is healthy.                                                                                                                           |
| `OPENFGA_HTTP`                                                | Docker-internal OpenFGA HTTP API URL used by the Web UI backend tuple writer and Slack bot route resolver                                                          | Keep this on the private service network; do not point browser clients at OpenFGA.                                                                                                                                                               |
| `OPENFGA_STORE_NAME` / `OPENFGA_STORE_ID`                     | Selects the OpenFGA store for tuple writes                                                                                                                         | Prefer `OPENFGA_STORE_ID` in locked-down deployments to avoid discovery ambiguity.                                                                                                                                                               |
| `BOOTSTRAP_ADMIN_EMAILS` / `RBAC_BOOTSTRAP_ADMIN_EMAILS`      | Comma-separated initial admin emails consumed by the Web UI BFF bootstrap reconciler; `RBAC_BOOTSTRAP_ADMIN_EMAILS` overrides the legacy fallback env var when set  | Keep the list short. The BFF resolves emails to Keycloak `sub` values and writes durable OpenFGA tuples; do not hardcode user UUID tuples in Helm values for normal admin bootstrap.                                                             |
| `OPENFGA_SEED_TUPLES`                                         | JSON list of exact OpenFGA tuple keys consumed by the OpenFGA init hook after the authorization model is loaded                                                     | Chart-generated from `openfga.init.seedTuples`; reserve for non-user emergency tuples or recovery. Human bootstrap admins should use `BOOTSTRAP_ADMIN_EMAILS` so Keycloak UUIDs are resolved automatically.                                      |
| `AGENT_GATEWAY_ADMIN_URL`                                     | Optional Web UI backend URL for AgentGateway admin config discovery; defaults to `http://agentgateway:15000/config`                                                | Keep the AgentGateway admin port on the private service network. The browser calls only the Web UI backend discovery/sync APIs, which require `mcp_server:agentgateway#can_discover` for discovery and `mcp_server:agentgateway#can_manage` for sync.                                          |
| `AGENT_GATEWAY_URL`                                           | AgentGateway data-plane base URL used when onboarding discovered MCP targets; defaults to `http://agentgateway:4000` and the UI backend appends `/mcp` when needed | AgentGateway-discovered MCP server records should route through this URL so JWT/authz enforcement remains on the gateway path. The backend target URL from AgentGateway config is stored only as operator metadata.                              |
| `AGENTGATEWAY_CONFIG_BRIDGE_POLL_SECONDS`                     | Docker Compose local-dev poll interval for the AgentGateway config bridge that renders standalone MCP routes from MongoDB `mcp_servers` rows                       | Local-only control plane helper. It writes only the shared generated AgentGateway config volume; Kubernetes uses native `AgentgatewayBackend` and `HTTPRoute` resources instead.                                                                  |
| `CAIPE_AGENT_CONTEXT_HMAC_SECRET`                             | Shared secret used by Dynamic Agents and the OpenFGA authz bridge to sign/verify `agent_id` context for per-agent MCP tool enforcement                             | Store only in runtime secrets. When unset, AgentGateway still enforces the coarse user `mcp_gateway:list` gate, but the bridge cannot enforce derived `agent:<id> can_call tool:<server>/<tool>` decisions.                                              |
| `CAIPE_CREDENTIALS_ENABLED` / `CREDENTIAL_STORE_BACKEND`       | Enables the Connections & Secrets surface and selects the MongoDB envelope credential backend                                                                      | Defaults disabled. Browsers can create or rotate credential values, but raw retrieval is limited to server-to-server callers.                                                                                                                      |
| `CREDENTIAL_KEY_PROVIDER` / `CREDENTIAL_KMS_CMK_ID` / `CREDENTIAL_KMS_REGION` | Selects the credential data-key wrapper. Local development uses `local-cmk`; production should use `aws-kms` with a real CMK.                                     | `local-cmk` and legacy `dev-local` fail closed in production. Do not put real CMK secrets in ConfigMaps; production KMS access must come from runtime identity and least-privilege key policy.                                                       |
| `CREDENTIAL_ALLOW_INSECURE_LOCAL_KEY_WRAP`                    | **Dev-only escape hatch.** When `true`, lets the `local-cmk`/`dev-local` key wrappers run even under `NODE_ENV=production` so the credential store works on the prod-parity UI image (`caipe-ui-prod`) for local testing. Defaults `false`. | **Insecure** — data keys are wrapped with locally-derived material, not a real KMS/HSM. The wrapper logs a loud `SECURITY WARNING` on every construction. Must never be `true` in a real production deployment; use `CREDENTIAL_KEY_PROVIDER=aws-kms` there instead. |
| `CREDENTIAL_BOOTSTRAP_OAUTH_CONNECTORS` / `GITHUB_*` / `CONFLUENCE_*` / `WEBEX_*` / `PAGERDUTY_*` / `GITLAB_*` | Lets the `caipe-ui` TypeScript startup bootstrap idempotently seed global GitHub, Atlassian/Confluence, Webex, PagerDuty, and GitLab OAuth connector records from environment variables | Docker Compose reads these from `.env`; Kubernetes must source them through ESO/ExternalSecret. Provider client secrets must never be placed in ConfigMaps or logs and are immediately written through MongoDB envelope encryption.                   |
| `CREDENTIAL_SERVICE_AUDIENCE` / `CREDENTIAL_API_URL`           | Audience and service URL used by Dynamic Agents and other internal services when retrieving secret refs or exchanging provider connections                         | Must match the issued service/OBO token audience. Browser-origin, session-only, and wrong-audience retrieval/exchange requests are denied before credential lookup.                                                                               |
| `USE_IMPERSONATION_TOKENS`                                    | When `true`, Dynamic Agents resolves MCP `credential_sources` through the server-to-server credential exchange (per-user OAuth tokens) instead of session cookies   | Required for the per-user Jira/PagerDuty/GitHub/GitLab provider-token flows. Leave `false` to keep only the coarse user-level AgentGateway/OpenFGA gate.                                                                                          |
| `GITHUB_PERSONAL_ACCESS_TOKEN` / `GITLAB_PERSONAL_ACCESS_TOKEN` (on **Dynamic Agents**) | Static org-PAT fallback read via `MCPCredentialSource.fallback_env` when a caller has not connected their personal GitHub/GitLab account                            | Keeps GitHub/GitLab tools backward compatible for unconnected callers. The PAT now lives only on Dynamic Agents (no longer a gateway `backendAuth` key); connected users always get their own OAuth token instead. Source from runtime secrets.   |
| `AUDIT_SERVICE_URL`                                           | Enables Python and TypeScript audit writers, including Dynamic Agents and `openfga-authz-bridge`, to emit durable `openfga_rebac` rows to audit-service             | Point services at the in-cluster or compose `audit-service`; configure local/S3 storage on audit-service itself.                                                                                                                                |
| `AUDIT_SERVICE_BACKEND` / `AUDIT_SERVICE_LOCAL_RETENTION_DAYS` | Selects the audit-service storage backend (`local` or `s3`) and controls local-disk retention                                                                       | `local` is the default backend. Local storage keeps `1` day by default and purges expired files on startup and periodically; S3 retention should be managed with bucket lifecycle policy.                                                        |
| `SLACK_AGENT_ROUTES_MODE`                                     | Slack bot route source: `db_prefer` (default; prefer OpenFGA-backed UI-managed channel-agent routes, fall back to static config), `config`, or `db_only`             | `db_prefer` and `db_only` require OpenFGA access; MongoDB is used only to enrich tuple-backed routes with listen/priority metadata. Use `config` only for static-only environments that should ignore UI-managed channel routes.                  |
| `SLACK_INTEGRATION_SILENCE_ENV`                               | Initial setup switch that makes the Slack bot ignore inbound payloads before handlers can send user-visible Slack responses                                           | Use only during bootstrap or broken-route setup windows. Admin/runtime diagnostics remain the place to inspect OpenFGA route health while end-user channel noise is suppressed.                                                                  |
| `SLACK_WORKSPACE_ALIAS`                                       | Canonical Slack workspace namespace used by the Web UI backend, Slack bot, Mongo route/grant rows, and OpenFGA `slack_channel:<alias>--<channel_id>` subjects      | Configure per deployment (for example, `CAIPE` or `Splunk`). The Slack bot maps incoming Slack `team_id` values to this alias before route and ReBAC lookups.                                                                                       |
| `SLACK_BOT_TOKEN`                                             | Web UI backend Slack Web API token used for admin Slack discovery and editor lookups (`available-channels`, `users/lookup`, `emoji`)                               | Source from Vault/ExternalSecret, normally the same bot token used by `slack-bot`. Never place the value in ConfigMaps or logs. User lookup needs `users:read` (and `users:read.email` for email lookup/profile email matching); emoji suggestions need `emoji:read`. |
| `SLACK_DISCOVERY_CACHE_TTL_MINUTES`                           | Bootstrap default for Slack channel discovery; defaults to `60` and is overridden by `platform_config.slack_discovery_cache_ttl_minutes` | Admins manage it from the Slack **Discovery cache** popover. Range `0`–`1440`; `0` disables caching. |
| `WEBEX_DISCOVERY_CACHE_TTL_MINUTES`                           | Bootstrap default for Webex space discovery; defaults to `60` and is overridden by `platform_config.webex_discovery_cache_ttl_minutes` | Admins manage it from the Webex **Discovery cache** popover. Range `0`–`1440`; `0` disables caching. |
| `SLACK_AGENT_ROUTES_ENABLED`                                  | Legacy rollout alias; when `true` and `SLACK_AGENT_ROUTES_MODE` is unset, behaves as `SLACK_AGENT_ROUTES_MODE=db_prefer`                                           | Prefer `SLACK_AGENT_ROUTES_MODE` for new deployments so the fallback behavior is explicit.                                                                                                                                                       |
| `SLACK_AGENT_ROUTES_TTL_SECONDS`                              | Slack bot in-process cache TTL for OpenFGA-backed channel agent routes; defaults to `60`                                                                           | Short TTLs make UI route changes visible faster at the cost of more OpenFGA reads and Mongo metadata joins.                                                                                                                                      |
| `SLACK_INTEGRATION_DEFAULT_AGENT_ID` / `SLACK_INTEGRATION_DM_AGENT_ID` | Env/YAML fallback for the Slack bot's channel fallback and DM agent. Overridden at runtime by `platform_config.default_agent_id` (Settings → Platform → Defaults) | These are now bootstrap fallbacks only — the platform default agent set in the UI takes precedence so the same value governs Web UI and Slack. |
| `SLACK_INTEGRATION_VICTOROPS_AGENT_ID`                        | Env/YAML fallback for the agent the Slack bot queries for VictorOps on-call lookups; overridden at runtime by `platform_config.slack_victorops_escalation_agent_id` | Superadmins set the live value in **Admin → Integrations → Slack → Advanced**. The env var only applies when no DB value is saved. |
| `SLACK_PLATFORM_SETTINGS_TTL_SECONDS`                         | Slack bot in-process cache TTL for `platform_config` settings (default + VictorOps agents); defaults to `60`                                                       | Short TTLs surface UI setting changes faster at the cost of more Mongo reads. |
| `CAIPE_PLATFORM_AUDIENCE`                                     | Audience requested by Slack/Webex OBO exchanges for bot → CAIPE UI BFF access checks; defaults to `caipe-platform`                                                | Keep this aligned with the Keycloak client accepted by the Web UI backend. Do not use `agentgateway` for bot pre-dispatch access checks because the next hop is the BFF.                                                                          |
| `WEBEX_THREAD_CONTEXT_ENABLED`                                | Enables Webex bot thread-context fetch before Dynamic Agent dispatch; defaults to `true`                                                                           | Reads only messages visible to the bot in the same Webex thread and sends bounded context to the authorized agent under the user's OBO path. Set to `false` where message-history minimization is required.                                     |
| `WEBEX_THREAD_CONTEXT_MAX_MESSAGES`                           | Caps prior Webex thread replies fetched with the Webex Messages API; defaults to `10`                                                                              | Keep this low to limit prompt size and data exposure.                                                                                                                                                                                            |
| `WEBEX_THREAD_CONTEXT_MAX_CHARS`                              | Caps formatted Webex thread context sent to Dynamic Agents; defaults to `4000`                                                                                     | Prevents unbounded prompt growth and avoids sending entire long conversations to downstream agents.                                                                                                                                              |
| `TENANT_ID` / `AUDIT_SUBJECT_SALT`                            | Controls tenant scoping and privacy-preserving subject hashing for Python OpenFGA audit events                                                                     | Keep the salt stable per environment so subject hashes remain correlatable without storing raw tokens.                                                                                                                                           |
| `AUTHZ_TRACING_ENABLED`                                       | Enables optional Web UI backend OpenFGA/ReBAC OTLP span export                                                                                                     | Defaults off in dev compose. Trace spans are observational only; do not put raw tokens, request bodies, or PII in span attributes.                                                                                                               |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                          | Optional OTLP HTTP endpoint for Web UI backend authz spans                                                                                                         | Leave unset unless an external collector is explicitly configured. RBAC Audit uses audit-service and does not need a trace backend.                                                                                                              |
| `KEYCLOAK_ADMIN_CLIENT_ID`                                    | Confidential Keycloak client used by Web UI backend admin APIs for Keycloak Admin REST calls such as user listing, role assignment, client inspection, and Keycloak RBAC OBO permission repair | Use a service-account client with only the required `realm-management` roles: user roles (`view-users`, `query-users`, `manage-users`), client roles (`query-clients`, `view-clients`, `manage-clients`), and authorization roles (`view-authorization`, `manage-authorization`). Production should not rely on the dev `admin-cli` password-grant fallback. |
| `KEYCLOAK_ADMIN_CLIENT_SECRET`                                | Matching client secret for `KEYCLOAK_ADMIN_CLIENT_ID`                                                                                                              | Store in Vault/ExternalSecret/Kubernetes Secret only; never commit the secret value.                                                                                                                                                             |
| `KEYCLOAK_ACCESS_TOKEN_LIFESPAN`                              | Keycloak init/reconcile job override for realm access-token lifetime; chart default is `3600` seconds                                                              | Keep access tokens short and rely on refresh tokens for active sessions.                                                                                                                                                                         |
| `KEYCLOAK_SSO_SESSION_IDLE_TIMEOUT`                           | Keycloak init/reconcile job override for realm SSO idle timeout; chart default is `28800` seconds                                                                  | This is the user-facing idle logout window. Increasing it should be a deliberate security decision.                                                                                                                                              |
| `KEYCLOAK_SSO_SESSION_MAX_LIFESPAN`                           | Keycloak init/reconcile job override for absolute realm SSO max lifespan; chart default is `86400` seconds                                                         | Must be longer than the idle timeout if active users should keep refreshing throughout the workday.                                                                                                                                              |
| `OIDC_ACCEPTED_AUDIENCES`                                     | Additional bearer JWT audiences accepted by the Web UI backend                                                                                                     | The dev compose stack defaults this to `caipe-platform` so RBAC persona tokens minted by the Keycloak resource-server client can exercise Web UI backend routes; production deployments should set the narrow audience list they actually issue. |
| `IDENTITY_SYNC_LOGIN_CLAIMS_ENABLED`                          | Controls best-effort login-time reconciliation from OIDC group claims                                                                                              | Defaults on; set to `false` to disable. Login remains best-effort and must not depend on directory sync health.                                                                                                                                  |
| `IDENTITY_SYNC_OIDC_CLAIM_PROVIDER_ID`                        | Provider id used to select mapping rules for claim-derived sync                                                                                                    | Defaults to `oidc-claims`; keep separate from direct Okta providers so provenance stays clear.                                                                                                                                                   |
| `IDENTITY_SYNC_OKTA_ORG_URL` / `IDENTITY_SYNC_OKTA_API_TOKEN` | Server-side Okta Management API connector for full inventory dry-runs                                                                                              | Store the token in runtime secrets only; never expose it to the browser or commit it.                                                                                                                                                            |


The `deploy/keycloak/init-idp.sh` bootstrap keeps the IdP group importer on per-mapper `syncMode=FORCE`, so the `idp_groups` attribute is refreshed on login without resetting unrelated user attributes such as Slack links. The same idempotent init job may seed identity-only test personas before e2e runs. The `caipe-ui` mapper intentionally leaves `access.token.claim=false` to avoid sending large group arrays through every downstream bearer-token path.

---

## Component 3: Dynamic Agents Path

Slack/Webex bots and the CAIPE UI talk to the CAIPE UI BFF (`/api/chat/*`) and the Dynamic Agents runtime (`/api/v1/chat/*`) over SSE. The agent runtime validates the JWT per request and forwards the same bearer token, service token, or OBO token to AgentGateway so per-user enforcement happens at the MCP PEP. See [Component 5: Dynamic Agents](#component-5-dynamic-agents--the-workshop-floor).

---

## Component 4: AgentGateway — The Security Checkpoint

> **Badge analogy:** The armed security checkpoint at the entrance to the server room. Everyone must badge in — no exceptions, no tailgating. The checkpoint verifies the badge locally, then calls the central relationship desk (OpenFGA) to ask whether this person is allowed through.

**Technically:** AgentGateway is the single **Policy Enforcement Point (PEP)** for all MCP tool calls. It proxies HTTP/SSE requests to registered MCP backend servers, validates the Keycloak JWT, and calls OpenFGA through `extAuthz` for the PDP decision before allowing each request through. MCP servers still mount a shared custom middleware package for **authentication defense-in-depth** (JWT/shared-key validation, token passthrough context, and an optional local-dev localhost bypass). For embedded/local MCP servers that do not sit behind AgentGateway, the same package can also perform an **optional Keycloak PDP scope check** (for example `mcp_jira#invoke`) so they still have a real authz gate.

### Request Flow

```
Dynamic Agent POST /rag/v1/query
  Authorization: Bearer <JWT>
         │
         ▼
  AgentGateway
  ┌────────────────────────────────────────────┐
  │  1. Extract JWT from Authorization header  │
  │  2. Validate signature against JWKS        │
  │  3. ext_authz → OpenFGA Check              │
  │  4a. OpenFGA DENY → 403 Forbidden          │
  │  4b. OpenFGA ALLOW → proxy to MCP server   │
  └────────────────────────────────────────────┘
         │ ALLOW
         ▼
  RAG MCP Server
  (receives same JWT for its own validation)
```

### Authorization Model

AgentGateway uses `jwtAuth` for authentication and `extAuthz` for authorization.
The `openfga-authz-bridge` adapts Envoy's gRPC authorization check into an
OpenFGA `Check`, so gateway authorization is maintained through ReBAC tuples
rather than CEL policy authoring.

On MCP `tools/call`, when `CAIPE_AGENT_CONTEXT_HMAC_SECRET` is configured, the
bridge also requires a signed `X-CAIPE-Agent-Context` header so it can enforce
per-agent tool allowlists (`agent:<id> can_call tool:<server>/<tool>`). See
[Agent context HMAC](./agent-context-hmac.md).

For observability and compliance, the bridge also writes a best-effort
`openfga_rebac` event to audit-service for every terminal
authorization result: missing subject, OpenFGA allow, OpenFGA deny, and
OpenFGA unavailable. These writes never affect the allow/deny response returned
to AgentGateway.

### ext_authz Timeout

The `extAuthz` policy fails **closed** (`denyWithStatus: 403`) so any error or
timeout reaching the `openfga-authz-bridge` denies the request — never
fail-open. The proxy's built-in `ext_authz` timeout is **200ms**, which is too
tight in practice: enumerating tools fires one `ext_authz` Check per MCP route
**concurrently**, and against a cold or loaded OpenFGA those checks serialize
and individually exceed 200ms, returning fail-closed 403s that surface in the UI
as "MCP server unavailable" even for healthy, authorized servers.

The shipped default raises this to **10s** (generous headroom; still bounds a
stuck call) on the default **static** routing path:

| Knob | Default | Where |
|------|---------|-------|
| `global.agentgateway.extAuth.timeout` | `10s` | Helm static routing — rendered into the `extAuthz.timeout` field of the AgentGateway static ConfigMap (`agentgateway-static-config.yaml`). Operator-tunable. |
| `extAuthz.timeout` (bootstrap) + `DEFAULT_MCP_ROUTE_POLICIES` (config-bridge) | `10s` | Local Docker Compose dev path (`deploy/agentgateway/config.yaml`, `deploy/agentgateway/config_bridge.py`) — kept in parity with the chart. |

Raising the timeout does **not** change the fail-closed posture: a genuine
OpenFGA `DENY` (or an unreachable bridge after the timeout) still returns 403.

> **Gateway-API / CRD routing (opt-in):** the `AgentgatewayPolicy.traffic.extAuth`
> resource has **no** timeout field, so this knob does not apply when
> `routingMode: gateway-api`. Tune the budget there via the `ext_authz` backend's
> `requestTimeout` (or a route-level request timeout) instead.

### Data-Plane Ingress

The Helm chart can expose AgentGateway's MCP data path with
`agentgateway.ingress.enabled=true`. That ingress always routes to the service
HTTP port (`service.port`, default `4000`). The admin listener
(`service.adminPort`, default `15000`) is not exposed by the ingress and should
remain reachable only from inside the cluster.

### Admin UI MCP Discovery and Migration

The Web UI backend owns AgentGateway MCP discovery and sync through
`/api/mcp-servers/agentgateway/discover` and `/api/mcp-servers/agentgateway/sync`.
Both routes check the singleton `mcp_server:agentgateway` resource directly:
`can_discover` for discovery and `can_manage` for sync/onboarding. Bootstrap
environments should seed that singleton grant explicitly instead of relying on a
session-role bypass.

Sync is intentionally one-click for migrations: the backend reads the private
AgentGateway admin config, imports every discovered target with status `new` as a
config-driven `source: "agentgateway"` MCP server, leaves already-managed targets
unchanged, and never overwrites conflicting legacy MCP servers. Conflicts are
returned as migration warnings with the legacy endpoint and AgentGateway target
endpoint so operators can remove or rename the old row manually.

### Why This Is the Right Architecture for a PEP

- **Decoupled policy from business logic:** MCP servers implement domain logic, not authz. Changing a policy means editing `config.yaml`, not redeploying an MCP server.
- **Consistent enforcement:** Every tool — RAG, GitHub, ArgoCD, Slack — goes through the same gateway with the same JWT. No tool can be accidentally left unenforced.
- **Externalized relationship decisions:** OpenFGA gives us a remote PDP for relationship checks without putting that logic inside each MCP server.
- **Token passthrough:** AgentGateway forwards the JWT to the MCP backend unchanged. The backend can do its own secondary validation (e.g. tenant isolation).

### Local / Embedded MCP Exception Path

Most production MCP traffic should still go through AgentGateway. The repository also ships a **shared custom MCP middleware** for the exception cases:

- **Local dev** — when an engineer runs a FastMCP server directly on `localhost` for `mcp dev`, `MCP_TRUSTED_LOCALHOST=true` can bypass auth for the real loopback peer only.
- **Embedded MCPs** — when an MCP lives inside another Python service and therefore cannot be registered as a standalone AgentGateway backend, the same package validates the bearer token locally and can optionally call Keycloak's PDP for a per-MCP scope decision.

That package lives under `ai_platform_engineering/mcp/common/mcp-auth/` and is intentionally **authn-focused by default**. In the normal standalone path, AgentGateway remains the source of truth for RBAC.

---

## AgentGateway + OIDC + Keycloak — The Integrated Picture

> **Badge analogy:** **Duo SSO is the national ID office** — it issues the underlying identity. **Keycloak is HR** — it takes that national ID, prints a CAIPE-branded employee badge with your roles stamped on it, and publishes a **public fingerprint scanner** (JWKS) in the lobby so anyone can verify a badge is really HR-issued. **AgentGateway is the armed checkpoint** at the server room door. The checkpoint verifies the badge locally, then calls the OpenFGA authorization desk through `ext_authz` before opening the door.

**Technically:** Keycloak, OpenFGA, and AgentGateway cooperate to put a verified, relationship-checked, role-carrying JWT in front of every MCP request. AG itself is the **Policy Enforcement Point (PEP)** — it doesn't authenticate users, it doesn't store roles, and it never talks to Duo. It verifies that the JWT in the request was signed by Keycloak (using a cached copy of Keycloak's JWKS), then calls OpenFGA through `extAuthz` for the authorization decision.


| Layer                                           | Role                     | What it owns                                                                                                                         | What it does NOT own                                          |
| ----------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Upstream IdP** (e.g. Duo SSO, Okta, Azure AD) | Identity provider        | User authentication (password, MFA, device trust), email ownership                                                                   | Application roles, per-tool access rules                      |
| **Keycloak**                                    | OIDC AS + IdP broker     | Realm roles (`chat_user`, `admin`), JWT issuance, JWKS publication, OBO token exchange (RFC 8693)                                    | Tool-level decisions, user password (delegated to Duo)        |
| **OpenFGA**                                     | Remote PDP               | Relationship decisions such as `user:<sub> can_call mcp_gateway:list` and team resource tuples (`team:<slug>#member can_use agent:<id>`) | JWT validation, token minting, proxying traffic               |
| **AgentGateway (PEP)**                          | Policy Enforcement Point | `jwtAuth`, `extAuthz`, local JWT verification against cached JWKS                                                                    | Identity store, role store, token minting, CEL policy storage |


Keycloak **brokers** the upstream IdP — Duo SSO doesn't issue the JWT that AG sees. Duo authenticates the user, returns an OIDC authorization code to Keycloak, and Keycloak then mints the CAIPE JWT whose identity claims feed the OpenFGA `extAuthz` check. From AG's perspective, **Keycloak is the only issuer it trusts** (`iss = http://localhost:7080/realms/caipe`); the existence of Duo is invisible to AG. This is the standard OIDC/OAuth 2.0 resource-server pattern applied to an MCP-aware proxy.

### Identity Provenance: Duo SSO → Keycloak → JWT → AG → MCP

```mermaid
flowchart LR
  subgraph IdP["Upstream IdP<br/>(Duo SSO / Okta / Azure AD)"]
    DUO["Duo Universal Prompt<br/>(MFA, device trust, password)"]
    DUO_OIDC["OIDC token endpoint<br/>sso-xxx.sso.duosecurity.com"]
    DUO --> DUO_OIDC
  end

  subgraph KC["Keycloak — Realm: caipe"]
    direction TB
    KC_IDP["IdP broker<br/>alias: duo-sso<br/>IDP_ISSUER, IDP_CLIENT_ID"]
    KC_MAP["IdP mappers<br/>email, given_name/firstname → userinfo"]
    KC_ROLES["Realm roles<br/>chat_user, admin<br/>(assigned via init-idp.sh)"]
    KC_TOK["Token endpoint<br/>signs JWT with realm's RS256 key"]
    KC_JWKS["JWKS endpoint<br/>public keys (for AG to fetch)"]
    KC_IDP --> KC_MAP --> KC_ROLES --> KC_TOK
    KC_TOK --> KC_JWKS
  end

  subgraph CAIPE["CAIPE Callers (all hold the same JWT)"]
    UI["CAIPE UI<br/>(Next.js, NextAuth)"]
    SB["Slack Bot<br/>(uses OBO token-exchange)"]
    DA["Dynamic Agents<br/>(forwards user JWT)"]
  end

  AG["AgentGateway :4000<br/><b>PEP</b><br/>jwtAuth + ext_authz"]
  FGA["OpenFGA<br/>remote PDP<br/>Check(user, relation, object)"]
  MCP["Backend MCP servers<br/>rag_server, github-mcp, …"]

  DUO_OIDC -. "1. OIDC auth code" .-> KC_IDP
  KC_TOK -. "2. JWT (iss=caipe, sub=alice,<br/>realm_access.roles=[chat_user])" .-> UI
  KC_TOK -. "2. JWT" .-> SB
  KC_JWKS -. "3. JWKS fetch (startup, TTL, unknown kid)" .-> AG

  UI --> DA
  SB --> DA
  DA --> AG
  AG -->|"4. ext_authz Check"| FGA
  FGA -->|"5. allow / deny"| AG
  AG -->|"6. proxied + JWT unchanged"| MCP
```



**Read this as the badge's lifecycle:**

1. **Duo SSO authenticates the human.** It doesn't know about CAIPE roles. It only proves "this really is `alice@example.com` with working MFA" and hands an OIDC authorization code to Keycloak. Duo's issuer (`IDP_ISSUER`) is configured in Keycloak as `IDP_ALIAS=duo-sso`; this is the only direct contact between CAIPE and Duo.
2. **Keycloak brokers and rebrands the identity.** It validates the Duo code, runs its IdP mappers (e.g. `firstname` → `given_name` to handle Duo's non-standard claim), and signs a **fresh JWT** with its own RS256 key. Product authorization is evaluated later through OpenFGA organization, team, and resource relationships. This is the only token CAIPE services ever see. Duo's identity token is discarded at the Keycloak boundary.
3. **Every CAIPE caller holds the same JWT.** The Slack Bot additionally does an RFC 8693 token-exchange to produce an **OBO (On-Behalf-Of) JWT** that pins `sub=alice` and `act.sub=caipe-slack-bot` — but it's still a Keycloak-signed JWT with `iss = http://localhost:7080/realms/caipe`. From AG's perspective there's no difference between a UI JWT and an OBO JWT; both pass `jwtAuth` as long as they're signed by a key in AG's JWKS cache.
4. **AG verifies locally, calls OpenFGA, forwards unchanged.** The JWT reaches the MCP server with Alice's identity intact, so MCP-level defense-in-depth checks (e.g. the RAG server's per-tenant document ACLs) see the real user — not the agent runtime's service account and not the Slack bot.

The practical consequence: **to switch CAIPE from Duo SSO to Okta or Azure AD you don't touch AgentGateway at all.** You change `IDP_ISSUER`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_ALIAS`, and maybe a mapper in Keycloak, and every component downstream continues to trust Keycloak-issued JWTs. This is the whole point of making Keycloak the IdP broker instead of having each service integrate directly with the upstream IdP.

### How AG Is Wired to Keycloak and OpenFGA (at boot and at steady state)

```mermaid
flowchart LR
  subgraph Keycloak["Keycloak — OIDC Authorization Server"]
    direction TB
    KC_ISS["Realm: caipe<br/>iss = http://localhost:7080/realms/caipe"]
    KC_JWKS["JWKS endpoint<br/>/protocol/openid-connect/certs<br/>(public RS256 keys)"]
    KC_TOK["Token endpoint<br/>/protocol/openid-connect/token"]
  end

  subgraph AG["AgentGateway :4000"]
    direction TB
    CFG["/etc/agentgateway/config.yaml<br/>(static ext_authz config)"]
    JWKS_CACHE[("In-memory JWKS cache<br/>TTL from Cache-Control")]
    JWT_VAL["jwtAuth:<br/>• mode: strict<br/>• issuer, audiences<br/>• jwks.url"]
    EXT["extAuthz:<br/>gRPC openfga-authz-bridge:9100"]
    PROXY["MCP proxy<br/>mcp.targets"]
    CFG --> JWT_VAL
    CFG --> EXT
    CFG --> PROXY
    JWT_VAL --> JWKS_CACHE
  end

  subgraph FGA["OpenFGA remote PDP"]
    BRIDGE["openfga-authz-bridge<br/>Envoy gRPC ext_authz adapter"]
    STORE[("OpenFGA store<br/>caipe-openfga")]
    BRIDGE --> STORE
  end

  KC_JWKS -.->|1. fetch at startup + TTL refresh| JWKS_CACHE
  Client["Caller<br/>(CAIPE UI / Slack Bot / Dynamic Agent)"] -->|2. Bearer JWT| JWT_VAL
  JWT_VAL --> EXT
  EXT -->|3. Check user:<sub> can_call mcp_gateway:list| BRIDGE
  BRIDGE -->|allow / deny| EXT
  EXT --> PROXY
  PROXY --> MCP["Backend MCP servers<br/>(rag_server, github-mcp, …)"]
  KC_TOK -.->|token issuance| Client
```



**Four independent channels feed the AG decision:**


| #   | Channel               | Direction                             | Purpose                                                            | Cadence                                                   |
| --- | --------------------- | ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| 1   | JWKS                  | AG → Keycloak                         | Fetch public keys to verify JWT signatures                         | On startup; on unknown `kid`; on Cache-Control TTL expiry |
| 2   | Token issuance        | Client → Keycloak → Client            | Users/bots obtain JWTs to present to AG; AG **never** mints tokens | On login / OBO exchange                                   |
| 3   | Relationship decision | AG → `openfga-authz-bridge` → OpenFGA | Remote PDP check before MCP proxying                               | Every MCP request                                         |


There is **no direct API call from AG to Keycloak per request**. JWKS fetching is a pure cache-refresh operation, not a live auth check.

### The Exact `jwtAuth` Contract (from `config.yaml`)

```yaml
binds:
- port: 4000
  listeners:
  - protocol: HTTP
    policies:
      jwtAuth:
        mode: strict           # reject request if no valid JWT present
        issuer: https://caipe.example.com/realms/caipe
        audiences: [caipe-platform, agentgateway]
        jwks:
          url: http://keycloak:7080/realms/caipe/protocol/openid-connect/certs
    routes:
    - policies:
        extAuthz:
          host: openfga-authz-bridge:9100
          failureMode:
            denyWithStatus: 403
          protocol:
            grpc:
              metadata:
                caipe.auth: '{"sub": jwt.sub}'
```

What `mode: strict` means in practice:

- `**iss` must equal `issuer**` — tokens from any other realm or IdP are rejected with 401.
- `**aud` must contain at least one of `audiences**` — protects against token substitution where a token was issued to a different service client.
- `**exp`, `nbf`, `iat` enforced** — expired or not-yet-valid tokens rejected.
- **Signature verified against JWKS** — `kid` in the JWT header must match a cached key.
- **Unknown `kid` triggers one forced JWKS refresh** — handles Keycloak key rotation without manual intervention.

Only after `jwtAuth` passes does AG call `extAuthz`. AG sends an Envoy `CheckRequest` over gRPC with `caipe.auth.sub` metadata derived from `jwt.sub`; the OpenFGA bridge maps that subject to `user:<sub>` and calls OpenFGA `Check`. The route-level bridge checks the coarse `mcp_gateway:list` object for MCP browse/list/init traffic, while signed Dynamic Agent `tools/call` requests additionally check the agent/tool relationships. If `jwtAuth` fails, the request never reaches policy evaluation; if OpenFGA/bridge is unavailable or denies, AG returns 403 because `failureMode.denyWithStatus=403`.

### OpenFGA ReBAC Model

The dev PDP model keeps the coarse AgentGateway gate and adds admin-configured team relationships:


| Type                           | Relation                                              | Tuple written by                                                                                       |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `mcp_gateway:list`             | `can_call: [user]`                                    | `openfga-init` seed / manual bootstrap for the current AGW coarse browse/list gate                     |
| `team:<slug>`                  | `member: [user]`                                      | Team Resources save, using Keycloak `sub` values resolved from team member emails                      |
| `agent:<agent_id>`             | base `user`, `manager`; derived `can_use`, `can_manage` | Team Resources agent Use / Manage checkboxes write base relations                                      |
| `tool:<server>/*`              | base `caller`; derived `can_call`                     | AgentGateway runtime grant for every tool on a concrete MCP server; Team Resources expands all-MCP-server access into one tuple per registered server |
| `knowledge_base:<id>`          | base `reader`, `ingestor`, `manager`; derived `can_read`, `can_ingest`, `can_admin` | Datasource Search settings write `reader` relationships. The `ingestor` relation remains available only for trusted ingestion transports; it is not granted by the Search UI. KB pages, sharing, and KB-scoped routes check these relationships. |
| `data_source:<id>`             | base `reader` (incl. `user:*` wildcard), `ingestor`, `manager`, `parent_kb`; derived `can_read`, `can_ingest`, `can_manage` | Indexed-content policy. A 1:1 `parent_kb knowledge_base:<id>` edge inherits query grants without mirrored per-team tuples; direct component grants remain possible. Search intersects this policy with the caller, while reload requires `ingestion_source` management. A `user:* reader data_source:<id>` tuple makes a datasource searchable by every authenticated user who also has the organization Search capability. |
| `rag_collection:<id>`          | base `owner`, `reader`, `publisher`, `manager`; derived `can_discover`, `can_read`, `can_publish`, `can_manage` | Control-plane grouping of datasource IDs. `reader` grants read access through `knowledge_base#parent_collection`; `data_source` then inherits through its existing `parent_kb` edge. `publisher` changes membership and `manager` changes settings; neither relation implies read access. |
| `ingestion_source:<id>`        | base `owner`, `reader`, `manager`; derived `can_read`, `can_manage` | Independent connector-configuration policy. Source create/edit/transfer/reload/delete and config visibility check this object; it does not inherit Search access from `data_source` or `knowledge_base`. |
| `skill:<id>`                   | base `reader`, `user`, `writer`, `manager`; derived `can_read`, `can_use`, `can_write`, `can_manage` | Team Resources skill selection writes `user` relationships for local and Skill Hub catalog ids; `/api/skills` filters by `can_read`/`can_use`. |
| `conversation:<id>`            | base `owner`, `reader`, `writer`, `sharer`, `manager`; derived `can_read`, `can_write`, `can_share`, `can_delete` | Chat list/read/write/share and Dynamic Agent stream/invoke/resume/cancel paths check implicit Mongo ownership first, then explicit OpenFGA conversation access. |
| `mcp_server:agentgateway`      | base `reader`, `writer`, `manager`; derived `can_discover`, `can_read`, `can_manage` | AgentGateway discovery uses `can_discover`; selected-server sync/onboarding uses `can_manage`. |
| `system_config:platform_settings` | base `reader`, `manager`; derived `can_read`, `can_manage` | Platform config GET/PATCH checks the concrete system config object in addition to admin session gates. |
| `organization:<org_key>`       | base `member`, `admin`, `auditor`, `ingestor`, `searcher`; derived `can_ingest` (`ingestor or admin`), `can_search` (`searcher or admin`) | `ingestor` is the explicit "data source author" capability written/deleted per team by `PUT/DELETE /api/admin/teams/[id]/ingest-capability` (`team:<slug>#member ingestor organization:<key>`). `searcher` is the explicit "search" capability written/deleted per team by `PUT/DELETE /api/admin/teams/[id]/search-capability` (`team:<slug>#member searcher organization:<key>`). `kb-tab-gates` and the RAG server check `can_ingest` (`authorize_datasource_create`) to gate creating new data sources, and `can_search` (`authorize_search`, plus the BFF `requireSearchCapability`) to gate using search (`/v1/query`, `/v1/mcp/invoke`) for built-in and custom tools. |


The Web UI backend tuple writer is idempotent: it checks tuples before writes/deletes to avoid duplicate-write failures and to tolerate missing tuples during removals. It intentionally rejects writable `can_*` tuples; callers must write base relationships and let OpenFGA derive the `can_*` permissions.

### First-class RAG collections and agent hands

A RAG collection stores stable datasource IDs in MongoDB. It does not copy
chunks, create another Milvus collection, or change reload behavior. Ingestors
continue to replace each datasource's indexed rows wholesale, including
removing stale pages when a source shrinks.

- Direct Search/API calls use all datasources the caller can currently read.
  The built-in `search` MCP tool also accepts an optional runtime
  `collection_id` filter so a caller can scope a query to one or more
  collections directly, without agent-level `rag_collection_ids`
  configuration. `server/rbac.py`'s `get_datasource_ids_for_collection`
  resolves a `rag_collection:<id>` to its member `knowledge_base`/
  `data_source` ids via a structural OpenFGA tuple read on the
  `parent_collection` edge — this resolution itself does **not** check the
  caller's access to the collection or its members. Enforcement instead
  comes from `tools.py`, which intersects the resolved ids with every other
  datasource constraint (config-pinned `datasource_ids`, a `datasource_id`
  filter, and the caller's live OpenFGA-accessible set) the same way
  `datasource_id` narrowing already works: the result can only narrow, never
  widen, so a collection containing a datasource the caller cannot read
  simply drops that datasource from the results rather than exposing it or
  erroring.
- An agent stores direct `datasource_ids` plus `rag_collection_ids`. The runtime
  expands collection membership live for every RAG tool call, unions it with
  direct pins, and the RAG server intersects the result with the caller's live
  OpenFGA access.
- Missing pin fields are a temporary pre-migration legacy state. Explicit empty
  arrays are a deny/opt-out. The migration attaches otherwise-unscoped
  RAG-enabled agents to `platform-rag`; new RAG-enabled agents default to that
  collection when their owner can read it, and may remove it.
- A personal collection writes separate owner and reader relationships. Its
  owner can publish only datasources they both manage and read. Organization
  admins may delegate Owner and Search teams for centrally managed
  collections.
- Service-account scope editing writes explicit `data_source#reader` grants for
  selected datasources. It uses the same grantable-resource rule as agents and
  tools: a creator cannot delegate a datasource they cannot access. There is no
  separate service-account query scope.
- Datasource deletion removes the source from collections and direct agent
  pins, preventing a later recreation of the same deterministic datasource ID
  from reviving an old agent selection. Collection deletion removes its agent
  references but never deletes indexed source data.

This separation keeps collection Owners from reading content merely
because they can curate it. When an organization admin delegates collection
Search to a team, the BFF also adds the coarse organization `can_search`
capability. That capability is additive-only because another collection or an
explicit Team setting may still depend on it; datasource relationships remain
the authoritative content boundary.

> **Team membership semantic:** On the `team` type, `member` is now defined as `[user, external_group#member] or admin` — i.e. anyone with the `admin` relation on a team automatically satisfies `team#member` checks (and, by extension, `team#member` userset references such as the `team:<slug>#member can_use agent:<id>` Slack/Webex resource paths). This means an admin no longer needs a separate `member` tuple to use the team's agents, and bots can ask `check(user, "member", team:<slug>)` as a single question. `admin` continues to be a directly-written relation; only `member` gains the derived branch. Callers that legacy-listed both `team#member` and `team#admin` as subject sets still work but are now redundant.

### AgentGateway Policy Model

AgentGateway no longer maintains a Mongo-backed CEL policy surface for MCP
authorization. The checked-in `deploy/agentgateway/config.yaml` is intentionally
static: it authenticates with `jwtAuth`, delegates authorization to the OpenFGA
bridge through `extAuthz`, and then proxies to the configured MCP targets.

The Admin UI's former "AG MCP Policies" tab, `/api/rbac/ag-policies`,
`/api/rbac/ag-sync-status`, `ag_mcp_policies`, `ag_mcp_backends`, and
`ag_sync_state` are retired. Relationship changes should be modeled as OpenFGA
tuples through the ReBAC admin surfaces instead of editing AgentGateway CEL.

The Web UI backend's former CEL overlay is also retired: `CEL_RBAC_EXPRESSIONS`,
`/api/rbac/admin-tab-policies`, editable `admin_tab_policies`, and the browser CEL
editor are no longer part of the UI authorization path. Keep custom authorization
logic in OpenFGA tuples and audited ReBAC change sets.

### Operational Guarantees


| Guarantee                                                      | Mechanism                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| AG restart does not invalidate user sessions                   | User JWTs are self-contained; AG just re-fetches JWKS on startup                                 |
| Keycloak key rotation is zero-downtime                         | Unknown `kid` triggers one forced JWKS refresh; cached keys remain valid until `exp`             |
| Policy update is zero-downtime                                 | OpenFGA tuple writes are independent of AG process restarts; AG keeps using `extAuthz`           |
| Admin UI edit audit trail                                      | ReBAC relationship/policy surfaces write `openfga_rebac` audit events through the Web UI backend |
| MongoDB outage doesn't take AG down                            | AG uses static config plus OpenFGA; it does not depend on Mongo-rendered CEL rules               |
| Keycloak outage doesn't take AG down for already-issued tokens | JWKS is cached; new logins fail at Keycloak, not at AG                                           |


> The end-to-end per-request sequence diagram (and the demo walkthrough that proves all three outcomes — 200, 403, 401) lives in [Workflows › Per-request authorization](./workflows.md#per-request-authorization-end-to-end). Use that to demo the system live.

---

## Component 5: Dynamic Agents — The Workshop Floor

> **Badge analogy:** A workshop where employees build and operate their own machines. The workshop checks your badge at the door (JWT validation on every request). Once inside, each machine has its own access tag — some are personal (Private), some are shared with your team (Team), some anyone can use (Global). Your badge level determines which machines you can touch. When a machine makes a tool call, it presents your badge — not its own — so the security checkpoint still sees *you*, not the machine.

**Technically:** A FastAPI service where every route handler uses `get_current_user()` as a FastAPI `Depends()`, validating the JWT on every request at the route level for precise control per endpoint. This is the component that carries the user's identity to the MCP layer: it validates the incoming JWT and forwards the same bearer token (or OBO token) to AgentGateway, so per-user enforcement at the PEP is preserved end-to-end.

### JWT Validation Chain

```python
# FastAPI dependency injection — runs before every protected handler
user: UserContext = Depends(get_current_user)
```

Inside `get_current_user()`:

```
1. Extract Bearer token from Authorization header
2. Fetch JWKS from Keycloak (cached in-process)
3. Validate:
   - Signature (RS256 against JWKS public key)
   - expiry (exp)
   - issuer (iss == OIDC_ISSUER)
   - audience (aud == OIDC_CLIENT_ID, if set)
4. Call OIDC userinfo endpoint (cached 10 min by token hash)
   → authoritative email, name, groups (OIDC tokens often omit these)
5. Extract realm_access.roles from JWT claims
   (Keycloak puts roles here; also checked in userinfo)
6. Evaluate the configured required-access group (if set) — 403 if missing
7. Preserve group claims as identity context only; product admin is decided by OpenFGA organization relationships
8. Return UserContext { email, name, groups, access_token, obo_jwt }
```

### Agent-Level Authorization (OpenFGA Execution Gate)

After the bearer token is validated by `JwtAuthMiddleware`, Dynamic Agents
decodes the already-validated JWT payload only to extract `sub` and repeats the
same OpenFGA check used by the Web UI backend:

```text
user:<sub> can_use agent:<agent_id>
```

The runtime check runs before agent lookup, MCP server lookup, runtime cache
creation, non-streaming invocation, or stream resume work. This second layer is
required because the runtime must not trust the Web UI backend as the only enforcement
point. Denials return `403 / pdp_denied`; OpenFGA outages return
`503 / pdp_unavailable`; missing or malformed bearer context returns a
structured `401`.

The older visibility-rule and CEL authorization paths are no longer the
authoritative execution gate for start, invoke, and resume. Downstream tool
authorization continues to be enforced by AgentGateway and OpenFGA.

### Token Forwarding to MCP Tools

The `UserContext.obo_jwt` (set from `X-OBO-JWT` header) or `UserContext.access_token` is forwarded as the `Authorization: Bearer` header on all MCP tool calls made by the agent runtime. This carries the original, unmodified user identity all the way to AgentGateway, so MCP-level checks see the real user rather than a service account.

Dynamic Agents also forwards the validated per-request bearer when probing MCP servers for tool manifests. The MCP client connection config carries an explicit `Authorization` header in addition to the HTTP client factory hook, because AgentGateway denies tokenless probe traffic before any upstream MCP server can return tools.

Only MCP server IDs listed in `AGENT_GATEWAY_MCP_SERVER_IDS` are rewritten to
`AGENT_GATEWAY_URL/mcp/<server_id>`. The special value `all` applies only to
gateway-managed rows (`source: agentgateway`, `agentgateway_discovered: true`,
or an endpoint already rooted at `AGENT_GATEWAY_URL`); manual/direct MCP rows
keep their stored endpoint so runtime-added tools do not get sent to missing
AgentGateway routes. Docker Compose defaults to `all` because
`agentgateway-config-bridge` reconciles enabled gateway-managed `mcp_servers`
rows into the standalone AgentGateway config. The Helm path uses AgentGateway's
native Kubernetes resources: `global.agentgateway.knowledgeBaseTarget` and
`global.agentgateway.extraMcpTargets` render `AgentgatewayBackend` and
`HTTPRoute` objects instead of running the Mongo polling bridge in-cluster.

For runtime `tools/call` requests, Dynamic Agents can also attach a signed
`X-CAIPE-Agent-Context` header containing the calling `agent_id`. The OpenFGA
bridge verifies this header with `CAIPE_AGENT_CONTEXT_HMAC_SECRET`, then checks
both relationships before allowing the call:

```text
user:<sub> can_use agent:<agent_id>
agent:<agent_id> can_call tool:<server_id>/<tool_name>
```

See [Agent context HMAC](./agent-context-hmac.md) for what the secret does, which
components must share it, and Helm/Compose wiring (including G1/G2 from PR #1967).

The Web UI backend reconciles the second tuple family from each agent's
`allowed_tools` whenever an agent is created, updated, or deleted. Empty
per-server tool lists are represented as `tool:<server_id>/*` so the runtime
allowlist and the enforcement graph use the same wildcard semantics.

### Key Environment Variables


| Variable                          | Default                                         | Security note                                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_ENABLED`                    | `false`                                         | **Must be `true` in production.** `false` returns a hardcoded `dev@localhost` admin — never deploy with `false`.                                                                               |
| `OIDC_ISSUER`                     | —                                               | Validated against `iss` claim; tokens from other issuers are rejected                                                                                                                          |
| `OIDC_CLIENT_ID`                  | —                                               | Identifies the Web UI client used by browser-facing flows. Dynamic Agents audience validation uses `KEYCLOAK_AUDIENCE` / `OIDC_AUDIENCE`.                                                      |
| `KEYCLOAK_URL` / `KEYCLOAK_REALM` | —                                               | Cluster-internal Keycloak base URL and realm used to fetch JWKS. Required when `OIDC_ISSUER` is a public hostname that is not reachable through the pod's localhost.                           |
| `KEYCLOAK_AUDIENCE` / `OIDC_AUDIENCE` | `caipe-platform,agentgateway`               | Comma-separated audiences accepted for Dynamic Agents bearer validation. Include `caipe-ui` when browser session tokens carry that audience.                                                     |
| `OIDC_REQUIRED_GROUP`             | —                                               | Optional deployment-specific Web UI admission gate; users missing this upstream group are denied before product authorization runs                                                              |
| `OIDC_REQUIRED_ADMIN_GROUP`       | —                                               | Deprecated for CAIPE product admin. Map enterprise admin groups to CAIPE teams through Identity Group Sync, then grant OpenFGA `admin` on `organization:<org>`.                                 |
| `DA_REQUIRE_BEARER`               | `false`                                         | Set to `true` to require validated bearer identity for runtime OpenFGA enforcement                                                                                                             |
| `OPENFGA_HTTP`                    | — (`http://openfga:8080` in Docker Compose dev) | OpenFGA API base URL used for runtime `can_use` checks                                                                                                                                         |
| `OPENFGA_STORE_ID`                | —                                               | Optional explicit OpenFGA store id; takes precedence over store-name discovery                                                                                                                 |
| `OPENFGA_STORE_NAME`              | `caipe-openfga`                                 | Store name used when discovering the OpenFGA store id; Docker Compose dev wires this into Dynamic Agents alongside the Web UI backend                                                          |
| `AGENT_GATEWAY_MCP_SERVER_IDS`    | `all`                                           | Comma-separated MCP server IDs that Dynamic Agents should reach through `AGENT_GATEWAY_URL`; `all` only includes gateway-managed rows, while manual/direct MCP servers keep their stored endpoints. |
| `CAIPE_AGENT_CONTEXT_HMAC_SECRET` | —                                               | Optional shared secret for signing Dynamic Agents → AgentGateway `agent_id` context used by the OpenFGA bridge for per-agent MCP tool enforcement. Use a secret manager; do not commit values. |
| `SLACK_BOT_ADMIN_URL`             | `http://ai-platform-engineering-slack-bot:3001` | Web UI backend URL for the Slack bot internal admin API used for runtime route status, cache reload, and static-config sync. Keep cluster-internal. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | `caipe-ui` / —                            | Web UI backend Keycloak confidential client credentials. The same `caipe-ui` client is used for browser OIDC login and server-side client-credentials calls to the Slack bot admin API. Store the secret in a secret manager; do not place it in ConfigMaps. |
| `SLACK_ADMIN_API_ENABLED`         | `false`                                         | Enables the Slack bot's internal admin API. It must remain internal-only and require JWKS-verified Bearer tokens. |
| `SLACK_BOT_ADMIN_DEV_AUTH_ENABLED` / `SLACK_BOT_ADMIN_DEV_TOKEN` | `false` / — | Web UI local-dev escape hatch for Slack bot admin API calls when Keycloak is intentionally not running. Sends the configured dev bearer token instead of minting a Keycloak client-credentials token. |
| `SLACK_ADMIN_DEV_AUTH_ENABLED` / `SLACK_ADMIN_DEV_TOKEN` | `false` / — | Slack bot side of the same local-dev escape hatch. The bot accepts the dev bearer token only when explicitly enabled. Never enable in shared, staging, or production environments. |
| `SLACK_ADMIN_JWKS_URL`            | —                                               | Optional Docker/cluster-internal JWKS URL for Slack bot token verification when the public issuer is not directly reachable from the bot container. |
| `SLACK_ADMIN_JWT_AUDIENCE`        | `caipe-slack-bot-admin`                         | Expected audience for Web UI backend service tokens calling Slack bot admin endpoints. |


---

## Service-to-Service Authentication (Slack bot → caipe-ui)

The Slack bot calls caipe-ui's API as a machine client, not as a logged-in user. It uses the OAuth2 `client_credentials` grant against the `caipe` realm:


| Env var                                | Purpose                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SLACK_INTEGRATION_ENABLE_AUTH=true`   | Enables Bearer-token path in `app.py`                                                                               |
| `SLACK_INTEGRATION_AUTH_TOKEN_URL`     | `${KEYCLOAK_URL}/realms/caipe/protocol/openid-connect/token`                                                        |
| `SLACK_INTEGRATION_AUTH_CLIENT_ID`     | `caipe-slack-bot` (pre-created in `realm-config.json`)                                                              |
| `SLACK_INTEGRATION_AUTH_CLIENT_SECRET` | Fetched from Keycloak — see "Provisioning service-client secrets" below                                             |
| `OAUTH2_CLIENT_SECRET`                 | Helm fallback env var for the same `caipe-slack-bot` client secret, normally sourced from the `keycloak-bot` Secret |
| `KEYCLOAK_BOT_CLIENT_SECRET`           | Same secret again for the Slack OBO helper (`utils/obo_exchange.py`)                                                |


**Token shape** (fields that matter):

- `iss` — `${KEYCLOAK_URL}/realms/caipe`
- `aud` — `[caipe-ui, caipe-platform]` — both audiences are needed. `caipe-platform` is added by Keycloak's default audience resolution; `caipe-ui` comes from an `oidc-audience-mapper` protocol mapper (`aud-caipe-ui`) on the `caipe-slack-bot` client. caipe-ui's JWT validator rejects tokens whose audience doesn't include `OIDC_CLIENT_ID` (i.e. `caipe-ui`), so this mapper is required.
- `azp` — `caipe-slack-bot`
- `sub` — service account UUID (stable)
- `preferred_username` — `service-account-caipe-slack-bot`
- `scope` — `groups email profile org roles`

The mapper is created automatically by `deploy/keycloak/init-idp.sh` (idempotent).

**This token represents the bot, not the user.** User identity is carried separately by the OBO flow in `utils/obo_exchange.py` (RFC 8693 token exchange), which produces a second token with `act.sub=caipe-slack-bot` and the real user's `sub`/`email`.

### Provisioning service-client secrets in production

In dev, secrets are embedded in `deploy/keycloak/realm-config.json`. In production, operators should treat them as rotating credentials:

**Option A — manual (Keycloak Admin UI):**

1. Log into Keycloak Admin Console → `caipe` realm → Clients → `caipe-slack-bot` → Credentials tab.
2. Copy the Secret value (or click **Regenerate Secret** for rotation).
3. Store it in your secret manager (Vault, AWS SSM, K8s Secret) as `SLACK_INTEGRATION_AUTH_CLIENT_SECRET`.
4. Redeploy / restart the Slack bot pod so it picks up the new secret.

**Option B — scripted (`deploy/keycloak/export-client-secrets.sh`):**

The script fetches secrets via the Keycloak Admin API and emits them in one of three formats:

```bash
# shell (source into current session)
eval "$(KC_URL=https://keycloak.example.com ./export-client-secrets.sh)"

# dotenv (append to a .env file)
KC_URL=https://keycloak.example.com FORMAT=dotenv \
  ./export-client-secrets.sh >> slack-bot.env

# kubernetes Secret (pipe to kubectl)
KC_URL=https://keycloak.example.com FORMAT=k8s \
  K8S_NAMESPACE=caipe K8S_SECRET_NAME=caipe-service-secrets \
  ./export-client-secrets.sh | kubectl apply -f -
```

The Helm chart can wire this up as a post-install Job so fresh installs get the Secret populated without operator intervention. Rotation is the same call — the Secret is overwritten in place.

## Slack bot → Keycloak user directory (via the BFF)

Separate from the OBO flow above. The Slack bot reads and writes Keycloak user
records — find a user by `slack_user_id` attribute or email, read
`caipe_default_team_id`, write `slack_user_id` / `slack_preauth_prompted_at`,
and JIT create-or-resolve a shell user — when someone @mentions the bot or DMs
it for the first time.

The bot does **not** hold Keycloak Admin credentials for this. Every call goes
to a first-party CAIPE UI BFF endpoint carrying the bot's own
**`caipe-slack-bot` service-account token** (the same client-credentials token
used for the OBO flow) plus `X-Client-Source: slack-bot`. The BFF graphs the
caller as `service_account:<sub>` and authorizes each endpoint with an explicit
OpenFGA grant:

| Bot operation | BFF endpoint | OpenFGA grant |
| --- | --- | --- |
| lookup by attribute / email / id | `GET /api/admin/users/resolve` | `reader admin_surface:user_directory` |
| merge a user attribute | `PATCH /api/admin/users/{id}/attributes` | `writer admin_surface:user_directory` |
| JIT create-or-resolve a shell user | `POST /api/admin/users/provision-shell` | `writer admin_surface:user_provisioning` |

The grants are seeded for every bot service account by the keycloak chart's
`init-token-exchange.sh` (`SA_GRANTS`). The BFF in turn uses its own
`KEYCLOAK_ADMIN_*` credentials to reach Keycloak — so realm-management
privilege lives only in the BFF, never in a bot. This removed the bot's former
`KEYCLOAK_SLACK_BOT_ADMIN_*` direct-Admin path (spec
[2026-06-09-slack-bot-remove-direct-keycloak-admin](../../specs/2026-06-09-slack-bot-remove-direct-keycloak-admin/plan.md);
JIT create moved first in #1781).

The `resolve` endpoint whitelists the attribute names a bot may query
(`slack_user_id`, `slack_preauth_prompted`, `slack_preauth_prompted_at`,
`caipe_default_team_id`) and the `attributes` endpoint whitelists the keys a bot
may write (`slack_user_id`, `slack_preauth_prompted_at`), so the service account
cannot scrape or mutate arbitrary identity attributes.

| Env var                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAIPE_UI_URL` / `CAIPE_API_URL`            | Base URL of the CAIPE UI BFF the bot calls for all Keycloak user operations. |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`             | Same values as everywhere else (used by the OBO token-exchange flow).                                                                                                                                                                                                                                                                                                     |
| `SLACK_RBAC_ENABLED`                         | Enables Slack-side identity lookup, team/channel resolution, OBO exchange, and channel ReBAC checks before the bot forwards a request.                                                                                                                                                                                                                                    |
| `SLACK_JIT_CREATE_USER` (spec 103)           | `true` (default) auto-creates a federated-only Keycloak shell user on first DM when no Keycloak user with the Slack email exists. `false` falls through to the HMAC link URL so onboarding requires the web UI. Provisioning flows through the BFF — no Keycloak Admin credential on the bot. |
| `SLACK_JIT_ALLOWED_EMAIL_DOMAINS` (spec 103) | Optional comma-separated allowlist (e.g. `corp.com,acme.io`). Empty = any domain. Recommended for prod when the federated IdP can return non-corporate emails.                                                                                                                                                                                                            |


In Helm and GitOps installs, `charts/ai-platform-engineering/charts/slack-bot/templates/deployment.yaml` wires `OAUTH2_CLIENT_SECRET` and `KEYCLOAK_BOT_CLIENT_SECRET` from the Keycloak bot Secret. There is no longer any Keycloak Admin secret to wire on the bot.

> **Operator migration.** `KEYCLOAK_SLACK_BOT_ADMIN_CLIENT_ID` and
> `KEYCLOAK_SLACK_BOT_ADMIN_CLIENT_SECRET` are no longer used by the Slack bot
> and can be removed from your `values.yaml` / `.env` (and from any
> ExternalSecret backing them, e.g. Vault `projects/caipe/rbac/slackbot`). The
> bot now reaches Keycloak only through the BFF using its `caipe-slack-bot`
> service account; the required `admin_surface:user_directory` /
> `admin_surface:user_provisioning` OpenFGA grants are seeded automatically by
> the keycloak chart's `init-token-exchange.sh`. No action is required beyond
> dropping the unused vars. Ensure the bot has `CAIPE_UI_URL` / `CAIPE_API_URL`
> pointed at the BFF (it already needs this for JIT provisioning since #1781).

## Spec 104 — `active_team` JWT claim (REMOVED by Phase 3 of spec 2026-05-24-derive-team-from-channel) {#spec-104--active_team-jwt-claim-team-scope-refactor}

> **Status: removed.** The `active_team` JWT claim mechanism described
> here has been demolished. Team identity is now derived from the
> `channel_team_mappings` collection at request time (BFF + AgentGateway
> PDP). Bots no longer mint `team-<slug>` client scopes, the OBO audience
> client no longer has any `team-*` default scope, and Keycloak no longer
> participates in team-identity negotiation.
>
> See [spec 2026-05-24-derive-team-from-channel](../../specs/2026-05-24-derive-team-from-channel/spec.md)
> for the full demolition rationale. The `active_team` mechanism never
> shipped to production, so no realm has legacy `team-*` scopes to
> clean up — Phase 3 is a pure code/Helm/UI deletion.

### Components touched (post-demolition)

1. **Keycloak** — no per-team client scopes, no `active_team` mapper, no
   `team-personal` DM-marker scope. Only the team-agnostic OBO permission
   wiring (token-exchange decision strategy, bot service-account
   impersonation roles, realm-wide `users.impersonate` scope-permission)
   remains in scope of the reconciliation migration.
2. **Web UI backend (`caipe-ui`)** — `POST /api/admin/teams` writes a
   Mongo team row + OpenFGA tuples only. `DELETE /api/admin/teams/[id]`
   removes those rows. Slack / Webex channel onboarding writes
   `channel_team_mappings` entries (no Keycloak touch).
3. **Slack / Webex bots** — `obo_exchange.impersonate_user()` no longer
   requests a `team-*` scope and no longer verifies an `active_team`
   claim. Channel → team resolution lives entirely in
   `channel_team_resolver`, which reads from `channel_team_mappings`.
4. **Dynamic agents** — request-bound auth context is the user OBO JWT
   only. No `active_team` claim is read or written.
5. **AgentGateway PDP / RAG server** — both consume the user JWT plus
   the channel→team mapping. RAG's `UserContext.active_team` field is
   gone; `_kb_cel_context` now exposes `user.teams` as a list of teams
   the user belongs to (OpenFGA-sourced), not the single channel team.

### Failure modes (post-demolition)

- **Group channel without a team mapping** → bot replies "this channel
  isn't assigned to a CAIPE team yet"; nothing reaches AGW.
- **User not in the mapped team** → bot replies "you aren't a member of
  `<team>`".
- **DM with no `dm_agent_id` preference and no realm default** → bot
  replies with the `default_agent_id` selection UI.
- **DA receives a request without a user JWT** → middleware logs
  WARNING, MCP call goes out without `Authorization`, AGW 401s.
