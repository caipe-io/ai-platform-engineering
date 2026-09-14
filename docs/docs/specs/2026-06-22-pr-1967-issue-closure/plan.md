# PR #1967 — Issue closure and follow-up plan

**PR**: https://github.com/caipe-io/ai-platform-engineering/pull/1967  
**Branch**: `prebuild/feat/credentials-mcp-agentgateway-integration`

## Issues linked on merge

| Issue | Link type | Rationale |
|-------|-----------|-----------|
| [#1930](https://github.com/caipe-io/ai-platform-engineering/issues/1930) | `Fixes` | AgentGateway MCP credential + lifecycle editing (supersedes closed #1960) |
| [#1929](https://github.com/caipe-io/ai-platform-engineering/issues/1929) | `Fixes` | CAIPE JWT consumed at gateway `jwtAuth`; provider cred on `X-CAIPE-Provider-Token` |
| [#1942](https://github.com/caipe-io/ai-platform-engineering/issues/1942) | `Fixes` | Duplicate report of #1929 (Jira MCP wrong `Authorization` header) |
| [#1920](https://github.com/caipe-io/ai-platform-engineering/issues/1920) | `Fixes` | `build_agent_context_headers()` + shared HMAC for per-agent `tools/call` |
| [#1928](https://github.com/caipe-io/ai-platform-engineering/issues/1928) | `Fixes` | Same root cause as #1920 (403 on `tools/call` after successful credential resolution) |
| [#1911](https://github.com/caipe-io/ai-platform-engineering/issues/1911) | `Fixes` | Independent `credentials` vs `service_accounts` admin tab gates + server-side credential feature flag |
| [#1931](https://github.com/caipe-io/ai-platform-engineering/issues/1931) | `Relates to` | Partial fix in PR; needs live bot-path validation before `Fixes` — **G5 (P3)** |

## Follow-up gaps (post-merge)

| Gap | Priority | Issues | Summary |
|-----|----------|--------|---------|
| G3 | **P2** | #1929, #1942 | `jwtAuth` disabled → CAIPE bearer may still leak upstream |
| G4 | **P2** | #1911 | Credentials tab `isAdmin` vs API `admin_surface:credentials#can_manage` |
| G5 | **P3** | #1931 | Live Webex OBO → agent → team workflow E2E |
| G6 | **P4** | #1968 | Rebuild `caipe-dynamic-agents` for workflow step outputs in prod |

## What PR #1967 already delivers

### #1929 / #1942 — Bearer leak upstream

- AgentGateway listener `jwtAuth` strips inbound CAIPE bearer before upstream hop.
- Dynamic Agents / BFF place provider material on `X-CAIPE-Provider-Token`.
- `config_bridge.py` rewrites to upstream `Authorization` only for provider tokens.
- Tests: `deploy/agentgateway/tests/test_config_bridge.py`, `test_mcp_client_token_forwarding.py`.

### #1920 / #1928 — Agent-context HMAC

- `mcp_client.build_agent_context_headers()` signs `agent_id` when secret is set.
- OpenFGA authz bridge verifies signature for per-tool `can_call`.
- Compose wires secret to **dynamic-agents** and **openfga-authz-bridge**.
- Unit tests: `test_mcp_client_token_forwarding.py`, bridge tests.
- **G1 + G2 (done):** Helm `agentContext.existingSecret` on dynamic-agents, `.env.example` + `setup-caipe.sh` bootstrap, startup warning. See [Agent context HMAC](../../security/rbac/agent-context-hmac.md).

**What the secret does (short):** shared HMAC key so dynamic-agents / caipe-ui can sign *which agent* is calling an MCP tool through AgentGateway; the bridge verifies the signature and enforces `user can_use agent` + `agent can_call tool` instead of only the coarse `mcp_gateway:list` gate.

### #1911 — Credentials vs Service Accounts gates

- Admin tab gates: separate `credentials` and `service_accounts` keys.
- `credentials` tab: `isAdmin && credentialsEnabled`.
- Admin credential APIs: `requireAdminSurfaceManage(session, "credentials")` + `assertFeatureEnabled()`.
- Tests: `admin-tab-gates/__tests__/route.test.ts`, `credentials-workspace-regression.spec.ts`.

### #1931 — Bot workflow PDP (partial)

- `WorkflowApiClient(user_bearer=self._auth_bearer)` in `agent_runtime.py`.
- Webex bot passes OBO JWT on `Authorization` → dynamic-agents chat stream.
- `fix(rbac): allow team workflow owners to run without team membership`.
- Tests: `test_workflow_user_delegation.py`, `workflow-agent-user-delegation*.spec.ts`.

---

## Gaps (not fully closed by PR #1967)

### G1 — HMAC secret not wired in Helm for dynamic-agents (#1920 / #1928) — **Done**

**Was:** `CAIPE_AGENT_CONTEXT_HMAC_SECRET` was wired for openfga-authz-bridge only; Kubernetes dynamic-agents pods could 403 on `tools/call` while compose worked.

**Delivered:**

1. `agentContext.existingSecret` on dynamic-agents subchart (mirrors bridge).
2. `CAIPE_AGENT_CONTEXT_HMAC_SECRET` via `secretKeyRef` in deployment template.
3. Umbrella `values.yaml` + `NOTES.txt` warning when gateway MCP routing is on but secret is unwired.
4. `setup-caipe.sh` Helm `--set` for bridge **and** dynamic-agents → `caipe-ui-secret`.
5. Chart tests in `tests/test_dynamic_agents_chart_keycloak_env.py`.

**Blip:** same shared secret as the bridge — signs `X-CAIPE-Agent-Context` so per-agent `allowed_tools` enforcement works at AgentGateway. [Docs](../../security/rbac/agent-context-hmac.md).

### G2 — HMAC secret missing from local bootstrap (#1920 / #1928) — **Done**

**Was:** Compose referenced `${CAIPE_AGENT_CONTEXT_HMAC_SECRET:-}` but `.env.example` did not document it; fresh dev stacks skipped per-agent tool enforcement silently.

**Delivered:**

1. `CAIPE_AGENT_CONTEXT_HMAC_SECRET` + `OPENFGA_RECONCILE_ENABLED` in root `.env.example` (with `openssl rand -hex 32` note).
2. `setup-caipe.sh` idempotent patch into `caipe-ui-secret` when AgentGateway is enabled.
3. `warn_if_agent_gateway_missing_hmac()` at dynamic-agents startup when `AGENT_GATEWAY_URL` is set but secret is empty.

**Blip:** without this env var, AgentGateway still does coarse user-level checks; `tools/call` may 403 when you expect per-agent tool policy. Set the secret in `.env` for local dev. [Docs](../../security/rbac/agent-context-hmac.md).

### G3 — jwtAuth-disabled regression guard (#1929 / #1942) — **P2**

**Gap**: Fix assumes `jwtAuth` is enabled. Custom deployments that disable `jwtAuth` can still forward CAIPE bearer upstream.

**Plan**

1. Add bridge/config test: with `jwtAuth` disabled, assert upstream request does **not** include caller `Authorization` when provider token is on `X-CAIPE-Provider-Token`.
2. Document in AgentGateway README: `jwtAuth` is **required** for MCP routes in production; disabling reopens #1929.
3. Optional: fail chart render if `jwtAuth.enabled: false` and MCP targets are configured.

### G4 — Admin Credentials tab FGA parity (#1911) — **P2**

**Gap**: Tab visibility uses `isAdmin && credentialsEnabled` but API routes use `admin_surface:credentials#can_manage`. A scoped credentials admin (manager tuple, not org admin) may not see the tab while APIs would allow access (or vice versa in simulation).

**Plan**

1. Change `admin-tab-gates` credentials branch to: `credentialsEnabled && (org admin OR admin_surface:credentials can_manage)`.
2. Add E2E matrix: `(credentialsEnabled × service_accounts visible × FGA tuple)` — 4 combinations.
3. Confirm Service Accounts tab still works with `credentialsEnabled=false`.

### G5 — #1931 live validation (bot → agent → workflow) — **P3**

**Gap**: Unit + mocked E2E cover delegation; no live test for Webex OBO → agent chat → `start_workflow_run` → BFF 201 on a **team** workflow.

**Plan**

1. Add `ui/e2e/rbac/webex-workflow-delegation-live.spec.ts` (or extend `workflow-agent-user-delegation-live.spec.ts`):
   - Team workflow + workflow agent with `builtin_tools.workflows`.
   - Simulate Webex OBO bearer (Keycloak token exchange fixture or test user).
   - POST `/api/v1/chat/stream/start` with workflow-triggering message; assert workflow run 201 via BFF audit or `get_workflow_run_status`.
2. Verify **agent → workflow** OpenFGA tuples exist (workflow agent access modal / save path).
3. If live test flakes on OBO, add integration test in `webex_bot` that mocks SSE + asserts `Authorization: Bearer <obo>` reaches dynamic-agents.
4. After green live run, change PR/issue link from `Relates to` → `Fixes #1931`.

### G6 — Workflow output visibility (UX) — **P4** — [#1968](https://github.com/caipe-io/ai-platform-engineering/issues/1968)

**Gap**: Webex/Slack/chat now surface step outputs in PR branch, but **production** needs a rebuilt `caipe-dynamic-agents` image for `wait_for_completion` + response prompts to take effect.

**Plan**

1. Rebuild/publish `caipe-dynamic-agents` prebuild image for PR branch.
2. Manual smoke: Webex workflow agent → run → thread shows step text (not only “completed”).
3. Optional: extend `chat-workflow-run-card.spec.ts` for polling state.

---

## Execution order (recommended)

| Phase | Items | Owner / effort |
|-------|--------|----------------|
| **P0 — Before merge** | Update PR #1967 body with `Fixes` lines; merge #1967 | 15 min |
| **P1 — Release blockers** | ~~G1 Helm HMAC, G2 env bootstrap~~ **done** | — |
| **P2 — Hardening** | G3 jwtAuth guard, G4 FGA tab parity | 1 day |
| **P3 — Close #1931** | G5 live Webex workflow delegation test | 1–2 days |
| **P4 — Polish** | G6 image rebuild + manual Webex smoke | 0.5 day |

---

## PR description snippet (paste into #1967)

```markdown
Fixes #1930
Fixes #1929
Fixes #1942
Fixes #1920
Fixes #1928
Fixes #1911

Relates to #1931 — workflow user-bearer delegation landed; live Webex bot → agent → team workflow validation tracked in `docs/docs/specs/2026-06-22-pr-1967-issue-closure/plan.md` (G5).
```

## Verification checklist (post-merge)

- [x] `CAIPE_AGENT_CONTEXT_HMAC_SECRET` set in Helm for **both** dynamic-agents and openfga-authz-bridge (G1 — `agentContext.existingSecret`, `setup-caipe.sh`)
- [x] Documented in `.env.example` + [Agent context HMAC](../../security/rbac/agent-context-hmac.md) (G2)
- [ ] Jira MCP test-tool: credential resolution shows `provider_connection` or `secret_ref`, not CAIPE JWT on upstream
- [ ] Admin: Service Accounts visible with `credentialsEnabled=false`
- [ ] Admin: Credentials hidden with `credentialsEnabled=false`
- [ ] Live: Webex OBO user triggers team workflow via custom agent (201, not `pdp_denied`)
