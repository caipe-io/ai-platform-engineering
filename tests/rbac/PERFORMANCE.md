# RBAC test suite — performance baseline

Performance invariant: a developer running `make test-rbac` on a current-gen
laptop sees the result inside **10 minutes** for the cheap lane and inside
**30 minutes** for the full Docker stack. If a run regresses past these limits,
open a GitHub Issue and consider raising the Playwright worker count.

## Methodology

- Hardware: M-series Mac (developer laptop)
- Repo state: initial comprehensive RBAC test-suite rollout
- Stack: migrated routes run; `migration_status: pending` rows are skipped by
  the matrix driver.
- Command: `/usr/bin/time -p make test-rbac` (no Docker stack, `RBAC_E2E` unset)
- The "cheap lane" runs the same three targets CI runs on every PR
  (`test-rbac-lint` → `test-rbac-pytest` → `test-rbac-jest`) and intentionally
  skips the Playwright Docker lane.

## Cheap lane — `make test-rbac` without `RBAC_E2E=1`

| Date       | Wall-clock | User CPU | Sys CPU | Notes                                              |
|------------|------------|----------|---------|----------------------------------------------------|
| 2026-04-22 | **6.22 s** | 3.24 s   | 1.46 s  | Phase 4 baseline. 72 jest assertions + 29 pytest.  |

Breakdown of what ran:

- **Lint** — `validate-rbac-matrix.py` (146 entries scanned), `validate-realm-config.py`
  (3 new resources cross-checked), `check-no-new-requireAdmin.sh` (32 legacy
  call sites covered by 49 `pending` matrix entries — all OK).
- **Pytest** — 564 collected, 29 passed, 535 skipped (Python surfaces are still
  `pending`, so the matrix-driver xfails them; helper-unit tests pass live).
- **Jest** — 546 collected, 72 passed, 474 skipped (UI BFF routes that haven't
  migrated yet are auto-`xit()`'d via `migration_status: pending`).

The 6 s number is for warm caches. A cold run (no `node_modules`, no `uv`
metadata cache) takes around **45–60 s**, dominated by `npm install` /
`uv sync`. CI hits the cold path once per workflow run.

## Full lane — `RBAC_E2E=1 make test-rbac`

### 2026-04-22 — first full-stack measurement (Phase 4 ship)

Recorded against the live e2e stack brought up via:

```bash
make test-rbac-up   # wraps:
# E2E_RUN=true MONGODB_HOST_PORT=28017 \
#   RBAC_FALLBACK_FILE=$(pwd)/deploy/keycloak/realm-config-extras.json \
#   RBAC_FALLBACK_CONFIG_PATH=/etc/keycloak/realm-config-extras.json \
#   COMPOSE_PROFILES='rbac,caipe-ui,caipe-mongodb,dynamic-agents,rag,mcp-servers,slack-bot' \
#   docker compose -f docker-compose.dev.yaml up -d
```

| Spec                                    | Personas | Wall-clock | Result | Notes                                        |
|-----------------------------------------|----------|------------|--------|----------------------------------------------|
| story-7-matrix-completeness.spec.ts     | 5        | 0.797 s    | PASS   | 5/5 — matrix id ↔ JUnit cross-check OK       |
| story-1-admin-ui.spec.ts (BLOCKED)      | 5        | n/a        | FAIL   | persona token mint failed — see below        |

Stack boot wall-clock (cold containers, recreate):

| Step                                              | Wall-clock | Notes                                    |
|---------------------------------------------------|------------|------------------------------------------|
| `docker compose up -d` (caipe-ui+dynamic-agents+rag) | ~95 s   | UI is the long pole (~60 s for next.js)  |
| `init-idp.sh` (persona seed + idp redirector)     | ~1 s       | (after the function-ordering bug fix)    |
| Playwright story-7 (5 personas, parallel)         | 0.8 s      | matrix-completeness; no live HTTP needed |
| **Total ready-to-test**                           | ~96 s      |                                          |

**Story 1 blocker (will be fixed in a follow-up — does not regress Phase 4 cheap lane):**

`init-idp.sh` posts `{"username":"alice_admin","email":"alice@example.com",…}` to the
realm, but the realm has `registrationEmailAsUsername: true`, so Keycloak ignores
the supplied `username` and creates the user as `alice@example.com`. The Playwright
fixture (`tests/rbac/fixtures/keycloak.ts`) then password-grants with
`username: "alice_admin"` → `invalid_grant`. Two clean fixes (either is fine, the
follow-up will pick one):

1. Disable `registrationEmailAsUsername` on the e2e realm (matches the script's
   intent — usernames like `alice_admin` are intentionally distinct from emails).
2. Update both the script and the fixture to use the email form
   (`alice@example.com`) as the canonical persona identifier.

Track follow-up work in GitHub Issues. The matrix-completeness contract is
validated by story-7, which is the structural gate for this test lane.

Anticipated upper bound for the **full** Phase 5–9 e2e lane: **15–20 min** with
the default 4 Playwright workers, based on per-route latency observations from
the helper-unit Keycloak round-trip (~50 ms p50 against the docker-compose
Keycloak). If we hit 25 min, file a Phase 11 polish task to bump workers and
split `story-7` into a separate job.

## How to re-run

```bash
# Cheap lane (no Docker)
/usr/bin/time -p make test-rbac

# Full lane (requires docker; brings up Keycloak+stack via test-rbac-up)
RBAC_E2E=1 RBAC_LINT_STRICT=1 /usr/bin/time -p make test-rbac
```

Append a new row to the table above whenever you run a fresh measurement —
keeping a chronological log here makes regressions obvious.
