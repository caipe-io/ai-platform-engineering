---
sidebar_position: 2
sidebar_label: Specification
id: 087-live-status-indicator-spec
---

# Spec: Live Status, Input Required & Unviewed Message Indicators

## Overview

Show visual indicators on sidebar chat items for three conversation states: a green pulsing antenna when actively streaming, an amber pulsing question icon when the agent is waiting for user input (HITL), and a blue "New response" badge after streaming completes on conversations the user hasn't opened yet. All indicators are always visible without hovering, even when the sidebar is collapsed.

## Motivation

When a user sends a message and a response is being streamed, there is no visual indication on the chat history sidebar that a conversation is actively processing. The streaming state is only visible inside the chat panel itself (via the A2AStreamPanel "Live" label) or in the AppHeader status dot. If a user navigates away from the active conversation or has multiple conversations in flight, there is no way to tell from the sidebar which ones are still live.

Additionally, once streaming completes on a background conversation, the user has no indication that a new response is ready and waiting. They must manually check each conversation to discover completed responses.

This feature provides at-a-glance awareness of both streaming activity and unviewed responses directly in the chat list — critical for multi-conversation workflows and collapsed sidebar states.

## Scope

### In Scope
- Show a green `Radio` (antenna) icon replacing the `MessageSquare` icon when a conversation is streaming
- Add a pulsing green dot overlay for additional visibility during streaming
- Replace the date text with "Live" in green when streaming
- Apply an emerald-tinted background/border to live conversation items
- After streaming ends on a non-active conversation, show a blue "New response" indicator
- Blue dot badge on the icon and "New response" text replacing the date
- Apply a blue-tinted background/border to unviewed conversation items
- Clear the unviewed indicator when the user navigates to that conversation
- Show an amber `MessageCircleQuestion` icon when the agent requests user input (HITL)
- Amber pulsing dot, "Input needed" text, and amber-tinted background/border
- Mark as input-required when `UserInputMetaData` artifact arrives via `addA2AEvent`
- Clear input-required when streaming resumes or user navigates to the conversation
- Ensure all indicators are visible in both expanded and collapsed sidebar states

### Out of Scope
- Sound or push notifications for live/unviewed status
- Showing streaming progress percentage
- Per-agent streaming indicators
- Persisting unviewed state across page reloads (ephemeral in-session tracking)
- Unread message count badges on the tab itself

## Design

### Architecture

**Live indicator**: Leverages the existing `streamingConversations` Map in the Zustand chat store. The `isConversationStreaming(conversationId)` method already exists.

**Unviewed indicator**: Adds a new `unviewedConversations: Set<string>` to the chat store. When streaming ends (`setConversationStreaming(id, null)`) and the conversation is not the currently active one, it is added to the unviewed set. When the user navigates to a conversation (`setActiveConversation(id)`), it is removed from the set.

**Input-required indicator**: Adds a new `inputRequiredConversations: Set<string>` to the chat store. When a `UserInputMetaData` artifact event is added via `addA2AEvent`, the conversation is marked as input-required. Cleared when streaming resumes (`setConversationStreaming(id, state)`) or when the user navigates to the conversation.

```
Conversation States (priority order):

1. isLive (streaming):
   Icon:       Radio (lucide-react) with animate-pulse + ping dot
   Background: bg-emerald-500/10, border-emerald-500/30
   Date text:  "Live" in emerald-600/400

2. isInputRequired (agent waiting for user input):
   Icon:       MessageCircleQuestion (lucide-react) with animate-pulse + ping dot
   Background: bg-amber-500/10, border-amber-500/30
   Date text:  "Input needed" in amber-600/400

3. isUnviewed (new response, not yet viewed):
   Icon:       MessageSquare in blue-500 + solid blue dot
   Background: bg-blue-500/5, border-blue-500/25
   Date text:  "New response" in blue-600/400

4. Default:
   Icon:       MessageSquare (existing behavior)
   Background: Existing active/shared/default styling
   Date text:  formatDate(conv.updatedAt)
```

The icon container (`shrink-0 w-8 h-8`) is rendered outside the `!collapsed` guard, so both indicators are always visible even when the sidebar is collapsed.

### Components Affected
- [ ] Agents (`ai_platform_engineering/agents/`)
- [ ] Multi-Agents (`ai_platform_engineering/multi_agents/`)
- [ ] MCP Servers
- [ ] Knowledge Bases (`ai_platform_engineering/knowledge_bases/`)
- [x] UI (`ui/`)
  - `ui/src/store/chat-store.ts` — `unviewedConversations` + `inputRequiredConversations` state, mark/clear/has actions, `beforeunload` handler
  - `ui/src/components/layout/Sidebar.tsx` — Visual rendering of all three indicators
  - `ui/src/components/layout/AppHeader.tsx` — Chat tab notification badges (green live / amber input / blue unviewed)
  - `ui/src/components/layout/LiveStreamBanner.tsx` — App-wide banner warning when live chats are active
  - `ui/src/app/(app)/layout.tsx` — Mounts `LiveStreamBanner` between header and content
- [x] Documentation (`docs/`)
  - ADR: [2026-03-03-live-status-indicator](../087-live-status-indicator/architecture.md)
- [ ] Helm Charts (`charts/`)

## Acceptance Criteria

