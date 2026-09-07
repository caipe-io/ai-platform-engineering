# Phase 0 — Research: Fix UI State Bugs on Browser Refresh

**Feature**: `2026-05-15-fix-refresh-state-bugs`
**Date**: 2026-05-15

This document records the root-cause investigation, the decisions taken to resolve them, and the alternatives considered. It is the input to `plan.md` Phase 1 design.

## Question 1 — Why does a duplicate sidebar entry appear after refresh?

### What the code does today

Two store actions populate `useChatStore.conversations` independently, both fire on (or shortly after) page mount, and they are merged into the same list:

- `loadConversationsFromServer({ source?: 'autonomous' | 'web' })` — `ui/src/store/chat-store.ts` ~L873–L1042. Pulls all the user's conversations from `/api/chat/conversations` (MongoDB). Each item carries an explicit `source` field if present on the server document. The merge step (~L992–L1011) also preserves any **local-only** conversation that is either actively streaming or is the `activeConversationId`, regardless of whether it appears in the server response.
- `loadAutonomousConversationsFromService()` — `ui/src/store/chat-store.ts` ~L1060–L1182. Calls the autonomous-agents service, synthesizes one Conversation per task using `synthesizeConversationForTask` (in `ui/src/components/autonomous/synthesize-conversation.ts`), and merges them back into the store. The merge filters `state.conversations` into:
  - `existingAutonomous` — entries with `source === 'autonomous'` (used to preserve user-typed messages on resync).
  - `others` — entries with `source !== 'autonomous'` (kept as-is).
  - then concatenates `[...others, ...merged]` and sorts.

The conversation `id` for a synthesized autonomous Conversation is `task.chat_conversation_id ?? uuidv5("task:<task.id>", AUTONOMOUS_NS)` (`canonicalConversationId`, synthesize-conversation.ts L67–L70). The same id is what the autonomous publisher writes to MongoDB as `chat_conversation_id`, so in the happy path the server-fetched record and the synthesized record share an id.

### Why duplicates appear

The autonomous merge filters `existingAutonomous` strictly by `source === 'autonomous'`. Anything with the same id but a different (or missing) `source` value falls into `others` and survives untouched. Then the synth produces a fresh entry with `source === 'autonomous'`. The final `[...others, ...merged]` array contains **two entries with the same `id`**.

Concrete paths that produce a same-id-without-`source` entry on refresh:

1. **Zustand persisted state (localStorage mode)**. The persisted snapshot at key `caipe-chat-history` includes `conversations` (with `messages`, ids, etc.). If the user's previously-active conversation was an autonomous one whose `source` field hadn't been written into the in-memory copy yet (race against `loadAutonomousConversationsFromService`, or persisted before the autonomous publisher populated `chat_conversation_id`), the persisted entry rehydrates with `source` undefined or `source: 'web'`.
2. **`ChatContainer` API fallback (`apiClient.getConversation`)**. On refresh of a deep link `/chat/<uuid>`, `ChatContainer.tsx` L196–L218 builds a `LocalConversation` from the conversation detail endpoint and pushes it into the store **without `source`** (the local mapping object at L204–L214 simply omits the field). If that uuid happens to match a synthesized autonomous canonical id, the entry without `source` ends up in `others` while the synth produces a parallel `source: 'autonomous'` entry.
3. **`loadConversationsFromServer` local-only preservation** (L1000–L1005) keeps the `activeConversationId` even if the server didn't return it. If that active conversation came from path (1) or (2), the same id-without-`source` is preserved into the post-merge list and then duplicated by the autonomous synth.

The user's observation — "a duplicate of the tab appears and is selected along with the autonomous chat" — matches exactly: the persisted/active copy stays selected (because `activeConversationId` is restored), and the synth adds a second item under the Autonomous section. Two entries, both clickable, both visually selected (since both have the same `id` and the sidebar likely highlights by id-equality).

### Decision

Add a final **dedupe-by-`id` pass** after both loaders run. When two entries share an id, prefer the autonomous-synthesized copy for `source / messages / a2aEvents` if present, and merge messages by `message.id` (the existing synth-merge logic at L1157–L1161 already keeps user-typed messages by id). Concretely:

- In `loadAutonomousConversationsFromService`, change the final assembly from `[...others, ...merged]` to a Map-based dedupe keyed by `id`, with the synth entry winning when both exist. This single change is sufficient.
- In `loadConversationsFromServer`, also run a dedupe-by-id over `[...serverConversations, ...localOnlyPreserved]` to harden against any other code path that pushes an entry into the store (defense in depth).

### Rationale

- One-line invariant ("no two sidebar entries share an id") is conceptually simpler than reconciling the source field everywhere it's written.
- Matches Constitution I (Worse is Better) and Constitution II (YAGNI): no new abstraction, no model rewrite, only a transformation at the merge sites.
- Backward compatible: any code that reads `state.conversations.find(c => c.id === uuid)` already assumes uniqueness; the fix matches that assumption.

### Alternatives considered

- **Reconcile `source` on every fetch path** — Rejected. Touches more files, risks regressions where conversations legitimately carry a non-autonomous source.
- **Drop the `partialize` `conversations` entry from Zustand persistence in MongoDB mode** — Rejected. Persistence is used to make the sidebar feel instant on refresh and to preserve in-progress drafts. Removing it widens the scope and degrades UX.
- **Bump the Zustand persist version (force clear)** — Rejected. Loses unrelated user state (input drafts, selected turn, unviewed flags).

## Question 2 — Why does refresh sometimes put the user in Read-Only Audit Mode?

### What the code does today

`requireConversationAccess` in `ui/src/lib/api-middleware.ts` L443–L529 returns `{ conversation, access_level }` where `access_level` is one of `'owner' | 'shared' | 'shared_readonly' | 'admin_audit'`. The order of checks is:

1. Owner → `owner`
2. `sharing.is_public` → `shared` or `shared_readonly`
3. `sharing.shared_with` includes the user → `shared`/`shared_readonly`
4. Team grant → `shared`/`shared_readonly`
5. Email-grant subcollection → `shared`/`shared_readonly`
6. **`session.role === 'admin' || session.canViewAdmin === true` → `admin_audit`** (L514–L517)
7. `conversation.source === 'autonomous'` → `shared_readonly` (L525–L527)
8. Else → 403

The `/api/chat/conversations/[id]` route returns `{ ...conversation, access_level }`. `ChatContainer.tsx` L200–L203 stores that value as `accessLevel`, and computes:

```ts
const isReadOnly = accessLevel === 'admin_audit' || accessLevel === 'shared_readonly';
const readOnlyReason = accessLevel === 'admin_audit' ? 'admin_audit'
  : accessLevel === 'shared_readonly' ? 'shared_readonly'
  : undefined;
```

`ChatPanel.tsx` L1837–L1865 renders the **Read-Only Audit Mode** banner with a "Back to Audit Logs" / "Back to Feedback" link whenever `readOnlyReason === 'admin_audit'`, regardless of `adminOrigin`. `adminOrigin` only influences which back-link is shown (defaulting to "Back to Feedback" when null).

### Why audit mode appears unexpectedly

Two converging defects:

- **Server**: For admin users (`session.role === 'admin'`), opening **any** conversation they don't own — including autonomous-source conversations — falls into the `admin_audit` branch at step 6 above. Step 7 (autonomous → `shared_readonly`) is never reached for admins. Effectively, an admin who looks at autonomous tasks daily (the design intent of the autonomous tab) is always told "you are auditing this conversation."
- **Client**: `ChatContainer` does not require `adminOrigin` to display the audit banner. So even when the user navigates to a conversation by clicking a sidebar item (no `?from=...` query param) or by hard-refreshing a deep link (query params often lost across redirects, or absent in the persisted URL), the banner triggers from the API-returned `access_level` alone.

Result: a signed-in admin who refreshes on any non-owned conversation — most reliably an autonomous one — sees the audit banner and is locked out of the composer.

### Decision (defense in depth)

