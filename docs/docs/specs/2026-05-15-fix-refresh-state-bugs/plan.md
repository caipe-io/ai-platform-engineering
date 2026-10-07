# Implementation Plan: Fix UI State Bugs on Browser Refresh

**Branch**: `2026-05-15-fix-refresh-state-bugs` | **Date**: 2026-05-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `docs/docs/specs/2026-05-15-fix-refresh-state-bugs/spec.md`

## Summary

After a hard browser refresh, two UX defects appear in the chat UI:

1. **Duplicate sidebar tab**: the previously-active conversation appears twice — once under its original source (e.g., web/persisted) and once under "Autonomous" — and both are visually treated as selected.
2. **Unexpected Read-Only Audit Mode**: admin users are dropped into the "Read-Only Audit Mode" banner on conversations they did not navigate to via the admin audit-logs / feedback views.

Investigation pinpoints two root causes, matching the user's hypotheses (access levels changing after refresh + autonomous-message posting into the chat):

- **Bug #2 root cause (access-level / audit mode)**: The server-side authorization helper `requireConversationAccess` (in `ui/src/lib/api-middleware.ts`) returns `access_level: 'admin_audit'` for **any** admin user on **any** conversation they don't own — including autonomous-source conversations — and that branch is checked **before** the `source === 'autonomous'` shared-readonly fallback. The UI (`ChatContainer` → `ChatPanel`) then translates `admin_audit` into the audit banner regardless of whether the user actually arrived from the admin audit-logs/feedback views in this session (i.e., regardless of the `?from=audit-logs|feedback` query param that drives `adminOrigin`).
- **Bug #1 root cause (duplicate autonomous tab)**: The autonomous sidebar adapter `loadAutonomousConversationsFromService` (in `ui/src/store/chat-store.ts`) merges synthesized autonomous conversations into store state by filtering on `source === 'autonomous'`. If a conversation with the same canonical id already exists in state but is **not** tagged with `source === 'autonomous'` (because it was rehydrated from Zustand-persisted state, was returned by the generic conversations API without the `source` field, or had a different `source` at the time it was last stored), it survives in the `others` bucket while the synth produces a fresh autonomous entry — producing two sidebar items with the same underlying conversation id.

The fix is UI-only and is grouped into **seven conceptual change clusters** (six code-side + one spec-side clarification). The numbered list below is a high-level mental model, NOT a one-to-one mapping to tasks — `tasks.md` expands these seven clusters into ~25 granular items (T001–T043), most of which are tests, dependency gates (T028), or sub-tasks created by the three prior `/speckit.analyze` re-reviews (T012a, T013a, T015a, T015c, T029a, T029c). See "Phase 2 stop point" below for the canonical task ledger.

