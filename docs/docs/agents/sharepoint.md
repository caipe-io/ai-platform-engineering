---
title: SharePoint MCP server
description: Connect a read-only MCP server to a scoped SharePoint Online site.
---

# SharePoint MCP server

CAIPE 1.4.0 expands the SharePoint MCP server with document, site-page, and scoped-search tools. The server uses a configured SharePoint Online site for discovery and a Microsoft Entra application identity to read content via Microsoft Graph.

1. For a single-site deployment, use [`Sites.Selected`](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) with a `read` grant on the intended site only.
2. Configure the server with the approved site URL and inject application credentials through the deployment's secret configuration.
3. Register the server through the [AgentGateway integration](../architecture/gateway.md) or configure the server's documented endpoint authentication. Enable only the tools required by the agent.
4. Test an authorized search or document read with the intended site grant.

The MCP tools are read-only. General drive browsing, search, and text reads
rely on Microsoft Graph to enforce the Entra application's grants. Keep those
grants limited to the intended site. Document manifests and the document HTTP
routes also check that a library belongs to the configured site.

See the [SharePoint server reference](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/mcp/sharepoint) for connection settings, tools, and content limits.

## Solution architecture

![An authorized tool request passes through CAIPE to the SharePoint MCP server. Microsoft Graph applies the Entra application's permissions to the read.](/diagrams/sharepoint-mcp.svg)

[Download editable Excalidraw](/diagrams/sharepoint-mcp.excalidraw)
