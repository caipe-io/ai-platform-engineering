---
sidebar_position: 6
---

# Chat workspace

Dynamic-agent chats have a resizable workspace panel to the left of the
conversation. Collapse it to an icon rail; select an icon to reopen a section.
On narrow screens, the workspace stacks above the conversation.

- **Agents:** the primary agent, configured subagents, and the latest turn's
  observed delegations. A configured subagent is not an independently attached
  remote session. Unconfirmed delegations are not shown as completed.
- **Coordination:** the latest task list published by the primary agent,
  restored from saved stream events after refresh. Delegation still follows the
  agent's configured instructions. The panel does not introduce autonomous
  coordination or change runtime behavior.
- **Workspace files:** files published to the conversation's existing filesystem
  API, with refresh, preview, and download. This is not a browser for the remote
  worker's entire filesystem. Access errors are distinguished from empty lists.
- **Context & agent details:** existing configuration, context usage, chat
  export, and session refresh. Read-only viewers cannot refresh the session.

Chat sharing does not grant agent, tool, or sandbox access. Opening or collapsing
the workspace does not start, stop, or replace a run. Independent sandbox-session
attachment and per-chat coordination modes require participant-level runtime
bindings and are not supplied by this panel.