1. **Dedupe-by-id at three sites** in `chat-store.ts` — `onRehydrateStorage` (back-to-back-F5 + autonomous-disabled resilience), `loadConversationsFromServer`, and `loadAutonomousConversationsFromService`. Autonomous-synthesized copy wins on collision; user-typed messages are merged in by `message.id` so nothing is lost. Winner-selection is **deterministic and NaN-safe** for legacy entries with missing/invalid `updatedAt` (finding N5 in `/speckit.analyze` re-run).
2. **Cross-loader clobber fix** (`Inv-G`, T015c, finding N1 in `/speckit.analyze` re-run) — convert `loadConversationsFromServer`'s final `set(...)` to the callback form so autonomous-source entries written by the other loader between snapshot-read and write are NOT discarded. (A same-loader guard for `loadAutonomousConversationsFromService` was considered and dropped: the Map-based dedupe inside that loader is idempotent on its own snapshot, so two concurrent invocations still converge to a duplicate-free final state — the cross-loader case is the only one that requires explicit coordination.)
3. **Split-denylist `partialize` test** (`Inv-E`) — enforce by parsed-tree walk with two scopes (top-level + recursive) so `ChatMessage.role` (legitimate non-authorization sender field) is not falsely flagged. The accompanying code comment on `partialize` documents both the denylist and the broader principle: persist conversation data only — never transient/loading/UI flags.
4. **Server-side authorization reorder** in `api-middleware.ts` — `requireConversationAccess` resolves `source === 'autonomous'` to `shared_readonly` **before** the admin-audit fallback. Admins viewing autonomous chats get the same read-only treatment as everyone else.
5. **Client-side audit-banner gate with `shared_readonly` fallback** in `ChatContainer.tsx` (T026; finding N3 in `/speckit.analyze` re-run; Inv-C2, option A) — `readOnlyReason === 'admin_audit'` only when (a) the API returned `access_level === 'admin_audit'` AND (b) the live URL `?from=audit-logs|feedback` is present. When the server returns `admin_audit` but the gate evaluates false (no `?from=`, or unrecognized value), route the case through the **existing `shared_readonly`** UI branch (composer hidden, standard sharing banner, no admin back-link) so the user does not face silent send-failures. No new `readOnlyReason` value is introduced; the `ChatPanel` rendering and prop-type union remain unchanged. Presentation-only; the server remains authoritative for authorization.
6. **Security audit gate** (T028) — before the server-side reorder lands, statically verify (a) no write-side handler grants extra power on `access_level === 'admin_audit'`, and (b) admin views of autonomous chats are not audit-logged via the `admin_audit` signal in a way the fix would silently break. Green on both is the precondition for T025. (FR-008 / Inv-F persistence-side coverage is enforced end-to-end by the T013 + T013a pair: T013a's defensive `stripDenylistedKeys` runs inside `partialize` and removes every denylisted key at write-time even if a future setter wrote one onto store state; T013 is a real Inv-E gate that **injects** the denylisted keys onto the seed state and asserts they are absent from the `partialize` output — closing the seed-shape blind spot that finding A1 flagged in the earlier draft. Together they make a separate static `rg` audit for store-setter writes redundant: any future write of a denylisted key to store state still lands in clean persisted output because T013a strips it, and T013 fails immediately if that strip ever regresses.)
7. **Spec-level FR-004 clarification** (finding N7 in `/speckit.analyze` re-run) — codifies that the in-session "I am acting as an auditor" flag is the live URL `?from=` parameter (cross-conversation carry-over allowed) AND that unrecognized `?from=` values MUST be treated as absent (with the **`shared_readonly` fallback** in change 5 ensuring no silent write-fail). Resolves an ambiguity between FR-004 and `data-model.md` Inv-C.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 20+
**Primary Dependencies**: Next.js 16 (App Router), React 19, Zustand (state + `persist` middleware), next-auth (`useSession`), Tailwind CSS
**Storage**: MongoDB (chat history) via existing API routes — **no schema change**; Zustand `localStorage` persistence under key `caipe-chat-history` (localStorage mode only)
**Testing**: Jest + React Testing Library (`make caipe-ui-tests` / `npm test`); existing unit suites: `ui/src/store/__tests__/chat-store.test.ts`, `ui/src/components/chat/__tests__/ChatPanel.test.tsx`, `ui/src/components/autonomous/__tests__/synthesize-conversation.test.ts`, `ui/src/app/api/__tests__/admin-audit-access.test.ts`
**Target Platform**: Browser (Chromium, Firefox, Safari) — UI runs server-side rendered + hydrated by Next.js
**Project Type**: Web application (Next.js frontend backed by Next.js API routes — single repo)
**Performance Goals**: No regression on sidebar render time or refresh-to-paint; dedupe pass is O(n) over conversations (n < 1k in practice)
**Constraints**: No backend (Python) changes; no database schema or migration changes; preserve current `localStorage` persistence key and shape for backward compatibility
**Scale/Scope**: Per-user UI state; typical user has 10–500 conversations across sources (web, autonomous, slack, shared)

## Constitution Check

Reviewed against `.specify/memory/constitution.md` (CAIPE Constitution v1.0.0).

| Principle | Status | Notes |
|---|---|---|
| I. Worse is Better | PASS | Fix is minimal, concrete code changes in 3 files (`chat-store.ts`, `ChatContainer.tsx`, `api-middleware.ts`); no new abstractions introduced. |
| II. YAGNI | PASS | Only fixing the two reported defects. No speculative refactor of the conversation-source model or audit-mode plumbing. |
| III. Rule of Three | PASS | The dedupe-by-id pattern is added once at the merge site; not extracted into a shared helper yet. |
| IV. Composition over Inheritance | PASS | Changes are functional/data transformations on existing store/middleware modules. |
| V. Specs as Source of Truth | PASS | This plan and the linked spec drive the work. Tests will reference spec FRs. |
| VI. CI Gates Are Non-Negotiable | PASS | Will run `npm run lint` and `npm test` for the UI workspace; new tests cover FR-001…FR-010. |
| VII. Security by Default | PASS | Server-side authorization tightening (`requireConversationAccess`) is **more restrictive**, not less: autonomous → `shared_readonly` (no write) instead of `admin_audit`. Non-admin users still cannot reach `admin_audit` under any path. No secrets touched. |

**Gate result**: All gates pass. No complexity-tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
docs/docs/specs/2026-05-15-fix-refresh-state-bugs/
├── plan.md              # This file (/speckit.plan output)
├── spec.md              # Feature spec
├── research.md          # Phase 0 — root-cause analysis & options
├── data-model.md        # Phase 1 — UI state shape & invariants
├── quickstart.md        # Phase 1 — manual reproduction & verification steps
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit.specify)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

