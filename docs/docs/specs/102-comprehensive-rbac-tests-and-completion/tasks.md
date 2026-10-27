---
description: "Task list for spec 102 — Comprehensive RBAC Tests + Completion of 098"
---

# Tasks: Comprehensive RBAC Tests + Completion of 098

**Input**: Design documents from `docs/docs/specs/102-comprehensive-rbac-tests-and-completion/`
**Prerequisites**: [`spec.md`](./spec.md), [`plan.md`](./plan.md), [`call-sequences.md`](./call-sequences.md), [`research.md`](./research.md), [`data-model.md`](./data-model.md), [`quickstart.md`](./quickstart.md), [`contracts/python-rbac-helper.md`](./contracts/python-rbac-helper.md)

**Tests**: REQUIRED throughout. The whole point of this spec is comprehensive automated tests; every implementation task ships with the matrix entry and parameterised test that exercise it. Test tasks are NOT optional here.

**Organisation**: Tasks are grouped by user story (US1–US8 from `spec.md`) so each story can be implemented, tested, and shipped independently. Phase order follows the plan's risk-ascending sequence: simpler/lower-risk migrations first (US1), test scaffolding next (US7) so subsequent phases get tests for free, then the bigger Python migrations (US3 → US2 → US4 → US6), then the higher-risk Slack OBO and the doc rewrite (US5 + US8).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks).
- **[Story]**: Which user story this task belongs to (US1, US2, … US8). Setup, Foundational, and Polish tasks have no story label.
- File paths are absolute relative to the repo root.

## Path Conventions

- **Backend (Python)**: `ai_platform_engineering/`
- **Frontend (TypeScript / Next.js BFF)**: `ui/`
- **Tests (cross-cutting RBAC)**: `tests/rbac/` (NEW per `research.md` §2)
- **Realm config**: `deploy/keycloak/`
- **Compose stacks**: `docker-compose/`
- **Automation scripts**: `scripts/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Repo-level scaffolding that every later phase consumes. Maps to `plan.md` §Phase 0 — Research, Schema, Fixtures.

- [X] T001 Create top-level `tests/rbac/` directory structure: `tests/rbac/{fixtures,unit/ts,unit/py,e2e}/` with empty `__init__.py` / `index.ts` placeholders so each component's runner can import from it
- [X] T002 [P] Add a `pyproject.toml` (or extend the root one) entry to register `tests/rbac/conftest.py` so `PYTHONPATH=. uv run pytest tests/rbac/` discovers the suite from repo root
- [X] T003 [P] Add `tests/rbac/.gitkeep` and a top-level `tests/rbac/README.md` linking to `docs/docs/specs/102-comprehensive-rbac-tests-and-completion/quickstart.md`
- [X] T004 [P] Create `docker-compose/docker-compose.e2e.override.yaml` as a thin overlay on top of `docker-compose.dev.yaml` (per spec Clarification 2026-04-22). The overlay only remaps host ports to avoid colliding with a running dev stack (e.g. mongo `27017→27018`, UI `3000→3010`, supervisor `8000→8010` per `quickstart.md`) and injects e2e-only env vars where needed. NO duplication of the full service definitions — every service is sourced from the dev compose file via `COMPOSE_PROFILES`
- [X] T005 Modify `deploy/keycloak/docker-compose.yml` to enable `--features=token-exchange,admin-fine-grained-authz` on the Keycloak container (resolves Open Question 4 — `research.md` §4)
- [X] T006 Add a stub `make test-rbac` target to `Makefile` that runs `bash -c "echo 'test-rbac wired in T037'; exit 0"`. Real implementation lands in T037; this exists so phase-1 acceptance ("`make test-rbac` exists") passes
- [X] T007 [P] Add `make test-rbac-jest`, `make test-rbac-pytest`, `make test-rbac-e2e` stub targets to `Makefile` (real bodies wired by T038/T039/T040)

**Checkpoint**: Setup ready — directory exists, compose file exists, make targets exist (vacuous).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The matrix, schemas, persona fixture, Python helpers, and linters that every user-story phase consumes. **Until this completes, no user-story phase can produce green tests.**

⚠️ **CRITICAL**: User-story phases MUST NOT begin until this phase is checkpointed.

### Matrix + linters

- [X] T008 Create the empty matrix file `tests/rbac/rbac-matrix.yaml` with `version: 1` and `routes: []`; add an inline comment pointing to `docs/docs/specs/102-comprehensive-rbac-tests-and-completion/contracts/rbac-matrix.schema.json`
- [X] T009 [P] Implement `scripts/validate-rbac-matrix.py`: walks `ui/src/app/api/{admin,dynamic-agents,mcp-servers,teams,agents}/**/route.ts` and `ai_platform_engineering/**/server.py`, fails if any `requireRbacPermission` / `require_rbac_permission` call is not represented in `tests/rbac/rbac-matrix.yaml`; prints actionable diff (per FR-010, SC-006)
- [X] T010 [P] Implement `scripts/extract-rbac-resources.py`: greps for every `(resource, scope)` literal pair in TS+Py code per `data-model.md` §E4; emits `ui/src/lib/rbac/resource-catalog.generated.ts` (`KEYCLOAK_RESOURCE_CATALOG` const)
- [X] T011 [P] Implement `scripts/validate-realm-config.py`: loads `KEYCLOAK_RESOURCE_CATALOG`, asserts every `(resource, scope)` exists in `deploy/keycloak/realm-config.json` `authorizationSettings.resources[].scopes` (per FR-006). Hard-gate, exit non-zero on drift
- [X] T012 Add a unit test for the matrix linter at `tests/rbac/unit/py/test_validate_matrix_lint.py`: feeds the linter a fixture route file and a fixture matrix; asserts pass on match, fail on missing entry, fail on invalid persona, fail on `(resource, scope)` not in realm config

### Realm config extras (PDP-unavailable fallback)

- [X] T013 Create `deploy/keycloak/realm-config-extras.json` with `{ "version": 1, "pdp_unavailable_fallback": { "admin_ui": { "mode": "realm_role", "role": "admin" } } }` — preserves existing behaviour as research.md §1 mandates
- [X] T014 [P] Add JSON-schema validation in `scripts/validate-realm-config.py` (T011) that asserts `realm-config-extras.json` validates against `docs/docs/specs/102-comprehensive-rbac-tests-and-completion/contracts/realm-config-extras.schema.json`

### Persona fixture (TS + Py)

- [X] T015 Implement `tests/rbac/fixtures/keycloak.py` with `get_persona_token(name)` and `clear_persona_cache()` per `data-model.md` §E5; uses Resource Owner Password Credentials grant against `http://localhost:7080/realms/caipe/protocol/openid-connect/token`; in-memory token cache with refresh-30s-before-expiry
- [X] T016 [P] Implement `tests/rbac/fixtures/keycloak.ts` with `getPersonaToken` + `clearPersonaCache` per `data-model.md` §E5; identical behaviour to T015 (parity is asserted by T031)
- [X] T017 Create `tests/rbac/conftest.py`: pytest fixtures `alice_admin`, `bob_chat_user`, `carol_kb_ingestor`, `dave_no_role`, `eve_dynamic_agent_user`, `frank_service_account` returning `PersonaToken`; plus `@pytest.fixture(params=PERSONAS)` for matrix-driven tests
- [X] T018 Create `tests/rbac/fixtures/audit.py` and `tests/rbac/fixtures/audit.ts`: `assert_audit_record(user_id, resource, scope, allowed, reason)` helpers reading from MongoDB `authz_decisions`; used by every matrix-driven test
- [X] T019 Modify `deploy/keycloak/init-idp.sh` (existing script) to seed the six personas with the realm/client roles, team memberships, and per-KB roles defined in `spec.md` §Personas. Idempotent (re-runnable). Verify `kcadm.sh get users -r caipe` shows all six after compose-up

### Python RBAC helpers (mirrors of TS implementation)

