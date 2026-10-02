# Feature Specification: Admin Users List Performance — Quick Wins

**Feature Branch**: `main` (small, surgical changes — no new branch)
**Created**: 2026-05-26
**Status**: Draft — quick wins only; deeper architectural fix tracked separately
**Input**: User question (paraphrased from session):
> *"Are we lazy loading users from mongodb when we launch caipe-ui admin page? When there are 1000+ users the admin loading is extremely slow."*

## One-sentence summary

Cut the first-paint cost of the CAIPE admin page by removing one dead Keycloak round-trip from `loadAdminData()` and dropping the N+1 per-user role-mapping call out of the `/api/admin/users` list endpoint, so the table list path uses one Keycloak call per page instead of `1 + pageSize` calls.

## Problem Context

Users live in **Keycloak**, not MongoDB. The CAIPE UI talks to Keycloak's Admin REST API through `/api/admin/users`. With 1000+ realm users the admin page can take several seconds to first paint. Investigation pinpointed three independent issues, only the first two of which are quick wins.

### Problem 1 — `loadAdminData()` fetches `/api/admin/users` then throws the result away

`ui/src/app/(app)/admin/page.tsx::loadAdminData()` runs on first mount regardless of which tab the user lands on, and includes `fetch('/api/admin/users')` in its `Promise.all`. The response is destructured into `usersResponse` and **never read** anywhere else in the file. That single call costs:

- 1 × Keycloak `GET /users?first=0&max=20`
- 20 × Keycloak `GET /users/{id}/role-mappings/realm` (one per user; see Problem 2)
- 1 × Keycloak `GET /users/count`

…on the critical path of every admin page load, for a value that is immediately discarded.

### Problem 2 — `/api/admin/users` enriches every row with a per-user role lookup

`enrichListRow()` calls `listRealmRoleMappingsForUser(id)` for every user in the page. For `pageSize=20` that's 20 extra round-trips to Keycloak Admin REST per request (run in parallel via `Promise.all`, but still 20 connections and 20 Keycloak handler invocations). Nothing in the UI list table reads the resulting `roles` / `raw_roles` / `role_classifications` / `hidden_role_count` fields — they are computed and shipped over the wire but never displayed.

Consumers of `/api/admin/users` and what they actually read:

| Caller | Reads roles fields? |
|---|---|
| `UserManagementTab` (Users tab table) | **No** — only `id`, `username`, `email`, `firstName`, `lastName`, `enabled`, `attributes`, `slack_link_status`, `webex_link_status` |
| `loadAdminData` in admin page | **No** — response is discarded |
| `CreateTeamDialog` member picker | **No** |
| `TeamDetailsDialog` add-member typeahead | **No** |
| `RebacGraphFilters` user search | **No** |
| `OpenFgaRebacTab` user search | **No** |
| Impersonation user search (separate endpoint) | **No** |

The only thing that reads the role fields is the route's own Jest test. The user **detail** modal/panel fetches roles separately via `/api/admin/users/[id]/roles` and `/api/admin/users/[id]/role` — those endpoints are unchanged.

### Problem 3 — Filtered scan path is O(realm) (NOT addressed in this spec)

When any filter is set (role, team, idp, slack/webex), the route falls into a "scan the whole realm in batches of 100" loop, and for the `idp` filter case does one `getUserFederatedIdentities(id)` call per user. That is real, but the fix is structural (mirror Keycloak users into MongoDB on a webhook/poll). Tracked separately.

### What is explicitly NOT changed here

- No Mongo mirror, no background sync, no schema changes.
- No new env vars, no Helm changes.
- No change to `/api/admin/users/[id]/...` endpoints used by the user detail panel.
- No change to authorization or RBAC gates on the route.
- The wire shape of the `/api/admin/users` list response remains the same.

## Goal

After these changes, the first paint of `/admin` issues exactly **one** Keycloak `GET /users` and **one** `GET /users/count` for the Users tab (which only mounts when selected), and **zero** Keycloak calls related to users when an admin lands on any other tab (Settings, OpenFGA, Skills, etc.).

The list endpoint stops fanning out to N role-mapping calls per page. Callers that need a user's roles continue to use the per-user detail endpoint (`/api/admin/users/[id]/roles`), which is unchanged.

## User Scenarios & Testing *(mandatory)*

### Scenario 1 — Admin opens `/admin` with 1000+ realm users

**Before:** First paint blocked on `loadAdminData()`'s `Promise.all`, which fans out to a useless `/api/admin/users` call that takes 20–50 Keycloak round-trips depending on enrichment depth. Observed wall-clock: multiple seconds before the first card renders.

**After:** `loadAdminData()` no longer fetches `/api/admin/users`. Settings, OpenFGA, Skills, and other tabs render with zero Keycloak-user round-trips. The Users tab still lazy-loads its own data on first mount via `UserManagementTab`.

### Scenario 2 — Admin clicks the Users tab

**Before:** `UserManagementTab` fetches `/api/admin/users?page=1&pageSize=20`, which costs 1 list call + 1 count call + 20 role-mapping calls + 1 nonces call ≈ ~23 Keycloak/Mongo round-trips.