Note: no `contracts/` directory — this feature does not change any API contract surface that's worth versioning; the server-side change is an authorization-policy fix and is covered by `data-model.md` invariants + tests. No `db-migration.md` — storage is unchanged.

### Source Code (repository root)

```text
ui/
├── src/
│   ├── store/
│   │   ├── chat-store.ts                      # MODIFY — dedupe-by-id in autonomous merge,
│   │   │                                      #   in loadConversationsFromServer merge,
│   │   │                                      #   AND in onRehydrateStorage (back-to-back-F5
│   │   │                                      #   resilience); plus callback-form set() in
│   │   │                                      #   loadConversationsFromServer to prevent
│   │   │                                      #   cross-loader clobber (Inv-G)
│   │   └── __tests__/
│   │       └── chat-store.test.ts             # ADD test cases for refresh + dedupe + rehydrate +
│   │                                          #   cross-loader interleave + split-denylist partialize
│   ├── components/
│   │   └── chat/
│   │       ├── ChatContainer.tsx              # MODIFY — gate admin_audit on adminOrigin (Inv-C);
│   │       │                                  #   route the admin-without-recognized-origin case
│   │       │                                  #   through the existing shared_readonly branch
│   │       │                                  #   (Inv-C2 option A, finding N3). No ChatPanel
│   │       │                                  #   or prop-type changes — only ChatContainer's
│   │       │                                  #   readOnlyReason derivation.
│   │       └── __tests__/
│   │           ├── ChatContainer.test.tsx     # ADD (NEW FILE) — gate test, leak test,
│   │           │                              #   cross-conversation ?from= carry-over test,
│   │           │                              #   shared_readonly fallback tests (admin + no
│   │           │                              #   recognized origin)
│   │           └── ChatPanel.test.tsx         # ADD ChatPanel-only rendering regression guards
│   ├── lib/
│   │   └── api-middleware.ts                  # MODIFY — autonomous resolves before admin_audit
│   └── app/
│       └── api/
│           └── __tests__/
│               └── admin-audit-access.test.ts # ADD test for autonomous + admin path
```

**Structure Decision**: This is a UI-only fix in the existing Next.js workspace under `ui/`. There is no second project; no new directories. All changes live in three existing files plus their colocated test files. No backend (Python) changes.

## Database migrations

*N/A — no `db-migration.md`.*

