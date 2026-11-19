---
title: Harness Engine and runtimes
description: Choose an execution runtime and understand durable chat with Harness Engine.
---

# Harness Engine and runtimes

CAIPE 1.4.0 adds durable execution through **Harness Gateway** and **Harness Engine**. A Harness-backed run can continue after a client disconnects. When the client reconnects, the Gateway can replay saved events and resume the live stream.

| Runtime | Availability | Where it runs |
| --- | --- | --- |
| LangChain Deep Agents | Stable | The Dynamic Agents service by default. Operators can opt into Engine routing. |
| Claude Agent SDK | Experimental | In the Engine or on a configured remote SDK worker, including the SDK-over-ACP option. |
| Claude Code CLI | Experimental | On a configured remote ACP worker. |
| Amazon Bedrock AgentCore | Experimental | In a configured AWS Harness or Runtime. The Engine uses its AWS identity to invoke it. |

## Choose and use a runtime

1. Have an operator configure the runtime and make a profile available. Review the [Harness Engine deployment guide](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/harness_engine) and the [Claude ACP guide](../architecture/claude-acp.md) for worker requirements.
2. In [Agent Builder](./agent-builder.md), choose an **Execution harness** and any required operator profile. Save the agent and start a new conversation to test it.
3. Watch the response in Chat. If the connection drops, reopen the same conversation to recover the saved progress.
4. For Slack or Webex, an operator can independently enable the [Harness Gateway transport](../integrations/bot-harness-gateway.md). Replay covers reconnects while the bot process is running.

Existing conversations retain their execution version and runtime binding. Start a new conversation to use an updated runtime configuration. For attached MCP tools brokered by CAIPE, current caller and agent permissions govern tool calls. Provider-native tools follow the permissions of the configured worker or provider.

## Solution architecture

![Chat clients connect to Harness Gateway. The Gateway authorizes requests, and Harness Engine dispatches runs to the saved runtime and stores replay events in MongoDB.](/diagrams/harness-runtimes.svg)

[Download editable Excalidraw](/diagrams/harness-runtimes.excalidraw)
