---

description: "Task list for 2026-05-15-fix-refresh-state-bugs"
---

# Tasks: Fix UI State Bugs on Browser Refresh

**Input**: Design documents from `docs/docs/specs/2026-05-15-fix-refresh-state-bugs/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md

**Tests**: Included. The plan explicitly maps each invariant (Inv-A, Inv-B, Inv-C, Inv-C2, Inv-D, Inv-E, Inv-F, Inv-G) to specific test files, and CAIPE Constitution VI ("CI Gates Are Non-Negotiable") requires lint + test gates.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and shipped independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label (US1, US2, US3). No story label on Setup / Foundational / Polish tasks.
- Include exact file paths.

## Path Conventions

UI-only feature. All paths are under `ui/` in the repository root. No backend (Python) files are touched. No `db-migration.md` (storage unchanged).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify the UI workspace is ready for editing and the existing test suites pass before any code change.

- [X] T001 Verify UI workspace is installed and tests pass on `main`. Run `cd ui && npm ci && npm run lint && npm test` and confirm green baseline. No file changes.
- [X] T002 Confirm the four target source files compile and the three target test files exist in the workspace: `ui/src/lib/api-middleware.ts`, `ui/src/store/chat-store.ts`, `ui/src/components/chat/ChatContainer.tsx`, `ui/src/app/api/__tests__/admin-audit-access.test.ts`, `ui/src/store/__tests__/chat-store.test.ts`, `ui/src/components/chat/__tests__/ChatPanel.test.tsx`. No file changes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: (a) Document the persistence-scope invariant that all subsequent tasks must respect, and (b) verify that the planned server-side authorization change is safe with respect to write-path enforcement and audit logging (analyze findings S1 and S2 — must be confirmed before T025 lands).

**⚠️ BLOCKING**: T028 must complete before T025. T003 should complete before T013.

- [X] T003 Add a code comment directly above the `partialize` block in `ui/src/store/chat-store.ts` (around L1870) documenting Inv-E from `data-model.md`. The comment must list the two scopes (kept in sync with the `TOP_LEVEL_DENYLIST` / `RECURSIVE_DENYLIST` constants T013a introduces):
  - **Top-level** keys of the persisted output and of each `Conversation` MUST NOT include (11 entries): `access_level`, `accessLevel`, `readOnlyReason`, `readOnly`, `adminOrigin`, `isAdmin`, `canViewAdmin`, `sessionRole`, `authRole`, `role`, `userRole`.
  - **Any nesting depth** MUST NOT include (10 entries — `TOP_LEVEL_DENYLIST` minus the single `role` exception): `access_level`, `accessLevel`, `readOnlyReason`, `readOnly`, `adminOrigin`, `isAdmin`, `canViewAdmin`, `sessionRole`, `authRole`, `userRole`. The bare `role` key is the ONLY recursive-denylist omission and is exempted because `ChatMessage.role: 'user' \| 'assistant' \| 'system'` is the canonical message-sender field on every persisted message; stripping it would break every persisted conversation. Any future authorization-role field MUST use one of the disambiguated names (`sessionRole`, `authRole`, `userRole`) — never bare `role`.

  **Broader principle (finding N9 in `/speckit.analyze` re-run)**: the comment must ALSO state the general guideline beyond the denylist — `partialize` persists conversation **data** only. Transient/UI/loading/timing flags (e.g., `isLoadingConversations`, `isLoadingAutonomous`, `streamingConversations`, `pendingMessage`, `inputDraft`) belong in module-level variables (see the existing `isLoadingConversations` at L883) or component-local `useState` (see `ChatContainer`'s `accessLevel` / `agentInfo`), NEVER in the persisted store state. The denylist is keyed signals; the principle is the broader safeguard against an inadvertent persistence of any session-scoped flag the future may add.

  Reference `docs/docs/specs/2026-05-15-fix-refresh-state-bugs/data-model.md` (Inv-E) and state that the enforcing test (T013) walks the object tree, not the serialized string.
- [X] T028 **Security audit (defense in depth — findings S1, S2 in `/speckit.analyze`)**. Conduct a read-only codebase audit before T025 reorders `requireConversationAccess`. Produce a findings note appended to `research.md` (under a new section "Phase 0 addendum: write-path and audit-log audit") that answers:
  1. **Write-path safety (S1)**: Run `rg "admin_audit|shared_readonly|access_level" ui/src/app/api -n -t ts` and inspect every match in a write-side route handler (POST, PUT, PATCH, DELETE). For each match, confirm the handler treats `admin_audit` and `shared_readonly` identically as "no write" (i.e., no handler grants write capability based on `access_level === 'admin_audit'`). If any handler does grant additional power on `admin_audit`, document the specific file:line and STOP — escalate to a spec clarification before continuing.
  2. **Audit-log behaviour (S2)**: Inspect `ui/src/app/api/admin/audit-logs/` and any code path that writes audit-log entries (`rg "audit_log|auditLog|access_level.*admin_audit" ui/src/app/api -n -t ts`). Determine whether admin views of autonomous-source conversations are currently logged via the `admin_audit` signal. Document the finding. If admin views of autonomous conversations are currently logged and the spec requires that to continue, add a follow-up task to T025 that preserves the logging on an orthogonal signal (e.g., `is_admin && !is_owner` regardless of `source`); if not required, document that the logging change is intentional with a one-line rationale.
  3. **Output**: A short "Findings" paragraph in `research.md` Phase 0 addendum, plus a green/red flag for each of (1) and (2). Green on both → T025 can proceed unchanged. Red on either → block T025 and update plan.

  (FR-008 / Inv-F persistence-side coverage is enforced by the **T013 + T013a pair**: T013a installs `stripDenylistedKeys` inside `partialize` so every denylisted key is removed at write-time regardless of how it got onto store state, and T013 is a real Inv-E gate that explicitly INJECTS those keys onto the seed state and asserts the output is clean — together they close the seed-shape blind spot that an earlier draft of T013 had. A separate `rg` audit for store-setter writes was considered and dropped as redundant: a regression in T013a's strip would surface as a T013 failure on the next test run, and any future code that writes a denylisted key to store state still produces clean persisted output because the strip is unconditional.)

**Checkpoint**: Persistence-scope invariant is documented (T003), and the write-path / audit-log audit (T028) is green. US1 and US2 work can now begin in parallel.

---

## Phase 3: User Story 1 — No duplicate conversation tab after refresh (Priority: P1) 🎯 MVP

**Goal**: After a browser refresh, the chat sidebar contains exactly one entry per unique conversation `id`, regardless of source. The previously-active conversation is highlighted exactly once. (Spec FR-001, FR-002, FR-003, FR-007, FR-010; Inv-A, Inv-B.)

**Independent Test**: Open an autonomous conversation as any user, send a typed reply, hard-refresh the browser; verify exactly one sidebar entry remains (DevTools: `const ids = useChatStore.getState().conversations.map(c => c.id); new Set(ids).size === ids.length`). Repeat with a non-autonomous conversation as the active chat.

### Tests for User Story 1 (write FIRST, ensure they FAIL before implementation)

- [X] T010 [P] [US1] Add a Jest test in `ui/src/store/__tests__/chat-store.test.ts` named `loadAutonomousConversationsFromService dedupes by id` that seeds `state.conversations` with one entry `{ id: 'X', source: undefined }` (mimicking a persisted/API-fetched entry that lost its `source` tag) AND seeds `state.activeConversationId = 'X'`, mocks `autonomousApi.listTasks`/`listRuns` to produce a task whose canonical id is `'X'`, calls the action, and asserts: (a) the resulting `conversations` array has exactly one entry with `id: 'X'` and `source === 'autonomous'` (FR-001, FR-003); AND (b) `state.activeConversationId === 'X'` still maps to exactly one entry in `state.conversations`, satisfying FR-002. Must fail against current `main`.
- [X] T011 [P] [US1] Add a Jest test in `ui/src/store/__tests__/chat-store.test.ts` named `loadAutonomousConversationsFromService preserves user-typed messages on dedupe` that seeds an existing entry `{ id: 'X', source: undefined, messages: [{ id: 'user-msg-1', role: 'user', content: 'hello', ... }] }` and a synthesized autonomous task with canonical id `'X'` and its own synth messages, then asserts the final entry for `id: 'X'` contains both the synth messages and `user-msg-1`, sorted by `timestamp`. Must fail against current `main`.
- [X] T012 [P] [US1] Add a Jest test in `ui/src/store/__tests__/chat-store.test.ts` named `loadConversationsFromServer produces unique ids after local-only preservation` that seeds an existing local-only active conversation `{ id: 'Y', source: undefined }`, mocks the API to return the same id in its `items` array, calls the loader, and asserts the resulting list has exactly one entry with `id: 'Y'`. Must fail against current `main`.
- [X] T012a [P] [US1] **Back-to-back-refresh resilience test (finding C2 in `/speckit.analyze`)**. Add a Jest test in `ui/src/store/__tests__/chat-store.test.ts` named `onRehydrateStorage dedupes duplicate ids in persisted localStorage`. Pre-populate `localStorage['caipe-chat-history']` with a Zustand-persist payload whose `state.conversations` array contains two entries that share the same `id` (one with `source: undefined`, one with `source: 'autonomous'`, each with a distinct `messages` list and `updatedAt`). Re-import / re-construct the store so `onRehydrateStorage` runs. Assert: (a) `useChatStore.getState().conversations` contains exactly one entry for that id; (b) the surviving entry has `source === 'autonomous'`; (c) the surviving entry's `messages` is the union by message id of both seed entries' messages, sorted by timestamp; (d) no network loader was invoked between rehydrate and the assertion — to avoid brittle action-spying, assert this by spying on the underlying network calls (`apiClient.getConversations` and `autonomousApi.listTasks`) and asserting both were called zero times. Must fail against current `main` (today `onRehydrateStorage` does no dedupe).

  (Cross-cutting consistency between `selectedTurnIds` and the merged-messages output is covered by T011, which already asserts user-typed messages survive the dedupe by `message.id` — no additional T012a sub-assertion needed.)
- [X] T013 [P] [US1] Add a Jest test in `ui/src/store/__tests__/chat-store.test.ts` named `partialize never persists authorization or session fields`. The test MUST be a **real Inv-E gate**, not a passive spread-shape regression: it has to **inject** every denylisted key onto the seed state at root, conversation, and message level (defeating the future-proofing failure mode where `partialize` does `{ ...conv, a2aEvents: [], ... }` and silently carries through any new field added to `Conversation` or `ChatMessage`), then assert those keys are **stripped** from the `partialize` output.

  **Arrange (the seed MUST exercise both the substring path AND the key path)**:

  1. Build a base state with one conversation. The conversation's `title` and one `message.content` MUST deliberately include the literal substrings `access_level`, `accessLevel`, `isAdmin`, and `adminOrigin` — this defeats any naive substring matcher a future author might write against the serialized JSON.
  2. Include at least one message with `role: 'user'` and one with `role: 'assistant'` (the bare `role` field on messages is the legitimate non-authorization use that motivates the split denylist below).
  3. **Inject denylisted KEYS** onto the state via `as any` casts so the test compiles even if the `ChatState` / `Conversation` / `ChatMessage` types don't declare them:
     ```ts
     (state as any).accessLevel = 'admin_audit';
     (state as any).readOnlyReason = 'admin_audit';
     (state as any).adminOrigin = 'audit-logs';
     (state as any).isAdmin = true;
     (state.conversations[0] as any).access_level = 'admin_audit';
     (state.conversations[0] as any).accessLevel = 'admin_audit';
     (state.conversations[0] as any).readOnlyReason = 'admin_audit';
     (state.conversations[0] as any).adminOrigin = 'audit-logs';
     (state.conversations[0].messages[0] as any).accessLevel = 'admin_audit';
     (state.conversations[0].messages[0] as any).adminOrigin = 'audit-logs';
     (state.conversations[0].messages[0] as any).isAdmin = true;
     ```
     This step is what makes T013 a real defense for FR-008 / Inv-F. Without it the test would pass trivially against the current shape and silently regress the moment any future setter wrote one of these keys onto store state.

  **Act**: invoke the `partialize` function on that state and **parse the result as JSON / treat it as a plain object**.

  **Assert** — define two `const` arrays at the top of the test:
  ```ts
  // Canonical denylists. RECURSIVE is TOP_LEVEL minus the single 'role'
  // exception (ChatMessage.role is the legitimate message-sender field).
  // Keep these constants in sync with the stripDenylistedKeys helper in
  // chat-store.ts (T013a) and the comment above partialize (T003).
  const TOP_LEVEL_DENYLIST = ['access_level', 'accessLevel', 'readOnlyReason', 'readOnly',
    'adminOrigin', 'isAdmin', 'canViewAdmin', 'sessionRole', 'authRole', 'role', 'userRole'] as const;
  const RECURSIVE_DENYLIST = ['access_level', 'accessLevel', 'readOnlyReason', 'readOnly',
    'adminOrigin', 'isAdmin', 'canViewAdmin', 'sessionRole', 'authRole', 'userRole'] as const;
  ```
  Walk every nested object recursively and assert: (a) no own enumerable key of the root persisted object matches `TOP_LEVEL_DENYLIST`; (b) no own enumerable key of any element of `conversations[]` matches `TOP_LEVEL_DENYLIST`; (c) at every nesting depth (root + conversations + messages + arbitrary nested objects), no own enumerable key matches `RECURSIVE_DENYLIST`. The bare `role` field on messages is the **only** key allowed to appear (it is the message-sender role, not an authorization role) — `RECURSIVE_DENYLIST` is precisely `TOP_LEVEL_DENYLIST` minus `'role'`.

  Substring search on the serialized string is **forbidden** by the test author note (false positives on titles / message bodies; false negatives if a future field encodes its value differently).

  Must **fail** against current `main` (because today's `partialize` does `{ ...conv, ... }` which copies the injected `conv.access_level` / `conv.accessLevel` through to the output). Must **pass** after the implementation explicitly strips the denylisted keys from each spread (e.g., by replacing `{ ...conv, a2aEvents: [], ... }` with an explicit pick of the persisted fields, or by reduce-then-delete). The implementation change required to make T013 green is part of the regression guard scope — if `partialize` currently lets these keys through, that is itself the bug Inv-E exists to prevent.

  (Regression guard for Inv-E; closes finding S4 in `/speckit.analyze`, finding C1 in `/speckit.analyze` re-run, and finding A1 in the latest re-analysis — the prior T013 wording exercised only the substring path and never the key path.)

### Implementation for User Story 1

- [X] T013a [US1] **Defensive `partialize` (Inv-E hardening; required to make T013 green per finding A1 in the latest `/speckit.analyze`)**. In `ui/src/store/chat-store.ts`, update the `partialize` block (around L1870) so that each persisted `Conversation` and each persisted `ChatMessage` is constructed by **explicitly picking** the persisted fields, OR by spreading and then `delete`-ing every key in `TOP_LEVEL_DENYLIST` (for `Conversation`) / `RECURSIVE_DENYLIST` (for `ChatMessage`). The intent is: even if a future setter writes one of those keys onto `state.conversations[i]` or `state.conversations[i].messages[j]`, `partialize` MUST strip it before the persist middleware writes to `localStorage`.

  Recommended approach (minimal, matches existing style):
  ```ts
  const stripDenylistedKeys = <T extends Record<string, unknown>>(
    obj: T,
    keys: readonly string[],
  ): Partial<T> => {
    const out: Record<string, unknown> = { ...obj };
    for (const k of keys) delete out[k];
    return out as Partial<T>;
  };

  // Inside partialize:
  conversations: state.conversations.map((conv) => stripDenylistedKeys({
    ...conv,
    a2aEvents: [],
    streamEvents: [],
    messages: conv.messages.map((msg) => stripDenylistedKeys({
      ...msg,
      events: [],
    }, RECURSIVE_DENYLIST)),
  }, TOP_LEVEL_DENYLIST)),
  ```

  The `TOP_LEVEL_DENYLIST` / `RECURSIVE_DENYLIST` arrays are declared once at module scope (or imported from a tiny helper module) so the test in T013 and the implementation in T013a reference the **same** lists by name — preventing them from drifting out of sync. Note that `'role'` is intentionally in `TOP_LEVEL_DENYLIST` (Conversation has no legitimate `role` field) but NOT in `RECURSIVE_DENYLIST` (`ChatMessage.role` is legitimate); applying `RECURSIVE_DENYLIST` to messages preserves the sender field while still stripping every authorization key.

  Add a short inline `// Inv-E:` comment referencing `data-model.md` and noting this strip is the runtime enforcement of the persistence-scope invariant — the T013 test is the corresponding gate.