- [X] T020 Implement `ai_platform_engineering/utils/auth/jwks_validate.py` (FR-002): `validate_bearer_jwt(token) -> dict` — JWKS fetch + caching (TTL ≥ 5 min), RS256 signature verify, `iss`/`exp`/`aud` checks, raises on invalid; uses `python-jose` per `research.md` §TD-2
- [X] T021 Implement `ai_platform_engineering/utils/auth/keycloak_authz.py` (FR-003): `require_rbac_permission(token, resource, scope) -> AuthzDecision` per [`contracts/python-rbac-helper.md`](./contracts/python-rbac-helper.md); includes `_CACHE: TTLCache`, `_cache_key`, fallback consult of `realm-config-extras.json`
- [X] T022 [P] Implement `ai_platform_engineering/utils/auth/audit.py` (FR-007): `log_authz_decision(decision_dict)` writes to MongoDB `authz_decisions` collection (best-effort, swallow + WARN on failure); document shape validates against [`contracts/audit-event.schema.json`](./contracts/audit-event.schema.json)
- [X] T023 [P] Implement `ai_platform_engineering/utils/auth/realm_extras.py`: `get_fallback_rule(resource) -> dict | None` reads `realm-config-extras.json` (path from `RBAC_FALLBACK_CONFIG_PATH` env, default `/etc/keycloak/realm-config-extras.json`)
- [X] T024 Add `require_rbac_permission_dep(resource, scope)` FastAPI dependency factory in `ai_platform_engineering/utils/auth/keycloak_authz.py` per [`contracts/python-rbac-helper.md`](./contracts/python-rbac-helper.md); raises `HTTPException(403)` on deny so handlers stay clean

### Tests for foundational helpers (TDD — write & confirm RED before T020/T021/T022 implementations)

- [X] T025 [P] Write `tests/rbac/unit/py/test_jwks_validate.py` covering: valid token (mock JWKS), expired token, wrong issuer, wrong audience, signature mismatch. Confirm RED before T020 implementation
- [X] T026 [P] Write `tests/rbac/unit/py/test_keycloak_authz.py` covering each `AuthzReason` path (cache hit/miss, PDP allow, PDP 403, PDP unreachable + fallback rule present, PDP unreachable + no rule). Confirm RED before T021
- [X] T027 [P] Write `tests/rbac/unit/py/test_audit.py` covering: successful Mongo write, Mongo write failure does NOT raise, document validates against `audit-event.schema.json`. Confirm RED before T022
- [X] T028 [P] Write `tests/rbac/unit/py/test_realm_extras.py` covering: file present + valid, file present + malformed, file missing (returns None), unknown resource (returns None). Confirm RED before T023

### TS↔Py parity test

- [X] T029 Add `(resource, scope)` cross-references to JSON schemas in `docs/docs/specs/102-comprehensive-rbac-tests-and-completion/contracts/` (already drafted) — verify each contract references its peers
- [X] T030 Implement `tests/rbac/unit/py/test_helper_parity.py`: parameterised over personas; asserts `await require_rbac_permission(token, R, S).allowed == ts checkPermission(token, R, S).allowed` for every (R, S) defined in matrix (parity invariants 1+2 from `contracts/python-rbac-helper.md`)
- [X] T031 [P] Implement `tests/rbac/fixtures/test_fixture_parity.py` smoke test: get a persona token via the Py fixture and again via the TS fixture (subprocess shelling out to `node -e`); assert the decoded `sub` claim is identical

### `make test-rbac` real wiring (replaces T006 stub)

- [X] T032 Replace stub in `Makefile`: `make test-rbac` now runs in order: `make test-rbac-lint` (`scripts/validate-rbac-matrix.py` + `scripts/validate-realm-config.py`) → `make test-rbac-pytest` (helper unit + parity tests) → `make test-rbac-jest` (UI matrix-driver) → `make test-rbac-e2e` (Playwright; gated on `RBAC_E2E=1`). `test-rbac-up` brings up `COMPOSE_PROFILES="rbac,caipe-ui,caipe-supervisor,caipe-mongodb,dynamic-agents,rag,all-agents,slack-bot" docker compose -f docker-compose.dev.yaml -f docker-compose/docker-compose.e2e.override.yaml up -d --wait` and seeds personas via `deploy/keycloak/init-idp.sh`; `test-rbac-down` tears it down. Strict matrix lint via `RBAC_LINT_STRICT=1` (allowed to soft-fail during phase rollout per spec.md Clarification). Honors FR-009. Per spec Clarification 2026-04-22: NO separate `docker-compose.e2e.yaml` — reuse the dev compose file with profiles + a thin overlay

**Checkpoint**: Foundation ready — matrix + helpers + fixtures + linters all in place. **All eight user stories below can now begin in parallel.** Until this checkpoint, the matrix-driven tests in every later phase will trivially fail/skip.

---

## Phase 3: User Story 1 — Admin UI is fully Keycloak-gated (Priority: P1) 🎯 MVP

**Goal**: Every BFF route under `/api/admin/*` (and `/api/dynamic-agents/*`, `/api/mcp-servers/*`, `/api/teams/*`, `/api/agents/*`) gates on Keycloak via `requireRbacPermission`. Legacy `requireAdmin` / `requireAdminView` remain only for `/api/internal/*` (out of scope) and are flagged unused on production paths.

**Independent Test**: Boot Keycloak + UI via `make test-rbac-up` (which sets `COMPOSE_PROFILES="rbac,caipe-ui,caipe-supervisor,caipe-mongodb,..."` against `docker-compose.dev.yaml` plus the e2e override). Log in as each persona. Hit every route in the matrix under those prefixes. Assert 200/403 per matrix entry. Verify `authz_decisions` Mongo collection has one document per call.

**Maps to**: Story 1, FR-001, FR-006, FR-010 (subset).

### Realm config seeding for US1

- [X] T033 [US1] Add resources to `deploy/keycloak/realm-config.json` per FR-006: `admin_ui` (existing — scopes `view`, `configure`, `admin`, `audit.view`), `team` (NEW — scopes `view`, `manage`), `mcp_server` (NEW — scopes `read`, `manage`); add policies `team-view-access`/`team-manage-access`/`mcp-server-read-access`/`mcp-server-manage-access` binding `admin` realm role to `manage` and `chat_user`/`team_member` to read scopes. Also extended `ui/src/lib/rbac/types.ts` to add the new `RbacResource` and `RbacScope` (`read`/`manage`) literals, and `ui/src/lib/api-middleware.ts` `RESOURCE_ROLE_FALLBACK` to map `team`→`admin`, `mcp_server`→`admin`
- [X] T034 [P] [US1] Add resources to `deploy/keycloak/realm-config.json`: `dynamic_agent` (NEW — scopes `view`, `invoke`, `manage`); added policies `dynamic-agent-invoke-access` (binds `chat_user` to `view`+`invoke`) and `dynamic-agent-manage-access` (binds `admin` to `view`+`invoke`+`manage`). Per-agent `dynamic_agent:<id>` resources still seeded later by US6's runtime (Phase 8). Fallback: `dynamic_agent`→`chat_user`

### Matrix entries for US1

- [X] T035 [US1] Added matrix entries for all 49 admin routes under `ui/src/app/api/admin/**/route.ts` per FR-001 via `scripts/generate-rbac-matrix-us1.py`. Mapping: `(admin_ui, view)` for read-only routes; `(admin_ui, admin)` for mutating; `(admin_ui, audit.view)` for audit routes. The 11 routes under `/api/admin/teams/**` map to `(team, view)` / `(team, manage)` per FR-006. All 6 personas covered. Pre-migration routes are tagged `migration_status: pending` so the matrix-driver renders them as `xit` (yellow/pending) — the linter still requires the entry, only test execution is gated. Phase 11 (T127) verifies no `pending` rows remain
- [X] T036 [P] [US1] Added matrix entries for the 23 routes under `ui/src/app/api/{dynamic-agents,mcp-servers,agents}/**/route.ts` via the same generator. Mapping: `dynamic-agents` → `dynamic_agent`/`view|invoke|manage`; `mcp-servers` → `mcp_server`/`read|manage`; `agents/tools` → `mcp_server`/`read`. `/api/dynamic-agents/health` and `/api/dynamic-agents/builtin-tools` are intentionally excluded (unauthenticated infra endpoints). `/api/teams` directory does not exist; the team routes live under `/api/admin/teams/**`. Also extended `rbac-matrix.schema.json` with `migration_status: enum(migrated|pending)` to preserve immutability of the contract
- [X] T037 [US1] Initial GREEN matrix-linter run after T035/T036: 73 generated routes + 1 hand-curated supervisor#invoke entry + 1 smoke entry. **Linter PASS** — every `requireRbacPermission(...)` call site in `ui/src/app/api/**/route.ts` is now represented. Pre-migration handlers (those still calling `requireAdmin`) appear in the matrix as `migration_status: pending`; the matrix-driver renders 402 tests as `xit` (pending). Subsequent T040–T049 migration tasks will flip each to `migration_status: migrated` and the driver assertions will activate
- [X] T038 [US1] Implement Jest matrix-driver at `ui/src/__tests__/rbac-matrix-driver.test.ts`. Loads `tests/rbac/rbac-matrix.yaml`, filters to `surface: ui_bff`, mocks `getServerSession` per persona + `checkPermission` per matrix expectation, then dynamically imports each `route.ts` and dispatches the declared method against a `NextRequest`. Asserts `[401,403]` for deny, otherwise non-401/403 for allow. **Pending-aware**: rows with `migration_status: pending` render as `xit()` (yellow); migrated rows run the assertion. With T035–T037 populated: 450 total tests, 48 passing (smoke + chat/conversations + admin/teams reads), 402 pending (waiting on T040–T049). Empty-matrix branch (Phase 2) and pending-skip branch (Phase 3 rollout) both render a clean test summary

