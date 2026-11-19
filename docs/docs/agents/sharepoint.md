---
title: SharePoint MCP server
description: Connect a read-only MCP server to a scoped SharePoint Online site.
---

# SharePoint MCP server

CAIPE 1.4.0 expands the SharePoint MCP server with document, site-page, and scoped-search tools. Each server is configured for one SharePoint Online site and uses a Microsoft Entra application identity to read content via Microsoft Graph.

1. Have a SharePoint administrator grant the Entra application read access to the intended site. Use a site-specific grant where available.
2. Configure the server with the approved site URL and inject application credentials through the deployment's secret configuration.
3. Register the server through the [AgentGateway integration](../architecture/gateway.md) or configure the server's documented endpoint authentication. Enable only the tools required by the agent.
4. Test an allowed search or document read. The configured site bounds what the server can read. The server exposes read-only tools.

See the [SharePoint server reference](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/mcp/sharepoint) for connection settings, tools, and content limits.

## Solution architecture

![An authorized tool request passes through CAIPE to the SharePoint MCP server, which uses its Entra application identity to read from a configured site through Microsoft Graph.](/diagrams/sharepoint-mcp.svg)

[Download editable Excalidraw](/diagrams/sharepoint-mcp.excalidraw)