This feature does not introduce, rename, or migrate any persisted storage. MongoDB schemas and indexes are unchanged. The Zustand `localStorage` persistence key (`caipe-chat-history`) and its `partialize` shape are unchanged; the dedupe pass operates on already-persisted state at read time, so existing client state remains valid.

## Phase 0 — Research

Deliverable: `research.md` in this directory. It answers:

1. **Why does refresh produce duplicate autonomous sidebar entries?**
   - Trace: `loadAutonomousConversationsFromService` (chat-store.ts ~L1108–L1177) merges synth entries by filtering `state.conversations` on `source === 'autonomous'`. Non-autonomous-tagged entries with the same id survive in `others`. Refresh restores the active conversation from Zustand-persisted state (localStorage mode) without a guaranteed `source` tag, and `loadConversationsFromServer` separately preserves `activeConversationId` even if the server didn't return it (chat-store.ts ~L1000–L1005). The synth fires independently and produces a second entry with the canonical id.
   - Decision: Dedupe by `id` after both loaders run. When two entries share an id, prefer the autonomous-synthesized one for `source/messages/a2aEvents` if present, and **keep** any user-typed messages by merging on `message.id` (the existing logic at L1157–L1161 already does this for the autonomous case — we just need to make sure no second copy escapes into `others`).
   - Rationale: One-line invariant ("no two sidebar entries share an id") is simpler than re-architecting the source model. Matches Constitution I (Worse is Better).
   - Alternatives considered:
     - Reconcile `source` on every fetch — rejected: requires touching every loader and risks losing source for legitimately non-autonomous conversations that share an id by coincidence (unlikely, but more invasive).
     - Remove Zustand `persist` entirely in MongoDB mode — rejected: persistence is used for many other UX wins (drafts, selected turn, etc.); out of scope.

2. **Why does refresh sometimes put the user in Audit Mode?**
   - Trace: `requireConversationAccess` (api-middleware.ts L443–L529) checks owner → public-share → user-share → team-share → email-grant → admin (`admin_audit`) → autonomous (`shared_readonly`) → forbid. The admin check (L514–L517) fires **before** the autonomous check (L525–L527). `ChatContainer` (L201–L203) stores `access_level` verbatim, and `ChatPanel` renders the audit banner whenever `readOnlyReason === 'admin_audit'`, regardless of whether the URL contains `?from=audit-logs|feedback` (the `adminOrigin` searchParam).
   - On refresh, the URL of an autonomous or other admin-viewed conversation typically does not carry the `?from=...` query param (the user navigated to the conversation slug directly, or the param was lost across a SPA navigation), so `adminOrigin` is `null` but `access_level === 'admin_audit'` — banner shows, "Back to Feedback" defaults in.
   - Decision (two-part, defense in depth):
     - **Server**: reorder `requireConversationAccess` so the `source === 'autonomous'` branch returns `shared_readonly` **before** the admin fallback. Admins viewing autonomous conversations get the same view as everyone else.
     - **Client**: in `ChatContainer`, when computing `readOnlyReason`, only honor `admin_audit` when `adminOrigin` is set (`'audit-logs'` or `'feedback'`). When the API returns `admin_audit` but no `adminOrigin` (or an unrecognized value), the user is admin-browsing — route through the **existing `shared_readonly` UI branch** (Inv-C2, option A): composer hidden, standard sharing banner, no admin back-link. This avoids a silent send-failure UX (the server still rejects writes for `admin_audit` regardless of URL state) without introducing a new `readOnlyReason` value or changing the `ChatPanel` prop-type union. Presentation-only; the server remains authoritative for authorization.
   - Rationale: Server fix closes the root authorization mislabel for autonomous; client fix closes the gap for any other "admin viewing not-their-own conversation" path (legitimate audit must come from the audit-logs/feedback views).
   - Alternatives considered:
     - Persist `adminOrigin` across refresh in the URL — rejected: URL is the source of truth; we should not silently restore admin/audit context.
     - Always show audit banner for admins on others' conversations — rejected: violates the spec (FR-004, FR-005) and confuses admins doing day-to-day work.

