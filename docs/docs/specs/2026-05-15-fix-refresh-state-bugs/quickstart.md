# Phase 1 — Quickstart: Reproduce and Verify

**Feature**: `2026-05-15-fix-refresh-state-bugs`
**Date**: 2026-05-15

This document describes how to reproduce the two refresh-time bugs in a local development environment and how to verify the fix. It is the manual-test counterpart to the automated tests called out in `data-model.md`.

## Prerequisites

- A local CAIPE dev stack with the UI workspace (`ui/`) running.
- An admin user account (`session.role === 'admin'` or `session.canViewAdmin === true`).
- A non-admin user account.
- The autonomous-agents service enabled (`autonomousAgentsEnabled` feature flag on).
- At least one autonomous task created (any agent, any cadence).
- At least one normal (non-autonomous) conversation owned by each test account.

## Reproduce Bug #1 — Duplicate autonomous sidebar entry

1. Sign in as **any** user (admin or non-admin).
2. Open or create an autonomous task. Click into its conversation from the Autonomous tab. Confirm the sidebar shows exactly one entry highlighted.
3. Send a typed reply into the autonomous chat thread (this writes a user-typed message into MongoDB for that conversation id, exercising the path that mixes synthesized + user-typed messages).
4. Hard-refresh the browser (Ctrl+Shift+R / Cmd+Shift+R).
5. **Expected (pre-fix, bug)**: the sidebar now shows two entries pointing at the same conversation — one under the Autonomous tab (the synth) and one under the general conversations list (the persisted / API-fetched copy). Both may appear highlighted.
6. **Expected (post-fix)**: exactly one entry remains, under the Autonomous tab, highlighted, with the user-typed reply still present in the message list.

Verification via DevTools console:

```js
const ids = useChatStore.getState().conversations.map(c => c.id);
new Set(ids).size === ids.length;  // must be true (no duplicates)
```

## Reproduce Bug #2 — Read-Only Audit Mode on refresh

### Case A — Admin on autonomous conversation (most common report)

1. Sign in as an **admin** user.
2. Open any autonomous conversation directly (click the sidebar entry — no `?from=` query param).
3. Confirm the composer is visible. No audit banner.
4. Hard-refresh the browser.
5. **Expected (pre-fix, bug)**: the Read-Only Audit Mode banner appears, the composer is hidden, and the "Back to Audit Logs" / "Back to Feedback" link is rendered — even though the admin never went through the audit-logs view.
6. **Expected (post-fix)**: the composer remains visible, no audit banner. The conversation may still be read-only (autonomous conversations are `shared_readonly` for non-owners by design), but the banner is the standard shared-readonly banner, not the admin-audit one.

### Case B — Admin on another user's normal conversation, without admin-origin

1. As an admin, navigate directly to a deep link `/chat/<uuid-owned-by-another-user>` (paste the URL — no `?from=` param).
2. Hard-refresh.
3. **Expected (pre-fix, bug)**: admin-audit banner appears with "Back to Feedback" defaulting in.
4. **Expected (post-fix)**: no admin-audit banner. The page renders as a normal (but read-only) view. The API still returns `access_level === 'admin_audit'` — the UI just doesn't render the audit banner without `adminOrigin`.

### Case C — Legitimate admin audit flow (must still work)

1. As an admin, go to `/admin?tab=audit-logs` and click into a conversation. The URL becomes `/chat/<uuid>?from=audit-logs`.
2. Confirm the audit banner appears with "Back to Audit Logs" link.
3. Hard-refresh (URL still contains `?from=audit-logs`).
4. **Expected**: audit banner still visible, back-link still correct. This case is unchanged by the fix.

### Case D — Non-admin safety

1. Sign in as a **non-admin** user.
2. Open one of your own conversations. Refresh. Repeat on a shared/read-only conversation if available. Repeat on an autonomous conversation.
3. **Expected (every case, pre- and post-fix)**: the admin-audit banner is never visible. (Spec FR-005.)

## Reproduce Bug #1 follow-up — Back-to-back-refresh resilience

This case verifies that finding C2 in `/speckit.analyze` is closed: the rehydrate-time dedupe pass MUST make the sidebar correct on the very first paint, before any network loader completes.

### Case E — Slam F5 twice in rapid succession (`localStorage` mode only)

1. Switch the UI workspace to `localStorage` storage mode (the default in dev when `NEXT_PUBLIC_STORAGE_MODE=localstorage` or unset).
2. Reproduce the original Bug #1: open an autonomous conversation, send a typed reply, refresh — confirm `localStorage['caipe-chat-history']` now contains the duplicate (use the DevTools snippet below).
3. **Without waiting** for the sidebar to finish loading, press F5 again immediately (twice in rapid succession is enough; thrice for paranoia). The autonomous-agents fetch is async and takes a moment; the goal is to refresh while it's still in flight.
4. **Expected (post-fix)**: the sidebar shows exactly one entry on the very first paint after each refresh. The DevTools `new Set(ids).size === ids.length` check passes immediately, before the spinner clears on the autonomous tab.
5. **Expected (pre-fix)**: the duplicate persists across both refreshes. The user could keep refreshing forever and never see the sidebar converge to a single entry until they let one full autonomous-loader cycle complete.

