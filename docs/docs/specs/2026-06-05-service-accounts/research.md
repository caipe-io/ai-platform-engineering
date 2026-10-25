# Phase 0 Research: Service Accounts

All items below were verified against the current codebase (not assumed). Each is a decision with
rationale and the evidence that grounds it.

## R-1 — OpenFGA identity & ownership model

**Decision**: Reuse the existing `service_account` OpenFGA type as the SA identity. Add an ownership
relation:
```
type service_account
  relations
    define owner_team: [team#member]
    define can_manage: owner_team
```
SA access grants reuse existing patterns: `service_account:<sub> can_use agent:<id>` and
`service_account:<sub> can_call tool:<server>/<tool>` (+ `tool:<server>/*` wildcard).

**Rationale**: Slack/Webex bots are already modeled as `service_account` subjects; these new
user-minted accounts are the same kind of identity with self-service management. `service_account`
is subject-only today, so adding relations is purely additive.

**Evidence**: `deploy/openfga/model.fga:29` (`type service_account`, no relations). `tool` type
(`model.fga:199-211`) — `caller` relation already lists **both** `user` and `service_account`, so
caller-keyed tool grants/checks need no model change. Subject convention confirmed in
`ui/src/lib/rbac/resource-authz.ts:147-155`.

**Alternatives rejected**: New `bot_account` type — more model churn and a second machine-identity
concept for no functional gain (Kevin/Erik decision).

## R-2 — Credential: dynamic Keycloak client per SA

**Decision**: Each SA is a dynamically-created Keycloak **confidential client** with
`serviceAccountsEnabled: true`. One client = one credential. The credential shown once = the Keycloak
`client_id` + `client_secret`. Rotation = regenerate the client secret. Revoke = delete the client.
No multi-token, no expiry in v1.

**Rationale**: "Work with Keycloak as it's meant to be." The SA is a first-class identity with its
own real JWT (client-credentials grant) — identical in kind to how Slack/Webex authenticate, just
created at runtime instead of statically in realm JSON.

**Evidence (capability verified)**:
- Admin client `caipe-platform` already holds `realm-management` role **`manage-clients`** —
  `charts/ai-platform-engineering/charts/keycloak/realm-config.json:719-735`. Sufficient to
  create/regenerate/delete clients.
- Existing admin plumbing to mirror: `ui/src/lib/rbac/keycloak-admin.ts` — `adminFetch` (l.215),
  `assertOk` (l.241), `getAdminToken` (l.192, client_credentials), `getClientByClientId` (l.845),
  and an existing `GET /clients/{id}/service-account-user` call (l.1324-1332).
- Client shape to mirror: `caipe-slack-bot` — `realm-config.json:164-187` (publicClient:false,
  serviceAccountsEnabled:true, standardFlowEnabled:false, directAccessGrantsEnabled:false).

**Net-new code (none exists today)**: `createServiceAccountClient`, `regenerateClientSecret`,
`deleteServiceAccountClient` in `keycloak-admin.ts`. Keycloak REST: `POST /clients`,
`POST /clients/{id}/client-secret`, `DELETE /clients/{id}`, `GET /clients/{id}/service-account-user`.

**Alternatives rejected**: opaque token + Mongo hash (catalog-api-keys style) → wouldn't give a real
SA JWT for downstream MCP checks. BFF-signed JWT → second issuer to trust. Token-as-Keycloak-secret
with N tokens → fights Keycloak's one-secret-per-client model and fragments identity.

## R-3 — Subject identity = JWT `sub` (no mapping table)

**Decision**: The OpenFGA subject id IS the Keycloak service-account-user `sub` (UUID). At create
time we read it back from `GET /clients/{id}/service-account-user` and write all tuples as
`service_account:<sub>`. Mongo stores the friendly name + client_id + sub for display.

**Rationale**: Zero translation layer; reuses the existing `service_account:${sub}` convention so the
same value works at every enforcement layer.

**Evidence**: BFF detection + namespacing already exists —
`ui/src/lib/jwt-validation.ts:243-249` sets `isServiceAccount` from
`preferred_username.startsWith('service-account-')`; `api-middleware.ts:476-493` propagates it into
the session; `resource-authz.ts:147-155` yields `service_account:${sub}`. So **BFF-layer authz
already works for SAs with no change.**

### FINALIZED (T002) — the single canonical service-account detection rule