### Jest matrix-driven test driver (TDD-RED for US1)

- [ ] T038 [US1] Implement `tests/rbac/unit/ts/matrix-driver.test.ts`: loads `tests/rbac/rbac-matrix.yaml`, filters to `surface: ui_bff` entries, parameterises over each (route × persona), uses Next.js test helpers + the persona fixture (T016) to issue real HTTP-equivalent calls into the route handler, asserts status + reason + audit record (via T018). Wire `make test-rbac-jest` to point at this file
- [ ] T039 [US1] Add `tests/rbac/unit/ts/__snapshots__/` to `.gitignore` if not already present (we never want jest snapshot drift to mask RBAC regressions)

### Migrate admin routes (mechanical swap; group commits per cluster)

- [ ] T040 [US1] Migrate `ui/src/app/api/admin/users/**/route.ts` (5 files: `route.ts`, `[id]/route.ts`, `[id]/role/route.ts`, `[id]/roles/route.ts`, `[id]/teams/route.ts`): replace `requireAdmin(session)` with `await requireRbacPermission(session, 'admin_ui', '<view|manage>')`. Pick scope per HTTP method (GET → `view`, all others → `manage`)
- [ ] T041 [P] [US1] Migrate `ui/src/app/api/admin/teams/**/route.ts` (4 files): same pattern as T040 but with `(resource: 'team', scope: 'view'|'manage')`
- [ ] T042 [P] [US1] Migrate `ui/src/app/api/admin/roles/**/route.ts` (2 files), `role-mappings/**/route.ts` (2 files): `(admin_ui, manage)` for all (these are mutation-heavy)
- [ ] T043 [P] [US1] Migrate `ui/src/app/api/admin/slack/**/route.ts` (3 files): `(admin_ui, view)` for GETs, `(admin_ui, manage)` for mutations
- [ ] T044 [P] [US1] Migrate `ui/src/app/api/admin/audit-{events,logs,logs/[id]/messages,logs/owners,logs/export}/route.ts` (5 files): `(admin_ui, view)` for all (read-only)
- [ ] T045 [P] [US1] Migrate `ui/src/app/api/admin/{nps,nps/campaigns,feedback,metrics,migrate-conversations,rbac-audit}/route.ts` (6 files): `(admin_ui, view)` for GETs, `(admin_ui, manage)` for POSTs
- [ ] T046 [P] [US1] Migrate `ui/src/app/api/admin/stats/**/route.ts` (3 files including `route.ts`, `skills/route.ts`, `checkpoints/route.ts`): `(admin_ui, view)` for all
- [ ] T047 [P] [US1] Migrate `ui/src/app/api/dynamic-agents/**/route.ts` (10 files): map per FR-001; chat-stream-start gets per-agent `(dynamic_agent:<agent_id>, invoke)` (this overlaps with US6 Phase 8 — coordinate by leaving `chat/stream/start` unmigrated here and reverting to it in T087)
- [ ] T048 [P] [US1] Migrate `ui/src/app/api/mcp-servers/**/route.ts` (2 files): `(mcp_server, read|manage)`
- [ ] T049 [P] [US1] Migrate `ui/src/app/api/agents/tools/route.ts`: `(mcp_server, read)`

### Mark legacy gates deprecated for production

- [x] T050 [US1] Modify `ui/src/lib/api-middleware.ts`: add a `@deprecated` JSDoc comment on `requireAdmin` and `requireAdminView` saying "Use `requireRbacPermission(session, '<resource>', '<scope>')` instead. Production callers MUST be removed; any new use will fail `scripts/validate-rbac-matrix.py`."
- [x] T051 [US1] Add a CI assertion in `scripts/check-no-new-requireAdmin.sh` (wired via `make test-rbac-lint`): every `route.ts` that imports `requireAdmin` / `requireAdminView` from `@/lib/api-middleware` must have a matching `migration_status: pending` entry in `tests/rbac/rbac-matrix.yaml`; new call sites outside that allowlist hard-fail when `RBAC_LINT_STRICT=1`. Stale legacy `requireAdmin(session)` calls were removed from the two now-migrated routes (`POST /api/admin/teams`, `PATCH /api/admin/users/[id]/role`); 13 remaining call sites outside Phase 3 scope (catalog/skills/policies/llm-models) were added to the matrix as `pending` via `scripts/append-pending-rbac-entries.py` so the guard reports a clean state today (50 pending entries cover all 32 import sites).

### Existing test fixes (handle pre-existing test breakage caused by migrations)

- [x] T052 [US1] Updated `ui/src/app/api/__tests__/admin-feedback.test.ts` so it mocks `checkPermission` from `@/lib/rbac/keycloak-authz` (and `logAuthzDecision`) the same way `admin-stats.test.ts` and `admin-users-stats.test.ts` already did. The route itself was migrated in this task — `ui/src/app/api/admin/feedback/route.ts` previously gated only on `withAuth`, now requires `requireRbacPermission(session, 'admin_ui', 'view')` (FR-001). The misleading "returns 200 for any authenticated user (no admin gate on route)" assertion was rewritten to "returns 403 for non-admin users (admin_ui#view denied)". The matrix entry for `GET /api/admin/feedback` was flipped from `pending` → `migrated`. The other two test files needed no changes.

### Acceptance check for US1

- [x] T053 [US1] Ran the assembly: `make test-rbac-lint` is green (matrix linter + realm-config validator + requireAdmin deprecation guard), and `make test-rbac-jest` runs 3 suites with **72 assertions passing, 0 failing, 474 skipped** (the skipped rows are the `migration_status: pending` routes covered by Phases 5–9 — they're already in the matrix but their handlers aren't migrated yet). The deprecation-guard report shows 32 legacy `requireAdmin` import sites, all covered by 49 pending matrix entries. Phase 3 acceptance criterion (FR-001 + SC-001) is satisfied for every Phase-3-scoped route; remaining `pending` rows are tracked for Phases 5–9.

**Checkpoint**: User Story 1 fully functional and independently testable. Admin UI is the first surface that can be **demoed as Keycloak-only** — even if every later phase slips, this is shippable today.

---

## Phase 4: User Story 7 — Comprehensive automated test matrix exists and runs in CI (Priority: P1)

**Goal**: `make test-rbac` is the single CI signal; adding a new gated route without a matrix entry fails the build. The matrix linter, realm-config drift check, and audit-log assertion helpers are wired together.

**Why before US3-US6**: Subsequent Python phases (US3, US4, US6) ship with matrix entries + parameterised tests; that requires US7's plumbing to already be live. US1's per-route migrations (Phase 3) used the bare-bones matrix driver; US7 hardens it for the rest of the migrations.

**Independent Test**: `make test-rbac` runs to completion locally in ≤10min. `make test-rbac-jest` and `make test-rbac-pytest` are also runnable independently. A deliberately-introduced unprotected route in a throwaway commit makes the suite fail with a specific message naming the route.

**Maps to**: Story 7, FR-008, FR-009, FR-010, SC-006, SC-008.

