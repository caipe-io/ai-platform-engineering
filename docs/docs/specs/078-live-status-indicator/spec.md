---
sidebar_position: 2
sidebar_label: Specification
---

# Live Status, Input Required & Unviewed Message Indicators on Sidebar Conversations

**Status**: 🟢 In-use
**Category**: Features & Enhancements
**Date**: March 3, 2026

## Overview

Added three-phase status indicators to sidebar chat history items:

1. **Live** (green antenna) — While a conversation is actively streaming, its icon changes to a green pulsing antenna with a ping dot.
2. **Input needed** (amber question) — When the agent requests user input (HITL), an amber pulsing question icon with "Input needed" text appears until the user responds or navigates to the conversation.
3. **Unviewed** (blue dot) — After streaming ends on a conversation the user isn't currently viewing, a blue dot and "New response" text appear until the user clicks into that conversation.

All indicators are always visible without hovering, even when the sidebar is collapsed.

## Motivation

The streaming state of a conversation was only visible inside the chat panel (A2AStreamPanel "Live" label) or as a subtle dot in the AppHeader. Users working with multiple conversations had no way to tell from the sidebar which chats were actively processing or had completed with new responses. This made it hard to track in-flight requests and discover completed responses, especially in collapsed sidebar mode where only icons are visible.

## Related

- Spec: [live-status-indicator](../087-live-status-indicator/spec.md)
- Branch: `prebuild/feat/live-status-indicator`
- PR: [#892](https://github.com/caipe-io/ai-platform-engineering/pull/892)

- Architecture: [architecture.md](./architecture.md)