> **Rule: a token is a service account iff its `preferred_username` claim starts with
> `service-account-`.** All three enforcement layers MUST use exactly this rule so a given token
> namespaces identically everywhere:
>
> | Layer | File | Status |
> |-------|------|--------|
> | BFF | `ui/src/lib/jwt-validation.ts` | ✅ already implements it (no change) |
> | DA backend (WS-G / T018) | `dynamic_agents/.../auth/openfga_authz.py` | must adopt it |
> | AGW bridge (WS-F / T020) | `deploy/openfga/bridge/main.py` | must adopt it |
>
> Subject id when SA → `service_account:<sub>`; otherwise `user:<sub>` (`<sub>` = JWT `sub`).
>
> **Why `preferred_username`, not `client_id`/`azp`** (this supersedes the R-6 provisional lean
> toward `client_id`):
> 1. **Zero BFF churn / already proven.** The BFF path uses it today and works; matching it
>    guarantees the three layers agree rather than introducing a second signal that could disagree
>    on an edge token.
> 2. **Guaranteed by Keycloak.** A confidential client with `serviceAccountsEnabled` always issues
>    its client-credentials tokens with `preferred_username = service-account-<clientId>`. Human
>    users never have a `preferred_username` in that namespace.
> 3. **`azp`/`client_id` is less reliable as the *primary* signal** — the bearer claim is `azp` in
>    standard Keycloak access tokens (a literal `client_id` claim depends on a protocol-mapper), and
>    `azp` is also present on interactive-user tokens (it names the client the user logged in
>    through), so it does not by itself distinguish a service account from a user.
>
> **Corroboration only:** layers MAY additionally read `azp`/`client_id` for logging, but the
> allow/deny namespacing decision keys on `preferred_username` alone.
>
> **Helper:** both Python layers should share one tiny predicate, e.g.
> `is_service_account(payload) -> bool: return str(payload.get("preferred_username", "")).startswith("service-account-")`,
> and build the subject as `f"service_account:{sub}"` vs `f"user:{sub}"`. Both `openfga_authz.py`
> (T018) and `bridge/main.py` (T020) already decode the full validated JWT payload, so
> `preferred_username` is available with no extra token work.

## R-4 — Call path: all traffic via BFF; SA JWT forwarded downstream

**Decision**: External callers present the SA's client-credentials JWT to the BFF `/api/v1/chat/*`
routes (same entry as browser + Slack/Webex). The BFF forwards the original JWT to the DA backend.

**Evidence**: `ui/src/lib/da-proxy.ts` — `authenticateRequest` reads `session.accessToken` (the
original bearer, l.106) and `buildBackendHeaders` forwards it as `Authorization: Bearer` (l.206-208).
DA backend is ClusterIP-only (verified earlier), so BFF is the only ingress. No opaque-token path
needed.

## R-5 — DA backend subject namespacing (BUG — must fix, WS-G)

**Decision**: Fix `_check_agent_use` to namespace SA subjects.

**Problem found**: `ai_platform_engineering/dynamic_agents/.../auth/openfga_authz.py:304-321`
hardcodes `"user": f"user:{subject}"`. An SA's forwarded JWT would be checked as
`user:<sub> can_use agent:<id>` and **denied**, because SA grants are `service_account:<sub> ...`.
The DA backend has **no** `isServiceAccount` detection today (the flag lives only in the BFF session
and never crosses to DA).

**Fix**: In the DA backend, detect service-account tokens from the validated JWT (via
`preferred_username` starting `service-account-`, or the `client_id` claim) and build
`service_account:<sub>` for those; keep `user:<sub>` for interactive users. Add pytest coverage.

## R-6 — Caller-keyed tool authorization (in-scope fix, WS-F)

**Decision**: Add a caller-keyed `<subject> can_call tool:<server>/<tool>` check to the bridge,
ANDed with the existing `agent:<id> can_call tool:...` check. Applies to both `user` and
`service_account` subjects (FR-012a/b).

**Evidence**: `deploy/openfga/bridge/main.py:595` builds `user = f"user:{sub}"` (hardcoded);
l.618-630 check `user→agent` then `agent→tool` — **no caller→tool check exists**. The bridge decodes
the JWT (`_decode_verified_bearer_subject`, l.321-345) but keeps only `sub`; it can additionally read
`client_id` to namespace the subject. Model already allows both subjects on `tool#caller` (R-1) — no
model change. Tests to mirror: `test_tools_call_requires_user_agent_and_agent_tool_grants` and
`test_tools_call_denies_when_agent_tool_grant_is_missing` (`test_grpc_bridge.py:247-321`). New deny
reason code `DENY_CALLER_TOOL` following the existing `_audit_decision` pattern.

**Consistency note**: BFF uses `preferred_username`, the bridge will use `client_id`. WS-F and WS-G
must apply the **same** service-account-detection rule so a given token namespaces identically at
every layer. Recommendation: prefer `client_id` presence as the canonical signal (present on all
client-credentials tokens), with `preferred_username` as corroboration; finalize in tasks.