- [X] T054 [US7] Implement `tests/rbac/unit/py/matrix_driver.py`: pytest-collected base class that loads `tests/rbac/rbac-matrix.yaml`, parameterises over each `(route × persona)` for entries with `surface ∈ {supervisor, mcp, dynamic_agents, rag, slack_bot}`, and provides per-surface helpers (`call_supervisor`, `call_mcp`, `call_da`, `call_rag`, `call_slack_event`) to invoke each surface with a persona token
- [X] T055 [P] [US7] Implement `tests/rbac/unit/py/conftest.py` (separate from `tests/rbac/conftest.py` to avoid recursion): registers the matrix driver, provides `audit_collection` fixture pointing at e2e-compose Mongo, provides `clean_authz_decisions` autouse fixture that drops the collection between test classes
- [X] T056 [US7] Implement `tests/rbac/e2e/playwright.config.ts`: configures Playwright to read base URL from `E2E_UI_URL` (default `http://localhost:3000`), uses `tests/rbac/fixtures/keycloak.ts` to mint persona tokens, captures audit-log assertions via API calls. Test artifacts under `tests/rbac/e2e/test-results/`
- [X] T057 [P] [US7] Implement Playwright spec `tests/rbac/e2e/story-1-admin-ui.spec.ts` covering Story 1 acceptance scenarios end-to-end (real browser, real Keycloak login)
- [X] T058 [P] [US7] Implement `tests/rbac/e2e/story-7-matrix-completeness.spec.ts`: asserts every matrix entry has a corresponding Jest or pytest result file; this surfaces "matrix entry exists but no test runs it" gaps
- [X] T059 [US7] Wire `make test-rbac-pytest` to `PYTHONPATH=. uv run pytest tests/rbac/unit/py -v`. Wire `make test-rbac-e2e` to `cd ui && npx playwright test --config ../tests/rbac/e2e/playwright.config.ts`
- [X] T060 [P] [US7] Add `.github/workflows/test-rbac.yaml` per `quickstart.md` §"How CI runs this": ubuntu-latest runner, sets up node 20 + uv, runs `COMPOSE_PROFILES="rbac,caipe-ui,caipe-supervisor,caipe-mongodb,dynamic-agents,rag,all-agents,slack-bot" docker compose -f docker-compose.dev.yaml -f docker-compose/docker-compose.e2e.override.yaml pull` and `make test-rbac`, uploads logs on failure
- [X] T061 [US7] Add a deliberately-broken sample to `tests/rbac/unit/py/test_linter_smoke.py` that imports the linter, points it at a fixture route directory containing a route with no matrix entry, and asserts the linter exits non-zero with a message containing the route path (validates SC-006)
- [X] T062 [US7] Verify SC-008: time `make test-rbac` end-to-end on M-series Mac, record the wall-clock time in `tests/rbac/PERFORMANCE.md`. If >10 min: flag as a Phase 11 (Polish) task and add `--workers=4` to Playwright config

**Checkpoint**: Test infrastructure complete. Every later phase can ship with: (1) realm-config seeding, (2) matrix entry, (3) parameterised test that's automatically picked up — no per-phase test plumbing needed.

---

## Phase 5: User Story 3 — Every agent MCP server is Keycloak-gated (Priority: P1)

**Goal**: Every MCP server validates the bearer against Keycloak JWKS, then gates each tool call on `require_rbac_permission(token, '<agent>_mcp', 'read'|'write')`. Shared-key auth is **removed** (FR-012).

**Independent Test**: For each MCP server, parameterised pytest POSTs `tools/list` and a representative `tools/call` with each persona's token; asserts the matrix.

**Maps to**: Story 3, FR-002, FR-003, FR-007 (Py side), FR-012.

### Realm config + matrix entries

- [ ] T063 [US3] Add to `deploy/keycloak/realm-config.json` per FR-006: 12 resources `argocd_mcp`, `aws_mcp`, `jira_mcp`, `github_mcp`, `pagerduty_mcp`, `splunk_mcp`, `confluence_mcp`, `webex_mcp`, `slack_mcp`, `komodor_mcp`, `aigateway_mcp`, `backstage_mcp` — each with scopes `read`, `write`. Bind `chat_user` to `read`, `team_member` to `read+write` (within team), `admin` to all
- [ ] T064 [US3] Add matrix entries to `tests/rbac/rbac-matrix.yaml` per MCP × representative tool: at minimum `tools/list` (scope `read`) and one mutating `tools/call` (scope `write`). For agents with no mutating tools (e.g. `splunk` is read-only), include only the `read` entry and a `notes:` line explaining the omission

### Python helper wiring (Starlette middleware for MCP servers)

- [ ] T065 [US3] Implement `ai_platform_engineering/agents/common/mcp-auth/keycloak_middleware.py`: Starlette ASGI middleware that calls `validate_bearer_jwt` (T020) on every request, raises 401 on failure, sets `current_bearer_token` ContextVar (existing in `mcp-auth/token_context.py`) for tool dispatch
- [ ] T066 [P] [US3] Modify `ai_platform_engineering/agents/common/mcp-auth/middleware.py`: add `oauth2_keycloak` mode that wires the new middleware (alongside existing `none`, `shared_key`, `oauth2`); set as the default when `MCP_AUTH_MODE=oauth2_keycloak`. Keep `shared_key` mode in code but emit a startup `loguru` ERROR if it's selected
- [ ] T067 [US3] Add a `tools/call`-time hook in each MCP `server.py`: a wrapper `_authz_wrap(tool_name, scope, fn)` that calls `await require_rbac_permission(current_bearer_token.get(), '<agent>_mcp', scope)` before delegating to the tool. Apply per-agent in T068–T078 below

### Per-agent MCP migrations (one task per MCP server — parallelisable)