- **Server fix (root cause for autonomous case)**: Reorder the checks in `requireConversationAccess` so the `source === 'autonomous'` branch returns `shared_readonly` **before** the admin fallback. Admins viewing autonomous conversations get the same read-only-but-non-audit view that all other users get. Legitimate admin audit access to private user conversations (the original intent) is preserved.
- **Client fix (covers any other code path that could mis-classify)**: In `ChatContainer.tsx`, when deriving `readOnlyReason`, gate `admin_audit` on `adminOrigin ∈ {'audit-logs', 'feedback'}`. When the API returns `admin_audit` but `adminOrigin` is null, treat the page as a normal admin view — no audit banner, no audit back-link. (Write attempts are still blocked at the API layer because the server returns `admin_audit` and the existing POST/PUT routes reject non-owner mutations; client-side banner suppression is presentation-only.)

### Rationale

- Server change closes the most common path (admin on autonomous) at the authority layer (Security by Default, Constitution VII).
- Client change closes the remaining presentation gap (admin viewing other non-owned conversations) without weakening any authorization decision.
- Together they implement spec FR-004 (audit context tied to in-session admin navigation) and FR-005 (non-admins never see audit banner — already true, preserved).

### Alternatives considered

- **Persist `adminOrigin` across refresh** — Rejected. URL/search-params are the source of truth for in-session navigation context; silently restoring admin/audit context from persisted state is exactly what FR-008 forbids.
- **Always show audit banner for admins on others' conversations** — Rejected. Contradicts FR-004 and produces the exact bug the user reported.
- **Remove `admin_audit` entirely** — Rejected. Legitimate admin auditing (reached from the audit-logs / feedback views) is a real feature; we just need to scope it correctly.

## Question 3 — Does persisted client state need a one-time cleanup?

### Decision

No mass clear is needed, but the dedupe pass MUST run at rehydrate time (not only at network-load time) — see Question 4.

- The dedupe-by-id pass heals duplicate entries the next time either loader runs after this fix ships. Users who refresh once after the upgrade and wait for the loaders to complete will see a clean sidebar.
- **However**, network loaders are not the only entry point. The dedupe pass MUST also run inside `onRehydrateStorage` so that (a) the duplicate is healed on the very first paint after rehydrate, before any network call, and (b) `localStorage` mode users who have `autonomousAgentsEnabled = false` (where neither `loadConversationsFromServer` nor `loadAutonomousConversationsFromService` does any meaningful work) are still healed. See Question 4 for the back-to-back-refresh analysis.
- The audit-mode fix is purely runtime: it depends on the **current** URL `adminOrigin` and the **current** API response, neither of which is persisted. Existing persisted state cannot carry forward an erroneous audit banner across the upgrade.
- A defensive comment will be added next to the Zustand `partialize` configuration noting that `access_level`, `readOnlyReason`, `adminOrigin`, and any other authorization/session flag MUST NOT be added to the persisted shape (Inv-E in `data-model.md`).

### Alternatives considered

- **Bump persist version** — Rejected. Loses unrelated user state. Not required because the bugs are runtime-derived once dedupe is in place at all three sites (rehydrate + both network loaders).

## Question 4 — What happens if the user refreshes twice in rapid succession?

### Why this matters

Reported during `/speckit.analyze` re-review: the original plan only added the dedupe pass at network-load time (`loadConversationsFromServer` and `loadAutonomousConversationsFromService`). Both are async. A user who has a poisoned `localStorage` (a duplicate persisted before this fix shipped) and slams F5 twice in rapid succession can land in a state where the persisted-duplicate is rehydrated, no loader has yet completed + persisted the deduped state, and the second F5 rehydrates the same poisoned `localStorage` again. The fix never catches up.

### Storage-mode analysis