- [x] Streaming conversations show a green pulsing antenna icon instead of the chat bubble
- [x] A green ping dot appears at the top-right corner of the icon for additional visibility
- [x] The conversation item has an emerald-tinted background and border when streaming
- [x] The date text is replaced with "Live" in green when streaming
- [x] After streaming ends on a background conversation, a blue dot and "New response" text appear
- [x] The unviewed indicator has a blue-tinted background and border
- [x] Clicking the conversation clears the unviewed indicator
- [x] Both indicators are visible when the sidebar is collapsed (icon-only mode)
- [x] The live indicator transitions to unviewed (if not active) or disappears (if active)
- [x] Non-streaming, non-unviewed conversations retain their existing appearance
- [x] Browser confirms before refresh/close when a chat is actively streaming
- [x] No confirmation dialog when no chats are streaming (non-annoying)
- [x] No regressions in existing sidebar behavior (navigation, archive, share)
- [x] Chat tab in AppHeader shows green pulsing dot when any conversation is streaming
- [x] Chat tab shows blue dot when there are unviewed responses (and nothing streaming)
- [x] Green dot takes priority over blue dot on the Chat tab
- [x] Conversations awaiting user input show amber pulsing `MessageCircleQuestion` icon
- [x] "Input needed" text in amber replaces the date for input-required conversations
- [x] Input-required indicator clears when streaming resumes or user navigates to conversation
- [x] Input-required takes priority over unviewed but not over live
- [x] Chat tab shows amber badge when conversations need input (between green and blue priority)
- [x] TypeScript compiles clean

## Implementation Plan

### Phase 1: Live Status Indicator ✅
- [x] Import `Radio` icon from lucide-react
- [x] Import `isConversationStreaming` from the chat store
- [x] Add `isLive` check per conversation item
- [x] Conditionally render `Radio` with pulse animation vs `MessageSquare`
- [x] Add ping dot overlay on live items
- [x] Apply emerald background/border styling for live items
- [x] Replace date text with "Live" label when streaming

### Phase 2: Unviewed Message Indicator ✅
- [x] Add `unviewedConversations: Set<string>` to chat store state
- [x] Add `markConversationUnviewed`, `clearConversationUnviewed`, `hasUnviewedMessages` actions
- [x] Mark as unviewed in `setConversationStreaming` when streaming ends on non-active conversation
- [x] Clear unviewed in `setActiveConversation` when user navigates to conversation
- [x] Add blue dot badge on icon for unviewed conversations
- [x] Replace date text with "New response" in blue for unviewed conversations
- [x] Apply blue background/border styling for unviewed items

### Phase 3: Refresh Guard ✅
- [x] Add `beforeunload` confirmation when conversations are actively streaming
- [x] Set descriptive `returnValue` message mentioning live chats (for browsers that support it)
- [x] Add `LiveStreamBanner` component at app layout level — visible proactive warning
- [x] Banner shows "N live chat(s) receiving response(s) — refreshing will interrupt"
- [x] Banner auto-hides when no conversations are streaming
- [x] Only triggers `beforeunload` when `streamingConversations.size > 0`
- [x] Still saves in-flight data regardless of user choice

### Phase 4: Input Required Indicator ✅
- [x] Add `inputRequiredConversations: Set<string>` to chat store state
- [x] Add `markConversationInputRequired`, `clearConversationInputRequired`, `isConversationInputRequired` actions
- [x] Mark as input-required in `addA2AEvent` when `UserInputMetaData` artifact arrives
- [x] Clear in `setConversationStreaming` when streaming starts (user submitted input)
- [x] Clear in `setActiveConversation` when user navigates to conversation
- [x] Add amber `MessageCircleQuestion` icon with pulse animation in Sidebar
- [x] Add amber ping dot, background, border, and "Input needed" text
- [x] Add amber count badge on Chat tab in AppHeader

### Phase 5: Documentation ✅
- [x] Create spec in `.specify/specs/`
- [x] Create ADR in `docs/docs/changes/`

## Testing Strategy

- Unit tests:
  - Store tests (37 tests): unviewedConversations CRUD, inputRequiredConversations CRUD, streaming-to-unviewed lifecycle, addA2AEvent marking, streaming-clears-input-required, beforeunload guard, multi-conversation independence
  - Sidebar component tests (23 tests): Radio/MessageCircleQuestion/MessageSquare icon rendering, emerald/amber/blue styling, "Live"/"Input needed"/"New response" text, priority ordering, mixed states, collapsed behavior
  - LiveStreamBanner component tests (6 tests): hidden when idle, singular/plural messages, "refreshing will interrupt" text, accessibility attributes
  - AppHeader Chat tab tests (10 tests): green/amber/blue badges with counts, priority ordering, no badge when idle
- Manual verification:
  - Start a new conversation and send a message — verify green antenna during streaming
  - Verify "Live" text replaces the date
  - Open a second conversation tab while the first is streaming
  - Wait for the first conversation's response to complete
  - Verify the first conversation now shows blue dot + "New response"
  - Click the first conversation — verify the unviewed indicator clears
  - Collapse the sidebar — verify both indicators are visible in icon-only mode
  - Cancel a streaming request — verify live indicator clears (no unviewed since active)

## Rollout Plan

1. Deploy via PR merge to main (branch: `prebuild/feat/live-status-indicator`)
2. No backend changes required — purely frontend
3. No configuration or feature flags needed

## Related

- ADR: [2026-03-03-live-status-indicator](../087-live-status-indicator/architecture.md)
- Branch: `prebuild/feat/live-status-indicator`
- PR: [#892](https://github.com/caipe-io/ai-platform-engineering/pull/892)
