---
title: Remote agents over A2A and ACP
description: Discover, register, and delegate to A2A agents, or chat with configured ACP workers.
---

# Remote agents over A2A and ACP

CAIPE 1.3.0 added remote **Agent-to-Agent (A2A)** delegation. CAIPE 1.4.0 adds a unified catalog for created agents, registered A2A specialists, and configured **Agent Client Protocol (ACP)** agents.

## Delegate to a registered A2A agent

1. In **Agents → Add agent → Connect existing**, a platform administrator discovers an Agent Card from a URL or an operator-enabled Kubernetes discovery source and registers the endpoint.
2. Set the endpoint authentication to the caller JWT, a saved-secret reference, or a connected credential. Use **Test connection** to inspect the Agent Card and advertised capabilities.
3. In **Agent Builder → Advanced → Subagents**, select the registered specialist. Start a conversation with the parent agent and give it a task to delegate. Dynamic Agents resolves the selected authentication for each call.

The connection test fetches metadata. Use a delegated task to verify execution and results. Direct conversations with registered A2A agents and Agent Teams are tracked in the [1.5.0 epic](https://github.com/caipe-io/ai-platform-engineering/issues/3432).

![An administrator registers an A2A Agent Card. A Deep Agents parent calls the registered remote specialist using the caller's configured authentication.](/diagrams/remote-a2a.svg)

[Download the editable A2A diagram](/diagrams/remote-a2a.excalidraw)

## Chat with a configured ACP agent

1. Ask an operator to configure a **Claude Agent SDK (ACP)** or **Claude Code CLI (ACP)** worker and publish an operator profile.
2. Create a CAIPE agent in [Agent Builder](./agent-builder.md), select the matching harness and profile, and save it.
3. Select **Chat** on the agent's catalog entry. Harness Engine uses its configured worker and keeps the existing conversation bound to that runtime.

ACP is experimental in 1.4.0 and uses configured worker connections. See [Claude ACP architecture](../architecture/claude-acp.md) for transport, session persistence, and supported tool paths.

![A saved ACP agent profile routes Chat through Harness Gateway and Engine to a configured Claude worker with a persistent workspace.](/diagrams/configured-acp.svg)

[Download the editable ACP diagram](/diagrams/configured-acp.excalidraw)

For tool access from external clients, see the [Dynamic Agents MCP API](../api/dynamic-agents-mcp.md).