3. **Does the `localStorage`-persisted state need cleanup?**
   - Decision: No mass clear. The existing one-time cleanup at chat-store.ts ~L2087–L2097 already removes a stale legacy cache key. We **do** ensure the dedupe runs on rehydration (via `onRehydrateStorage` or naturally at the next `loadAutonomousConversationsFromService` call after mount) so users with stale persisted state are healed on first refresh after this fix ships.
   - Alternative: Bump the persist key version — rejected: drops the user's draft/turn-selection state unnecessarily.

4. **Best practices applied**:
   - Zustand persistence: minimize partialize shape; never persist mode/permission flags. (Already followed — `a2aEvents`, `streamEvents`, and per-session flags are excluded.)
   - Next.js App Router: query params drive in-session context; do not restore from `localStorage`.
   - Defense in depth (Constitution VII): both server and client enforce; server is authoritative.

## Phase 1 — Design & Contracts

Deliverables in this directory:

1. **`data-model.md`** — UI state invariants:
   - **Inv-A**: `chatStore.conversations` MUST NOT contain two entries with the same `id`, regardless of `source`. Enforced at three sites (rehydrate, server loader, autonomous loader) so the invariant holds in every storage mode and across back-to-back F5 refreshes — see `data-model.md` "State transitions" and "Back-to-back-refresh resilience".
   - **Inv-B**: A conversation's `source` is set exactly once per fetch path (server response, autonomous synth, or fallback `undefined`). When two paths produce the same `id`, autonomous wins for the `source` label; messages from either are merged by message id (existing logic).
   - **Inv-C**: `readOnlyReason === 'admin_audit'` MAY only be rendered in the UI when (a) the API returned `access_level === 'admin_audit'` **and** (b) `adminOrigin ∈ {'audit-logs', 'feedback'}` is present in the current URL searchParams. The `?from=` param is a per-page-load signal sourced from the live URL and is intentionally allowed to carry across cross-conversation navigation in the same session — see `data-model.md` "Cross-conversation `?from=` carry-over".
   - **Inv-C2 (new — Option A `shared_readonly` fallback)**: When the server returns `access_level === 'admin_audit'` but the Inv-C gate evaluates false (no `?from=`, or unrecognized `?from=` value), the UI MUST render the **existing `shared_readonly` read-only treatment** — `readOnlyReason === 'shared_readonly'`, composer hidden, standard sharing banner, no admin back-link. No new `readOnlyReason` value is introduced; the `ChatPanel` rendering and prop-type union are unchanged. FR-005 still holds because non-admin users cannot reach `access_level === 'admin_audit'` server-side, so this fallback branch is unreachable for non-admins.
   - **Inv-D**: For a conversation with `source === 'autonomous'`, the server MUST return `access_level === 'shared_readonly'` (or `'owner'` if the user owns it), never `'admin_audit'`.
   - **Inv-E**: Zustand-persisted state MUST NOT include `access_level`, `readOnlyReason`, `adminOrigin`, or other authorization/session signals. Enforced via a split denylist (top-level vs recursive) so that `ChatMessage.role` (a non-authorization sender field) is not falsely flagged — see `data-model.md` Inv-E table.
   - **Inv-F (new — FR-008 coverage)**: Every read-only-trigger UI flag (`admin_audit`, `shared_readonly`, `agent-deleted`, `agent-disabled`) is derived per render from the current session, current URL, or current server response. None is persisted. Persistence-side enforcement is in T013 (the `partialize` tree-walk).
   - **Inv-G (new — cross-loader merge safety)**: When `loadConversationsFromServer` and `loadAutonomousConversationsFromService` write to `conversations` concurrently, neither write may discard the other's contribution. Implemented by converting the server loader's final imperative `set(value)` to the callback form `set((state) => ...)` so autonomous-source entries written between snapshot-read and write are preserved. (Same-loader re-entry of the autonomous loader is already safe by construction: the Map-based dedupe inside that loader is idempotent on its own snapshot.)