### COARSE-GATE FIX (discovered during T020/T028 — `mcp_gateway.caller`)

Once the bridge namespaces SA subjects as `service_account:<sub>`, the **coarse**
ext_authz gate — `_check_openfga(<subject>, can_call, mcp_gateway:list)`, run on EVERY request before
the tool-specific checks — applies to SAs too. Unlike `tool#caller`, the `mcp_gateway.caller` relation
was `[user]` ONLY, so:
1. an SA would always fail the coarse gate (no baseline), and
2. the baseline tuple **could not even be written** — OpenFGA rejects
   `service_account:<sub> caller mcp_gateway:list` with
   `type 'service_account' is not an allowed type restriction for 'mcp_gateway#caller'`.

**Fix (additive, applied):** add `service_account` to `mcp_gateway.caller` in `deploy/openfga/model.fga`
and `charts/.../authorization-model.json` (mirrors how humans hold the baseline `caller mcp_gateway:list`
via `baseline-access.ts`). The SA equivalent is written at **create** time and removed on **revoke**
(`ui/src/app/api/admin/service-accounts/route.ts` + `[id]/route.ts`). Humans get the baseline from the
login/bootstrap reconciler; SAs never log in, so the create route writes it explicitly. Without this,
quickstart S1 (create) fails at the OpenFGA write and S4/S5 (external call) fail the coarse gate.

## R-7 — UI placement & gating (RESOLVED — T001)

**Finding**: The admin page (`ui/src/app/(app)/admin/page.tsx`) uses a two-level Radix tab system;
the "Settings" category is the right home for a "Service Accounts" sub-tab. Tabs are gated via
`tabGateValues` and the page is fronted by `useAdminRole()` (`canViewAdmin`/`isAdmin`).

**Tension**: Spec says self-service for **any team member** (not admin-only). So the tab's visibility
must key on "user belongs to ≥1 team," not `isAdmin`.

**Decision (FINAL, T001)**: Mount a `service-accounts` sub-tab under the **Settings** category in
`ui/src/app/(app)/admin/page.tsx` `CATEGORIES`. Gate it on **team membership** (user belongs to ≥1
team), **NOT `isAdmin`**. Real control is per-action owning-team authorization on every BFF route
(`can_manage` / membership checks), exactly as the rest of the feature already enforces.

**Verified during T001** (no longer "provisional"):
- **Non-admins already reach the admin page.** `admin/page.tsx` is wrapped only in `<AuthGuard>`
  (authentication, not admin role) — `page.tsx:3228-3232`. `useAdminRole` docstring + behaviour
  confirm: *"All authenticated users can view the Admin dashboard (read-only)."* `isAdmin` only
  gates write affordances (Create Team button, role edits, simulation "View as", `ai_review`). So
  **no page-level gating change is needed** — a non-admin team member can already land here.
- **Tab visibility is data-driven** via `tabGateValues[gateKey]` (`page.tsx:496-523`), fed by
  `gates` from `GET /api/rbac/admin-tab-gates`. A category/tab renders iff its `gateKey` is `true`.
- **A non-admin, resource-scoped gate precedent already exists.** `hasResourceScopedIntegrationAccess`
  (`admin-tab-gates/route.ts`) turns the **Slack/Webex** tabs `true` for non-admins who can_manage
  ≥1 channel/space — i.e. visibility keyed on resource relationship, not org-admin. Service Accounts
  follows the identical pattern: visible to anyone who belongs to ≥1 team.

**Gate mechanism (for T014 to implement)**:
1. Add gate key `service_accounts` to `AdminTabKey`/`AdminTabGatesMap` (`ui/src/lib/rbac/types.ts`),
   to `EMPTY_GATES` + the dev-auth `allAdminTabGates` set (`useAdminTabGates.ts`), and to `ALL_TABS`
   in `admin-tab-gates/route.ts`.
2. In `admin-tab-gates/route.ts`, compute `service_accounts = (member of ≥1 team)` for the current
   subject — derive via `listOpenFgaObjects(user:<sub>, member, team)` (length ≥ 1) using the same
   `ui/src/lib/rbac/openfga.ts` helper the grantable/TeamPicker paths use. Fail-closed on error.
   This is a **non-admin, resource-scoped** gate (mirror `hasResourceScopedIntegrationAccess`), NOT
   an org-admin `hasAdminSurfaceManage` check.
3. Register the tab in `CATEGORIES` under `key: 'settings'`:
   `{ value: 'service-accounts', label: 'Service Accounts', icon: Bot, gateKey: 'service_accounts' }`,
   add `'service-accounts'` to `VALID_TABS`, and render its `<TabsContent>` guarded by
   `tabGateValues.service_accounts` (no `isAdmin` conditioning).