- [X] T014 [US1] In `ui/src/store/chat-store.ts`, modify `loadAutonomousConversationsFromService` (the `set((state) => { ... })` block around L1108–L1177) so the final conversation list is deduplicated by `id`. Replace the current `const final = [...others, ...merged].sort(...)` line with a `Map<string, Conversation>` keyed by `id`, populated by first inserting every entry from `others` and then overwriting with every entry from `merged` (autonomous-synth wins on collision). Convert the Map's values back to an array and sort with `compareConversationsForSidebar`. Preserves the existing per-message merge inside `merged.map(...)` for the autonomous-tagged case (L1157–L1161); the new dedupe handles the non-autonomous-tagged collision case.
- [X] T015 [US1] In `ui/src/store/chat-store.ts`, modify `loadConversationsFromServer` (around L992–L1011 + L1011) so the `allConversations = [...serverConversations, ...localOnlyPreserved]` concatenation also goes through a `Map<string, Conversation>` dedupe keyed by `id`. **Insertion semantics (server-wins-on-collision)**: insert every entry from `serverConversations` first; then iterate `localOnlyPreserved` and insert each entry **only if its `id` is not already present in the Map** (i.e. do NOT overwrite an existing server entry — server is authoritative for `source` and metadata). Concretely the second pass is `if (!map.has(conv.id)) map.set(conv.id, conv)`, NOT `map.set(conv.id, conv)`. In practice no collision occurs at this site because L1000–L1001 already filters local-only-preserved by `!serverIds.has(conv.id)`; this dedupe is defense in depth so no future code path that drops that filter can introduce duplicates at this merge site.
- [X] T015a [US1] **Rehydrate-time dedupe (finding C2 in `/speckit.analyze` — closes back-to-back-refresh and `autonomousAgentsEnabled = false` edge cases; findings N2, N5, N7, N8 in `/speckit.analyze` re-run)**. In `ui/src/store/chat-store.ts`, modify `onRehydrateStorage` (around L1883–L1943) to add a Map-based dedupe-by-id pass over `state.conversations` *after* the existing legacy-id filter (L1892–L1894) and *before* the messages re-mapping (L1905–L1938).

  **Defensive guards (run BEFORE the dedupe pass)**:
  - **Null-state guard (N7)**: if `!state || !Array.isArray(state.conversations)`, `return` early — rehydration failed or persisted shape is unexpected; let the store start empty.
  - **Invalid-id guard (N8)**: before inserting any entry into the dedupe Map, skip entries where `typeof conv.id !== 'string' || conv.id.length === 0`. Defense against corrupted/tampered `localStorage`.

  **Insertion strategy when two persisted entries share an id (deterministic, NaN-safe per finding N5 in `/speckit.analyze` re-run)**:
  1. Iterate `state.conversations` once, building `Map<id, Conversation>`.
  2. **Winner selection** (apply in order; first rule that produces a winner wins):
     a. If exactly one of the two has `source === 'autonomous'`, that one wins.
     b. Otherwise prefer the entry with more `messages.length`.
     c. Otherwise prefer the entry whose `updatedAt` parses to a **finite, valid** number — i.e., `Number.isFinite(new Date(updatedAt).getTime())` is true. If exactly one is valid, it wins. (Without this rule, missing/null/malformed `updatedAt` produces `NaN` and the Map insertion-order winner becomes non-deterministic.)
     d. Otherwise (both have valid `updatedAt`) prefer the most-recent `new Date(updatedAt).getTime()`.
     e. Otherwise (both invalid `updatedAt`, last-resort) prefer the entry whose `id` sorts first lexicographically.
  3. **Message-level merge (N2 in original `/speckit.analyze`)**: after selecting the winning entry, MERGE messages from BOTH collision entries by `message.id`. Concretely: build `Map<message.id, ChatMessage>` populated first from the winner's messages, then from the loser's messages (winner wins per-message-id on collision). Convert back to an array and sort by `timestamp` ascending **with NaN-safe comparator** (treat non-finite timestamps as `+Infinity` so malformed messages sort to the end without disrupting well-formed ordering). Assign this merged list to the surviving entry's `messages` field. This guarantees no user-typed message is lost just because the entry that carried it lost the source-preference contest.
  4. Replace `state.conversations` with `Array.from(map.values())`.

  Document inline that this pass is the ONLY thing protecting users in `localStorage` mode + `autonomousAgentsEnabled = false` (where neither network loader runs) from duplicate persistence carried over from before this fix shipped, and is also what makes back-to-back F5 refreshes self-healing without any network call.