2. **`quickstart.md`** — manual reproduction and verification:
   - Repro 1 (duplicate tab): seed an autonomous task; open it in the chat; hard refresh; verify the sidebar shows exactly one entry.
   - Repro 2 (audit mode): sign in as an admin; open the admin's own conversation; hard refresh; verify no audit banner. Then open an autonomous conversation (no `?from=...`); refresh; verify no audit banner. Then enter via `/admin?tab=audit-logs` → conversation; verify audit banner appears; refresh; verify behavior matches FR-004 (the URL `?from=audit-logs` should still be present in the legitimate flow).
   - Repro 3 (non-admin safety): sign in as a non-admin; confirm under no circumstance is the audit banner shown after any refresh.

3. **`contracts/` — N/A.** No external interface contract changes. The internal Next.js `/api/chat/conversations/[id]` response shape is unchanged; only the **values** of `access_level` for autonomous-source conversations under admin sessions change (admin_audit → shared_readonly). This is covered as a server invariant in `data-model.md` and asserted in `ui/src/app/api/__tests__/admin-audit-access.test.ts`.

4. **Database migrations** — not applicable; see section above.

5. **Agent context update**: Run `bash .specify/scripts/bash/update-agent-context.sh cursor-agent` to refresh `AGENTS.md` / `CLAUDE.md` recent-changes blocks. No new technology is introduced; the update is a no-op or appends only the feature name.

### Constitution Re-check (post-design)

Re-evaluated all gates with the design above:

- Worse-is-Better, YAGNI: Confirmed — three small functional edits, no new modules.
- Security by Default: Confirmed — server-side change tightens autonomous to `shared_readonly` instead of `admin_audit`; client change adds a gating condition, never relaxes one. Non-admins remain locked out of audit mode at multiple layers.
- CI Gates: Confirmed — added tests cover new invariants; existing tests should pass unchanged.

**Gate result**: All gates still pass.

## Phase 2 — Stop point

Per the speckit.plan workflow, this command stops here. Task breakdown happens in `/speckit.tasks`. The expected high-level task list (refined post-`/speckit.analyze` re-review):

1. Server: reorder `requireConversationAccess` in `ui/src/lib/api-middleware.ts` so autonomous-source returns `shared_readonly` before the admin fallback (Inv-D).
2. Server tests: extend `ui/src/app/api/__tests__/admin-audit-access.test.ts` to assert (admin + autonomous source → shared_readonly) and (admin + non-autonomous, non-owner → admin_audit unchanged).
3. Store: in `loadAutonomousConversationsFromService` (`ui/src/store/chat-store.ts`), add a final dedupe-by-id pass on `final` so no two entries share an `id`; when collision happens, prefer the autonomous-synth copy (Inv-A, Inv-B).
4. Store: also apply the dedupe-by-id pass in `loadConversationsFromServer` for the `[...serverConversations, ...localOnlyPreserved]` concatenation (defense in depth).
5. **Store**: also apply the dedupe-by-id pass inside `onRehydrateStorage` so the rehydrate path is self-healing on first paint, before any network call. Closes the back-to-back-refresh edge case and the `localStorage` mode + `autonomousAgentsEnabled = false` edge case (finding C2 in `/speckit.analyze`).
6. Store tests: extend `ui/src/store/__tests__/chat-store.test.ts` with (a) a refresh-rehydration scenario asserting one entry per id after both loaders run; (b) a rehydrate-only scenario asserting the dedupe runs before any loader is invoked.
7. UI: in `ui/src/components/chat/ChatContainer.tsx`, gate `readOnlyReason === 'admin_audit'` on `adminOrigin ∈ {'audit-logs', 'feedback'}` (Inv-C). When the API returns `admin_audit` without `adminOrigin`, route through the existing `shared_readonly` UI branch (Inv-C2, option A).
8. UI tests: extend `ui/src/components/chat/__tests__/ChatPanel.test.tsx` with regression guards for the existing read-only rendering branches, and add `ui/src/components/chat/__tests__/ChatContainer.test.tsx` covering: gate-fail (no banner), audit-context leak guard (admin viewing their own conversation), cross-conversation `?from=` carry-over (intentional behaviour per Inv-C cross-conversation clause, finding C5), and the `shared_readonly` fallback branch (Inv-C2, finding N3 in `/speckit.analyze` re-run).
9. Verify Zustand `partialize` does not leak `accessLevel`/`adminOrigin`. The regression test uses a **split denylist** (top-level vs recursive) so that `ChatMessage.role` is not falsely flagged (finding C1).
10. T028 security audit: verify (a) no write-side handler grants extra power on `access_level === 'admin_audit'`, and (b) admin views of autonomous chats are not audit-logged via the `admin_audit` signal in a way the fix would silently break. Green on both is the precondition for step 1 above. (Persistence-side coverage of Inv-F is enforced end-to-end by step 9 above.)
11. **Cross-loader clobber fix** (finding N1 in `/speckit.analyze` re-run): T015c — convert `loadConversationsFromServer`'s final `set(...)` to the callback form so the autonomous loader's writes are not clobbered by an interleaving server-loader write. Inv-G in `data-model.md`. Adds an interleave Jest test.
12. Lint and run UI test suite; update spec/plan with any deviations.

