# PDP Coverage Audit — UI BFF `/api/*` Routes

**Status:** Living audit, last refreshed 2026-05-27. Re-run the grep snippets in the [How this audit was produced](#how-this-audit-was-produced) section whenever you change `ui/src/lib/api-middleware.ts::resolveLegacyWithAuthRbacPolicy` or add a new `/api/*` route.

**Audience:** Engineers reviewing whether a UI BFF endpoint is properly PDP-gated, and security architects checking that we never silently regressed to a Mongo-only "is admin?" decision.

**TL;DR**

1. Every production `/api/*` route in the UI BFF reaches a Policy Decision Point (PDP). There is no endpoint today that authorizes purely from MongoDB.
2. The PDP is **OpenFGA** for everything that goes through `requireRbacPermission()`, with a **Keycloak Authorization Services** fallback for routes whose target relation isn't yet modelled in OpenFGA. See [JWT and OpenFGA](./jwt-and-openfga.md) for the dual-PDP rationale.
3. Three patterns coexist today, in decreasing order of how cleanly they map to user intent:
   - **Resource-scoped PDP** (`requireResourcePermission(..., { type, id, action })`) — best.
   - **Capability-scoped PDP** (`requireRbacPermission(..., resource, scope)` or `requireAdminSurfaceManage`/etc.) — good.
   - **Compatibility `withAuth(...)`** that resolves route prefixes to explicit capabilities via `ui/src/lib/api-middleware.ts`. Tracked for continued cleanup by [`2026-05-27-fine-grained-rbac-for-withauth-routes`](../../specs/2026-05-27-fine-grained-rbac-for-withauth-routes/plan.md).
4. A handful of routes still have an `if (user.role === 'admin') { skip PDP }` short-circuit. These are **not** Mongo-based — `session.role === 'admin'` comes from the JWT (`BOOTSTRAP_ADMIN_EMAILS` or `OIDC_REQUIRED_ADMIN_GROUP`) — but they are a parallel decision path with no OpenFGA audit trail. Listed in [Category 1](#category-1--legacy-admin-bypass-no-pdp-on-the-bypass-branch).

If you are here because something denied unexpectedly, jump straight to [How to read an `audit_event_id` row](#how-to-read-an-audit_event_id-row).

---

## How the BFF gate works

Every UI API route ends up at one of three call sites, all defined in `ui/src/lib/api-middleware.ts`:

```ts
// Pattern 1 — resource-scoped (preferred)
const { session } = await getAuthFromBearerOrSession(request);
await requireResourcePermission(session, { type: "system_config", id: "platform_settings", action: "read" });

// Pattern 2 — capability-scoped
const { session } = await getAuthFromBearerOrSession(request);
await requireRbacPermission(session, "admin_ui", "admin");

// Pattern 3 — legacy umbrella (still PDP, but via a prefix-derived policy)
return withAuth(request, async (req, user, session) => { ... });
```

`withAuth` is **not** "is the user signed in?" — it resolves the URL to a `{ resource, scope }` pair and then runs the same `requireRbacPermission()` everyone else does. The mapping (post the 2026-05-27 `platform-config` carve-out) is:

| URL prefix                                            | PDP capability the BFF enforces |
|-------------------------------------------------------|--------------------------------|
| `/api/users/debug`                                    | `admin_ui#view`                |
| `/api/admin/platform-config` (`GET`, exception)       | `system_config#read`           |
| `/api/admin/*` (other `GET`)                          | `admin_ui#view`                |
| `/api/admin/*` (non-`GET`)                            | `admin_ui#manage`              |
| `/api/users/me`                                       | `self_profile#read/write`      |
| `/api/users/search`                                   | `user_directory#read`          |
| `/api/auth/my-roles`, `/api/auth/role`                | `self_profile#read`            |
| `/api/auth/slack-link`, `/api/auth/webex-link`        | `self_profile#write`           |
| `/api/settings`                                       | `user_settings#read/write`     |
| `/api/feedback`, `/api/tickets/report`, `/api/tickets/jira` | `feedback#submit`       |
| `/api/chat`, `/api/dynamic-agents/models`, `/api/dynamic-agents/available` | `chat#invoke` |
| `/api/files`                                          | `user_files#read/write`        |
| `/api/ai`                                             | `ai_assist#invoke`             |
| `/api/credentials`                                    | `credential_vault#use` plus concrete `secret_ref` checks |
| `/api/workflow-configs` (all methods)                 | `dynamic_agent#view` |
| `/api/workflow-runs` (`GET` / non-`GET`)              | `dynamic_agent#view` / `invoke` |
| `/api/catalog-api-keys`                               | `skill#configure`              |
| `/api/skills/seed`                                    | `admin_ui#admin`               |
| `/api/skills/token`                                   | `skill#invoke`                 |
| `/api/skills` / `/api/skill-templates` (everything else) | `skill#view` / `delete` / `configure` |
| **fallback** (`GET` / non-`GET`)                      | `admin_ui#view` / `manage`     |

The OpenFGA relation each pair maps to is computed by `organizationRelationFor()` in the same file:

| `resource` | `scope`                | OpenFGA relation on `organization:caipe` |
|------------|------------------------|-------------------------------------------|
| `admin_ui` | `view` / `audit.view`  | `can_audit`                               |
| `admin_ui` | any other              | `can_manage`                              |
| `self_profile` | `read` / `write`  | `can_read_self` / `can_manage_self`       |
| `user_directory` | any             | `can_search_directory`                    |
| `chat` | any                        | `can_chat`                                |
| `feedback` | any                    | `can_submit_feedback`                     |
| `user_settings` | any              | `can_manage_self`                         |
| `user_files` | any                 | `can_use_files`                           |
| `ai_assist` | any                  | `can_use_ai_assist`                       |
| `credential_vault` | any           | `can_use_credentials`                     |
| any        | `view` / `read` / `query` / `invoke` | `can_use`                       |
| any        | `audit.view`           | `can_audit`                               |
| any        | anything else          | `can_manage`                              |

So `withAuth` on `GET /api/users/me` becomes an OpenFGA `check` for `user:<sub> can_read_self organization:caipe`, while `PATCH /api/users/me` checks `can_manage_self`. Those relations are derived from organization membership/admin in the model, so existing signed-in members keep baseline self-service access after upgrade.

---

## Route-by-route audit

The audit reaches every `route.ts` under `ui/src/app/api/` (excluding `__tests__/`). Routes are grouped by *what gates them*, not by URL.

### Category 1 — Legacy admin bypass (no PDP on the bypass branch)

These routes contain a branch of the form `if (user.role === 'admin') { skip PDP } else { ... }`. `session.role === 'admin'` is set by the NextAuth JWT callback in `ui/src/lib/auth-config.ts` from one of:

- A match against `BOOTSTRAP_ADMIN_EMAILS`, or
- Membership in `OIDC_REQUIRED_ADMIN_GROUP` (default empty / unused).

The bypass is **not** Mongo-derived, but it is invisible to OpenFGA and produces no `audit_event_id` row. In the steady state we want every authorization decision to flow through PDP so the audit trail is complete.

| Route | File | Bypass site | Notes |
|---|---|---|---|
| `/api/workflow-configs` | `ui/src/app/api/workflow-configs/route.ts` | lines 117, 217, 265 | Skips `requireResourcePermission({ type: "task", … })` for admins on `GET`, `PUT`, `DELETE`. |
| `/api/skills/configs` | `ui/src/app/api/skills/configs/route.ts` | line 367 | Admin reads skip `requireResourcePermission({ type: "skill", id, action: "read" })`. Writes/deletes always PDP. |
| `/api/admin/teams/[id]/kb-assignments` (`GLOBAL_PSEUDO_TEAM` branch) | `ui/src/app/api/admin/teams/[id]/kb-assignments/route.ts` | lines 151, 204, 300 | The global pseudo-team branch only checks `user.role === 'admin'` — no PDP at all on that branch. |
| `/api/admin/openfga/baseline-profile` (`isAdminUser` helper) | `ui/src/app/api/admin/openfga/baseline-profile/route.ts` | line 167 | Reads `users.role === 'admin'` from MongoDB, but only as *input data* to bulk OpenFGA reconciliation. The route handler itself is gated by `withOpenFgaViewAuth` / `withOpenFgaAdminAuth`. Safe; included here for completeness. |

**Severity:** Medium. Bootstrap admins are already empowered through PDP anyway (they hold `organization:caipe#can_manage`), so the bypass doesn't actually grant additional access. The cost is the missing audit trail and a code path that future contributors might extend without realizing they're skipping the canonical PDP.

**Remediation:** Replace each bypass with a `requireResourcePermission(..., { ..., action: "admin" })` call against the resource the route mutates (or `requireRbacPermission(session, "admin_ui", "admin")` where no resource exists). The `GLOBAL_PSEUDO_TEAM` branch in `kb-assignments` should route through PDP unconditionally.

### Category 2 — `withAuth`-only routes (PDP via the legacy umbrella)

These routes look ungated at first glance — the only auth line in the file is `return withAuth(request, async (req, user, session) => { ... })` — but they ARE PDP-gated. `withAuth` runs the URL through `resolveLegacyWithAuthRbacPolicy()` and then calls `requireRbacPermission()`, which hits OpenFGA. The capability they end up enforcing is in the table at the top of this doc. The long tail that used to fall through to a single generic capability is now split into purpose-specific route capabilities.

| Route | File | Effective PDP capability |
|---|---|---|
| `/api/users/me` (GET / PATCH) | `ui/src/app/api/users/me/route.ts` | `self_profile#read/write` (self-scoped Mongo query is keyed on the caller's verified email — no IDOR surface) |
| `/api/users/me/insights`, `/api/users/me/favorites`, `/api/users/me/agent-*` | `ui/src/app/api/users/me/...` | `self_profile#read` (self-scoped) |
| `/api/users/search` | `ui/src/app/api/users/search/route.ts` | `user_directory#read` — returns public profile fields only (`email`, `name`, `avatar_url`) |
| `/api/chat/conversations/[id]/messages` | `ui/src/app/api/chat/conversations/[id]/messages/route.ts` | `chat#invoke` at the BFF + an inline conversation write check on `PATCH` until that route is fully migrated |
| `/api/chat/conversations/[id]/share` | `ui/src/app/api/chat/conversations/[id]/share/route.ts` | `chat#invoke` at the BFF + `requireConversationResourcePermission(session, user.email, conversation, "share")` inline |
| `/api/settings/*` | `ui/src/app/api/settings/...` | `user_settings#read/write` |
| `/api/feedback`, `/api/tickets/report`, `/api/tickets/jira` | `ui/src/app/api/feedback/...`, `ui/src/app/api/tickets/...` | `feedback#submit` — direct ticket submission uses the same feedback gate as stored feedback |
| `/api/files/list`, `/api/files/content` | `ui/src/app/api/files/...` | `user_files#read/write` (session-scoped upload tree) |
| `/api/ai/review`, `/api/ai/assist` | `ui/src/app/api/ai/...` | `ai_assist#invoke` |
| `/api/credentials/{retrieve,audit,health}` | `ui/src/app/api/credentials/...` | `credential_vault#use` at the BFF; per-credential `secret_ref` checks enforced inside the credential services in `ui/src/lib/credentials/` |
| `/api/credentials/connections/*`, `/api/credentials/oauth/*`, `/api/credentials/inject/*` | `ui/src/app/api/credentials/...` | Same pattern — credential-vault route gate plus resource-scoped checks inside service |
| `/api/integrations/slack/.../access-check`, `/api/integrations/webex/.../access-check` | `ui/src/app/api/integrations/...` | Concrete `slack_channel#read` / `webex_space#read` before delegated access checks |
| `/api/auth/role`, `/api/auth/my-roles`, `/api/auth/slack-link`, `/api/auth/webex-link` | `ui/src/app/api/auth/...` | `self_profile#read/write`; `/api/auth/role` also checks `organization:caipe#can_manage` to elevate to admin |
| `/api/dynamic-agents/models` | `ui/src/app/api/dynamic-agents/models/route.ts` | `chat#invoke` |
| `/api/dynamic-agents/available` | `ui/src/app/api/dynamic-agents/available/route.ts` | `chat#invoke` at the BFF + `filterResourcesByPermission(session, agents, { type: "agent", action: "use" })` inline |
| `/api/version` | `ui/src/app/api/version/route.ts` | Public read-only build metadata; no `withAuth` wrapper |

**Severity:** Reduced. Every route IS PDP-gated, and the high-traffic basic surfaces now emit capability names that match the surface being used. Any newly added `withAuth` route that does not fit the table should be given an explicit capability mapping before merge.

**Remediation:** Continue shrinking this category by replacing wrapper-level gates with inline resource checks where concrete resource ids are available. New `withAuth` routes should add an explicit mapping instead of relying on the deprecated fallback.

### Category 3 — Properly resource-scoped PDP

These routes call a fine-grained `require*Permission` helper directly. The PDP decision matches user intent, the audit trail is precise, and revocation is granular.

| Route | File | PDP capability |
|---|---|---|
| `/api/admin/teams` | `ui/src/app/api/admin/teams/route.ts` | `requireAdminSurfaceManage(session, "teams")` |
| `/api/admin/teams/[id]` | `ui/src/app/api/admin/teams/[id]/route.ts` | `requireRbacPermission(session, "team", "view" | "manage")` |
| `/api/admin/teams/[id]/openfga/reconcile` | `ui/src/app/api/admin/teams/[id]/openfga/reconcile/route.ts` | `requireTeamMembershipManagementPermission(session, user.email, { slug })` |
| `/api/admin/users/[id]/role` | `ui/src/app/api/admin/users/[id]/role/route.ts` | `requireRbacPermission(session, "admin_ui", "admin")` |
| `/api/admin/stats` | `ui/src/app/api/admin/stats/route.ts` | `requireAdminSurfaceManage(session, "stats")` |
| `/api/admin/openfga/baseline-profile` | `ui/src/app/api/admin/openfga/baseline-profile/route.ts` | `withOpenFgaViewAuth` / `withOpenFgaAdminAuth` |
| `/api/admin/credentials/secrets/*`, `/api/admin/credentials/oauth-connectors/*` | `ui/src/app/api/admin/credentials/...` | Resource-scoped via the credential services |
| `/api/admin/platform-config` | `ui/src/app/api/admin/platform-config/route.ts` | `requireResourcePermission(session, { type: "system_config", id: "platform_settings", action: "read" })` on `GET`; `admin_ui#admin` + `system_config#admin` on `PATCH` |
| `/api/admin/teams/[id]/kb-assignments` (non-global branch) | `ui/src/app/api/admin/teams/[id]/kb-assignments/route.ts` | `requireRbacPermission(session, "admin_ui", "admin")` OR canonical team-admin via `findUserRoleInTeam` (per [`2026-05-26-canonical-team-membership`](../../specs/2026-05-26-canonical-team-membership/plan.md)) |
| `/api/rag/[...path]` | `ui/src/app/api/rag/[...path]/route.ts` | `requireRbacPermission` for the parent capability + `requireResourcePermission` per datasource. Per-resource calls pass `bypassForOrgAdmin: true` (PR 1, 2026-05-27 fine-grained KB ReBAC plan) so org admins (`user:<sub> can_manage organization:<key>`) are always allowed on KB / Search / Data Sources / Graph / MCP Tools; set `RAG_ADMIN_BYPASS_DISABLED=true` to revert to pure per-resource checks. |
| `/api/rag/kb/[...path]` | `ui/src/app/api/rag/kb/[...path]/route.ts` | Same as `/api/rag/[...path]` — uses `bypassForOrgAdmin: true` for the per-KB gate (PR 1, 2026-05-27 fine-grained KB ReBAC plan). |
| `/api/rbac/kb-tab-gates` | `ui/src/app/api/rbac/kb-tab-gates/route.ts` | PR 2 of the 2026-05-27 fine-grained KB ReBAC plan. Returns `{search, data_sources, graph, mcp_tools, has_any_kb, kb_count}` so the Knowledge sidebar can render disabled-with-tooltip tabs. Org admins short-circuit to every tab `true` with `kb_count=-1`; non-admins get a count from the `/v1/datasources` list filtered by `knowledge_base:<id>#can_read`. |
| `/api/rag/kbs/[id]/sharing` | `ui/src/app/api/rag/kbs/[id]/sharing/route.ts` | PR 3 of the 2026-05-27 fine-grained KB ReBAC plan. `GET` returns the current shared-team slugs; `PUT` reconciles the slug list through `reconcileKnowledgeBaseRelationships` (writes new team grants, deletes ones that were unchecked). Gated by `knowledge_base:<id>#can_manage` with `bypassForOrgAdmin: true`. |
| `PUT /v1/mcp/custom-tools/<tool_id>` (proxied via `/api/rag/[...path]`) | `ui/src/app/api/rag/[...path]/route.ts` | PR 4 of the 2026-05-27 fine-grained KB ReBAC plan. After the RAG server returns 2xx the proxy reconciles `mcp_tool:<tool_id>` OpenFGA tuples (owner subject + owner team slug). The owner team slug, if present in the request body, is gated by `team:<slug>#can_use`. |
| `GET /v1/mcp/custom-tools` (proxied via `/api/rag/[...path]`) | `ui/src/app/api/rag/[...path]/route.ts` | PR 4 of the 2026-05-27 fine-grained KB ReBAC plan. Response is filtered to tools the caller has `mcp_tool:<id>#can_read` on. Org admins bypass via PR 1's super-grant. |
| `/api/rag/tools` | `ui/src/app/api/rag/tools/route.ts` | `requireRbacPermission(session, "rag", "tool.*")` |
| `/api/skill-hubs/*`, `/api/skill-hubs/[id]/refresh` | `ui/src/app/api/skill-hubs/...` | `requireBaselineAdminSurfaceRead(session, "skills")` / `requireAdminSurfaceManage(session, "skills")` |
| `/api/dynamic-agents/teams` | `ui/src/app/api/dynamic-agents/teams/route.ts` | `requireResourcePermission(session, { type: "organization", id: caipeOrgKey(), action: "manage" })` |
| `/api/chat/conversations/[id]/share` (PATCH/DELETE) | `ui/src/app/api/chat/conversations/[id]/share/route.ts` | `requireConversationResourcePermission(session, user.email, conversation, "share" | "manage")` |

This is the shape every route should reach over time.

### Category 4 — Hybrid Mongo + PDP (intentional)

A few admin routes still consult the `teams` collection or canonical `team_membership_sources` reader inline. These are **not** legacy holdouts; they're intentional, scoped to team-membership questions that the [`2026-05-26-canonical-team-membership`](../../specs/2026-05-26-canonical-team-membership/plan.md) refactor moved to a canonical Mongo store. The reader is `findUserRoleInTeam` in `ui/src/lib/rbac/team-membership-store.ts`, and it's used alongside a fall-through to organization-level PDP:

```ts
const canAdmin = await requireRbacPermission(session, "admin_ui", "admin").then(() => true, () => false);
const role = await findUserRoleInTeam(team.slug, { user_email: normalizeEmail(email) });
if (!canAdmin && role !== "admin") {
  throw new ApiError("You do not have permission …", 403);
}
```

This is the supported pattern until team-membership tuples themselves live in OpenFGA. Don't refactor these without coordinating with the canonical-team-membership migration.

---

## How to read an `audit_event_id` row

Every `requireRbacPermission()` and `requireResourcePermission()` call writes an audit row via `logAuthzDecision()` in `ui/src/lib/rbac/audit.ts`. Rows are emitted to audit-service, which owns local/S3 storage, and the structured Next.js log.

A typical allow row looks like:

```json
{
  "subject_hash": "sha256:9accc8a00ffe…",
  "capability": "system_config:platform_settings#read",
  "outcome": "allow",
  "reason_code": "OK",
  "pdp": "openfga",
  "email": "viewer@example.com",
  "tenantId": "default",
  "audit_event_id": "ae_2026-05-27T06:26:14.082Z_…"
}
```

Useful filters when troubleshooting:

- **Route-specific capabilities** such as `self_profile#read`, `chat#invoke`, and `feedback#submit` identify the surface that performed the check. If an audit row is too generic, add a route-specific entry to `resolveLegacyWithAuthRbacPolicy()`.
- **`pdp: openfga` vs `pdp: keycloak`** — `keycloak` only appears as a fallback when OpenFGA returned `DENY_NO_CAPABILITY` and the route still wants to consult Keycloak Authorization Services. If you see a route consistently using `keycloak`, its target relation is missing from the OpenFGA model.
- **`reason_code: DENY_PDP_UNAVAILABLE`** means OpenFGA returned an error. The user gets a 503, not a 403. Treat it like an SLO incident, not a policy bug.

---

## How this audit was produced

To re-run from a clean clone:

```bash
# 1. List every production route file that touches a role/admin pattern.
rg -l 'requireAdmin|isAdmin\(|userRole|getUserRole|session\.role\s*===\s*.admin|role:\s*.admin' \
   ui/src/app/api --type ts -g '!**/__tests__/**' -g '!**/*.test.ts'

# 2. List routes whose only auth line is withAuth (Category 2 candidates).
for f in $(rg -l '' ui/src/app/api --type ts -g 'route.ts' -g '!**/__tests__/**'); do
  if ! rg -q 'requireRbacPermission|requireResourcePermission|requireAdmin|withOpenFga|requireAdminSurface' "$f"; then
    echo "  $f"
  fi
done

# 3. For each candidate, confirm whether withAuth or getAuthFromBearerOrSession is present.
#    If neither, the route is genuinely ungated and that IS a bug.
```

When you add a new `/api/*` route:

1. Pick the smallest `require*Permission` helper that matches user intent. Resource-scoped is best.
2. If the route falls back to `withAuth`, add an explicit entry in `resolveLegacyWithAuthRbacPolicy` rather than relying on the admin UI fallback.
3. Add a route test that mocks `checkOpenFgaTuple` and asserts the relation that was requested. The pattern is in `ui/src/lib/__tests__/api-middleware.test.ts` under `withAuth › legacy RBAC policy resolution`.
4. Append a row to the right table in this audit doc.

---

## Related

- [Architecture — UI section](./architecture.md) — bigger picture of the BFF tier and where this audit fits.
- [JWT and OpenFGA](./jwt-and-openfga.md) — how identity is carried from Keycloak through to the PDP.
- [OpenFGA Permission Evaluation](./openfga-permission-evaluation.md) — what actually happens inside an OpenFGA `check`.
- [Roles vs Scopes](./roles-scopes-comparison.md) — the model the resolver maps URLs into.
- [Feasibility — Remote PDP options](./feasibility-pdp-options.md) — why we picked OpenFGA for the data plane in the first place.
- [`2026-05-27-fine-grained-rbac-for-withauth-routes` plan](../../specs/2026-05-27-fine-grained-rbac-for-withauth-routes/plan.md) — migration path for Category 2.
- [`2026-05-26-canonical-team-membership` plan](../../specs/2026-05-26-canonical-team-membership/plan.md) — context for the Category 4 hybrid pattern.