**After:** Same fetch, but the role-mapping fan-out is gone. Cost drops to 1 list + 1 count + 1 nonces ≈ 3 round-trips. Same data is displayed (role fields are not rendered in this table).

### Scenario 3 — Admin opens a user detail row

**Before:** Per-user role data was already loaded by the list call (and then never displayed) and re-fetched separately by the detail panel on click.

**After:** Detail panel still fetches per-user roles via the existing `/api/admin/users/[id]/roles` endpoint. No regression; just no longer doing redundant work in the list endpoint.

### Scenario 4 — Caller explicitly wants roles in the list

A `?includeRoles=true` query parameter on `/api/admin/users` re-enables the legacy per-user enrichment. This preserves the wire shape's role fields for any out-of-tree consumer that may exist and keeps the existing unit-test assertions valid by passing the flag in tests that assert on `roles` / `raw_roles` / `role_classifications`.

The flag is **off by default**.

### Acceptance Criteria

1. Loading `/admin` on the Settings tab (the default landing tab for admins) issues **zero** requests to `/api/admin/users`.
2. Loading `/admin?cat=people&tab=users` issues exactly one request to `/api/admin/users?page=1&pageSize=20` and that request makes exactly **two** Keycloak round-trips (`GET /users`, `GET /users/count`) plus at most one MongoDB call (`slack_link_nonces`).
3. The Users table renders identically to before (name, email, teams, IdP, Slack badge, Webex badge, enabled dot).
4. The User Detail modal still shows realm roles, scope grants, and team memberships.
5. `/api/admin/users` with no `includeRoles` flag returns rows that omit `roles`, `raw_roles`, `role_classifications`, and `hidden_role_count`. With `includeRoles=true` it returns the previous shape unchanged.
6. All existing tests pass; tests that previously asserted on `roles` are updated to pass `?includeRoles=true`.

## Implementation

### Change 1 — Delete the dead `/api/admin/users` fetch from `loadAdminData`

`ui/src/app/(app)/admin/page.tsx`:
- Remove `fetch('/api/admin/users')` from the `Promise.all` in `loadAdminData()`.
- Remove the `usersResponse` slot from the destructure on line ~922 and the unused JSON parse.
- No other change in this file; `UserManagementTab` is already inside `<TabsContent value="users">` which only mounts when selected.

### Change 2 — Make role enrichment opt-in on the list endpoint

`ui/src/app/api/admin/users/route.ts`:
- Parse `includeRoles` from the query string (`?includeRoles=true|1` → `true`, anything else → `false`).
- Split `enrichListRow` into a cheap base mapper (no Keycloak call) and the existing rich enricher. The base mapper returns `id`, `username`, `email`, `firstName`, `lastName`, `enabled`, `attributes`, `slack_link_status`, `webex_link_status` only.
- When `includeRoles` is false (the default), both the non-scan and scan code paths use the base mapper.
- When `includeRoles` is true, behaviour is unchanged from today.
- The `scoped: "self"` fallback for non-admin viewers keeps the legacy rich shape (one user, one call — negligible cost).

### Change 3 — Update tests

`ui/src/app/api/__tests__/admin-users.test.ts`:
- The case that asserts on `roles`, `raw_roles`, and `role_classifications` is updated to fetch with `?includeRoles=true`.
- Add a new case asserting that the default call (no `includeRoles`) omits those fields and does **not** invoke `listRealmRoleMappingsForUser`.

`ui/src/app/(app)/admin/__tests__/admin-page.test.tsx`:
- A unit test asserts that on initial admin page load with the default tab, `global.fetch` is **not** called with `/api/admin/users`.

## Out of scope (deferred, tracked separately)

- Mirroring Keycloak users into MongoDB and serving the list out of Mongo. This is the real fix for >2k user realms but requires a sync source (webhook or poller) and proper indexing. It will be its own spec.
- Batching role-mappings or federated-identity lookups. Keycloak Admin REST has no bulk endpoint for `role-mappings`; a true batch path requires either group-membership-based denormalisation or the Mongo mirror above.
- Removing the per-user `getUserFederatedIdentities` call inside the scan-filter path. Requires the Mongo mirror.

## Risk and rollback

Risk is low. The wire shape with `?includeRoles=true` is byte-for-byte identical to today. The wire shape without the flag drops four fields that no UI consumer reads. If an out-of-tree script breaks, the rollback is a one-line change: invert the default of `includeRoles` to `true`.

## Files touched

- `ui/src/app/(app)/admin/page.tsx` — remove dead fetch (~3 lines).
- `ui/src/app/api/admin/users/route.ts` — split enricher, add `includeRoles` parse (~20 lines).
- `ui/src/app/api/__tests__/admin-users.test.ts` — adjust one test, add one test (~30 lines).
- `ui/src/app/(app)/admin/__tests__/admin-page.test.tsx` — add one test (~15 lines).
- `docs/docs/specs/2026-05-26-admin-users-list-perf-quick-wins/spec.md` — this file.