See `tasks.md` for the granular task breakdown including all NEW tasks (T012a, T015a, T015c, T029a, T029c) introduced by the `/speckit.analyze` re-reviews.

## Code Comment Conventions

These conventions are derived from the existing style in the three target source files (`ui/src/store/chat-store.ts`, `ui/src/components/chat/ChatContainer.tsx`, `ui/src/lib/api-middleware.ts`) and MUST be matched by every new comment introduced by this feature. Tests, documentation, and PR descriptions are NOT bound by these rules — they may reference spec/task/finding identifiers freely. Only **source-file comments** are constrained.

### DO

- **Explain *why*, not *what*.** The code already shows what; the comment captures the rationale, trade-off, or non-obvious constraint that the code itself cannot convey. Examples in the codebase:
  - `chat-store.ts` L882: `// Prevent multiple simultaneous loads` (rationale, not narration).
  - `api-middleware.ts` L519–L524: a 6-line paragraph above the autonomous branch explaining what an autonomous-agent conversation *is* and why any authenticated user gets read-only access. The code itself is a 3-line `if` block.
- **Use single-line `//` comments by default.** Multi-line is acceptable when the rationale needs a paragraph (e.g., `api-middleware.ts` L519–L524, `chat-store.ts` L1885–L1889).
- **Reserve `// ALL-CAPS LABEL:` tags for safety / recovery / migration branches.** This style already exists for crash-recovery and heal paths (`chat-store.ts` L1912 `// CRASH RECOVERY:`, L1916 `// HEAL:`). New comments MAY use this convention when introducing a parallel safety branch — e.g., `// REHYDRATE DEDUPE:`, `// CROSS-LOADER MERGE:`. Keep tags short (one or two words) and consistent within a file.
- **Reference other source files by relative path or symbol name in plain prose.** Example from `chat-store.ts` L1887: "`services/chat_history.py`". Backticks around symbol names are NOT required in comments (the codebase uses both styles inconsistently; default to no backticks to match the dominant convention in `chat-store.ts` and `api-middleware.ts`).
- **Inline `//` for short property-level rationale.** Example: `a2aEvents: [], // Don't persist events (too large)` (`chat-store.ts` L1873). Use sparingly and only when the property's value alone is misleading.
- **Reference invariants by their canonical name (`Inv-A`, `Inv-C`, `Inv-G`) where the comment explains a non-obvious safety property.** The invariant name acts as a stable cross-reference into `data-model.md` for a future reviewer. This is the ONE allowed form of "documentation pointer" inside source comments.