| Scenario | Pre-rehydrate-dedupe behaviour | Post-rehydrate-dedupe behaviour |
|---|---|---|
| **MongoDB mode**, any refresh count | No `localStorage` persistence — store starts empty, loaders run, dedupe applies, clean. | Same. (Rehydrate dedupe is a no-op in MongoDB mode because there's nothing to rehydrate.) |
| **`localStorage` mode + autonomous enabled**, single refresh | Brief flicker showing the duplicate, then `loadAutonomousConversationsFromService` heals it and `partialize` writes clean state. | No flicker — rehydrate is self-healing on first paint. |
| **`localStorage` mode + autonomous enabled**, back-to-back refresh | If the second F5 fires before the first refresh's loader completes + persists, the same poisoned `localStorage` is rehydrated. Possible to never converge if the user keeps mashing F5. | Each rehydrate is independently self-healing. The very first paint after F5 already shows the deduped sidebar. Loader completion is no longer required for correctness. |
| **`localStorage` mode + `autonomousAgentsEnabled = false`**, any refresh | `loadAutonomousConversationsFromService` early-returns (only filters `source === 'autonomous'`), and `loadConversationsFromServer` early-returns (localStorage mode skips server sync). The dedupe pass never runs. **Duplicate persists indefinitely.** | Rehydrate dedupe runs unconditionally on every rehydrate. Heals on first paint. |

### Decision

Add a Map-based dedupe-by-id pass to `onRehydrateStorage` in `chat-store.ts`. Insertion order on collision: `source === 'autonomous'` wins; otherwise more `messages` wins; otherwise most-recent `updatedAt` wins. This complements the network-load dedupe sites and makes the rehydrate path self-healing in every storage mode.

### Rationale

- **Defense in depth (Constitution VII)**: three independent dedupe sites (rehydrate, server loader, autonomous loader) — removing any one still leaves correctness coverage in the most common modes.
- **Worse-is-Better**: the rehydrate dedupe is ~10 lines using the same `Map<id, Conversation>` pattern as the loader sites; no new abstraction.
- **Survives unbounded back-to-back F5 presses** without requiring loader completion or network availability.

### Alternatives considered

- **`isLoadingAutonomous` module-level guard** (considered and dropped) — A same-loader concurrency guard symmetric to the existing `isLoadingConversations` was considered for the autonomous loader but is not required for correctness. The Map-based dedupe inside `loadAutonomousConversationsFromService` is idempotent on its own snapshot, so two concurrent invocations of the same loader still produce a duplicate-free final state. The intermediate write order is non-deterministic but the final state converges. The cross-loader case is the one that needs explicit coordination, and that is handled by T015c's callback-form `set(...)` (Inv-G).
- **`BroadcastChannel` to dedupe across tabs** — Over-engineering for this bug. Multi-tab race is a separate, lower-priority edge case.

## Question 5 — Can the two loaders clobber each other when they interleave? (finding N1)

### Why this matters

Reported during the second `/speckit.analyze` re-review. The two network loaders run on independent timers and lifecycles:

- `loadConversationsFromServer` (chat-store.ts L873–L1042) reads its snapshot at L954, builds `sortedConversations`, and writes via the **imperative form** `set({ conversations: sortedConversations, ... })` at L1018. The imperative form does NOT re-read the latest store state at write time — it overwrites with the value computed from the stale snapshot.
- `loadAutonomousConversationsFromService` (chat-store.ts L1108–L1177) writes via the **callback form** `set((state) => { ... })`, which always sees the latest state.

If the autonomous loader's callback `set(...)` lands **between** the server loader's snapshot read (L954) and the server loader's imperative `set(...)` (L1018), the autonomous loader's freshly-written entries are silently overwritten by the server loader's stale snapshot. Reproducer: a refresh that fires both loaders in parallel — the autonomous loader is typically faster (fewer fan-out calls) and writes first; the server loader then overwrites and loses the autonomous entries until the next 30-second autonomous resync.

### Why a same-loader guard alone is not enough

A same-loader guard (e.g., adding an `isLoadingAutonomous` boolean symmetric to the existing `isLoadingConversations`) only short-circuits a **second invocation of the same loader**. It explicitly does not coordinate between the server and autonomous loaders, because they pull different data sources and one waiting on the other would double the worst-case refresh latency. The cross-loader interleave (server's stale-snapshot imperative `set(...)` overwriting autonomous's freshly-written callback `set(...)`) is unaffected by any same-loader guard.

### Decision

Convert `loadConversationsFromServer`'s final `set(...)` to the callback form, and explicitly preserve any autonomous-source or streaming entries that appeared in the latest state but not in the snapshot. See `data-model.md` "Inv-G" and tasks.md T015c. The Map-based dedupe pass already required by T015 stays in place as defense in depth; T015c only changes WHICH list goes through the dedupe (snapshot-only → snapshot ∪ cross-loader-additions).

### Rationale

- **Worse-is-Better**: a one-line change from `set(value)` to `set((state) => value)` plus a small filter expression. No new abstraction, no shared mutex.
- **Preserves parallel I/O latency**: both loaders still run unblocked; only the write step coordinates.
- **Defense in depth**: the dedupe-by-id invariant is preserved; any future code that writes to `conversations` outside the loaders is still healed at rehydrate (Inv-A site 1) and at the loader sites.

### Alternatives considered

- **Single shared mutex (`isLoadingConversationsOrAutonomous`)** — Rejected as the default. Serializes the loaders, doubling worst-case refresh latency. Acceptable as a fallback if the callback-form fix proves intricate in review.
- **Pure `useReducer`-style atomic merge in a custom Zustand middleware** — Rejected. Over-engineering; YAGNI (Constitution II).

## Phase 0 addendum: write-path and audit-log audit (T028)

**Date**: 2026-05-15
**Scope**: Read-only static codebase audit confirming the precondition for T025 (the server-side reorder of `requireConversationAccess`). Two questions per `tasks.md` T028.

### 1. Write-path safety (S1) — GREEN

Audit command: `rg "admin_audit|shared_readonly|access_level" ui/src/app/api -n -t ts`. Every match in a write-side handler (POST/PUT/PATCH/DELETE) was inspected:

- `ui/src/app/api/chat/conversations/[id]/messages/route.ts` L81 — POST handler:

  ```ts
  if (access_level === 'admin_audit' || access_level === 'shared_readonly') {
    throw new ApiError('Read-only access — cannot add messages', 403, 'FORBIDDEN');
  }
  ```

- `ui/src/app/api/chat/conversations/[id]/turns/route.ts` L99 — POST handler:

  ```ts
  if (access_level === "admin_audit" || access_level === "shared_readonly") {
    throw new ApiError("Read-only access — cannot write turns", 403, ...);
  }
  ```

Both handlers treat `admin_audit` and `shared_readonly` **identically** as "no write." No write-side handler grants additional capability based on `access_level === 'admin_audit'` alone. Reclassifying admin-on-autonomous from `admin_audit` to `shared_readonly` (T025) does **not** change any write-path decision: the user was blocked from writing before, and is blocked from writing after.

**Flag: GREEN.** T025 may proceed.

### 2. Audit-log behaviour (S2) — GREEN

Audit command: `rg "audit_log|auditLog|access_level.*admin_audit" ui/src/app/api -n -t ts`. Inspection of `ui/src/app/api/admin/audit-logs/`:

- `route.ts`, `[id]/route.ts`, `[id]/messages/route.ts`, `export/route.ts`, `owners/route.ts` — every audit-logs route gates on the `auditLogsEnabled` server config and `requireAdmin(session)` (which keys on `session.role === 'admin' || session.canViewAdmin`), **NOT** on `access_level === 'admin_audit'`. The `access_level` value returned by `requireConversationAccess` is never read by an audit-log writer.

- No code path was found that conditionally writes an audit-log entry based on `access_level === 'admin_audit'` vs. `'shared_readonly'`. There is no implicit "admin viewed an autonomous conversation as `admin_audit`" log entry that the T025 reclassification would silently disable. Audit logs in this codebase are list/export views over `conversations` and `messages` collections, gated by admin role — they are not produced by the access-decision helper.

**Flag: GREEN.** T025 may proceed without an additional log-preservation follow-up.

### Conclusion

Both flags are GREEN. T025 (autonomous-before-admin reorder in `requireConversationAccess`) is safe to land:
- No write-side regression: all writers already treat `admin_audit` and `shared_readonly` identically.
- No audit-log regression: no writer keys on `access_level === 'admin_audit'`.

T013 + T013a together cover the FR-008 / Inv-F persistence-side enforcement (the `partialize` strip + the explicit-key-injection test).

## Best practices applied

- **Defense in depth** (Constitution VII): both server (`requireConversationAccess`) and client (`ChatContainer`) enforce the audit-mode condition. Removing either alone would still leave the user covered.
- **Idempotent merges** (Zustand pattern): dedupe-by-id at the assembly step is the canonical fix when multiple async loaders contribute to the same list.
- **Session vs persisted state separation** (Next.js + Zustand): authorization, permission, and navigation-origin signals must always be derived from the current session and URL, never restored from `localStorage`.
- **No backend changes** beyond the authorization helper: keeps the blast radius small. No MongoDB schema, no migration, no Python code touched.
