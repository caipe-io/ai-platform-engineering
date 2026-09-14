# Problem Statement: Centralized BFF Authorization & PDP-Agnostic API

**Status:** Draft for second-opinion review<br />
**Date:** 2026-06-05<br />
**Authors:** Sri Aradhyula (problem framing); AI-assisted synthesis from PR review + team discussion<br />
**Audience:** Platform engineers, security architects, agents reviewing implementation options<br />

**Related work:**

| Link | Role |
|------|------|
| [PR #1751](https://github.com/caipe-io/ai-platform-engineering/pull/1751) | Workflow RBAC visibility, run access, unsaved UX, agent-access modal |
| [PR #1751 review r3362688683](https://github.com/caipe-io/ai-platform-engineering/pull/1751#discussion_r3362688683) | @subbaksh: workflows are UI/BFF concept; DA should not own workflow RBAC |
| [Issue #1742](https://github.com/caipe-io/ai-platform-engineering/issues/1742) | Epic: RBAC/Auth review remediation (PR #1444 follow-ups) |
| [Issue #1755](https://github.com/caipe-io/ai-platform-engineering/issues/1755) | Skills RBAC UI parity / shared-module hygiene (#1727 follow-up) |
| [Issue #1455](https://github.com/caipe-io/ai-platform-engineering/issues/1455) | Runtime BFF ReBAC endpoints for Slack/Webex bots |
| [Issue #1454](https://github.com/caipe-io/ai-platform-engineering/issues/1454) | Refactor DA runtime auth surface |
| [Issue #1731](https://github.com/caipe-io/ai-platform-engineering/issues/1731) | Duplicate OpenFGA `can_use` on DA chat path |
| [Issue #1734–#1738](https://github.com/caipe-io/ai-platform-engineering/issues/1742) | RAG thin PEP / Mongo in hot path |

---

## 1. Executive summary

CAIPE has **reusable RBAC modules on the BFF** (Next.js UI server) and **CI guards** for new resource types, but authorization is still implemented inconsistently across surfaces:

- **Dynamic Agents (DA)** sometimes reads **MongoDB** for UI-domain data (e.g. `workflow_configs`, `teams`) and duplicates **OpenFGA** checks the BFF already performs.
- **RAG** still uses a **monolithic `server/rbac.py`** that mixes token validation, legacy roles, OpenFGA, and MongoDB — a different pattern than agents/KB/MCP on the BFF.
- **Public APIs and errors** expose OpenFGA-specific concepts (`agent#use`, `pdp_denied`, tuple strings), coupling integrators and UI copy to the current PDP.
- **HTTP authorization** is fragmented: admin-only `rebac/check`, domain-specific `access-check` routes, and no generic **runtime** evaluate API for service callers (bots, DA).

After testing **0.5.9** and reviewing **PR #1751**, the team wants to:

1. **Stop creating anti-patterns** (DA → Mongo for workflows; one-off RBAC per resource).
2. **Enforce shared module usage** going forward (linters, hygiene).
3. **Make the authorization API PDP-agnostic** so OpenFGA is an implementation detail, not a user-facing contract.
4. **Centralize policy decisions on the BFF** where platform domain data lives (workflows, teams, visibility).

This document captures the **problem statement**, **current state**, **stakeholder input**, and **implementation options** for a follow-up spec.

---

## 2. Problem statement

### 2.1 Core problem

**Authorization logic and platform domain data are scattered across BFF, Dynamic Agents, RAG, and Slack bot**, with multiple parallel patterns for the same decision (`user X may use resource Y`). This causes:

1. **Architectural drift** — reviewers repeatedly flag DA/RAG reading Mongo or re-implementing visibility rules that belong on the BFF.
2. **Duplicate PDP hops** — BFF checks OpenFGA, then DA checks OpenFGA again (latency, availability, confusion about source of truth).
3. **Inconsistent developer experience** — agents use `shareable-resource.ts` + `resource-authz.ts`; RAG uses `rbac.py`; workflows added DA-side Mongo reads in PR #1751.
4. **Leaky abstraction** — API consumers see OpenFGA relation names and PDP jargon instead of stable product-level denial reasons.
5. **Weak enforcement** — CI guarantees new **types** are registered and default-deny tested, but does not force routes/services to use shared modules vs ad-hoc checks.

### 2.2 Triggering incidents (this conversation)

#### A. PR #1751 — workflow RBAC + DA delegation

PR [#1751](https://github.com/caipe-io/ai-platform-engineering/pull/1751) adds:

- BFF: workflow visibility, run access gates, team slug normalization, unsaved UX, agent-access modal on save.
- DA: `workflow_execution_authz.py` — reads `workflow_configs` and `teams` from Mongo; allows `agent#can_use` bypass when `workflow_config_id` is passed on chat requests.

**Reviewer feedback (@subbaksh, [r3362688683](https://github.com/caipe-io/ai-platform-engineering/pull/1751#discussion_r3362688683)):**

> Workflows are purely a UI server concept. The UI invokes agents one step at a time. DA usually has no clue whether it's a workflow or a user chatting. For invocation — the DA server just has a tool (with `workflow_id` param) that it calls to invoke a workflow. The RBAC for invocation should be in UI server no?

**Assessment:** The reviewer is aligned with epic [#1742](https://github.com/caipe-io/ai-platform-engineering/issues/1742). Workflow lifecycle auth already exists on the BFF (`/api/workflow-runs`, `workflow-config-rebac.ts`). DA Mongo reads are an anti-pattern; the bypass exists only because the workflow engine forwards the **user JWT** to DA and DA enforces `agent#can_use` independently.

#### B. Reusable modules — one path did not use them

Shared modules were introduced for **unified shareable resource RBAC** (spec `2026-06-03-unified-shareable-resource-rbac`):

- **Write path:** `ui/src/lib/rbac/shareable-resource.ts` → `openfga-owned-resources.ts` (`reconcileShareableResource`)
- **Read path:** `ui/src/lib/rbac/resource-authz.ts` (`requireResourcePermission`, `filterResourcesByPermission`)

Skills team sharing was fixed in [#1729](https://github.com/caipe-io/ai-platform-engineering/pull/1729) to use `reconcileShareableResource`. Follow-up [#1755](https://github.com/caipe-io/ai-platform-engineering/issues/1755) tracks optional UI DRY (`useShareableTeams` hook) and documents explicit non-goals (skills as owner-team resources).

**Gap:** Not every feature path uses the shared stack. PR #1751’s DA workflow auth is the latest example of **bypassing** BFF modules entirely.

#### C. Team discussion (Kevin Kantesaria, 2026-06-05)

Paraphrased Slack thread:

| Speaker | Point |
|---------|--------|
| Sri | Created [#1755](https://github.com/caipe-io/ai-platform-engineering/issues/1755) to track cleanup after reusable modules; one instance did not use them. |
| Kevin | Push cleanup soon so we don’t keep creating anti-patterns; unsure how to **enforce** going forward. |
| Sri | Added basic RBAC enforcement for new resources; need linters and hygiene. |
| Kevin | Does that enforcement **use the modules**? Original problem: **RAG and agents used different RBAC setups** — want to avoid that. |
| Kevin / Sri | Make **OpenFGA less obvious** to end users; API should be **agnostic** if we switch PDP. |

### 2.3 Goals (desired end state)

1. **Single policy ownership** — BFF owns platform domain data (workflows, teams, visibility) and composes FGA + product rules.
2. **Single module stack** — application code uses `shareable-resource` / `resource-authz` (or a thin facade), not raw `openfga.ts` or service-local Mongo policy.
3. **PDP-agnostic public contract** — HTTP and user-facing errors use `{ resource, action, reason }`, not `can_use` / `agent#use` / `pdp_denied`.
4. **Thin PEPs downstream** — DA, RAG, bots either trust BFF decisions via API or verify signed claims; they do not read `workflow_configs` from Mongo for authz.
5. **Enforceable in CI** — import boundaries, create-path linter extensions, no new anti-patterns without explicit spec exception.

### 2.4 Non-goals (for initial spec)

- Replacing OpenFGA as the relationship store (unless a separate strategic decision).
- Removing all OpenFGA checks from DA in v1 (tracked as [#1731](https://github.com/caipe-io/ai-platform-engineering/issues/1731); depends on [#1458](https://github.com/caipe-io/ai-platform-engineering/issues/1458) dual-gate documentation).
- Migrating skills to owner-team model ([#1708](https://github.com/caipe-io/ai-platform-engineering/pull/1708)) — separate from this problem.

---

## 3. Current state (as of 2026-06-05, branch `prebuild/feat/workflow-rbac-visibility-unsaved`)

### 3.1 BFF authorization layers

```text
┌─────────────────────────────────────────────────────────────────┐
│  BFF route handler (ui/src/app/api/**/route.ts)                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
  requireRbacPermission   requireResourcePermission   Domain helpers
  (api-middleware.ts)     (resource-authz.ts)         (workflow-config-rebac,
   org/capability gates                             slack-channel-rebac, …)
         │                   │                   │
         └───────────────────┼───────────────────┘
                             ▼
              checkOpenFgaTuple / checkUniversalRebacRelationship
                             (openfga.ts)
                             ▼
                        OpenFGA HTTP API
```

#### Key modules

| Module | Path | Responsibility |
|--------|------|----------------|
| OpenFGA transport | `ui/src/lib/rbac/openfga.ts` | `checkOpenFgaTuple`, tuple read/write/reconcile |
| Resource ReBAC | `ui/src/lib/rbac/resource-authz.ts` | `requireResourcePermission`, `filterResourcesByPermission`, `requireAgentPermission`, `requireSkillPermission` |
| Agent use (chat proxy) | `ui/src/lib/rbac/openfga-agent-authz.ts` | `requireAgentUsePermission` — used by `/api/v1/chat/*` |
| Agent use (audit path) | `ui/src/lib/rbac/pdp-shared.ts` | `evaluateAgentAccess` — direct + team-union with reason codes |
| Shareable write | `ui/src/lib/rbac/shareable-resource.ts` | `handleShareableResourceWrite`, `resolveShareableOwnershipWrite` |
| FGA reconcile | `ui/src/lib/rbac/openfga-owned-resources.ts` | `reconcileShareableResource` |
| Workflow policy | `ui/src/lib/rbac/workflow-config-rebac.ts` | Visibility, `workflowDelegatesAgentUse`, `reconcileWorkflowConfigAccess` (uses `reconcileShareableResource`) |
| Access explain (admin) | `ui/src/lib/rbac/access-explainer.ts` | `explainAccess` + Mongo provenance |
| Type registry | `ui/src/types/rbac-universal.ts` | `UniversalRebacResourceType`, `UniversalRebacRelationship` |
| Enforcement manifest | `ui/src/lib/rbac/fga-enforcement-manifest.ts` | Per-type `rebac_enforced` / surfaces for auditors |

#### HTTP APIs that expose authorization today

| Endpoint | Auth gate | Purpose | Runtime-safe? |
|----------|-----------|---------|---------------|
| `POST /api/admin/rebac/check` | `admin_ui#view` | Explain access (`explainAccess`) | **No** — admin only |
| `POST /api/integrations/slack/.../access-check` | Session + `slack_channel#read` | `checkSlackChannelAccess` | **Partial** — bot path evolving |
| `POST /api/integrations/webex/.../access-check` | Same pattern | Webex space access | **Partial** |
| `POST /api/admin/slack/.../access-check` | Admin | Diagnostics | No |
| `POST /api/admin/openfga/relationship` | Admin | Tuple grant/revoke | No (write) |
| `POST /api/workflow-runs` | `assertCanExecuteWorkflowRunsForConfigId` | Start run | Yes — domain API |
| `POST /api/workflow-configs/check-agent-access` | `withAuth` | Pre-save agent gap check (PR #1751) | Yes — BFF-only |
| DA `WorkflowApiClient` → `/api/workflow-runs` | OAuth2 client credentials | Workflow tools from agents | Yes — correct pattern |

**There is no generic `POST /api/runtime/authorize` today.**

Spec draft exists: `docs/docs/specs/2026-05-11-identity-group-rebac/contracts/rebac-policy-api.md` (`POST /api/admin/rebac/check` with `UniversalRebacRelationship`).

### 3.2 CI enforcement (FGA coverage guarantee, spec 2026-06-04)

| Layer | Artifact | What it enforces |
|-------|----------|------------------|
| 1 | `fga-type-coverage.test.ts` | OpenFGA model ≡ type registry ≡ chart |
| 2 | `fga-enforcement-manifest.test.ts` | Every type classified; enforced surfaces exist on disk |
| 3 | `scripts/validate-fga-create-paths.py` | Ownable types wire `reconcile*Relationships` from production routes |
| 4 | `default-deny-coverage.test.ts` | New types auto-covered for deny-by-default |

**Gap:** Layers 1–4 do **not** require routes to call `shareable-resource` / `resource-authz` vs ad-hoc `checkOpenFgaTuple`. They do **not** block DA/RAG Mongo reads for authz.

### 3.3 Dynamic Agents — workflow-related anti-patterns

| Location | Mongo / policy | Issue |
|----------|----------------|-------|
| `dynamic_agents/auth/workflow_execution_authz.py` | Reads `workflow_configs`, `teams` | Duplicates BFF visibility; reviewer rejected |
| `dynamic_agents/auth/openfga_authz.py` | OpenFGA + workflow bypass | Third auth layer on chat path |
| `dynamic_agents/services/agent_runtime.py` | Reads `workflow_configs` for builtin tool validation | Should use BFF resolve API |
| `dynamic_agents/services/builtin_tools.py` | `WorkflowApiClient` → BFF | **Correct** pattern for invocation |

### 3.4 RAG vs agents — divergent stacks

| Concern | Agents / BFF resources | RAG server |
|---------|------------------------|------------|
| Read/use gate | `resource-authz.ts` → OpenFGA | `server/rbac.py` (mixed) |
| Share/write | `shareable-resource.ts` | Partial (KB sharing route on BFF); ingestor paths differ |
| Mongo in authz hot path | Mostly moved to BFF | Still present ([#1736](https://github.com/caipe-io/ai-platform-engineering/issues/1736)) |
| Target architecture | Unified shareable resource RBAC | [Thin PEP plan](../2026-05-19-rag-thin-pep-openfga/plan.md) |

Kevin’s concern: **“RAG and agents used different RBAC setups”** — still true at the Python RAG layer.

### 3.5 PR #1751 commit inventory (relevant)

| Commit / area | BFF-aligned? | Notes |
|---------------|--------------|-------|
| Workflow run access (`workflow-run-access.ts`) | Yes | |
| `workflow-config-rebac.ts` + `reconcileShareableResource` | Yes | |
| Unsaved UX, team slugs, `TeamMultiPicker` | Yes | |
| `check-agent-access` + `WorkflowAgentAccessModal` | Yes | Pre-grant agent tuples on save |
| `workflow_execution_authz.py` on DA | **No** | Remove or defer to epic |
| `workflow_config_id` on DA chat body | **No** | Remove with above |

### 3.6 User-visible OpenFGA leakage (examples)

From `openfga-agent-authz.ts` and `resource-authz.ts`:

```json
{
  "success": false,
  "error": "Permission denied",
  "code": "agent#use",
  "reason": "pdp_denied",
  "action": "contact_admin"
}
```

Admin explain responses include FGA tuple strings. Audit events use `pdp: "openfga"`. These are appropriate for **operators**, not for generic API consumers or end-user copy.

---

## 4. Architectural principles (agreed direction)

1. **Workflows are a BFF concern** — config, visibility, run orchestration, delegation checks live in UI server + `workflow-engine.ts`.
2. **DA invokes agents; DA workflow tools invoke workflows via BFF** — `WorkflowApiClient` is the model.
3. **OpenFGA is the current PDP for relationships** — but **callers** should not depend on FGA tuple shape.
4. **Defense-in-depth is optional and explicit** — duplicate DA OpenFGA ([#1731](https://github.com/caipe-io/ai-platform-engineering/issues/1731)) must be a documented choice ([#1458](https://github.com/caipe-io/ai-platform-engineering/issues/1458)), not accidental duplication.
5. **Epic [#1742](https://github.com/caipe-io/ai-platform-engineering/issues/1742) phases** — runtime BFF endpoints ([#1455](https://github.com/caipe-io/ai-platform-engineering/issues/1455)) before bots/DA drop Mongo.

---

## 5. Options (detailed)

### Option 1 — In-process Authz facade (BFF library)

**Summary:** Introduce `ui/src/lib/authz/` as the **only** import surface for application authorization. OpenFGA moves behind a `PolicyEngine` interface.

#### Proposed structure

```text
ui/src/lib/authz/
  index.ts                 # authorize(), filterAccessible(), reconcileShares()
  types.ts                 # Subject, Resource, Action, Decision (PDP-agnostic)
  errors.ts                # PERMISSION_DENIED, AUTHZ_UNAVAILABLE
  engines/
    openfga-adapter.ts     # implements PolicyEngine today
  domains/
    workflow.ts            # workflowDelegatesAgentUse, visibility (Mongo product policy)
    slack-channel.ts
    webex-space.ts
```

#### Public API (sketch)

```typescript
interface AuthorizeRequest {
  subject: { type: "user" | "service_account"; id: string };
  resource: { type: UniversalRebacResourceType; id: string };
  action: ResourcePermissionAction;
  context?: Record<string, unknown>; // workflow_id, channel_id, etc.
}

interface AuthorizeDecision {
  allowed: boolean;
  reason: "OK" | "NO_CAPABILITY" | "AUTHZ_UNAVAILABLE" | "INVALID_REQUEST";
  action?: "sign_in" | "contact_admin" | "retry";
  // Admin-only extension:
  debug?: { engine: string; path?: string };
}

async function authorize(req: AuthorizeRequest): Promise<AuthorizeDecision>;
async function authorizeOrThrow(req: AuthorizeRequest): Promise<void>;
```

#### Migration

1. Wrap existing `resource-authz.ts`, `pdp-shared.ts`, domain modules.
2. Deprecate direct `checkOpenFgaTuple` imports outside `lib/authz/**`.
3. Map existing `ApiError` codes to PDP-agnostic envelope.

#### Pros

- No new network hop; fits existing Next.js deployment.
- Clear import boundary for ESLint.
- Enables future non-OpenFGA engine without route changes.

#### Cons

- Does not alone fix DA/RAG — they don’t run inside BFF.
- Requires disciplined migration of ~dozens of route call sites.

#### Enforcement

```javascript
// eslint no-restricted-imports
"@/lib/rbac/openfga" → only from "@/lib/authz/**"
```

---

### Option 2 — Runtime HTTP authorize API (BFF routes)

**Summary:** Expose authorization decisions as HTTP for **service callers** (Slack bot, Webex bot, Dynamic Agents). Implements [#1455](https://github.com/caipe-io/ai-platform-engineering/issues/1455) and generalizes `access-check` routes.

#### Proposed endpoint

```http
POST /api/runtime/authorize
Authorization: Bearer <user-jwt | service-account-token>
Content-Type: application/json

{
  "subject": { "type": "user", "id": "<oidc-sub>" },
  "resource": { "type": "agent", "id": "platform-engineer" },
  "action": "use",
  "context": {
    "workflow_config_id": "wf-optional-hint"
  }
}
```

**Response (allow):**

```json
{
  "allowed": true,
  "reason": "OK"
}
```

**Response (deny):**

```json
{
  "allowed": false,
  "reason": "NO_CAPABILITY",
  "action": "contact_admin"
}
```

**Response (PDP down):**

```json
{
  "allowed": false,
  "reason": "AUTHZ_UNAVAILABLE",
  "action": "retry"
}
```

#### Domain-specific endpoints (alternative/complement)

Instead of one generic endpoint, extend the **access-check pattern**:

| Endpoint | Caller | Checks |
|----------|--------|--------|
| `POST /api/runtime/authorize` | Generic | FGA + optional context handlers |
| `POST /api/runtime/workflows/authorize-run` | DA, internal | Workflow visibility + step agents |
| `POST /api/runtime/workflows/resolve-configs` | DA | Replace Mongo `workflow_configs` read |
| Existing Slack/Webex `access-check` | Bots | Channel/space scoped |

#### Authentication model

- **User bearer** — subject must match token `sub` (or OBO chain).
- **Service account** — `service_account:<client_id>` in FGA; may evaluate on behalf of user when `context.delegated_subject` is present and bot OBO is valid (needs threat model).

#### Pros

- DA/RAG/bots stop reading Mongo for policy.
- Single HTTP contract for integrators.
- Aligns with epic [#1742](https://github.com/caipe-io/ai-platform-engineering/issues/1742) prerequisite [#1455](https://github.com/caipe-io/ai-platform-engineering/issues/1455).

#### Cons

- Latency and availability — every DA chat could add BFF round-trip unless cached or combined with Option 3.
- Duplicates [#1731](https://github.com/caipe-io/ai-platform-engineering/issues/1731) debate if DA **still** checks OpenFGA after BFF says allow.

#### Implementation notes

- Implement handlers by delegating to Option 1 facade internally.
- Admin `POST /api/admin/rebac/check` remains explain-only with richer `debug` payload.

---

### Option 3 — Signed authorization claims (PEP-only downstream)

**Summary:** BFF is the **sole PDP**. After `authorize()`, BFF mints a **short-lived signed claim** (JWT or HMAC macaroon) attached to downstream requests. DA/RAG verify signature + expiry only.

#### Claim sketch

```json
{
  "iss": "caipe-bff",
  "sub": "user:<oidc-sub>",
  "resource": "agent:platform-engineer",
  "action": "use",
  "iat": 1710000000,
  "exp": 1710000060,
  "jti": "unique-id"
}
```

DA `require_agent_use_permission` becomes `require_authorization_claim` — no OpenFGA client in DA.

#### Pros

- Eliminates duplicate OpenFGA in DA ([#1731](https://github.com/caipe-io/ai-platform-engineering/issues/1731)).
- True PDP agnostic at service boundary.
- Workflow delegation encoded in claim issuance on BFF (no `workflow_config_id` on DA).

#### Cons

- Largest engineering cost: key management, revocation, clock skew, claim replay.
- Requires [#1458](https://github.com/caipe-io/ai-platform-engineering/issues/1458) dual-gate retirement plan.
- Workflow engine currently forwards **user JWT** — would need claim issuance at run start and per step.

#### When to choose

- Phase 3+ of [#1742](https://github.com/caipe-io/ai-platform-engineering/issues/1742), after runtime BFF API proves correct.

---

### Option 4 — Enforcement-first (linters + manifest, minimal API change)

**Summary:** Keep current modules; **block anti-patterns in CI** without redesigning HTTP APIs yet.

#### Proposed guards

| Guard | Mechanism | Blocks |
|-------|-----------|--------|
| Import boundary | ESLint `no-restricted-imports` | `checkOpenFgaTuple` outside `lib/rbac/**` or `lib/authz/**` |
| Service boundary | `scripts/validate-authz-boundaries.py` | `workflow_configs` / `teams` reads in `dynamic_agents/**` for authz |
| Route coverage | Extend `validate-fga-create-paths.py` or new script | New routes must import from `resource-authz` or `authz` facade |
| Manifest update | `fga-enforcement-manifest.ts` | Add surfaces for `task` (workflows), runtime authorize routes |
| PR template | Checkbox | “Uses shareable-resource / resource-authz / domain wrapper” |

#### Pros

- Fastest win; addresses Kevin’s “don’t create more anti-patterns.”
- Low risk; parallel to other options.

#### Cons

- Does not fix RAG `rbac.py` or user-visible OpenFGA strings.
- Does not give DA a supported API without Option 2.

---

### Option 5 — Universal relationship contract (spec-only standardization)

**Summary:** Standardize all checks on `UniversalRebacRelationship` from `rbac-universal.ts` — already in [rebac-policy-api.md](../2026-05-11-identity-group-rebac/contracts/rebac-policy-api.md).

#### Request shape

```json
{
  "subject": { "type": "user", "id": "user-123", "relation": "member" },
  "action": "use",
  "resource": { "type": "agent", "id": "platform-engineer" },
  "context": { "slack_channel": "C123" }
}
```

#### Mapping

- Internal: `checkUniversalRebacRelationship(relationship)` in `openfga.ts`.
- `action: "use"` maps to FGA relation `can_use` inside adapter — **not** exposed to clients.

#### Pros

- One vocabulary for docs, admin UI, runtime API, tests.
- Natural fit for Option 1 + Option 2.

#### Cons

- `action` names still mirror current FGA model; true PDP swap requires adapter mapping table per engine.

---

## 6. PDP-agnostic public surface (cross-cutting)

Regardless of option, define a **stable external contract**:

### 6.1 Error envelope migration

| Current | Target (public) | Admin/debug only |
|---------|-----------------|------------------|
| `code: "agent#use"` | `code: "PERMISSION_DENIED"` | `detail: "agent#use"` |
| `reason: "pdp_denied"` | `reason: "NO_CAPABILITY"` | |
| `reason: "pdp_unavailable"` | `reason: "AUTHZ_UNAVAILABLE"` | |
| `pdp: "openfga"` in JSON body | Omit | Keep in audit logs |
| FGA tuple in error message | Omit | `POST /api/admin/rebac/check` |

### 6.2 Stable reason codes

| Code | Meaning | User `action` hint |
|------|---------|-------------------|
| `OK` | Allowed | — |
| `NO_CAPABILITY` | Deny — no relationship | `contact_admin` |
| `NOT_SIGNED_IN` | Missing/invalid auth | `sign_in` |
| `AUTHZ_UNAVAILABLE` | PDP timeout/error | `retry` |
| `INVALID_REQUEST` | Bad resource id / malformed | `fix_request` |

### 6.3 Two-tier API

| Tier | Audience | OpenFGA visible? |
|------|----------|------------------|
| **Runtime** | UI, bots, DA, RAG PEP | No |
| **Admin explain** | Operators, support | Yes (paths, tuples, provenance) |

---

## 7. Workflow-specific resolution (PR #1751)

### 7.1 Correct split of responsibility

| Operation | Owner | Mechanism |
|-----------|-------|-----------|
| Create/update workflow config | BFF | `workflow-configs` routes + `reconcileWorkflowConfigAccess` |
| Start/list/cancel/resume run | BFF | `/api/workflow-runs` + `workflow-run-access.ts` |
| Pre-save agent access gaps | BFF | `check-agent-access` + grant via `/api/admin/openfga/relationship` |
| Orchestrate steps | BFF `workflow-engine.ts` | Calls DA with user auth headers |
| Agent `#can_use` at DA | DA OpenFGA only | **No workflow Mongo** — team access via pre-granted tuples or BFF-only delegation |
| DA workflow tools | DA → BFF | `WorkflowApiClient` /api/workflow-runs |

### 7.2 `workflowDelegatesAgentUse` (exists, unused)

Defined in `workflow-config-rebac.ts`:

- Agent listed in workflow steps **and**
- `workflowRunAllowedByVisibility` for caller

**Action:** Wire at `POST /api/workflow-runs` and optionally before each `consumeAgentStream` in `workflow-engine.ts`. Remove DA `workflow_execution_authz.py`.

### 7.3 Global workflow gap

`check-agent-access` detects `(all users)` gaps but grant loop skips them. Spec should decide: org-wide agent grants vs admin-only warning.

---

## 8. Recommended phased approach

| Phase | Scope | Options | Depends on |
|-------|-------|---------|------------|
| **0 — Immediate** | PR #1751 cleanup | Remove DA workflow Mongo; keep BFF-only RBAC | — |
| **1 — Hygiene** | CI + docs | Option 4 + [#1755](https://github.com/caipe-io/ai-platform-engineering/issues/1755) UI DRY | — |
| **2 — Facade** | BFF routes | Option 1 + Option 5 + error envelope §6 | Phase 1 |
| **3 — Runtime API** | Bots, DA read paths | Option 2 ([#1455](https://github.com/caipe-io/ai-platform-engineering/issues/1455)) | Phase 2 |
| **4 — RAG convergence** | `rbac.py` thin PEP | Option 1 client in Python or Option 2 HTTP | [#1734](https://github.com/caipe-io/ai-platform-engineering/issues/1734) |
| **5 — Optional** | DA duplicate FGA removal | Option 3 | [#1458](https://github.com/caipe-io/ai-platform-engineering/issues/1458), [#1731](https://github.com/caipe-io/ai-platform-engineering/issues/1731) |

---

## 9. Open questions for second opinion

1. **DA execution gate:** Keep OpenFGA in DA for `agent#use` ([#1731](https://github.com/caipe-io/ai-platform-engineering/issues/1731)) or move to BFF-only + signed claims (Option 3)?
2. **Workflow delegation without agent tuples:** Is pre-grant on save (modal) sufficient for team workflows, or must runtime delegation work without prior grants?
3. **Generic vs domain HTTP APIs:** One `POST /api/runtime/authorize` vs family of `access-check` endpoints?
4. **RAG:** HTTP client to BFF vs shared Python library duplicating facade logic?
5. **Service account delegation:** How should bots evaluate access **for** a user without admin UI perms?
6. **Claim revocation:** Required for Option 3, or acceptable 60s TTL?
7. **Breaking API changes:** Version `/api/v2/` for error envelope, or migrate in place?
8. **Workflow `task` type in FGA:** Is Mongo visibility a permanent product layer on top of FGA, or should all run access be FGA-only eventually?

---

## 10. Acceptance criteria (draft for full spec)

- [ ] No production authz path in `dynamic_agents/**` reads `workflow_configs` or `teams` from Mongo.
- [ ] All new BFF routes use `authorize()` facade or documented domain wrapper — CI enforced.
- [ ] Public API errors use §6 reason codes; no `pdp_denied` / `agent#use` in user-facing responses.
- [ ] Runtime callers (Slack, Webex, DA workflow tools) use BFF HTTP or documented service contract — not admin rebac routes.
- [ ] `workflowDelegatesAgentUse` wired at run start (and documented for step execution).
- [ ] RAG plan references same contract as BFF (no third parallel RBAC vocabulary).
- [ ] `fga-enforcement-manifest.ts` updated with new surfaces and `rebac_enforced` entries.
- [ ] ADR or [#1458](https://github.com/caipe-io/ai-platform-engineering/issues/1458) documents dual-gate retirement if DA OpenFGA is removed.

---

## 11. References (code & docs)

### Code

- `ui/src/lib/rbac/shareable-resource.ts`
- `ui/src/lib/rbac/resource-authz.ts`
- `ui/src/lib/rbac/openfga.ts`
- `ui/src/lib/rbac/workflow-config-rebac.ts`
- `ui/src/lib/rbac/fga-enforcement-manifest.ts`
- `ui/src/app/api/admin/rebac/check/route.ts`
- `ui/src/app/api/integrations/slack/.../access-check/route.ts`
- `ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/workflow_execution_authz.py`
- `ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/builtin_tools.py` (`WorkflowApiClient`)
- `ui/src/lib/server/workflow-engine.ts`
- `scripts/validate-fga-create-paths.py`

### Docs

- [PDP coverage audit](../../security/rbac/pdp-coverage-audit.md)
- [RBAC architecture](../../security/rbac/architecture.md)
- [Chat execution authz contract](../2026-05-16-dynamic-agent-pdp-gate/contracts/chat-execution-authz.md)
- [Unified shareable resource RBAC](../2026-06-03-unified-shareable-resource-rbac/spec.md)
- [RAG thin PEP plan](../2026-05-19-rag-thin-pep-openfga/plan.md)
- [ReBAC policy API contract](../2026-05-11-identity-group-rebac/contracts/rebac-policy-api.md)

---

## 12. Instructions for reviewing agent

Please evaluate:

1. Whether **Option 1 + 2 + 4** is the right default combo vs Option 3 early.
2. Whether **workflow delegation** should be FGA tuples (grant on save) vs runtime BFF check only.
3. Gaps in **threat model** for runtime authorize API (service account, OBO, user impersonation).
4. **Migration risk** for error code changes on existing UI/clients.
5. Whether this should be one spec or split: (a) facade + enforcement, (b) runtime HTTP API, (c) RAG/DA convergence.

Return: recommended option mix, ordered task list, and any contradictions with [#1742](https://github.com/caipe-io/ai-platform-engineering/issues/1742) phasing.