### DO NOT

- **Do NOT cite spec IDs, finding IDs, task IDs, or PR / commit numbers in source-file comments.** The spec lives in `docs/docs/specs/2026-05-15-fix-refresh-state-bugs/` and is the authoritative reference; cluttering source with `// FR-004 / finding N3 / T026 / PR #1234` makes comments stale the moment those identifiers change and adds zero information that the code structure does not already convey. Specifically, the following are **forbidden** in new source-file comments introduced by this feature:
  - Spec slugs / dates (`2026-05-15-fix-refresh-state-bugs`)
  - Functional-Requirement IDs (`FR-001`, `FR-008`)
  - Analyze finding IDs (`finding C2`, `finding N3 in /speckit.analyze`, `S1`, `M4`)
  - Task IDs (`T013`, `T015a`, `T026`)
  - Tool / workflow names (`/speckit.analyze`)
  - Issue / PR numbers
- **Do NOT narrate what the next line does** (e.g., `// Set the variable to true`, `// Loop over the array`). The code is self-evident.
- **Do NOT use JSDoc / multi-line `/** ... */` blocks for inline rationale.** The target files do not use JSDoc except on a handful of exported function signatures. Match the local style.
- **Do NOT add author / date / version markers.** Git history is authoritative.

### Rationale

The spec, plan, and tasks documents are versioned alongside the code and serve as the durable record of *why* a change was made and *which* finding it addresses. Source-file comments serve a different audience — a future maintainer reading the code who needs the minimum non-obvious context to make a safe change. Identifiers like `finding N3` are noise to that audience and rapidly stale as the spec evolves; the invariant names (`Inv-A`…`Inv-G`) are the only durable cross-reference because they are part of the spec's public contract.

### Examples — new comments introduced by this feature

GOOD (matches the conventions; rationale-focused, invariant-tagged, no finding/task IDs):

```ts
// Map-based dedupe by id (Inv-A). Autonomous-synth wins on collision so the
// sidebar source label is correct; user-typed messages are merged in below
// by message.id so nothing the user wrote is lost.
const final = Array.from(new Map([...others, ...merged].map(c => [c.id, c])).values());
```

```ts
// REHYDRATE DEDUPE: heals duplicates persisted before this fix shipped and
// makes back-to-back F5 refreshes self-healing without a network call (Inv-A
// site 1). Skip entries with non-string / empty ids to defend against
// tampered or corrupted localStorage.
```

```ts
// Callback-form set() protects Inv-G: if the autonomous loader wrote between
// our snapshot read and this write, the imperative form would silently
// discard those entries. Read the latest state here and re-union.
set((state) => { ... });
```

```ts
// Inv-C: audit banner requires BOTH server admin_audit AND a recognized
// in-session ?from= value. Inv-C2: when the server says admin_audit but the
// gate fails, route through the existing shared_readonly UI branch so the
// user sees a clear read-only banner instead of a silent send-failure. The
// adminOrigin signal is presentation-only — the server is authoritative for
// authorization.
```

BAD (cites finding / task / FR IDs; reads as a stale changelog):

```ts
// Map-based dedupe by id (Inv-A; T014; finding C2 from /speckit.analyze;
// closes FR-001 + FR-002; see docs/docs/specs/2026-05-15-fix-refresh-state-bugs/tasks.md).
```

```ts
// Per finding N3 in the third /speckit.analyze re-review (option A — collapse
// admin_no_origin into shared_readonly), this branch routes the failed-gate
// case through the existing shared_readonly UI; tested by T029c sub-tests 1
// and 2 in ChatContainer.test.tsx.
```

### Enforcement

This is a review-time convention, not a lint rule. PR reviewers SHOULD flag any new source-file comment that cites a finding ID, task ID, or FR ID, and request a rewrite. The convention is documented here so reviewers and authors share the same expectation up front.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_ | — | — |