- [X] T015c [US1] **Cross-loader clobber fix (finding N1 in `/speckit.analyze` re-run; Inv-G in `data-model.md`)**. In `ui/src/store/chat-store.ts`, convert the imperative `set({ conversations: sortedConversations, ... })` at the end of `loadConversationsFromServer` (around L1018) to the **callback form** so that any autonomous-source entries written by `loadAutonomousConversationsFromService` between this loader's snapshot read (L954) and its write are NOT discarded. Concretely:

  ```ts
  set((state) => {
    // Keep entries the other loader wrote between L954 and now (Inv-G).
    // Autonomous-synth entries are the canonical case (cross-loader race);
    // also keep any locally-streaming entries that appeared mid-load.
    const serverIds = new Set(sortedConversations.map(c => c.id));
    const crossLoaderAdditions = state.conversations.filter(c =>
      !serverIds.has(c.id) && (c.source === 'autonomous' || state.streamingConversations.has(c.id))
    );
    const merged = [...sortedConversations, ...crossLoaderAdditions];
    // Map-based dedupe-by-id (defense in depth; should be a no-op given the filter above)
    const deduped = Array.from(new Map(merged.map(c => [c.id, c])).values())
      .sort(compareConversationsForSidebar);
    return {
      conversations: deduped,
      ...(activeId && !deduped.some(c => c.id === activeId) ? {
        activeConversationId: deduped.length > 0 ? deduped[0].id : null,
        a2aEvents: [],
      } : {}),
    };
  });
  ```

  Add an inline comment referencing Inv-G in `data-model.md` explaining that the callback-form `set()` protects cross-loader interleaving (the same-loader case is already covered by `isLoadingConversations` at L883 for the server loader; the autonomous loader's Map-based dedupe is idempotent on a single snapshot, so no equivalent guard is required there).

  Add a Jest test in `ui/src/store/__tests__/chat-store.test.ts` named `loadConversationsFromServer + loadAutonomousConversationsFromService interleave preserves both loaders' contributions`. Setup:

  1. Mock `apiClient.getConversations` to return a controllable promise (resolve manually) yielding one server item with id `'S'`, no `source`.
  2. Mock `autonomousApi.listTasks` / `listRuns` to return one autonomous task with canonical id `'A'`.
  3. Invoke `loadConversationsFromServer()` (do NOT await) and let it reach the snapshot read.
  4. Invoke `loadAutonomousConversationsFromService()` and await its completion (writes `{id: 'A', source: 'autonomous'}` to the store).
  5. Resolve the server loader's promise so it proceeds to `set(...)`.
  6. Await the server loader.

  Assert the final `state.conversations` contains BOTH `'S'` and `'A'` with `'A'` retaining `source === 'autonomous'`. Pre-fix, this test fails because the server loader's imperative `set` clobbers the autonomous entry. Post-fix, both survive.
- [ ] T016 [US1] Re-run the four new dedupe tests (T010, T011, T012, T012a), the partialize regression test (T013, which exercises T013a's defensive strip), and the cross-loader interleave test from T015c; confirm all seven are green. Run `npm run lint` for the UI workspace and fix any new lint warnings introduced by T013a/T014/T015/T015a/T015c.

**Checkpoint**: User Story 1 is fully functional and independently testable. The sidebar shows exactly one entry per id after any sequence of `loadConversationsFromServer` + `loadAutonomousConversationsFromService` calls.

---

## Phase 4: User Story 2 — Refresh does not unexpectedly put the user in Audit Mode (Priority: P1)

**Goal**: After a browser refresh, the Read-Only Audit Mode banner appears only when (a) the user is an admin **and** (b) they actually navigated from the admin audit-logs or feedback views in the current session (`?from=audit-logs|feedback` is present). Non-admin users never see the banner. Autonomous conversations never resolve to `admin_audit` server-side. When the server returns `admin_audit` but the gate evaluates false (no `?from=`, or unrecognized value), the UI routes the case through the existing `shared_readonly` treatment. (Spec FR-004, FR-005, FR-006, FR-008, FR-009; Inv-C, Inv-C2, Inv-D.)

**Independent Test**: Sign in as an admin. Open an autonomous conversation directly (no `?from=...`), hard-refresh; verify no audit banner. Open another user's non-autonomous conversation via a deep link (no `?from=...`), hard-refresh; verify no audit banner. Open a conversation via `/admin?tab=audit-logs` (URL becomes `?from=audit-logs`), hard-refresh; verify audit banner still shows with "Back to Audit Logs" link.

### Tests for User Story 2 (write FIRST, ensure they FAIL before implementation)

- [X] T020 [P] [US2] Add a Jest test in `ui/src/app/api/__tests__/admin-audit-access.test.ts` named `admin viewing autonomous conversation returns shared_readonly` that mocks an admin session (`session.role === 'admin'`) and a non-owned conversation with `source: 'autonomous'`, calls `requireConversationAccess`, and asserts the returned `access_level === 'shared_readonly'`. Must fail against current `main`.
- [X] T021 [P] [US2] Add a Jest test in the same file named `admin viewing non-autonomous non-owned conversation still returns admin_audit` that mocks an admin session and a non-owned conversation without `source` (or `source: 'web'`), and asserts `access_level === 'admin_audit'`. This regression guard must pass against current `main`.
- [X] T022 [P] [US2] Add a Jest test in **`ui/src/components/chat/__tests__/ChatContainer.test.tsx`** (create the file if it does not exist — `ChatContainer` is the unit that contains the new Inv-C derivation; this test must target that unit, not `ChatPanel`) named `does not render audit banner when access_level is admin_audit but adminOrigin is null`. Mock `useSession` (return an admin session), `useParams` (return a `uuid`), `useSearchParams` (return `null` for `'from'`), and the underlying conversation API call to return `{ access_level: 'admin_audit', ... }`. Render `<ChatContainer />` and assert (a) the string "Read-Only Audit Mode" is **not** in the rendered output, AND (b) the "Back to Audit Logs" / "Back to Feedback" link is not rendered. Must fail against current `main` (because today the banner renders whenever `accessLevel === 'admin_audit'`).
- [X] T023 [P] [US2] **`ChatPanel` rendering regression guard (NOT a gate test — finding C9 in `/speckit.analyze`)**. Add a Jest test in `ui/src/components/chat/__tests__/ChatPanel.test.tsx` named `renders audit banner when readOnlyReason='admin_audit' is passed in`. This test exercises ONLY `<ChatPanel>` in isolation — render with the props `readOnlyReason='admin_audit'` and `adminOrigin='audit-logs'` and assert the banner + "Back to Audit Logs" link are visible. The actual *gate* (`accessLevel === 'admin_audit' && adminOrigin ∈ {...}`) lives in `ChatContainer` and is tested in T022 (negative) / T029 / T029a — this test is purely a guard against a future refactor that breaks the rendering side of the contract while the gate computation is correct. Must pass against current `main` (regression guard for legitimate audit-flow rendering).
- [X] T024 [P] [US2] Add a Jest test in `ui/src/components/chat/__tests__/ChatPanel.test.tsx` named `non-admin user with shared_readonly access never sees audit banner` rendering with `readOnlyReason={'shared_readonly'}` and asserting the "Read-Only Audit Mode" string is absent. Must pass against current `main` (regression guard for FR-005).
- [X] T029 [P] [US2] **Audit-context leak test (finding S5; spec edge case "audit context must not leak onto next own-conversation view")**. Add a Jest test in `ui/src/components/chat/__tests__/ChatContainer.test.tsx` named `does not render audit banner when user owns the conversation even if adminOrigin is set`. Mock `useSession` (admin session), `useParams` (return owned conversation's `uuid`), `useSearchParams` (return `'audit-logs'` for `'from'` — simulating a stale URL param carried across navigation), and the conversation API to return `{ access_level: 'owner', ... }`. Render `<ChatContainer />` and assert the "Read-Only Audit Mode" banner is **not** rendered (because `accessLevel === 'owner'`, the `adminAuditActive` gate evaluates false regardless of `adminOrigin`). Must pass against current `main` (already correct due to `accessLevel === 'admin_audit'` clause); kept as a regression guard so a future refactor cannot accidentally introduce an OR with `adminOrigin` alone.
- [X] T029a [P] [US2] **Cross-conversation `?from=` carry-over (finding C5 in `/speckit.analyze`)**. Add a Jest test in `ui/src/components/chat/__tests__/ChatContainer.test.tsx` named `renders audit banner for a different non-owned conversation when ?from=audit-logs is carried over in the URL`. Mock `useSession` (admin), `useParams` (return UUID of conversation B — admin does not own B), `useSearchParams` (return `'audit-logs'` for `'from'` — simulating the URL carry-over from a prior audit of conversation A in the same session), and the conversation API to return `{ access_level: 'admin_audit', ... }` for B. Assert the banner IS rendered (the gate is satisfied: server-side admin_audit AND URL says `?from=audit-logs`). This documents the intentional cross-conversation behaviour (data-model.md Inv-C, "Cross-conversation `?from=` carry-over", item 2) so a future change cannot tighten the gate to a per-conversation pin without an explicit spec update.
- [X] T029c [P] [US2] **`shared_readonly` fallback tests for the admin-without-recognized-origin case (finding N3 in `/speckit.analyze` re-run; spec FR-004 clarification 2; Inv-C2 option A)**. Add three Jest tests in `ui/src/components/chat/__tests__/ChatContainer.test.tsx`:
  1. `routes admin + admin_audit + no ?from= through the shared_readonly UI branch (no silent write-fail)` — Mock `useSession` (admin), `useParams` (non-owned UUID), `useSearchParams` (return `null` for `'from'`), API returns `{ access_level: 'admin_audit', ... }`. Assert: (a) the rendered output does NOT contain "Read-Only Audit Mode"; (b) the rendered output does NOT contain "Back to Audit Logs" or "Back to Feedback"; (c) the composer is NOT rendered (read-only); (d) the `ChatView` / `SupervisorChatView` prop is `readOnly={true}` AND `readOnlyReason === 'shared_readonly'` (NOT `'admin_audit'`, NOT a new value). Must fail against current `main` (today the audit banner renders, so post-T026 this test pins the fallback choice).
  2. `routes admin + admin_audit + unrecognized ?from= through the shared_readonly UI branch` — Same setup except `useSearchParams` returns `'shared-link'` (or `'whatever'`, `''`, or any string outside the closed set). Same assertions as test 1. Documents that the gate honours ONLY `'audit-logs'` and `'feedback'`.
  3. `non-admin user with non-owned shared_readonly conversation receives shared_readonly directly` — Mock `useSession` (non-admin), API returns `{ access_level: 'shared_readonly', ... }`, `useSearchParams` returns `null`. Assert `readOnlyReason === 'shared_readonly'`. Regression guard for FR-005: this branch is reachable from BOTH `access_level === 'shared_readonly'` (any user) AND `access_level === 'admin_audit' + no recognized ?from=` (admin only, via the Inv-C2 fallback); the test confirms non-admins reach it through path A (which is unchanged by this fix), not path B (which non-admins cannot reach because the server cannot return `admin_audit` for them).

### Implementation for User Story 2

- [X] T025 [P] [US2] **Depends on T028 (security audit) being green.** In `ui/src/lib/api-middleware.ts`, modify `requireConversationAccess` (around L443–L529). Move the autonomous-source branch (currently at L525–L527) to run **before** the admin fallback (currently at L514–L517). Add a comment referencing Inv-D from `data-model.md` and citing T028's findings as the justification (no write-path or audit-log regression). The new order is: owner → public-share → user-share → team-share → email-grant → **autonomous → shared_readonly** → admin → 403.
- [X] T026 [US2] In `ui/src/components/chat/ChatContainer.tsx` (around L404–L405), replace the current `readOnlyReason` derivation with the gated form per `data-model.md` "New derivation (post-fix)" — implementing Inv-C (audit-banner gate) and Inv-C2 (option A: `shared_readonly` fallback for the admin-without-recognized-origin case; finding N3). Concretely:

  ```ts
  // Inv-C: audit banner requires BOTH server admin_audit AND a recognized
  // in-session ?from= value (closed set: 'audit-logs' or 'feedback').
  const adminAuditActive = accessLevel === 'admin_audit'
    && (adminOrigin === 'audit-logs' || adminOrigin === 'feedback');

  // Inv-C2 (option A): server says admin_audit but the gate failed → route
  // through the EXISTING shared_readonly UI branch. No new readOnlyReason
  // value is introduced. ChatPanel rendering and prop-type union are
  // unchanged. FR-005 still holds because non-admins cannot reach
  // access_level === 'admin_audit' server-side.
  const isReadOnly =
    adminAuditActive
    || accessLevel === 'admin_audit'
    || accessLevel === 'shared_readonly';
  const readOnlyReason =
    adminAuditActive ? 'admin_audit'
    : (accessLevel === 'admin_audit' || accessLevel === 'shared_readonly') ? 'shared_readonly'
    : undefined;
  ```

  **No changes to `ChatPanel.tsx`, `ChatView`, or `SupervisorChatView` are required** — the existing `shared_readonly` rendering branch handles the new fallback case. The `readOnlyReason` prop-type union does NOT change.

  Add a comment referencing Inv-C and Inv-C2 from `data-model.md` noting that this gating is **presentation-only** and `adminOrigin` (from URL search params) is never trusted for authorization — the server-side `access_level` is authoritative.

  **Scope note (finding N2 in `/speckit.analyze` re-run; data-model.md "Where the gate runs")**: This gate runs on the API-roundtrip path (`ChatContainer.tsx` L196–L218), where the server can return `access_level === 'admin_audit'`. It is intentionally a no-op on the local-store-hit path (L130–L143), which never assigns `'admin_audit'` because Inv-E forbids persisting that signal. Add an inline comment documenting this so a future reviewer does not "fix" the local-store-hit path to ALSO produce `'admin_audit'` (that would be a feature expansion, out of scope for this spec).
- [ ] T027 [US2] Re-run the new tests T020, T021, T022, T023, T024, T029, T029a, T029c and confirm all eight are green. Run `npm run lint` for the UI workspace.

**Checkpoint**: User Story 2 is fully functional. Admins refreshing on autonomous chats or other-user chats without `?from=...` see no audit banner. Legitimate admin audit flow (via `?from=audit-logs|feedback`) still works.

---

## Phase 5: User Story 3 — Active conversation state survives refresh cleanly (Priority: P2)

**Goal**: For every conversation source (web, autonomous, slack, shared), after refresh the selected sidebar entry and the conversation shown in the main panel reference the same `id`; if the persisted active id no longer matches a real server-known conversation, the app falls back cleanly without fabricating a placeholder or applying any read-only treatment. (Spec User Story 3 acceptance scenarios; FR-006, FR-009.)

**Independent Test**: For each source type, open a conversation, refresh, verify exactly one highlighted sidebar entry and the URL/active id matches. Then delete the active conversation in another tab and refresh this tab; verify graceful fallback (no duplicate stub, no audit banner).

### Tests for User Story 3 (write FIRST, ensure they FAIL or pass-as-regression as noted)

- [X] T030 [P] [US3] Add a Jest test in `ui/src/store/__tests__/chat-store.test.ts` named `stale activeConversationId falls back without creating a stub` covering the full US3 Scenario 2 contract (finding M4 in `/speckit.analyze` Pass 3 — was previously only asserting the negative half). Two sub-tests:

  **Sub-test 1 — empty server response**: seed `activeConversationId: 'STALE'` with `conversations: []`, mock `apiClient.getConversations` (the `loadConversationsFromServer` dependency) to return `{ items: [] }`, call `loadConversationsFromServer()`, then assert:
  - (a) `state.conversations` contains no entry with `id: 'STALE'` (negative half — was the only prior assertion);
  - (b) `state.activeConversationId === null` — no stub is fabricated to satisfy the stale pointer; the selection clears cleanly (FR-006, FR-009);
  - (c) `state.a2aEvents` is `[]` — no event state carried over from the stale conversation.

  **Sub-test 2 — server returns a different conversation**: same seed but the API returns `{ items: [{ id: 'REAL', ... }] }`. Assert `state.conversations` has exactly one entry with `id: 'REAL'`, then assert the active id against the **spec contract** (not the current implementation):
  - `expect(state.activeConversationId).not.toBe('STALE')` — the stale pointer MUST be cleared (FR-006 + FR-009);
  - `expect([null, 'REAL']).toContain(state.activeConversationId)` — the spec deliberately leaves the fallback as "no selection OR most-recent valid conversation"; either value is acceptable.

  This wording (disjunctive, contract-shaped) replaces the earlier instruction that told the test author to read `chat-store.ts` L1014–L1024 and pin the assertion to whichever value the implementation chose. Pinning to the implementation hides the spec's intentional ambiguity from the test surface and makes the test brittle to a legitimate future change of fallback policy (e.g., from "first conversation" to "null"). The contract-shaped form will continue to pass whichever branch lands as long as the spec contract holds.

  Both sub-tests should pass against current `main` — the `activeStillExists` branch already implements one valid fallback (most-recent valid conversation). Test acts as a regression guard for FR-006 + FR-009 + US3 Scenario 2's clean-fallback contract, and as documentation that EITHER fallback choice is acceptable. (Closes finding A4 in the latest `/speckit.analyze`.)
- [X] T031 [P] [US3] Add a single source-agnostic Jest test in `ui/src/store/__tests__/chat-store.test.ts` named `dedupe is source-agnostic` that seeds two entries with the same `id` but different `source` values (the canonical bug case: `source: undefined` vs `source: 'autonomous'`) and asserts the dedupe path leaves exactly one entry. The Map-based dedupe in T014/T015/T015a keys on `id` alone — `source` never appears in the key — so a single test pins the source-agnostic property; parameterizing over every `source` value would only re-test the same Map-key behaviour. Must fail against current `main` (this is the same bug T010 already exercises; T031 is the US3 cross-source regression guard that documents the source-agnostic contract for future maintainers).

### Implementation for User Story 3

- [X] T032 [US3] No new code beyond what US1 and US2 already deliver — T014 and T015 (dedupe-by-id) together satisfy FR-006 and the cross-source coverage. T031 acts as the cross-source regression guard. If T031 fails for a source not covered by the Map-based dedupe (because that source label is dropped/changed elsewhere), extend the dedupe in T014/T015 to handle that source; otherwise mark T032 complete with a one-line note in the spec PR description that says "implementation satisfied by T014, T015; verified by T031."

**Checkpoint**: User Story 3 verified. Refresh restoration is clean for every source; stale active-id falls back without side effects.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, documentation, and quality gates.

- [ ] T040 [P] Run the full UI workspace test suite: `cd ui && npm run lint && npm test`. Fix any unrelated test failures only if they appear flaky; otherwise report them and leave for a separate PR.
- [ ] T041 [P] Walk through the three manual repro scenarios in `docs/docs/specs/2026-05-15-fix-refresh-state-bugs/quickstart.md` (Case A: admin on autonomous; Case B: admin on other-user non-autonomous; Case C: legitimate audit flow; plus the non-admin Case D safety check). Record results in the PR description.
- [X] T042 [P] Update the spec's Status field at the top of `docs/docs/specs/2026-05-15-fix-refresh-state-bugs/spec.md` from `Draft` to `Implemented` and add a `**Closed**:` date line below `**Created**:`.
- [ ] T043 Run `make caipe-ui-tests` from the repo root (Constitution VI quality gate) and confirm green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion.
  - **T028 (security audit)** BLOCKS T025 (server-side authorization reorder). T028 must produce green flags for both write-path safety and audit-log behaviour, or T025 is rebased to a different approach (see T028 for the escalation path).
  - **T003 (partialize comment)** is a soft prerequisite for T013 (the test it grounds) and should land before US1 tests merge.
- **User Story 1 (Phase 3)**: Can start as soon as Phase 1 is green. T013 should land after T003. Otherwise independent of US2.
- **User Story 2 (Phase 4)**: Test-authoring (T020–T024, T029, T029a, T029c) can start as soon as Phase 1 is green. **T025 must wait for T028.** T026 is independent of T028 (client-side, presentation-only).
- **User Story 3 (Phase 5)**: Verification phase that depends on US1's implementation tasks (T014, T015). Tests T030, T031 can be authored in parallel with US1 implementation but will only go green once T014 and T015 land.
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### User Story Dependencies

- US1 ↔ US2: Independent. Different files (`chat-store.ts` vs `api-middleware.ts` + `ChatContainer.tsx`). Can be implemented in parallel by different developers.
- US3: Depends on US1 implementation; depends on nothing in US2.

### Within Each User Story

- Tests authored and failing **before** implementation lands (TDD per Constitution VI).
- US1: tests T010–T013 + T012a → implementation T013a → T014 → T015 → T015a → T015c → verification T016.
- US2: T028 (security audit, BLOCKING for T025) → tests T020–T024, T029, T029a, T029c → implementation T025 (server, after T028 green) ∥ T026 (client) → verification T027.
- US3: tests T030, T031 → no implementation beyond US1; verification T032.

### Parallel Opportunities

- All test-authoring tasks marked [P] across phases can be written in parallel (T010–T013, T012a, T020–T024, T029, T029a, T029c, T030, T031 — each lives in a distinct test file or a distinct `describe` block in `chat-store.test.ts` / `ChatContainer.test.tsx` / `ChatPanel.test.tsx`).
- T013a, T014, T015, T015a, T015c (all in `chat-store.ts`) must be sequential to avoid merge conflicts in the same file. Recommended order: T013a → T014 → T015 → T015a → T015c.
- T025 (`api-middleware.ts`) and T026 (`ChatContainer.tsx`) are different files → parallel **after T028 is green**.
- T028 is read-only investigation and can run in parallel with all US1 work and all US2 test authoring; it only gates T025.
- All Polish tasks marked [P] can run in parallel.

---

## Parallel Example: User Story 1

```bash
# Author all five US1 tests in parallel (different describe blocks in the same file):
Task: "T010 — Add 'loadAutonomousConversationsFromService dedupes by id' test in ui/src/store/__tests__/chat-store.test.ts"
Task: "T011 — Add 'preserves user-typed messages on dedupe' test in ui/src/store/__tests__/chat-store.test.ts"
Task: "T012 — Add 'loadConversationsFromServer produces unique ids' test in ui/src/store/__tests__/chat-store.test.ts"
Task: "T012a — Add 'onRehydrateStorage dedupes duplicate ids in persisted localStorage' test in ui/src/store/__tests__/chat-store.test.ts"
Task: "T013 — Add 'partialize never persists authorization fields' test in ui/src/store/__tests__/chat-store.test.ts"

# Then implementation (sequential — all five edits in chat-store.ts):
Task: "T013a — Defensive partialize: explicit denylist-strip per Conversation and ChatMessage (Inv-E runtime enforcement)"
Task: "T014 — Map-based dedupe in loadAutonomousConversationsFromService"
Task: "T015 — Map-based dedupe in loadConversationsFromServer"
Task: "T015a — Rehydrate-time dedupe in onRehydrateStorage (defensive guards + winner selection + message merge)"
Task: "T015c — Callback-form set() in loadConversationsFromServer to prevent cross-loader clobber (Inv-G)"
```

## Parallel Example: User Story 2

```bash
# 1. Run the security audit FIRST (blocks T025):
Task: "T028 — Read-only audit of API write handlers and audit-log writers; append findings to research.md"

# 2. Author US2 tests in parallel (three files; can run alongside T028):
Task: "T020 — admin + autonomous → shared_readonly test in admin-audit-access.test.ts"
Task: "T021 — admin + non-autonomous non-owned → admin_audit regression test (same file)"
Task: "T022 — audit banner hidden without adminOrigin test in ChatContainer.test.tsx"
Task: "T023 — audit banner shown with adminOrigin=audit-logs (regression) test in ChatPanel.test.tsx"
Task: "T024 — non-admin shared_readonly never sees audit banner (regression) test in ChatPanel.test.tsx"
Task: "T029 — audit context does not leak onto own conversation (regression) test in ChatContainer.test.tsx"
Task: "T029a — cross-conversation ?from= carry-over renders banner on conversation B in ChatContainer.test.tsx"
Task: "T029c — shared_readonly fallback (Inv-C2) for admin without recognized ?from= (3 sub-tests) in ChatContainer.test.tsx"

# 3. Then implementation (T025 blocked on T028 green; T026 unblocked):
Task: "T025 — Reorder requireConversationAccess in api-middleware.ts (after T028 green)"
Task: "T026 — Gate admin_audit on adminOrigin in ChatContainer.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001, T002).
2. Complete Phase 2 foundational items needed for US1 only (T003). T028 is only required for US2's T025 and can be deferred until US2 work begins.
3. Complete Phase 3: User Story 1 (tests T010–T013 + T012a → implementation T013a → T014 → T015 → T015a → T015c → verification T016).
4. **STOP and VALIDATE**: Run quickstart Repro 1 (duplicate tab). Deploy if green.

This MVP alone closes the more visible of the two reported bugs (duplicate autonomous tab) and is independently shippable.

### Incremental Delivery

1. Setup + Foundational → baseline.
2. US1 → Test (Repro 1) → Demo / merge → MVP shipped.
3. US2 → Test (Repros 2A/B/C) → Demo / merge.
4. US3 → Verify (parametric regression test) → Demo / merge.
5. Polish → ship.

### Parallel Team Strategy

With two developers:

- Developer A: US1 (chat-store dedupe) — owns `chat-store.ts` edits.
- Developer B: US2 (audit-mode gating) — owns `api-middleware.ts` + `ChatContainer.tsx` edits.
- Both run their respective test suites independently; integrate at Phase 6.
- US3 verification can be picked up by either developer once US1 lands.

---

## Notes

- [P] markers indicate tasks in different files with no incomplete-task dependencies.
- All tests are co-located with the code under test (`ui/src/.../__tests__/`) per existing repo convention.
- No backend (Python) changes, no MongoDB schema changes, no migration file.
- Persistence key (`caipe-chat-history`) and `partialize` output shape are unchanged; existing user state remains valid across the upgrade.
- Constitution VII (Security by Default): the server-side change in T025 is more restrictive (admin + autonomous → `shared_readonly` instead of `admin_audit`), never less. Non-admin users remain locked out of audit mode at every layer. **T028** explicitly verifies, before T025 lands, that no write-side handler or audit-log writer is silently weakened by the reclassification (defense in depth; findings S1 and S2 from `/speckit.analyze`).
- The client-side gating in T026 is **presentation-only**. `adminOrigin` is sourced from a user-controllable URL query parameter and is NEVER trusted for authorization. The server-side `access_level` in `requireConversationAccess` remains the sole authorization source of truth (finding S3 from `/speckit.analyze`).
- Verify tests fail before implementing (TDD per Constitution VI).
- Commit after each task or logical group; use conventional commits with DCO sign-off (`-s`).
