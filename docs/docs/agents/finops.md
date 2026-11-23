---
title: FinOps reporting and usage alerts
description: Report cloud and model spending with Cloudability and LiteLLM, and configure optional token-usage alerts.
---

# FinOps reporting and usage alerts

CAIPE 1.4.0 adds an optional FinOps agent configuration that uses
**Cloudability** for cloud cost and **LiteLLM** for model and token usage.

1. Enable the Cloudability and LiteLLM MCP servers as needed. Supply each
   provider's credentials through the deployment's secret configuration.
2. Use the [FinOps starter configuration](https://github.com/caipe-io/ai-platform-engineering/blob/1.4.0/config/app-config.finops.yaml)
   or attach the approved tools to an agent in Agent Builder.
3. Test a cloud-cost question against Cloudability and a model-usage question
   against LiteLLM. The tools can report only the data their provider access
   permits.

See the [Cloudability MCP reference](https://github.com/caipe-io/ai-platform-engineering/tree/1.4.0/ai_platform_engineering/mcp/cloudability) for credentials and deployment settings.

![The FinOps agent calls separate MCP tools for cloud cost data and model usage data.](/diagrams/finops-reporting.svg)

[Download the editable FinOps reporting diagram](/diagrams/finops-reporting.excalidraw)

## Configure LiteLLM token-usage alerts

The optional scanner reads LiteLLM daily usage for configured users or API keys
and compares it with a token limit. The allowlist check passes when the
monitored identity (a user or API key) or the Webex delivery address matches
an entry.
Review each configured delivery address and check the outcome in dry-run mode
before enabling delivery.

Set limits, thresholds, and the allowlist using the
[token-usage alert settings](https://github.com/caipe-io/ai-platform-engineering/tree/1.4.0/ai_platform_engineering/mcp/litellm#token-usage-alerts).
Then use the [automatic Webex alert settings](https://github.com/caipe-io/ai-platform-engineering/tree/1.4.0/ai_platform_engineering/mcp/litellm#automatic-webex-alerts)
to enable the scanner, configure targets, and set the scan interval.
Alerts report threshold crossings. Gateway budget enforcement is tracked in
the [budget routing epic](https://github.com/caipe-io/ai-platform-engineering/issues/2537).

![The optional scanner reads daily token usage, evaluates configured thresholds, deduplicates notifications, and sends eligible alerts to Webex.](/diagrams/finops-token-alerts.svg)

[Download the editable token-alert diagram](/diagrams/finops-token-alerts.excalidraw)
