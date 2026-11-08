---
sidebar_position: 6
---

# Chat workspace

Dynamic-agent chats have a resizable workspace panel to the right of the
conversation. It opens by default with **Agent coordination** selected as the
first tab, followed by **Agent info**. Collapse it to an icon rail or select an
icon to reopen a specific section.
On narrow screens, the workspace stacks below the conversation.

The **Agent coordination** tab contains:

- **Agents:** the primary agent, configured subagents, and the latest turn's
  observed delegations, and agents attached to the chat. Unconfirmed
  delegations are not shown as completed.
- **Coordination:** the latest task list published by the primary agent,
  restored from saved stream events after refresh. Delegation still follows the
  agent's configured instructions. Attached agents respond to explicitly
  addressed messages; automatic team coordination is not enabled.
- **Workspace files:** files published to the conversation's existing filesystem
  API, with refresh, preview, and download. This is not a browser for the remote
  worker's entire filesystem. Access errors are distinguished from empty lists.

The **Agent info** tab preserves configuration, context usage, chat export,
and session refresh. Read-only viewers cannot refresh the session.

## Add an agent from chat

1. Open **Agent coordination → Add agent** as the chat owner.
2. Choose an existing enabled agent you can Use and a unique handle, for example `reviewer`.
3. Select **Join chat**. The primary agent and conversation URL stay unchanged.
4. Start a message with `@reviewer`, select it from `@` autocomplete, or use the
   **To** picker above the composer. Use `@primary` to return to the primary agent.

- Membership is saved on the conversation and survives refresh. Up to eight
  additional agents can join. A configured subagent remains a different concept:
  the primary runtime delegates to it through its task tool.
- Each attached agent has a separate Harness Gateway binding and Engine session.
  The agent receives addressed messages and its own session history. Earlier chat
  messages and other agents' workspace files are not copied automatically.
- Existing native conversations must migrate to Harness Engine before adding
  participants. Attachment never silently replaces a native checkpoint.
- Chat sharing grants no agent, tool, credential, or sandbox permission. Every
  invocation checks the current caller's agent Use access and conversation write
  permission. Only the owner can attach agents; app-owned assistants and automated
  run histories do not support attachment.
- Assistant/user turns save the actual recipient. Refresh recovery, replay,
  pending input, Stop and retry use that identity, not the current composer
  selection. Shared replay checks saved chat membership before issuing an Engine
  read scope.
- Coordinated chats admit one turn at a time across agents, callers and BFF
  replicas. A Mongo admission fence retains ownership through browser disconnects;
  the previous Engine run must be terminal before another agent starts. Paused
  runs must be resumed or stopped. A lost acknowledgement can be repaired by
  status replay; an admission with no confirmable Engine run fails closed and
  requires operator reconciliation, never automatic prompt replay.
- Earlier-turn editing is disabled after another agent joins: rewinding just one
  provider would strand the other participants' state. Send a follow-up instead.
- Arbitrary sandbox/BYO-session attachment, participant removal, shared workspace
  mounting and automatic team coordination remain separate work.

## API and storage

- `GET /api/chat/conversations/:id/agents`: authorized membership, owner-management
  capability, and Engine availability; no credential or agent-config grants.
- `POST /api/chat/conversations/:id/agents`: `{ agent_id, handle }`; owner + target
  Use checks, enabled runtime validation, reserved/unique handles and an atomic
  bounded Mongo update. Does not alter Agent Builder definitions.
- `conversations.coordination_agents`: saved handles and audit attribution.
- `chat_coordination_admissions`: chat-wide admission generation, request identity
  and admitted run ID. No access tokens are stored in membership or admission rows.

Opening or collapsing the workspace does not start, stop, or replace a run.
