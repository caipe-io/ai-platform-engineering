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
  addressed messages; owners can enable agent-to-agent handoffs in Team mode.
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

- A recognized leading `@mention` is deleted as one object with Backspace or
  Delete. Any unselected message text remains. Removing the selected recipient's
  mention resets **To** to the primary agent.
- Primary mentions use blue. Joined agents receive distinct colors in saved
  membership order, consistent across autocomplete, the composer, messages and
  workspace controls. Handles remain visible; color never grants access or
  changes routing. Code, links, email addresses and unknown handles stay literal.
- User-message bubbles use a muted blue surface. Text selection has a separate pale-blue
  highlight with dark text so selecting prose or composer text remains visible.
  These styles apply across all themes, with lighter bubbles in Light and Legacy Light.
- Primary accents and focus rings use blue in Dark, Light and Midnight. Other
  themes retain their primary accents. The SSO login button uses the separate
  brand gradient; its focus ring follows the selected theme.

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
- Arbitrary sandbox/BYO-session attachment, participant removal and shared
  workspace mounting remain separate work.

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

## Team coordination and handoffs

- **Mentions & assignments** is the default. Address a joined agent with `@handle`.
- The chat owner can enable **Team coordination** in the right workspace panel.
- Deep Agents and Claude SDK/ACP/CLI workers then receive `handoff_to_agent`.
  AgentCore can receive assignments; its remote runtime must implement a compatible
  tool to originate them.
- The tool advertises other joined agents' names and handles to each agent,
  including the primary. It does not advertise their tools or share their files.
  Mentions mode does not expose this handoff tool or its participant roster.
- The tool accepts a joined handle and a self-contained assignment. It queues work
  durably and returns an assignment ID. The receiving run starts after the sender
  completes. No model-output mention parser silently launches work.
- The panel shows queued, working, completed, stopped or failed assignments.
  Click a handle to select that participant and follow its Harness session.
- Each agent retains its separate session. Only the assignment text is transferred;
  transcripts, sandbox files and credentials are not automatically shared.
- A chain allows at most eight assignments and four hops. Identical assignments
  from the same parent run deduplicate. Normal per-chat admission still serializes
  execution across participants and browser sessions.

### Authorization and recovery

```mermaid
sequenceDiagram
  participant Agent
  participant BFF as CAIPE BFF
  participant Queue as Durable delivery
  participant Gateway as Harness Gateway
  Agent->>BFF: handoff_to_agent(handle, message) with caller token
  BFF->>BFF: Check active run, owner policy, membership and Use
  BFF->>Queue: Reserve bounded idempotent assignment
  Queue->>BFF: Parent completed; claim fenced delivery lease
  BFF->>BFF: Resolve original encrypted login; recheck chat and both agents
  BFF->>Gateway: Start target with stable request ID and user identity
  Gateway-->>Queue: Durable run ID and terminal journal
  Queue->>BFF: Persist result in the chat
```

- Team mode is an explicit, owner-scoped authorization tied to that login's
  absolute lifetime. Queue records contain only its reference, never tokens.
- The worker uses the existing encrypted session store and serialized refresh
  mechanism. Revocation, logout, expiration or a failed access check stops queued
  work. There is no service-account fallback or copied refresh token.
- Chat sharing grants neither agent access nor tool/credential access. Every
  handoff rechecks both agents and conversation write permission. MCP calls keep
  the original user's existing CAS and connected-credential boundaries.
- Task delivery uses its own durable queue and leases. Human preferences and
  transport outages do not authorize or suppress execution.
- An ambiguous admission retries the identical Gateway request ID. Engine admission
  and the per-chat fence prevent duplicate work. Browser refresh does not own the
  task's lifetime; Engine restart may still interrupt an in-flight provider run.
- Stopping the sender cancels its queued assignments. Turning off team mode or
  changing its authorization generation invalidates queued work. Already active
  responses continue until explicitly stopped.
- Diagnostics expose status codes and participant handles, without prompts,
  provider errors or tokens. Assignment history expires after 30 days.
- This is bounded asynchronous handoff, not a conductor, distributed task board,
  shared filesystem or sandbox isolation. Existing container hardening and runtime
  security boundaries still apply.
