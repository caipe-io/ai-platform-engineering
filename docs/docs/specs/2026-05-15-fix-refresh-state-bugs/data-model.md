# Phase 1 — Data Model & Invariants

**Feature**: `2026-05-15-fix-refresh-state-bugs`
**Date**: 2026-05-15

This feature does not introduce new persisted entities. It tightens the invariants of two existing in-memory shapes (`ChatState.conversations` and `ChatContainer`'s derived `readOnlyReason`) and one server-side return value (`requireConversationAccess.access_level`).

## In-Memory: `ChatState.conversations` (Zustand store)

**Type**: `Conversation[]` (see `ui/src/types/a2a.ts` for the `Conversation` type)

### Existing fields (unchanged)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (UUID) | Canonical conversation identifier. For autonomous tasks, `task.chat_conversation_id ?? uuidv5("task:<task.id>", AUTONOMOUS_NS)`. |
| `title` | `string` | |
| `createdAt` / `updatedAt` | `Date` | |
| `messages` | `ChatMessage[]` | |
| `a2aEvents` | `A2AEvent[]` | Not persisted. |
| `streamEvents` | `StreamEvent[]` | Not persisted. |
| `participants` | `Participant[]` | |
| `owner_id` | `string?` | Server-provided when present; missing on synthesized autonomous entries. |
| `sharing` | `Conversation['sharing']?` | |
| `source` | `'web' \| 'slack' \| 'autonomous' \| undefined` | Set by the loader that produced the entry. |
| `task_id`, `run_id` | `string?` | Autonomous metadata. |

### Invariants enforced by this feature

- **Inv-A — Uniqueness by id**: For all `i ≠ j`, `conversations[i].id !== conversations[j].id`. No two sidebar entries may share an id, regardless of `source`. Enforced at **three** sites so the invariant holds in every storage mode and even when no network call has run yet:
  1. **`onRehydrateStorage`** (Zustand `persist`, `localStorage` mode only) — runs synchronously when the store is first hydrated from `localStorage`. Defensive guards FIRST: short-circuit if `state` is null/missing `conversations`; skip any entry with a non-string or empty `id`. Then Map-based dedupe-by-id keyed on `Conversation.id`. **Winner selection on collision (deterministic, NaN-safe; finding N5 in `/speckit.analyze` re-run)**:
     a. If exactly one of the two has `source === 'autonomous'`, that one wins (consistent with Inv-B).
     b. Otherwise prefer the entry with more `messages.length`.
     c. Otherwise prefer the entry whose `updatedAt` parses to a **finite, valid** epoch number — i.e., `Number.isFinite(new Date(updatedAt).getTime())` MUST be true. If exactly one entry has a valid `updatedAt`, that one wins. (Defends against legacy persisted entries with missing/null/malformed `updatedAt`, which would otherwise produce `NaN` and make `<` and `>` both return `false`, leading to non-deterministic Map insertion-order winners.)
     d. Otherwise (both have valid `updatedAt`) prefer the entry with the most-recent `new Date(updatedAt).getTime()`.
     e. Otherwise (final last-resort tiebreak — both invalid `updatedAt`) prefer the entry whose `id` sorts first lexicographically. Strictly deterministic so two runs over the same persisted state produce identical winners.

     **After winner selection, merge messages from BOTH entries by `message.id`** (winner's messages first, then the loser's whose id is not already present), then sort the merged list by `timestamp` ascending and assign to the surviving entry's `messages`. The same NaN-safety applies to message timestamps: messages with non-finite timestamps sort to the END of the merged list (treat `NaN` as `+Infinity`) so they don't disrupt the chronological ordering of well-formed messages. This guarantees no user-typed message is lost to the source-preference contest.
  2. **`loadConversationsFromServer`** — runs after the conversations API call returns. Map-based dedupe-by-id over `[...serverConversations, ...localOnlyPreserved]`. Insertion semantics: **server-wins-on-collision**. Server entries are inserted first; each local-only-preserved entry is inserted **only if its `id` is not already present in the Map** (i.e. the second pass does NOT overwrite an existing server entry, because the server is authoritative for `source` and metadata). Concretely: `for (const c of localOnlyPreserved) if (!map.has(c.id)) map.set(c.id, c);`. In practice no collision occurs at this site because the upstream `localOnlyPreserved` filter already excludes any id present in `serverConversations`; the dedupe is defense in depth against a future refactor that drops that filter.
  3. **`loadAutonomousConversationsFromService`** — runs after the autonomous-agents service call returns. Map-based dedupe-by-id over `[...others, ...merged]`. Autonomous synth entries override on collision (consistent with Inv-B). The existing per-message merge inside `merged.map(...)` (chat-store.ts L1157–L1161) preserves user-typed messages by `message.id`; the dedupe must not bypass it.

  Sites (1) and (3) together close the back-to-back-refresh edge case: even if the user mashes F5 before any network loader completes, rehydrate is self-healing on its own. Site (3) also handles the `autonomousAgentsEnabled = false` early-return: the early return MUST also pass surviving conversations through the same dedupe (any pre-existing `source: undefined` collision is healed at rehydrate; the early return only filters `source === 'autonomous'` rows and does not need its own dedupe pass).
- **Inv-B — Source resolution on collision**: When two paths produce an entry with the same `id`, the autonomous-synthesized copy wins for the `source` label and the canonical messages list. User-typed messages from the surviving non-autonomous copy are merged in by `message.id` (the existing autonomous merge already does this; the dedupe must not bypass it).
- **Inv-E — Persistence scope**: The Zustand `partialize` output MUST NOT carry any authorization, session, or admin-origin signals into client storage. The denylist is split into two scopes because the persisted shape contains nested objects (notably `ChatMessage`) that legitimately use the generic field name `role` for their own (non-authorization) purpose:

  | Scope | Denylist (canonical list — kept in sync with T013 + T013a) | Rationale |
  |---|---|---|
  | **Top-level keys** of the `partialize` output (i.e. direct properties of the root object Zustand persists, AND direct properties of each `Conversation` object inside `conversations[]`) | `access_level`, `accessLevel`, `readOnlyReason`, `readOnly`, `adminOrigin`, `isAdmin`, `canViewAdmin`, `sessionRole`, `authRole`, `role`, `userRole` (11 entries) | These are session/authorization labels. They MUST NOT be persisted at the conversation or root level. No legitimate `Conversation` field uses any of these names — including `role`, which is not a `Conversation` property. |
  | **Recursive (any nesting depth)** | `access_level`, `accessLevel`, `readOnlyReason`, `readOnly`, `adminOrigin`, `isAdmin`, `canViewAdmin`, `sessionRole`, `authRole`, `userRole` (10 entries — `TOP_LEVEL_DENYLIST` minus the single `role` exception) | These names have no legitimate use anywhere in the persisted shape at any depth. `readOnly` (boolean ChatPanel prop), `userRole` (disambiguated session/auth label), and the underscore/camel-cased server names all stay out at every level. |

  **The `role` exception is the ONLY recursive-denylist omission, and it has a hard-coded justification**: `ChatMessage.role: 'user' \| 'assistant' \| 'system'` is the canonical message-sender field and appears on every persisted message. Including bare `role` in the recursive denylist would break every persisted conversation by stripping the message-sender label. Any future need to persist an authorization role MUST use one of the explicitly-denylisted disambiguated names (`sessionRole`, `authRole`, or `userRole`) — never bare `role`. This is the contract that makes the split denylist sound.

  No other key is recursively-omitted. In particular, `readOnly` is in BOTH scopes (it has no legitimate use as a persisted field — it is a `ChatPanel` prop, computed per-render, and would be a category-error to store on a `Conversation` or `ChatMessage`); same for `userRole`. The earlier draft of this table omitted `readOnly` and `userRole` from recursive without rationale; that omission was a documentation oversight (finding A3 in the latest `/speckit.analyze`) and is corrected here.

  The currently persisted shape (conversations with empty `a2aEvents`/`streamEvents` and trimmed messages) is correct and remains unchanged. The enforcing test (T013) parses the `partialize` output as JSON and walks the object tree, applying the **top-level** denylist to root + each `Conversation` and the **recursive** denylist to every nested object. The implementation in T013a explicitly strips both denylists from every spread (so even if a future setter writes one of these keys onto store state, `partialize` removes it before persist). Substring search on serialized JSON is insufficient and forbidden by the test — conversation titles and message bodies can legitimately contain denylisted substrings.

### State transitions (refresh sequence)

```text
mount
  ├─ Zustand persist rehydrates `conversations` from localStorage (localStorage mode)
  │    or starts empty (MongoDB mode).
  │    └─ NEW: dedupe-by-id pass inside onRehydrateStorage; autonomous-source wins
  │       on collision; ties broken by message count then updatedAt. Heals any
  │       duplicate persisted before this fix shipped, BEFORE any network call,
  │       so the sidebar is correct on the very first paint and survives
  │       back-to-back F5 refreshes.
  ├─ `loadConversationsFromServer()` fetches MongoDB-backed conversations.
  │    └─ Merges with `streamingConversations` + `activeConversationId` preservation.
  │    └─ NEW: final dedupe-by-id pass.
  └─ `loadAutonomousConversationsFromService()` synthesizes autonomous entries.
       └─ Existing per-message merge for autonomous-tagged entries.
       └─ NEW: final dedupe-by-id pass; autonomous-synth wins on collision.
```

End-state guarantee: regardless of order of completion, regardless of storage mode, regardless of whether the autonomous service is enabled, and regardless of how many times the user refreshes in rapid succession, every `id` appears at most once.

### Back-to-back-refresh resilience

The rehydrate-time dedupe (site 1) is critical for the "F5 twice in a row" path. Without it, a user with poisoned `localStorage` (a duplicate persisted before this fix shipped) sees the duplicate on every refresh until *both* of these complete in a single uninterrupted session: (a) `loadAutonomousConversationsFromService` finishes its async work and applies `set(...)`, and (b) Zustand's `partialize` writes the deduped state back to `localStorage`. If the user refreshes before either of those, the original duplicated `localStorage` is rehydrated again. With site (1) in place, the rehydrate path is self-healing on its own — no network call required.

### Concurrency: same-loader and cross-loader (finding N1 in `/speckit.analyze` re-run)

`loadConversationsFromServer` already has a module-level `isLoadingConversations` guard (`chat-store.ts` L883–L886) that short-circuits a second concurrent invocation. `loadAutonomousConversationsFromService` does NOT have an equivalent guard, but a guard is not strictly required for correctness because the Map-based dedupe inside each call is idempotent on its own snapshot — two concurrent invocations of the same autonomous loader still produce a duplicate-free final state. The behaviour worth pinning is the **cross-loader** case where `loadConversationsFromServer` and `loadAutonomousConversationsFromService` interleave. Today (chat-store.ts L1018):

```ts
// loadConversationsFromServer (imperative form):
set({ conversations: sortedConversations });   // overwrites with snapshot built at L954
```

```ts
// loadAutonomousConversationsFromService (callback form):
set((state) => { ... return { conversations: final }; });   // reads latest state
```

If autonomous's callback `set(...)` runs **between** server's snapshot read (L954) and server's imperative `set(...)` (L1018), autonomous's update is silently overwritten. The Map-based dedupe inside the server loader operates on the L954 snapshot, which does not contain autonomous's freshly-written entries.

**Inv-G — Cross-loader merge safety**: When two loaders write to `conversations` concurrently, neither write may discard the other's contribution. Implementations satisfy this by:

1. Converting `loadConversationsFromServer`'s `set(...)` to the **callback form** `set((state) => ({ conversations: dedupeById([...sortedConversations, ...state.conversations.filter(c => shouldKeepFromOther(c))]) }))`, where `shouldKeepFromOther` keeps any entry that the server snapshot would not have known about (notably autonomous-source entries written by the other loader between snapshot-read and write); OR
2. A single shared mutex (`isLoadingConversationsOrAutonomous`) that serializes BOTH loaders so their reads and writes cannot interleave.

Option (1) is preferred: it preserves parallel I/O latency. Option (2) is acceptable as a fallback if option (1) proves intricate. Tested by T015c.

## In-Memory: `ChatContainer` derived state

**Source file**: `ui/src/components/chat/ChatContainer.tsx`

### Existing inputs

| Input | Source | Notes |
|---|---|---|
| `accessLevel` | API response `access_level` (or `null` if not provided) | Server-side authorization label. |
| `adminOrigin` | `useSearchParams().get('from')` | One of `'audit-logs'`, `'feedback'`, or `null`. |

### Existing derivation (today, BUGGY)

```ts
const isReadOnly = accessLevel === 'admin_audit' || accessLevel === 'shared_readonly';
const readOnlyReason =
  accessLevel === 'admin_audit' ? 'admin_audit'
  : accessLevel === 'shared_readonly' ? 'shared_readonly'
  : undefined;
```

### New derivation (post-fix)

```ts
// admin_audit is only honored as an in-session audit context when the user
// actually navigated from the admin audit-logs or feedback views (Inv-C).
// The closed set {'audit-logs', 'feedback'} is the ONLY set of values
// honoured; any other value (including e.g. 'shared-link', 'whatever',
// or empty string) is treated identically to ?from= being absent.
const adminAuditActive = accessLevel === 'admin_audit'
  && (adminOrigin === 'audit-logs' || adminOrigin === 'feedback');

// Inv-C2: when the server returns admin_audit but the gate evaluates
// false (no ?from=, or unrecognized ?from=), the user has no write
// access at the server but the composer would render. Route this case
// through the EXISTING shared_readonly UI treatment so the user sees a
// clear read-only banner instead of a silent send-failure. We do NOT
// introduce a new readOnlyReason value for this case; reusing
// 'shared_readonly' keeps the prop-type union and ChatPanel rendering
// branches unchanged. FR-005 still holds because non-admin users
// cannot reach access_level === 'admin_audit' server-side, so this
// fallback branch is unreachable for non-admins.
const isReadOnly =
  adminAuditActive
  || accessLevel === 'admin_audit'      // server says read-only; gate failed → SR fallback
  || accessLevel === 'shared_readonly';
const readOnlyReason =
  adminAuditActive ? 'admin_audit'
  : (accessLevel === 'admin_audit' || accessLevel === 'shared_readonly') ? 'shared_readonly'
  : undefined;
```

### Invariant enforced

- **Inv-C — Audit banner gating**: The UI MAY render `readOnlyReason === 'admin_audit'` only when both (a) the API returned `access_level === 'admin_audit'`, and (b) `adminOrigin` is `'audit-logs'` or `'feedback'` (the closed honoured set; any other value is treated identically to `adminOrigin` being `null`).
- **Inv-C2 — No silent write-fail via `shared_readonly` fallback (finding N3 in `/speckit.analyze` re-run; option A per design discussion)**: When the server returns `access_level === 'admin_audit'` but the Inv-C gate evaluates false (no `?from=`, or unrecognized `?from=` value), the UI MUST render the **existing `shared_readonly` read-only treatment** (`readOnlyReason === 'shared_readonly'`, composer hidden, standard sharing banner). The UI MUST NOT render the "Read-Only Audit Mode" heading and MUST NOT render the "Back to Audit Logs / Feedback" admin back-link for this case. Justification: the API rejects writes for any `admin_audit` user regardless of URL state; routing through the existing `shared_readonly` UI branch gives the user a clear read-only treatment without leaking admin-only UI chrome and without introducing a new `readOnlyReason` value. FR-005 still holds because non-admin users cannot reach `access_level === 'admin_audit'` server-side.

### Where the gate runs (and where it doesn't) — finding N2 in `/speckit.analyze` re-run

`ChatContainer.tsx` has TWO paths that populate `accessLevel`:

1. **Local-store hit** (L130–L143). Used on the common refresh path when the conversation already exists in `useChatStore.conversations` (rehydrated from `localStorage` or fetched by a prior loader). This path derives `accessLevel` from `localConv.owner_id + localConv.sharing.*` only. It NEVER sets `accessLevel = 'admin_audit'`, because the persisted store does not (and per Inv-E MUST not) carry session/admin signals. For an admin viewing a non-owned non-shared conversation, `accessLevel` stays at `null` until `loadMessagesFromServer` / `loadTurnsFromServer` round-trips and `setAccessLevel` is called from the API response (handled implicitly by the messages loader in some code paths, or by the API-fallback path described next).
2. **API roundtrip** (L196–L218). Used on a deep-link refresh when the conversation is NOT in the local store. Calls `apiClient.getConversation(uuid)`, reads `(conv as any).access_level`, and sets `accessLevel` to that value. This is the path where the server can return `'admin_audit'`, and therefore the path where the Inv-C gate (T026) actually has work to do.

**Implication for testing**: T022, T029, T029a all exercise path (2) by mocking the conversation API. They do NOT — and should not — assert behaviour on path (1), because path (1) cannot produce `accessLevel === 'admin_audit'` in the first place. This is intentional and is the reason Bug #2 is reproducible primarily on deep-link refreshes (URL → API path) rather than on sidebar-click navigation (already-in-store path).

**Implication for the fix**: T026's gate is narrowly scoped to path (2). Path (1) is already safe by construction — it cannot mis-classify a conversation as `'admin_audit'` because it never assigns that value. Reviewers should not expect T026 to "do anything" on the local-store-hit path; the lack of effect there is correct.

This is a deliberate scope decision: fixing path (1) to ALSO produce `accessLevel === 'admin_audit'` for admins on non-owned non-shared conversations would be a feature expansion (admin-audit awareness on sidebar-click), not a bug fix, and is out of scope for this spec.

### Cross-conversation `?from=` carry-over

`adminOrigin` is read from `useSearchParams().get('from')` on every render — it is a per-page-load signal sourced from the live URL, never restored from `localStorage`. This means it follows whatever the URL currently says, which has two implications worth calling out (finding C5 in `/speckit.analyze`; spec FR-004 clarification 1 codifies the design choice):

1. **Refresh on the same audit URL is honored.** If the admin lands on `/chat/<uuid>?from=audit-logs` via the audit-logs view and refreshes, the URL still contains `?from=audit-logs` and the banner remains. This is intentional and matches FR-004 acceptance scenario 3.
2. **Cross-conversation carry-over via the URL is honored too.** If the admin is on `/chat/<A>?from=audit-logs` (legitimate audit) and then types `/chat/<B>?from=audit-logs` into the address bar (or follows a sidebar link that preserves all current search params, depending on how the link is constructed), the banner shows on B as well — provided the server independently returns `access_level === 'admin_audit'` for B (i.e., B is non-owned, non-shared, and the admin is browsing it). This is by design: the `?from=` query string is the source of truth for "I am acting as an auditor right now"; if the admin keeps that flag in the URL while moving to another non-owned conversation, they are still acting as an auditor and the banner is correct.
3. **Sidebar links MUST NOT preserve `?from=` when navigating to the user's OWN conversation.** This case is already neutralized by the server: when the admin opens their own conversation, the API returns `access_level === 'owner'`, the gate's first conjunct (`accessLevel === 'admin_audit'`) is false, and the banner does not render — even if `?from=audit-logs` is left over in the URL. T029 covers this. Out of caution, sidebar code SHOULD strip `?from=` when constructing links to conversations the user owns, but this is a UX nicety, not a correctness requirement.

**Security note**: This gating is **presentation-only**. The server-side `access_level` decision in `requireConversationAccess` is authoritative for authorization. `adminOrigin` is derived from a user-controllable URL search parameter (`?from=...`) and is NEVER trusted to grant, escalate, or modify permissions. Even if a user tampers with the URL to add `?from=audit-logs`, the audit banner only renders when the **server** independently determined `access_level === 'admin_audit'` for that user on that conversation; a non-admin can never reach `admin_audit` server-side, so URL tampering cannot expose admin-only UI.

## Server: `requireConversationAccess` return value

**Source file**: `ui/src/lib/api-middleware.ts`

### Existing return type (unchanged)

```ts
type ConversationAccessLevel = 'owner' | 'shared' | 'shared_readonly' | 'admin_audit';
interface ConversationAccessResult { conversation: any; access_level: ConversationAccessLevel; }
```

### New check order

Reorder the cascade so the `source === 'autonomous'` branch runs **before** the admin fallback:

```text
1. Owner                          → 'owner'
2. sharing.is_public              → 'shared' | 'shared_readonly'
3. sharing.shared_with includes   → 'shared' | 'shared_readonly'
4. Team grant                     → 'shared' | 'shared_readonly'
5. Email-grant subcollection      → 'shared' | 'shared_readonly'
6. NEW POSITION:
   conversation.source === 'autonomous' → 'shared'   (revised — see addendum below)
7. session.role === 'admin' || canViewAdmin → 'admin_audit'
8. Else                           → 403
```

### Invariant enforced

- **Inv-D — Autonomous never resolves to admin_audit**: For every conversation with `source === 'autonomous'` and a non-owner user, `requireConversationAccess` returns `access_level === 'shared'`. Admin status does not change this.

### Backward compatibility

- The `ConversationAccessLevel` union and the API response shape are unchanged. Only the **value** returned for one previously-misclassified case changes (admin + autonomous: was `admin_audit`, now `'shared'`).
- Admin auditing of **non-autonomous** conversations the admin does not otherwise have access to is unchanged: step 7 still fires and returns `admin_audit`.
- Autonomous conversations are interactive — write-side endpoints accept POST/PUT for `'shared'` (only `'admin_audit'` and `'shared_readonly'` are 403'd in `messages/route.ts` and `turns/route.ts`).
- **Non-admin users on autonomous conversations**: pre-fix they got `'shared_readonly'` (silent 403 on writes); post-revision they get `'shared'` (writable). Authorship is captured per-message via `sender_email` (set from the authenticated session in the messages POST route), so audit trail is preserved even though access is broad.

### Phase 1 addendum (2026-05-15) — autonomous-chat read-only contract revised

The original Inv-D returned `'shared_readonly'` for `source === 'autonomous'`, citing the README's "operator visibility only" framing. Post-implementation review revealed this contradicted actual product usage: operators routinely add manual follow-up messages to autonomous task threads, and those typed messages were silently 403'd by the messages POST route, then disappeared on refresh because they were never persisted. The revised Inv-D returns `'shared'` instead. Effects:

1. **Server**: `requireConversationAccess` autonomous branch returns `'shared'`. Manual follow-ups POST successfully and round-trip through `loadMessagesFromServer`.
2. **Client (`ChatContainer.tsx`)**: an autonomous-source short-circuit hard-suppresses any read-only banner derivation when `conversation.source === 'autonomous'`, defending against a stale `accessLevel` `useState` value (e.g. left over from an `admin_audit` chat the user just navigated away from) leaking onto the autonomous view.
3. **Inv-G strengthening**: `loadConversationsFromServer`'s callback `set()` now also handles the **same-id** collision case where the server's autonomous row has `messages: []` (synth messages are client-only) but the live state already has the autonomous loader's synth messages. Without this fix, the server loader would clobber the synth messages with the empty server payload, producing the "manual chat history disappears in autonomous task chat" symptom that resolved itself only after a sidebar tab-switch retriggered the autonomous loader.

## Cross-cutting: read-only-trigger inventory (FR-008)

**Inv-F — All read-only triggers are session/URL/server-derived, never persisted.** This invariant complements Inv-E by enumerating every flag the UI can use to render a read-only treatment, and pinning the trustworthy source for each:

| Read-only trigger | UI surface | Trustworthy source | Persisted in `localStorage`? |
|---|---|---|---|
| `admin_audit` | "Read-Only Audit Mode" banner + admin back-link in `ChatPanel` | (a) `requireConversationAccess` returning `access_level === 'admin_audit'` AND (b) `useSearchParams().get('from') ∈ {'audit-logs','feedback'}` (Inv-C). | **No.** Both the API response and the URL search param are session-scoped. Inv-E denies persistence. |
| `shared_readonly` | "Read-Only" / sharing banner in `ChatPanel` | Multiple equivalent sources, all session/server-derived: (i) `requireConversationAccess` evaluating `sharing.is_public`, `sharing.shared_with`, `shared_with_teams`, `sharing_access` collection, or `source === 'autonomous'` (post-T025) and returning `access_level === 'shared_readonly'`; (ii) per Inv-C2, the admin-without-recognized-origin fallback (server returned `admin_audit` but the Inv-C gate failed) — `ChatContainer` routes this through the same `shared_readonly` UI branch; (iii) `ChatContainer`'s local-store-hit path (L130–L143) derives `shared_readonly` from `localConv.owner_id` + `sharing.*`, but that data came from the most-recent server response and is refreshed by `loadMessagesFromServer` shortly after. | **No** (the `accessLevel` `useState` is session-only; the conversation's `sharing.*` fields ARE persisted, but they are server-authoritative metadata, not client-asserted permission flags). |
| `agent-deleted` (Dynamic Agents) | "Agent deleted" banner / disabled composer | Live `/api/dynamic-agents/agents/{id}` response with HTTP 404. Stored in `ChatContainer`'s `agentNotFound` `useState`. | **No** (`useState`, not persisted). |
| `agent-disabled` (Dynamic Agents) | "Agent disabled" treatment | `agentInfo.enabled === false` from the live `/api/dynamic-agents/agents/{id}` response. Stored in `ChatContainer`'s `agentInfo` `useState`. | **No** (`useState`, not persisted). |

FR-008 persistence-side coverage is enforced end-to-end by **T013** (`partialize` tree-walk in `chat-store.test.ts`), which parses the `partialize` output and fails if any of `accessLevel`, `readOnlyReason`, `adminOrigin`, `isAdmin`, `canViewAdmin`, `sessionRole`, `authRole` (or the underscore-cased server names) ever appear as own-keys at any nesting depth. A separate static `rg` audit for store-setter writes was considered and dropped as redundant — any future code path that wrote one of those flags into a persisted-store setter would surface as a T013 failure on the next test run. `agentNotFound` and `agentInfo` are not in the denylist by name because they live in `ChatContainer` `useState` (never in the store), but the broader principle documented next to `partialize` (T003 comment) makes adding them to the persisted shape a review-time red flag.

**Scope note (finding N8 in `/speckit.analyze` re-run)**: Inv-F covers PERSISTENCE only. It does NOT cover whether `agentInfo` itself contains admin-only or PII fields that get rendered to non-admins. The `agentInfo` payload includes `model.id`, `allowed_tools`, `subagents`, `skills`, `ui.gradient_theme`, etc., and is fetched per-conversation from `/api/dynamic-agents/agents/{id}`. Render-side disclosure of those fields is governed by that API route's existing per-user authorization, NOT by this invariant. If a future security review discovers that the API route over-shares (e.g., returns admin-only `model.id` to non-admin viewers of a publicly-shared dynamic agent), that would be a separate finding against the dynamic-agents API contract, not against Inv-F. This note exists so a reviewer who sees `agentInfo` mentioned in Inv-F's "trustworthy source" column does not conclude "all `agentInfo` security concerns are covered here."

## Test surface

| Invariant | Test file | Assertion |
|---|---|---|
| Inv-A, Inv-B | `ui/src/store/__tests__/chat-store.test.ts` | (a) After both `loadConversationsFromServer` and `loadAutonomousConversationsFromService` complete, no two `conversations` share an id; collisions resolve to the autonomous copy with user-typed messages preserved. (b) The `activeConversationId`, when set, resolves to exactly one entry in `conversations`. (c) **Rehydration test (back-to-back-refresh resilience)**: seed raw `localStorage` for key `caipe-chat-history` with two `conversations[]` entries that share an `id` (one with `source: undefined`, one with `source: 'autonomous'`); construct the store; assert `useChatStore.getState().conversations` contains exactly one entry for that id with `source === 'autonomous'`, before any loader is invoked. |
| Inv-C | `ui/src/components/chat/__tests__/ChatContainer.test.tsx` (or `ChatPanel.test.tsx` with explicit props) | Audit banner renders iff `access_level === 'admin_audit'` AND `adminOrigin ∈ {'audit-logs','feedback'}`. Negative cases: non-admin user, admin without `?from=`, admin with `access_level === 'shared_readonly'`, **owner viewing own conversation with `?from=audit-logs` in URL (audit-context leak test)**. |
| Inv-C2 | `ui/src/components/chat/__tests__/ChatContainer.test.tsx` (T029c) | When `access_level === 'admin_audit'` AND `adminOrigin` is null OR an unrecognized value (`'shared-link'`, `'whatever'`, `''`), the rendered output: (a) does NOT contain "Read-Only Audit Mode"; (b) does NOT contain "Back to Audit Logs" / "Back to Feedback"; (c) hides the composer; (d) is rendered with `readOnlyReason === 'shared_readonly'` (NOT `'admin_audit'`, NOT a new value) — i.e., the case is routed through the existing `shared_readonly` UI branch. |
| Inv-D | `ui/src/app/api/__tests__/admin-audit-access.test.ts` | Admin session + autonomous-source conversation → `access_level === 'shared_readonly'`. Admin session + non-autonomous non-owned conversation → `access_level === 'admin_audit'` (unchanged). |
| Inv-E | `ui/src/store/__tests__/chat-store.test.ts` (dedicated `partialize` test, T013, exercising the T013a defensive strip) | Test **injects** every denylisted key onto the seed state at root, `Conversation`, and `ChatMessage` level (via `as any` casts so the test compiles even when the types do not declare them); then parses the `partialize` output as JSON and walks the object tree asserting (a) the **top-level** denylist (11 entries: `access_level`, `accessLevel`, `readOnlyReason`, `readOnly`, `adminOrigin`, `isAdmin`, `canViewAdmin`, `sessionRole`, `authRole`, `role`, `userRole`) is absent at the root and on every `Conversation` object's own keys, and (b) the **recursive** denylist (10 entries — `TOP_LEVEL_DENYLIST` minus the single `role` exception; see the Inv-E table above) is absent at every nesting depth. The bare `role` key is the only exemption from the recursive check because `ChatMessage.role` is a non-authorization sender field. Inline code comment near `partialize` documents this constraint; T013a's `stripDenylistedKeys` helper is the runtime enforcement that makes T013 green. |
| **Write-path coverage (defense in depth)** | Codebase audit (task T028) | All API write handlers (POST/PUT/PATCH/DELETE under `ui/src/app/api/`) that read `access_level` treat `admin_audit` and `shared_readonly` identically as "no write." No handler grants writes based on `access_level === 'admin_audit'` alone. |
| **Audit-log behaviour (defense in depth)** | Codebase audit (task T028) | Audit-log writers do not key exclusively on `access_level === 'admin_audit'`; reclassifying admin-on-autonomous as `shared_readonly` does not silently disable audit logging for views that policy requires to be logged. |