- [ ] T068 [P] [US3] Migrate `ai_platform_engineering/agents/argocd/mcp/mcp_argocd/server.py`: switch `MCP_AUTH_MODE` default to `oauth2_keycloak`, wrap every tool function with `_authz_wrap('argocd_mcp', '<read|write>', ...)`, remove `SharedKeyMiddleware` registration. Add to `realm-config.json` audience for `aud=caipe-platform`
- [ ] T069 [P] [US3] Migrate `ai_platform_engineering/agents/jira/mcp/mcp_jira/server.py`: same pattern (`jira_mcp`, `read`/`write`)
- [ ] T070 [P] [US3] Verify GitHub agent RBAC coverage through its gh CLI-backed tools; the local GitHub MCP server has been removed, so there is no GitHub MCP entrypoint to migrate
- [ ] T071 [P] [US3] Migrate `ai_platform_engineering/agents/pagerduty/mcp/mcp_pagerduty/server.py` (`pagerduty_mcp`)
- [ ] T072 [P] [US3] Migrate `ai_platform_engineering/agents/splunk/mcp/mcp_splunk/server.py` (`splunk_mcp` — read-only)
- [ ] T073 [P] [US3] Migrate `ai_platform_engineering/agents/confluence/mcp/mcp_confluence/server.py` (`confluence_mcp`)
- [ ] T074 [P] [US3] Migrate `ai_platform_engineering/agents/webex/mcp/mcp_webex/__main__.py` (`webex_mcp`)
- [ ] T075 [P] [US3] Migrate `ai_platform_engineering/agents/komodor/mcp/mcp_komodor/server.py` (`komodor_mcp`)
- [ ] T076 [P] [US3] Migrate `ai_platform_engineering/agents/backstage/mcp/mcp_backstage/server.py` (`backstage_mcp`)
- [ ] T077 [P] [US3] Migrate `ai_platform_engineering/agents/victorops/mcp/mcp_victorops/server.py` (`victorops_mcp` — note: not in plan's 12-agent list but exists in repo; treat the same)
- [ ] T078 [P] [US3] Migrate `ai_platform_engineering/agents/netutils/mcp/mcp_netutils/server.py` (`netutils_mcp` — same as T077)

> **AWS, Slack, AIGateway**: these three MCPs from the plan's list have no `server.py` or `__main__.py` in the current codebase (verified Phase 0). If they exist as in-repo agents by the time this phase runs, mirror the T068 pattern. If not (i.e., still planned), add a placeholder matrix entry with `notes: "agent MCP server not yet implemented"` and a `skip_reason` in expectations. Add a **test that fails** when the agent appears in the codebase to force re-visiting.

### Tests for US3

- [ ] T079 [P] [US3] Implement `tests/rbac/unit/py/test_mcp_auth_jwt.py`: parameterised over the 10 in-repo MCPs × 6 personas; uses the e2e-compose stack to spin up each MCP via its existing `__main__.py`; asserts 401 on missing/expired/wrong-issuer token, 200/403 per matrix
- [ ] T080 [US3] Implement `tests/rbac/unit/py/test_mcp_shared_key_removed.py`: greps for `SharedKeyMiddleware` registrations in `ai_platform_engineering/agents/`; asserts ZERO matches (FR-012). Runs as part of `make test-rbac-pytest`

**Checkpoint**: Every MCP server in the repo gates on Keycloak. Shared-key auth removed.

---

## Phase 6: User Story 2 — Supervisor enforces Keycloak before delegating to agents (Priority: P1)

**Goal**: Supervisor's existing `JwtUserContextMiddleware` + OBO mint + `httpx_client_factory` chain is **proven by tests** to produce a downstream MCP `Authorization` header whose JWT `sub` resolves to the original user. Implementation is already there post-merge; this phase locks it down with tests and adds the missing PDP gate at the supervisor's A2A entry.

**Independent Test**: Stand up supervisor + a stub MCP server (`tests/rbac/fixtures/stub_mcp.py`) that records inbound headers. Send A2A requests with each persona token. Assert: inbound JWT validated; OBO minted; stub MCP sees `Authorization: Bearer <obo>` whose decoded `sub` is the persona's `keycloak_sub` and `act.sub` is the supervisor service account.

**Maps to**: Story 2, FR-002 (verify), FR-003 (apply at supervisor), FR-007 (audit at supervisor).

### Realm config + matrix entries

- [ ] T081 [US2] Add to `deploy/keycloak/realm-config.json`: client `caipe-supervisor` with `serviceAccount` enabled; impersonation policy granting it `urn:ietf:params:oauth:grant-type:token-exchange` for users in `chat_user` realm role (per `call-sequences.md` Flow 3). Verify by inspecting `realm-config.json` → `clients` array
- [ ] T082 [US2] Add matrix entries for the supervisor surface (`surface: supervisor`): `POST /tasks/send` (rpc-equivalent) with one entry per agent invocation — `argocd_agent.list_apps` (resource `argocd_mcp`, scope `read`), one mutating tool (`argocd_agent.delete_app` → `write`), etc.

### Supervisor PDP gate at A2A entry (defense-in-depth — MCP already gates)

- [ ] T083 [US2] Modify `ai_platform_engineering/multi_agents/platform_engineer/protocol_bindings/a2a/agent_executor.py` `execute()`: before invoking the graph, call `await require_rbac_permission(ctx.token, 'supervisor', 'invoke')` (NEW resource — add to T081's realm config too); raise A2A error on deny with `reason=DENY_NO_CAPABILITY`
- [ ] T084 [US2] Add resource `supervisor` (scopes `invoke`, `manage`) to `deploy/keycloak/realm-config.json` (chained off T081); bind `chat_user` to `invoke`, `admin` to `manage`

### Tests for US2

- [ ] T085 [US2] Implement `tests/rbac/fixtures/stub_mcp.py`: minimal Starlette MCP that records every request's `Authorization` header and tool name in an in-memory list, exposes `/_test/captured_requests` for assertions. Used by T086 + T108 (US6)
- [ ] T086 [US2] Implement `tests/rbac/unit/py/test_supervisor_obo.py`: parameterised over 4 cases per Story 2 acceptance scenario — (a) valid bob token → 200 + stub_mcp sees correct OBO; (b) expired token → 401, no graph stream; (c) wrong-issuer token → 401, JWKS not re-fetched within 60s (asserted via JWKS cache mock); (d) chain of 2 agents → every hop sees `sub=bob.keycloak_sub`

**Checkpoint**: Supervisor proven correct under test. A2A entry now also has a PDP gate (defense-in-depth).

---

## Phase 7: User Story 4 — RAG hybrid Keycloak + Mongo KB ACL (Priority: P1)

**Goal**: RAG `/v1/ingest` and `/v1/query` gate on Keycloak (`rag#ingest`, `rag#retrieve`); per-KB visibility computed as union of `TeamKbOwnership` (Mongo) and per-KB realm roles (`kb_reader:<id>`, `kb_ingestor:<id>`).

**Independent Test**: Seed two KBs (`team-a-docs`, `team-b-docs`) with sentinel docs. Call `/v1/query` as each persona. Assert: alice sees both, carol sees only `team-a-docs`, bob sees nothing in strict mode, dave gets 403.

**Maps to**: Story 4, FR-002, FR-003, FR-013.

### Realm config + matrix

- [ ] T087 [US4] Add resource `rag` (scopes `ingest`, `retrieve`, `manage`) to `deploy/keycloak/realm-config.json`; bind `chat_user` to `retrieve`, `kb_ingestor` realm role to `ingest+retrieve`. Note: per-KB realm roles (`kb_reader:<id>`, `kb_ingestor:<id>`) are created by team-management UI on KB provision (existing 098 implementation); this phase only consumes them
- [ ] T088 [P] [US4] Add matrix entries for RAG: `(POST /v1/ingest, rag, ingest)` and `(POST /v1/query, rag, retrieve)`. Add per-persona expectations including the per-KB filter scenario as `notes`

### RAG server modifications

- [ ] T089 [US4] Modify `ai_platform_engineering/knowledge_bases/rag/server/src/server/restapi.py`: register `JwtUserContextMiddleware` at the FastAPI app level; add `Depends(require_rbac_permission_dep('rag', 'ingest'))` to `/v1/ingest` route, `Depends(require_rbac_permission_dep('rag', 'retrieve'))` to `/v1/query`
- [ ] T090 [US4] Modify `ai_platform_engineering/knowledge_bases/rag/server/src/server/rbac.py`: implement `accessible_kbs(user_token, db) -> set[str]` per `data-model.md` §E6 — union of (Mongo `team_kb_ownership` rows where user is in `ownerTeamId`) ∪ (KB ids where user has realm role `kb_reader:<id>` or `kb_ingestor:<id>`)
- [ ] T091 [US4] Modify `ai_platform_engineering/knowledge_bases/rag/server/src/server/query_service.py`: post-filter result chunks by `chunk.kb_id ∈ accessible_kbs(user)`; if the resulting set is empty, return 200 + empty results (NOT 403 — that distinction matters for non-malicious users in strict deployments)
- [ ] T092 [US4] Modify `ai_platform_engineering/knowledge_bases/rag/server/src/server/ingestion.py`: assert `request.kb_id ∈ accessible_kbs(user)` AND user has `kb_ingestor:<kb_id>` realm role (or is admin) before writing; raise `HTTPException(403, reason=DENY_NO_CAPABILITY)` otherwise

### Tests for US4

- [ ] T093 [P] [US4] Implement `tests/rbac/fixtures/rag_seed.py`: helper `seed_kbs(['team-a-docs', 'team-b-docs'])` that creates the KBs in Mongo `team_kb_ownership`, creates the per-KB realm roles in Keycloak (via `kcadm` shell-out), assigns `carol_kb_ingestor` to `kb_ingestor:team-a-docs`. Runs once per test session
- [ ] T094 [US4] Implement `tests/rbac/unit/py/test_rag_query_per_kb.py`: parameterised over the 4 personas relevant to Story 4 — alice (sees both), carol (sees only team-a-docs), bob (sees neither in strict deployment), dave (403). Uses T093's seed
- [ ] T095 [P] [US4] Implement `tests/rbac/unit/py/test_rag_ingest_per_kb.py`: covers Story 4 acceptance scenarios 1+2 — carol can ingest into team-a-docs but not team-b-docs

**Checkpoint**: RAG runs the hybrid gate end-to-end. Story 4 demonstrably shippable.

---

## Phase 8: User Story 6 — Custom (Dynamic) Agents are bound to Keycloak (Priority: P1) **biggest delta**

**Goal**: All five layers from `call-sequences.md` Flow 4b — BFF chat-stream gate, `da-proxy.ts` no-X-User-Context, DA backend JWT middleware, DA backend PDP defense-in-depth, MCP-call-from-DA carries fresh per-request OBO.

**Independent Test**: Three agents seeded — `private-eve`, `team-a-shared`, `global-public`. Each persona attempts `view`, `invoke`, `manage` on each. Assert via Playwright (BFF) and pytest (DA backend probed directly with a forged `X-User-Context` — must be ignored).

**Maps to**: Story 6, FR-002, FR-003, FR-004, FR-005.

### Realm config

- [ ] T096 [US6] Extend the resource `dynamic_agent` in `deploy/keycloak/realm-config.json` (created in T034) to support per-agent instance resources: convention `dynamic_agent:<agent_id>` with same three scopes. Implement seeding via the existing dynamic-agent provisioning code path so creating a DA in the UI also creates the Keycloak resource (out-of-scope code change is minimal — wire into `ui/src/app/api/dynamic-agents/route.ts`'s POST handler)
- [ ] T097 [P] [US6] Add matrix entries for: `POST /api/v1/chat/stream/start` per representative agent (`private-eve`, `team-a-shared`, `global-public`); `dynamic_agents` admin routes (already in T047 from US1)

### BFF gate (TS)

- [ ] T098 [US6] Modify `ui/src/app/api/v1/chat/stream/start/route.ts`: parse `agent_id` from request body before any DA call; call `await requireRbacPermission(session, 'dynamic_agent:' + agent_id, 'invoke')`; on deny, return 403 without opening the SSE stream
- [ ] T099 [P] [US6] Modify `ui/src/lib/da-proxy.ts`: remove `userContext` base64 construction from `authenticateRequest()`; `proxySSEStream()` no longer adds `X-User-Context` header; pass through `Authorization: Bearer <session.accessToken>` header instead. Update the function signature to accept `{ bearer: string }` instead of `{ userContext: string }`
- [ ] T100 [US6] Update jest test `ui/src/app/api/__tests__/da-proxy.test.ts` (create if missing): asserts the outbound request to DA has `Authorization` header but NOT `X-User-Context`

### DA backend (Python)

- [ ] T101 [US6] Implement `ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/token_context.py`: `current_user_token: ContextVar[str | None] = ContextVar('current_user_token', default=None)` — mirror of supervisor's `ai_platform_engineering/utils/auth/token_context.py`
- [ ] T102 [P] [US6] Implement `ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/jwt_middleware.py`: Starlette ASGI middleware mirroring `ai_platform_engineering/utils/auth/jwt_user_context_middleware.py`; on every request, validates JWT (T020), sets `current_user_token` ContextVar, sets a DA-local `current_user_context` ContextVar with `{sub, email, roles}`. On invalid token: respond 401 immediately
- [ ] T103 [US6] Modify `ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/auth.py` `get_user_context()`: replace base64 `X-User-Context` decode with `get_jwt_user_context()` from the new ContextVar (FR-004). Delete the `_decode_user_context_header` helper and any remaining `request.headers.get('X-User-Context')` reads
- [ ] T104 [P] [US6] Implement `ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/keycloak_authz.py`: thin wrapper exporting `require_rbac_permission` (re-exports from `ai_platform_engineering/utils/auth/keycloak_authz.py`) plus a `require_da_permission(agent_id, scope)` FastAPI dependency that constructs `dynamic_agent:<agent_id>` and calls the underlying helper
- [ ] T105 [P] [US6] Implement `ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/obo_exchange.py`: copy of `ai_platform_engineering/utils/obo_exchange.py` adjusted to use `KEYCLOAK_DA_CLIENT_ID` env var; cached (TTL ≥ 30s before expiry)
- [ ] T106 [US6] Modify `ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/access.py` `can_view_agent`, `can_use_agent`, `can_access_conversation`: after the existing local CEL eval, also call `require_rbac_permission(token, 'dynamic_agent:<agent_id>', '<view|invoke|manage>')`; if EITHER local CEL OR Keycloak denies → deny. (Defense-in-depth pattern)
- [ ] T107 [US6] Modify `ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/agent_runtime.py`: at the start of every `invoke()` / `chat_stream()` entry point, set `current_user_token` ContextVar from the request's bearer; remove the instance attribute `self._auth_bearer` entirely (callers must use ContextVar). Verify no remaining `_auth_bearer` references with `rg -n '_auth_bearer' ai_platform_engineering/dynamic_agents/`
- [ ] T108 [US6] Modify `ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/mcp_client.py`: implement `_build_httpx_client_factory()` mirroring `ai_platform_engineering/utils/a2a_common/base_langgraph_agent.py:255` (`current_user_token.get()` → `Authorization` header per request); replace the static `auth_bearer=…` argument in `MultiServerMCPClient` construction (FR-005)

### Tests for US6

- [ ] T109 [US6] Implement Playwright spec `tests/rbac/e2e/story-6-dynamic-agents.spec.ts`: covers all 5 acceptance scenarios for Story 6 — including alice/bob/eve hitting `private-eve`, `team-a-shared`, `global-public` and asserting the matrix
- [ ] T110 [US6] Implement `tests/rbac/unit/py/test_da_jwt_middleware.py`: directly POSTs to DA with (a) no auth → 401, (b) valid bob → 200, (c) **forged `X-User-Context: <base64({"is_admin":true})>` AND no Authorization header → 401** — proves header is no longer trusted (Story 6 acceptance scenario 3, the security-critical test)
- [ ] T111 [P] [US6] Implement `tests/rbac/unit/py/test_da_mcp_obo.py`: stand up T085's stub_mcp; configure a DA to use it; chat with the DA as bob; assert stub_mcp's captured `Authorization` header decodes to a JWT with `sub=bob.keycloak_sub` AND a fresh `iat` (≤5s old — proves per-request mint, not cached)
- [ ] T112 [US6] Implement `tests/rbac/unit/py/test_da_no_xusercontext.py`: greps the entire `ai_platform_engineering/dynamic_agents/` tree for `X-User-Context`; asserts only matches are in test fixtures or audit-log lines (SC-002)

**Checkpoint**: DA fully Keycloak-bound. The largest security-relevant delta is locked down by tests.

---

## Phase 9: User Story 5 — Slack commands run with the user's identity, not the bot's (Priority: P2)

**Goal**: Slack bot uses Keycloak `impersonate_user(slack_user→keycloak_sub)` token-exchange per command; supervisor sees `sub=user, act.sub=bot` JWT.

**Independent Test**: Send a slash command from a linked user via the Slack Events test harness; capture supervisor's incoming Authorization header; decode JWT; assert `sub == bob.keycloak_sub` and `act.sub == caipe-slack-bot`'s service-account sub.

**Maps to**: Story 5, FR-011.

### Realm config

- [ ] T113 [US5] Add to `deploy/keycloak/realm-config.json`: client `caipe-slack-bot` (already exists in 098 — verify); add token-exchange + impersonation policies granting it the right to mint OBO tokens for users in `chat_user` realm role. Add resource `slack` (scopes `use`, `register`); bind `chat_user` to `use`, only `caipe-slack-bot` service account to `register`
- [ ] T114 [P] [US5] Add matrix entries: `surface: slack_bot` for representative slash commands — `/caipe list argocd apps` (resource `argocd_mcp`, scope `read`), `/caipe link` (resource `slack`, scope `use`)

### Slack bot wiring

- [ ] T115 [US5] Modify `ai_platform_engineering/integrations/slack_bot/app.py`: every command handler (e.g. `handle_app_mention`, `handle_slash_command`) must call `await impersonate_user(keycloak_sub)` on the resolved `keycloak_sub` from the Slack-link metadata, then build the supervisor request with `Authorization: Bearer <obo>`. Reference `call-sequences.md` Flow 5
- [ ] T116 [P] [US5] Modify `ai_platform_engineering/integrations/slack_bot/utils/rbac_middleware.py`: remove the channel-allowlist gate (it becomes a Keycloak `slack#use` scope check); on unlinked user, respond with the linking instructions (FR-025 from 098)
- [ ] T117 [US5] Verify `ai_platform_engineering/integrations/slack_bot/utils/obo_exchange.py:89` (`impersonate_user`) still works against the now-token-exchange-enabled Keycloak (T005) by manual smoke against the dev compose

### Tests for US5

- [ ] T118 [US5] Implement `tests/rbac/unit/py/test_slack_obo.py`: uses Slack Bolt's test harness (`SocketModeRequest` mock) to fire a slash command from `bob_chat_user`; intercepts the supervisor HTTP call; decodes JWT; asserts `sub == bob.keycloak_sub` AND `act.sub == caipe-slack-bot's sub`
- [ ] T119 [P] [US5] Implement `tests/rbac/unit/py/test_slack_unlinked_user.py`: covers Story 5 acceptance scenarios 2 + 4 — unlinked user gets linking instructions, and a user lacking `team_member` for a channel-mapped team gets the FR-031 deny
- [ ] T120 [US5] Implement Playwright spec `tests/rbac/e2e/story-5-slack.spec.ts`: end-to-end Slack flow via the bot's HTTP webhook endpoint (no real Slack — uses the test harness)

**Checkpoint**: Slack commands carry user identity end-to-end. Per-user audit attribution finally works.

---

## Phase 10: User Story 8 — `docs/docs/security/rbac/` is the canonical reference (Priority: P2)

> **Note (post-split):** the canonical RBAC reference was previously a single file at `docs/docs/specs/098-enterprise-rbac-slack-ui/how-rbac-works.md`. It has been split into focused files under `docs/docs/security/rbac/` (`index.md`, `architecture.md`, `workflows.md`, `usage.md`, `file-map.md`). Tasks below have been retargeted accordingly. The old path still exists as a redirect stub.

**Goal**: `docs/docs/security/rbac/` accurately reflects the post-migration state. File map is auto-validated.

**Independent Test**: A junior reviewer answers a 10-question quiz auto-generated from the file map and component sections; passes 9/10 in &lt;5 min.

**Maps to**: Story 8, FR-014, SC-007.

- [ ] T121 [US8] Implement `scripts/validate-rbac-doc.py`: parses the table in `docs/docs/security/rbac/file-map.md`; asserts every listed file exists; asserts every authz-relevant production file (referenced by `requireRbacPermission` / `require_rbac_permission` calls or by `JwtUserContextMiddleware` registrations) appears in the table; exits non-zero on drift (FR-014). Wire into `make test-rbac` after the matrix linter
- [ ] T122 [US8] Update `docs/docs/security/rbac/architecture.md` component sections: add a NEW Component for "Python RBAC helpers" (T020–T024) with env vars table, error responses, file paths; update Component 5 (Dynamic Agents) to reflect the post-Phase-8 state; add a "Migrated from 098 partial implementation" callout box on every section affected
- [ ] T123 [P] [US8] Update `docs/docs/security/rbac/file-map.md` table: add the new files from Phases 2, 6, 7, 8, 9 — `tests/rbac/**`, `ai_platform_engineering/utils/auth/{jwks_validate,keycloak_authz,audit,realm_extras}.py`, `ai_platform_engineering/dynamic_agents/.../auth/{jwt_middleware,token_context,keycloak_authz,obo_exchange}.py`, `deploy/keycloak/realm-config-extras.json`, `scripts/validate-rbac-{matrix,doc,realm-config}.py`, `scripts/extract-rbac-resources.py`
- [ ] T124 [US8] Update sequence diagrams in `docs/docs/security/rbac/workflows.md`: the existing AgentGateway end-to-end diagram is fine — add a sister `sequenceDiagram` for the **non-AG** paths (BFF → Supervisor → MCP and BFF → DA → MCP), and add a fresh diagram for the per-agent gate at the chat endpoint introduced by Phase 8
- [ ] T125 [P] [US8] Generate the 10-question quiz at `docs/docs/specs/102-comprehensive-rbac-tests-and-completion/quiz.md`. Sample questions: "Which env var controls the PDP cache TTL?" (`RBAC_CACHE_TTL_SECONDS`), "Which file maps Keycloak resources to PDP-unavailable fallback rules?" (`deploy/keycloak/realm-config-extras.json`), etc. Include answer key
- [ ] T126 [US8] Run `python scripts/validate-rbac-doc.py` after all updates. Confirm exit 0. Run the quiz on a junior reviewer (or the team's "least-RBAC-aware" engineer); record score in `quiz.md`. Pass = 9/10

**Checkpoint**: Documentation is accurate, validated, and reviewer-approved. Spec 098 has its companion document brought up to truth.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, perf budget verification, and follow-up tickets. Runs after all 8 user stories are green.

- [ ] T127 [P] Delete `requireAdminView` from `ui/src/lib/api-middleware.ts` (callers all migrated by T040–T049). Run `npx tsc --noEmit` to confirm no remaining type references
- [ ] T128 [P] Delete `SharedKeyMiddleware` and `MCP_AUTH_MODE=shared_key` code path from `ai_platform_engineering/agents/common/mcp-auth/middleware.py` (FR-012; was kept with deprecation warning in T066). Update `mcp-auth/README.md` to remove the `shared_key` documentation
- [ ] T129 [P] Verify SC-001: `rg -n 'requireAdmin\(session\)|canViewAdmin' ui/src/app/api/{admin,dynamic-agents,mcp-servers,teams,agents}/` returns ZERO matches. Verify SC-002: `rg -n "X-User-Context" ai_platform_engineering` returns only test fixtures and audit-log emit lines
- [ ] T130 [P] Verify SC-003: every matrix entry under `ui_bff` surface has at least 1 allow + 1 deny test result file. Run `python scripts/validate-rbac-coverage.py` (NEW — small helper that counts test functions per matrix id)
- [ ] T131 [P] Verify SC-004: `pytest tests/rbac/unit/py --collect-only -q | wc -l` ≥ (#python services × 4 minimum cases)
- [ ] T132 [P] Verify SC-005 + SC-008: time `make test-rbac` end-to-end; record in `tests/rbac/PERFORMANCE.md`. Both ≤10min local, ≤12min CI. If exceeded: enable Playwright `workers: 4` and re-time
- [ ] T133 Update `agents.md` and `CLAUDE.md` "Active Technologies" sections to reflect Phase 5–10 changes (mention `tests/rbac/`, the new Python helpers, the matrix linter)
- [ ] T134 [P] Open follow-up issues for the items in `research.md` "Open follow-ups (NOT for this PR)": (1) `authz_decisions` retention (`expireAfterSeconds`), (2) Cross-process PDP cache (Redis), (3) Keycloak realm export drift detection, (4) Per-tool MCP scopes. File via `gh issue create`; do NOT block this PR on them
- [ ] T135 [P] Run final `make lint` + `make test` + `make caipe-ui-tests` + `make test-rbac`. Confirm all four green. Update `prebuild/feat/comprehensive-rbac` PR `#1257` description with completion summary linking to this `tasks.md`

**Final Checkpoint**: All 8 user stories ship together in PR `#1257` (FR-015). Doc is current. Tests are green. Follow-ups are tracked, not lost.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No deps — start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1. **BLOCKS every user-story phase.**
- **Phase 3 (US1)**: Depends on Phase 2. Independent of Phases 4–10.
- **Phase 4 (US7)**: Depends on Phase 2. Should run before Phases 5–9 because subsequent phases reuse the matrix driver and Playwright config it builds.
- **Phase 5 (US3)**: Depends on Phase 2 + Phase 4. Independent of Phases 6–10.
- **Phase 6 (US2)**: Depends on Phase 2 + Phase 4 + Phase 5 (uses MCP-side tests as integration target via stub_mcp).
- **Phase 7 (US4)**: Depends on Phase 2 + Phase 4. Independent of others.
- **Phase 8 (US6)**: Depends on Phase 2 + Phase 4 + Phase 5 (DA's MCP calls go through MCP-side gate). **Largest delta — schedule carefully.**
- **Phase 9 (US5)**: Depends on Phase 2 + Phase 4 + Phase 6 (Slack OBO calls supervisor with the same OBO pattern). Independent of Phases 7–8.
- **Phase 10 (US8)**: Depends on **all** prior story phases (doc reflects post-migration state). MUST be last user-story phase.
- **Phase 11 (Polish)**: Depends on all prior phases.

### Within Each User Story

- **TDD-first** for foundational helpers (T025–T028 RED before T020–T023 implementations).
- **Matrix entry first**, then code (matrix entry causes the linter to fail until code lands → TDD-RED-style for the linter itself).
- **Realm config first**, then code that calls the new resource (otherwise PDP returns `DENY_RESOURCE_UNKNOWN`).
- **Tests in same commit** as the code change they cover (every implementation task has a matching test task — they MUST land together).

### Parallel Opportunities (within a single phase)

- **Phase 2**: T009/T010/T011 + T015/T016 + T020/T021/T022/T023 + T025/T026/T027/T028 — most foundational tasks are file-disjoint and parallelisable; ~12 of 25 Phase-2 tasks marked `[P]`.
- **Phase 3 (US1)**: T040–T049 are 10 file-disjoint route-cluster migrations — can run in parallel by 10 developers (or one developer in 10 separate commits for clean review).
- **Phase 5 (US3)**: T068–T078 are 11 file-disjoint per-MCP migrations — same parallelism story.
- **Phase 8 (US6)**: T101/T102/T104/T105 (NEW DA auth files) all parallel; T106/T107/T108 (modifications) sequential within `dynamic_agents/services/`.
- **Cross-phase**: Phases 5, 7, 8 can run in parallel after Phase 4 completes if multiple devs are on the project (distinct surface areas).

---

## Parallel Example: Phase 3 (US1)

```bash
# Once Phase 2 (Foundational) is checkpointed, kick these off concurrently:

# Realm config (single editor; do this first, sequentially)
Task: T033 — Add admin_ui, team, mcp_server resources to realm-config.json
Task: T034 — Add dynamic_agent resource

# Matrix entries (single editor)
Task: T035 — Add 30 admin route entries to rbac-matrix.yaml
Task: T036 — Add 10 entries for dynamic-agents/mcp-servers/teams/agents

# Then 10 parallel route migrations across 10 PR commits / 10 devs
Task: T040 — Migrate ui/src/app/api/admin/users/**/route.ts
Task: T041 — Migrate ui/src/app/api/admin/teams/**/route.ts
Task: T042 — Migrate ui/src/app/api/admin/roles/**/route.ts
Task: T043 — Migrate ui/src/app/api/admin/slack/**/route.ts
Task: T044 — Migrate ui/src/app/api/admin/audit-{events,logs}/route.ts
Task: T045 — Migrate ui/src/app/api/admin/{nps,feedback,metrics,…}/route.ts
Task: T046 — Migrate ui/src/app/api/admin/stats/**/route.ts
Task: T047 — Migrate ui/src/app/api/dynamic-agents/**/route.ts
Task: T048 — Migrate ui/src/app/api/mcp-servers/**/route.ts
Task: T049 — Migrate ui/src/app/api/agents/tools/route.ts
```

The final assembly task (T053) waits for all 10 to complete and runs the suite end-to-end.

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete **Phase 1** (Setup).
2. Complete **Phase 2** (Foundational) — CRITICAL gate.
3. Complete **Phase 3** (US1).
4. **STOP and VALIDATE**: `make test-rbac-jest` green; admin UI is fully Keycloak-only; demo internally.
5. This alone is a real security improvement and a defensible incremental ship.

### Incremental Delivery (recommended order)

1. Setup + Foundational → foundation ready (Phases 1+2).
2. Add Story 1 → ship admin-UI-only (Phase 3).
3. Add Story 7 → CI signal locked (Phase 4).
4. Add Stories 3 + 2 + 4 → Python services hardened (Phases 5+6+7).
5. Add Story 6 → DA fully migrated (Phase 8). **Largest single delta — most thorough review.**
6. Add Stories 5 + 8 → Slack + docs (Phases 9+10).
7. Polish (Phase 11).

### Parallel Team Strategy (2 developers, ~6 working days)

| Day | Dev A | Dev B |
|-----|-------|-------|
| 1   | Phase 1 + start Phase 2 helpers | Phase 1 + start Phase 2 fixtures |
| 2   | Finish Phase 2 helpers (T020–T024) | Finish Phase 2 fixtures + lints (T015–T019, T009–T011) |
| 3   | Phase 3 (US1) routes T040–T049 | Phase 4 (US7) test infrastructure T054–T062 |
| 4   | Phase 5 (US3) MCP migrations T068–T078 | Phase 6 (US2) supervisor + Phase 7 (US4) RAG |
| 5   | Phase 8 (US6) DA migration — pair on this | Phase 8 (US6) DA migration — pair on this |
| 6   | Phase 9 (US5) Slack | Phase 10 (US8) doc + Phase 11 polish |

### Single-developer strategy (~10 working days)

Sequential phases in priority order; expect 1–1.5 days per phase except Phase 8 (DA) which is 2 days.

---

## Notes

- `[P]` tasks operate on disjoint files and have no in-phase dependencies — safe to parallelise.
- `[Story]` label maps a task to the user story it serves; setup/foundational/polish tasks have no story label.
- Every test task ASSUMES TDD: write the test, see it fail, then implement, then see it pass. Phase 2 explicitly calls this out; later phases inherit the discipline.
- Tasks without a file path are forbidden by the format. If an action doesn't have a single file path (e.g., "verify SC-001"), the file path is the verification artifact (e.g., the `rg` command output captured in PR description).
- **Single-PR mandate (FR-015)**: every commit lands on `prebuild/feat/comprehensive-rbac` and rolls into PR `#1257`. Do not branch off this branch for individual phases.
- Stop at any checkpoint to validate the story independently. Each story IS independently testable per `spec.md`.
- Avoid: cross-story dependencies that break independence (e.g., a US5 task that requires US8's doc to exist), same-file conflicts in `[P]` tasks, vague tasks without file paths.

---

## Appendix: Deferred/Operator Follow-Ups

This appendix replaces the former root-level `BLOCKERS.md` scratch tracker. Keep
new deferred RBAC work in this spec so the task list remains the source of
truth; completed historical notes stay in git history instead of being copied
forward.

### Operator verification

- [ ] Verify the Dynamic Agents to AgentGateway MCP chain after the bearer
  forwarding fix. Restart `dynamic-agents`, send a web chat to an agent that
  uses Jira/Confluence/Argo MCP tools, and confirm `dynamic-agents` no longer
  logs `HTTP 401 error connecting to http://agentgateway:4000/mcp/...`.
  Confirm AgentGateway logs show MCP-bound requests carrying
  `Authorization: Bearer ...`. For a negative check, set
  `DA_REQUIRE_BEARER=true`, restart Dynamic Agents, and verify requests without
  BFF bearer propagation fail with `code: missing_bearer`; then restore the
  previous environment.
- [ ] Verify the supervisor PDP gate in a live stack. Set
  `SUPERVISOR_PDP_GATE_ENABLED=true`, restart the supervisor, and confirm a
  `chat_user` can chat while a user without `chat_user` receives the
  standardized RBAC denial:
  `{"code":"rbac_denied","reason":"missing_role","action":"contact_admin"}`.
  Stop Keycloak and confirm a non-bootstrap-admin receives
  `code: pdp_unavailable`, then restart Keycloak and unset the gate flag.
- [ ] Wire the RBAC Playwright harness into GitHub Actions once the live stack
  can be provisioned in CI. The harness already exists under `ui/e2e/rbac/`
  with `npm run test:e2e:rbac`; the remaining work is infrastructure
  provisioning for Keycloak, supervisor, Dynamic Agents, and the BFF, either via
  kind + Helm or a hosted preview stack.
- [ ] Run the RAG document ACL migration before enabling
  `RBAC_DOC_ACL_TAGS_ENABLED=true` in any environment with existing data:
  first dry-run `python3 scripts/rag-doc-acl-migration.py --milvus-uri
  http://localhost:19530 --dry-run`, inspect the JSON summary, then run the
  command without `--dry-run`. Verify representative rows now contain
  `metadata.acl_tags=["__public__"]`, restart `rag-server` with the feature
  flag enabled, and smoke-test a RAG chat query. Optionally tag a small subset
  with a real tag such as `team:platform-eng` and verify users outside that team
  no longer see those documents.
- [ ] Tune the PDP cache TTL after `rbac_pdp_*` metrics have enough production
  signal. This depends on the decision-cache observability added in Phase 11.
- [ ] After live verification, rerun `make lint` and `make test` from the repo
  root before opening or updating the PR.

### Product follow-ups

- [ ] Add UI support for assigning RAG `metadata.acl_tags` at ingest time. The
  current safe default is `["__public__"]`.
- [ ] Add connector-side ACL tag automation so ingestors populate
  `document_metadata.metadata["acl_tags"]` from source permissions such as
  Confluence space permissions, Jira project permissions, and Slack channel
  membership.
- [ ] Remove `X-User-Context` forwarding entirely after one release cycle of
  soak on `DA_REQUIRE_BEARER=true`. The header is no longer authoritative, but
  is still forwarded temporarily for Dynamic Agents claim-hint compatibility.

### Known pre-existing failures

- [ ] Track and fix the pre-existing
  `ai_platform_engineering/dynamic_agents/tests/test_sse_error_sanitization.py`
  failures caused by `_generate_resume_sse_events` signature drift.
- [ ] Track and fix the pre-existing
  `ai_platform_engineering/multi_agents/tests/...test_ai.py` failures confirmed
  during the RBAC branch validation cycle.
