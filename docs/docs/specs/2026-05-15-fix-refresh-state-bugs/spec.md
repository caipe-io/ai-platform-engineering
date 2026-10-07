# Feature Specification: Fix UI State Bugs on Browser Refresh

**Feature Branch**: `2026-05-15-fix-refresh-state-bugs`
**Created**: 2026-05-15
**Closed**: 2026-05-15
**Status**: Implemented (with 2026-05-15 follow-up — see Phase 1 addendum in `data-model.md`)
**Input**: User description: "There's a problem that I keep facing on the UI side. One big issue is when the browser is refreshed, sometimes a duplicate of the tab appears and is selected along with the autonomous chat. Another problem that appears when the page resets is that you're sometimes put in audit mode."

## Background *(informational)*

The chat UI lets users switch between several conversation sources (their own chats, autonomous-task conversations, shared/read-only conversations, and admin "audit" views of other users' conversations). The sidebar shows each as a selectable item, and the active conversation is highlighted as a "tab."

Two recurring defects appear after a hard browser refresh (or any client-side state rehydration from persisted storage):

1. A duplicate sidebar entry for the conversation the user had open appears alongside the existing autonomous-tab entry, and the duplicate is auto-selected. The user sees two highlighted items pointing at the same conversation, or two visually distinct entries representing the same underlying chat.
2. The chat opens in **Read-Only Audit Mode** (the banner shown to admin auditors), even though the user did not navigate from the admin audit/feedback views in this session. This makes their own conversation appear un-editable and exposes admin-only UI to non-audit flows.

Both bugs disappear if the user clicks away to another conversation and back, or clears site data — strongly indicating a state-rehydration / merge problem rather than a backend data issue.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - No duplicate conversation tab after refresh (Priority: P1)

As any user who has a conversation open in the chat panel, when I refresh the browser I should see exactly one sidebar entry for that conversation, and the same one selected — never a duplicate appearing next to an autonomous-task entry.

**Why this priority**: This is the most visible and confusing of the two bugs. Two highlighted "tabs" for the same chat make the sidebar look broken, cause users to doubt whether their conversation history is corrupted, and can lead to them clicking the wrong entry and losing context on the in-flight conversation. It impacts every user, not just admins.

**Independent Test**: Open any conversation (a normal user chat — not autonomous), confirm the sidebar shows one highlighted entry, hard-refresh the browser, and verify the sidebar still shows exactly one entry for that conversation and exactly one entry is selected. Repeat with an autonomous-task conversation open as the active chat.

**Acceptance Scenarios**:

1. **Given** I have a normal (non-autonomous) conversation open and selected, **When** I hard-refresh the browser, **Then** the sidebar shows exactly one entry for that conversation, that entry is selected, and no additional duplicate entry appears under the Autonomous tab/section.
2. **Given** I have an autonomous-task conversation open and selected, **When** I hard-refresh the browser, **Then** the sidebar shows exactly one entry for that autonomous task, it is selected, and no duplicate entry appears under any other section (Web/Slack/etc.).
3. **Given** I have a shared/read-only conversation open, **When** I refresh, **Then** that conversation remains visible and selected with no duplicate entry generated elsewhere in the sidebar.
4. **Given** the sidebar has loaded after refresh, **When** I inspect the list of conversations, **Then** no two entries share the same underlying conversation identifier, regardless of their source (web, autonomous, slack, shared).

---

### User Story 2 - Refresh does not unexpectedly put the user in Audit Mode (Priority: P1)

As any user (admin or non-admin) viewing my own conversation, when I refresh the browser I must remain in a normal editable conversation view. I should only see the "Read-Only Audit Mode" banner and back-link if I actually navigated to this conversation from the admin audit-logs or feedback views in the current session.

**Why this priority**: Audit Mode disables sending, hides the composer, and surfaces admin-only navigation ("Back to Audit Logs" / "Back to Feedback"). Showing it to users who are not currently auditing — and especially to non-admin users on their own conversations — looks like a permissions/UX bug, blocks the user from continuing their chat, and risks leaking the existence of admin features.

**Independent Test**: Open one of your own conversations (no audit navigation in this session), confirm the composer is visible and there is no audit banner, hard-refresh the browser, and verify the composer is still visible and no Read-Only Audit banner appears.

**Acceptance Scenarios**:

1. **Given** I am viewing my own conversation in a normal session (I did not navigate from the admin audit-logs or feedback views), **When** I refresh the browser, **Then** the conversation opens in normal editable mode with the composer visible and no Read-Only Audit banner.
2. **Given** I am a non-admin user, **When** I refresh the browser on any of my conversations, **Then** under no circumstances does the Read-Only Audit Mode banner or the "Back to Audit Logs / Feedback" link appear.
3. **Given** I am an admin and I genuinely arrived at the current conversation via the audit-logs view earlier in this session, **When** I refresh the browser, **Then** behavior is determined by the combination of (a) whether the URL still contains a recognized `?from=audit-logs|feedback` query parameter, and (b) what `access_level` the server returns for me on this conversation:
   - **Case 3a (legitimate audit retained)**: `?from=audit-logs|feedback` is present AND the server returns `access_level === 'admin_audit'` → the Read-Only Audit Mode banner remains visible with the correct back-link. Composer hidden.
   - **Case 3b (admin still locked out, no audit context)**: `?from=` is absent OR has an unrecognized value, AND the server still independently returns `access_level === 'admin_audit'` (I am an admin viewing a non-owned, non-shared, non-autonomous conversation) → the page renders the **existing `shared_readonly` read-only treatment** (composer hidden, the standard read-only banner shown — NOT the "Read-Only Audit Mode" heading, NOT the "Back to Audit Logs / Feedback" admin back-link). The user sees a clear read-only treatment instead of a silent send-failure, without any admin-only UI chrome leaking. This is the FR-004 clarification 2 fallback.
   - **Case 3c (fully normal view)**: `?from=` is absent AND the server returns `access_level === 'owner'` (or any non-`admin_audit` non-`shared_readonly` value) — typically the conversation is the admin's own — → the page renders fully normally: composer visible, no banner.

   In NO case is audit mode silently applied to a different, unrelated conversation or carried over from prior client-persisted state. The "Read-Only Audit Mode" banner (with admin back-link) MUST require BOTH a recognized `?from=` value in the live URL AND a server-side `access_level === 'admin_audit'` — neither alone is sufficient, and persisted client state is never consulted for this decision.
4. **Given** I am a non-admin user, **When** I open a shared/read-only conversation and refresh, **Then** the read-only treatment shown (if any) reflects "shared" context, not "admin audit" context.

---

### User Story 3 - Active conversation state survives refresh cleanly (Priority: P2)

As a user, after I refresh the browser the app should restore exactly the conversation I had open (or fall back gracefully to a known-good default) without inventing extra sidebar entries, switching me into a different mode, or leaving the active selection ambiguous.

**Why this priority**: Stories 1 and 2 are symptoms of the same underlying problem: state restored from the client at refresh is being merged with state fetched from the server in a way that creates inconsistent UI. Treating "clean rehydration" as its own acceptance target keeps regressions visible if either symptom comes back in a slightly different form.

**Independent Test**: For each chat source (web, autonomous, slack-synced, shared), open a conversation, refresh, and verify (a) exactly one entry in the sidebar is highlighted, (b) the URL/active-conversation identifier matches that entry, (c) no mode banner is shown unless it was already shown before the refresh and is still legitimately applicable.

**Acceptance Scenarios**:

1. **Given** I have any conversation open, **When** I refresh, **Then** the selected conversation in the sidebar and the conversation shown in the main panel refer to the same conversation identifier.
2. **Given** I have a conversation open whose backing record no longer exists on the server (e.g., it was deleted from another tab), **When** I refresh, **Then** the app falls back to a clean "no conversation selected" or default state instead of creating a duplicate stub entry or putting me in audit mode.
3. **Given** the sidebar finishes its post-refresh sync with the server, **When** I count the entries that match the previously-active conversation, **Then** the count is exactly one.

---

### Edge Cases

- A conversation was created in another browser tab while this tab was open, then this tab is refreshed. The merge of locally-persisted state and server-fetched state must not produce a duplicate row for the newly seen conversation.
- A conversation that was streaming when the user refreshed: it must still appear once and remain selectable, without spawning an autonomous-tab clone.
- The user previously opened an admin audit view of someone else's conversation in this browser. After refresh, audit context must not "leak" onto their next own-conversation view.
- A non-admin user has audit-related state lingering in client storage from a prior admin session on the same device. Refresh must not honor that stale audit context.
- The autonomous-agents service is unreachable when the page loads after refresh. The sidebar must still render the user's normal conversations without duplicates and without inferring audit mode.
- A conversation's `source` field (e.g., `autonomous`, `web`, `slack`, `shared`) is missing or differs between the persisted client copy and the server copy. The system must converge to a single entry under the correct source.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: After a browser refresh, the chat sidebar MUST display at most one entry per unique conversation identifier, regardless of how many times that conversation was previously hydrated (locally persisted, fetched from server, synthesized from autonomous-tasks, etc.).
- **FR-002**: After a browser refresh, exactly one sidebar entry MUST be in the "selected/active" state, and it MUST correspond to the conversation displayed in the main chat panel.
- **FR-003**: The system MUST NOT create or surface a duplicate sidebar entry for the previously-active conversation under a different source/section (e.g., "autonomous") merely as a side effect of state rehydration.
- **FR-004**: The system MUST NOT place the user in Read-Only Audit Mode on refresh unless audit context is signalled by the **current** URL `?from=audit-logs` or `?from=feedback` query parameter AND the server independently returns `access_level === 'admin_audit'` for the user on the currently-displayed conversation. Both signals are required; either alone is insufficient.

  Two clarifications resolve cases the original wording left ambiguous:

  1. **Cross-conversation carry-over via the URL is permitted.** The `?from=` parameter is read from the live URL on every render and is the in-session "I am acting as an auditor right now" flag. If the admin lands on `/chat/<A>?from=audit-logs` legitimately and then navigates the URL bar (or follows a link that preserves the search params) to `/chat/<B>?from=audit-logs` where B is also a non-owned non-shared conversation that the server independently classifies as `admin_audit`, the audit banner correctly renders on B. This treats the URL as the source of truth for in-session navigation context and is the only practical contract given that Next.js search params are not bound to a specific conversation id. The system MUST NOT instead silently restore audit context from `localStorage`.
  2. **When the server returns `access_level === 'admin_audit'` but the `?from=` parameter is absent or holds a value outside the closed honoured set `{'audit-logs', 'feedback'}`, the UI MUST surface the existing `shared_readonly` read-only treatment** (banner + hidden composer), NOT the "Read-Only Audit Mode" banner with admin back-link, and NOT a fully-normal composer-visible view. The server still rejects writes from this user (the server's `access_level` decision is the authoritative one), so rendering the composer would produce a silent send-failure UX. Routing this case through the existing `shared_readonly` banner gives the user a clear read-only treatment without leaking admin-only UI chrome. No new `readOnlyReason` value is introduced — the UI reuses the established `shared_readonly` branch in `ChatPanel`.
- **FR-005**: Non-admin users MUST NEVER see the Read-Only Audit Mode banner, the "Back to Audit Logs" link, or the "Back to Feedback" link, regardless of any client-persisted state.
- **FR-006**: When the active conversation referenced by client-persisted state no longer matches a real server-side conversation accessible to the user, the system MUST fall back to a clean default view (no selection, or the most recent valid conversation) rather than fabricating a placeholder entry or applying any read-only/audit treatment.
- **FR-007**: When the local sidebar state is merged with conversations fetched from the server (or synthesized from the autonomous-agents service) after refresh, the merge MUST deduplicate by conversation identifier and reconcile each entry to a single canonical source label.
- **FR-008**: Any flags that control read-only treatment MUST be reset on refresh and re-derived from a trustworthy source — they MUST NOT be carried over from client-persisted state without re-validation. The trustworthy sources are, by category:
  - `admin_audit` — derived per render from (a) the server-side `access_level` returned by `requireConversationAccess` AND (b) the live URL `?from=audit-logs|feedback` query parameter. NEVER read from `localStorage`.
  - `shared_readonly` (sharing-based read-only) — derived per render from the server-side `access_level` (which itself reflects the conversation's `sharing.*` and `sharing_access` collection state at request time, OR `source === 'autonomous'` post-T025, OR — per FR-004 clarification 2 — the admin-without-recognized-origin fallback case where the server returned `admin_audit` but the `?from=` gate evaluated false). NEVER cached in `localStorage` beyond what the server returns on the next request.
  - `agent-deleted` / `agent-disabled` (Dynamic-Agent read-only treatment) — derived per render from the live `/api/dynamic-agents/agents/{id}` response (component state in `ChatContainer`'s `agentInfo` / `agentNotFound` `useState`, both session-only and not persisted). NEVER read from `localStorage`.

  In short: every read-only banner the UI can show MUST be a function of the current session, the current URL, and the current server response. None of those signals MAY appear as own-keys on any persisted object (see Inv-E and Inv-F).
- **FR-009**: The previously-active conversation identifier MAY be persisted across refresh to restore the user's view, but the persisted identifier MUST NOT be used to infer audit/admin context or to spawn a new sidebar entry; if the identifier matches an existing server-known conversation, that existing entry is selected, otherwise the selection is cleared.
- **FR-010**: The behavior described above MUST apply uniformly across all conversation sources (web, autonomous, slack, shared).

### Key Entities *(include if feature involves data)*

- **Conversation**: A chat thread the user can view in the sidebar. Has a unique identifier, a `source` label (e.g., web / autonomous / slack / shared), and an optional read-only context (audit, shared-read-only, agent-deleted, agent-disabled). The same conversation must never appear twice in the sidebar.
- **Active Conversation Selection**: The single conversation currently shown in the main chat panel. Restored on refresh but must always resolve to at most one existing sidebar entry.
- **Audit Context**: A session-scoped state indicating the user is currently viewing a conversation as an admin auditor. Must be tied to an explicit in-session admin navigation, not to long-lived client storage.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In automated and manual refresh tests across all conversation source types (web, autonomous, slack, shared), 100% of refreshes result in exactly one sidebar entry per underlying conversation identifier — zero duplicates observed.
- **SC-002**: In automated and manual refresh tests with normal-user accounts on their own conversations, 0% of refreshes result in the Read-Only Audit Mode banner being shown.
- **SC-003**: For non-admin users, 0% of any UI state (refresh, navigation, deep-link) exposes audit-mode banners or admin-audit back-links.
- **SC-004**: Time for a returning user to recognize their previously-active conversation after refresh remains under 2 seconds, with selection unambiguous (single highlighted entry).
- **SC-005**: Support/feedback reports mentioning "duplicate tab after refresh" or "stuck in audit mode" drop to zero within one release cycle after deployment.

## Assumptions

- Both bugs are reproducible from a clean, signed-in session and are not dependent on a specific account's data corruption — they are state-management issues in the UI's persistence/rehydration layer.
- "Audit mode" refers to the existing Read-Only Audit Mode banner shown in the chat panel (the `admin_audit` read-only reason), and the legitimate way to enter it is by navigating to a conversation from the admin audit-logs or feedback views.
- The chat sidebar is expected to merge locally-persisted conversations with conversations fetched from the server and synthesized from the autonomous-agents service; this merge is the most likely site of the duplication defect.
- Persisting the previously-active conversation identifier across refresh is desirable UX and should be retained, but only as a pure pointer — never as a carrier of mode/permission state.
- No backend/API changes are required to satisfy this spec; the fix is in the UI's state rehydration, merging, and read-only-mode derivation logic.
