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

The optional scanner reads LiteLLM daily usage for configured users or API keys.
It compares usage against a token limit and can notify allowlisted Webex
recipients. Check the outcome in dry-run mode before enabling delivery.

Follow the [LiteLLM alert configuration](https://github.com/caipe-io/ai-platform-engineering/tree/1.4.0/ai_platform_engineering/mcp/litellm#token-usage-alerts)
to set limits, thresholds, recipient allowlists, and the scanner interval.
Alerts report threshold crossings. Gateway budget enforcement is tracked in
the [budget routing epic](https://github.com/caipe-io/ai-platform-engineering/issues/2537).

![The optional scanner reads daily token usage, evaluates configured thresholds, deduplicates notifications, and sends eligible alerts to Webex.](/diagrams/finops-token-alerts.svg)

[Download the editable token-alert diagram](/diagrams/finops-token-alerts.excalidraw)