**Rejected**: gating on `isAdmin` (contradicts FR self-service-for-any-team-member); a separate
non-admin settings surface outside `/admin` (unnecessary — the admin page is already non-admin
reachable, and Settings is the documented home for identity settings).

**Reusable components verified**: `Tabs`, `Dialog`, `CopyButton`, `TeamPicker`
(`ui/src/components/ui/team-picker.tsx`), `SecretValueDialog`
(`ui/src/components/credentials/`), and the fetch/`{success,data,error}` pattern
(`PlatformSettingsTab.tsx`). Grantable resources: `/api/dynamic-agents/available` (agents) and the
team-resources endpoint expose `available.tools`; the SA grantable list (WS-D) will use OpenFGA
`listOpenFgaObjects` for `user:<sub>` to be authoritative.

## R-8 — Grantable-set derivation (FR-006/007/009)

**Decision**: UI picker = `listOpenFgaObjects(user:<sub>, can_use, agent)` and the tool equivalent,
so only what the user holds is offered. Every write re-runs `checkOpenFgaTuple(user:<sub>, …)`
(FR-008). `ui/src/lib/rbac/openfga.ts` provides `listOpenFgaObjects`, `checkOpenFgaTuple`,
`writeOpenFgaTuples` — all reused, none net-new.

## R-9 — Coarse `mcp_gateway:list` gate baseline for service accounts (BUG — must fix)

**Decision**: Service accounts need an EXPLICIT `service_account:<sub> caller mcp_gateway:list`
tuple, written at create and removed at revoke — AND the OpenFGA model must allow
`service_account` on `mcp_gateway#caller` (currently `[user]` only).

**Problem found** (investigation, task #28):
- The bridge's ext_authz entry point runs a COARSE gate for EVERY caller before any per-tool
  check: `deploy/openfga/bridge/main.py:648` → `_check_openfga(user, "can_call", "mcp_gateway:list")`.
  If this returns false, the request is denied (`DENY_NO_CAPABILITY`) and the per-tool / caller-keyed
  checks at l.650+ never run. This applies to `service_account:<sub>` subjects too; the bridge has
  no subject bypass or service-account exemption from the coarse gate.
- **Humans get this baseline via a per-USER tuple, not team inheritance**:
  `memberBaselineGrantDefinitions()` (`ui/src/lib/rbac/baseline-access.ts:136-140`) defines
  `user:<sub> caller mcp_gateway:list`, written by `repairCurrentUserBaseline` on every admin-page
  load / `baselineBootstrapTuples`. Service accounts NEVER log into the BFF, and their `owner_team`
  carries no `mcp_gateway` grant — so they have **no path** to this tuple.
- **The model also blocks it**: `mcp_gateway#caller` is `[user]` only (`model.fga:203-206`;
  `authorization-model.json:1976-1982`). Even an explicit `service_account:<sub>` tuple would fail to
  write/resolve until `service_account` is added to that relation.

**Net effect without the fix**: every SA tool call (quickstart S4/S5) is denied at the coarse gate
even with perfectly correct agent/tool scopes. Silent — the deny reason is the generic
`DENY_NO_CAPABILITY`, not a scope error.

**Fix (split across two owners)**:
- **Model (WS-A / implementer-a)**: `mcp_gateway.caller: [user, service_account]` in
  `deploy/openfga/model.fga`, recompiled into `authorization-model.json` + re-seeded.
- **BFF (WS-D / implementer-b, DONE)**: create route writes `service_account:<sub> caller
  mcp_gateway:list` alongside owner_team + scopes; revoke route deletes it with the rest. Create +
  rotate-revoke Jest tests assert the tuple is written/removed. `ui/src/app/api/admin/service-accounts/route.ts`
  + `.../[id]/route.ts`.

**Verify**: quickstart S4 on the live stack — an SA with a granted agent+tool should now pass the
coarse gate and the per-tool check. Coordinated with testing-manager.

## Resolved risks summary

| Risk (from working notes) | Status |
|---|---|
| Keycloak admin can create clients? | ✅ Yes — `caipe-platform` has `manage-clients` |
| SA JWT validates + namespaces at BFF? | ✅ Yes — existing `isServiceAccount` path |
| DA agent-use check works for SA? | ❌ No — hardcoded `user:` → **WS-G fix required** |
| `.fga`→JSON model change for caller fix? | ✅ Not needed — `tool#caller` already allows both |
| Caller-keyed tool check exists? | ❌ No — **WS-F adds it** |
| UI self-service vs admin-gated? | ⚠️ Open — R-7, resolve in tasks |
| SA passes coarse `mcp_gateway:list` gate? | ❌ No — **R-9: model change (`mcp_gateway#caller` += `service_account`) + create/revoke baseline tuple required** |