DevTools snippet to inspect the persisted duplicate before refresh (in `localStorage` mode):

```js
const raw = window.localStorage.getItem('caipe-chat-history');
const persisted = JSON.parse(raw);
const ids = (persisted.state?.conversations ?? []).map(c => c.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
console.log({ totalConversations: ids.length, duplicateIds: dupes });
// dupes.length > 0 means the persisted state needs rehydrate-time healing.
```

### Case F — Autonomous service disabled (`localStorage` mode + `autonomousAgentsEnabled=false`)

1. Set `autonomousAgentsEnabled=false` (config flag) so the autonomous loader early-returns.
2. Manually seed `localStorage['caipe-chat-history']` with two conversations sharing the same `id` (one with `source: undefined`, one with `source: 'autonomous'`) — simulating a user who upgraded after the duplicate had already been persisted.
3. Refresh.
4. **Expected (post-fix)**: rehydrate-time dedupe heals the sidebar to one entry. No loader runs, but correctness is preserved.
5. **Expected (pre-fix)**: duplicate persists indefinitely because neither network loader does any meaningful work in this configuration.

## Verify in DevTools console

After the fix, the following expressions should hold immediately after a hard refresh on an autonomous conversation while signed in as admin:

```js
// 1. No duplicate ids.
const ids = useChatStore.getState().conversations.map(c => c.id);
new Set(ids).size === ids.length;

// 2. The active conversation, if autonomous, has source === 'autonomous'.
const active = useChatStore.getState().conversations.find(c =>
  c.id === useChatStore.getState().activeConversationId
);
active?.source; // 'autonomous' for autonomous conversations

// 3. No authorization/session flag in persisted state.
//    NOTE: A naive substring search like /admin_audit|adminOrigin/i.test(raw)
//    would false-positive on conversation titles, message bodies, or anything
//    a user typed that happens to contain those substrings (data-model.md Inv-E).
//    Walk the parsed object keys instead.
const raw = window.localStorage.getItem('caipe-chat-history');
if (raw) {
  const TOP_LEVEL_DENYLIST = ['access_level', 'accessLevel', 'readOnlyReason',
    'readOnly', 'adminOrigin', 'isAdmin', 'canViewAdmin',
    'sessionRole', 'authRole', 'role', 'userRole'];
  // Recursive list is TOP_LEVEL_DENYLIST minus the single 'role' exception
  // (ChatMessage.role is the legitimate message-sender field).
  const RECURSIVE_DENYLIST = ['access_level', 'accessLevel', 'readOnlyReason',
    'readOnly', 'adminOrigin', 'isAdmin', 'canViewAdmin',
    'sessionRole', 'authRole', 'userRole'];
  const persisted = JSON.parse(raw);
  const persistedState = persisted.state ?? persisted;

  // Top-level: root object + each Conversation in conversations[]
  const rootHits = Object.keys(persistedState).filter(k => TOP_LEVEL_DENYLIST.includes(k));
  const convHits = (persistedState.conversations ?? []).flatMap(c =>
    Object.keys(c).filter(k => TOP_LEVEL_DENYLIST.includes(k))
  );

  // Recursive: every object at every depth (note: bare 'role' is allowed
  // here because ChatMessage.role is a non-authorization sender field).
  const recursiveHits = [];
  const walk = (obj) => {
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (RECURSIVE_DENYLIST.includes(k)) recursiveHits.push(k);
        walk(obj[k]);
      }
    }
  };
  walk(persistedState);

  console.log({ rootHits, convHits, recursiveHits });
  // All three arrays must be empty for Inv-E to hold.
}
```

## Automated test commands

```bash
# UI test suite (Jest)
cd ui
npm test -- chat-store
npm test -- ChatPanel
npm test -- admin-audit-access
npm test -- synthesize-conversation

# Full UI lint + tests
npm run lint
npm test
```

## Out of scope for this spec

- Backend (Python) authorization or autonomous-agents service behavior — unchanged.
- MongoDB schema, indexes, or any migration — unchanged.
- The visual treatment of the autonomous tab, sidebar grouping, or sorting — unchanged.
- The behavior of the `?from=audit-logs|feedback` query parameter itself — unchanged; we only gate the audit banner on its presence.
- **Storage-mode migration cleanup (finding N6 in `/speckit.analyze` re-run)**: when a deployment switches `NEXT_PUBLIC_STORAGE_MODE` from `localstorage` to `mongodb` (or vice-versa), the existing `caipe-chat-history` localStorage key is NOT cleared by this fix. In MongoDB mode the `persist` middleware is not wrapped around the store at all, so `onRehydrateStorage` never runs and the stale (potentially poisoned-with-duplicates) data simply sits in the browser. If the user later switches back to `localstorage` mode (uncommon but possible — re-deploy, env override, A/B flag flip), the stale data resurfaces and the rehydrate-time dedupe (Inv-A site 1) heals it on the very first paint. **Operator workaround if needed**: instruct affected users to run `localStorage.removeItem('caipe-chat-history')` in DevTools, OR add a one-time cleanup at module-import time gated by a new persist version key (deferred to a separate spec — bumping the persist version unconditionally would lose unrelated user state such as input drafts and turn selections, which is rejected in `research.md` Q3).
