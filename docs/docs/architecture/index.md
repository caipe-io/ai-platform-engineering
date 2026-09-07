---
sidebar_position: 1
---

# Solution Architecture

Users reach CAIPE through Slack, Webex, the UI, or CLI. Keycloak authenticates every path, CAIPE Agent(s) run the request, and AgentGateway routes MCP tool calls after OpenFGA authorization.

## CAIPE System Architecture

![CAIPE System Architecture](images/caipe-system-architecture.svg)


## CAIPE Dynamic Agents

![](images/caipe-dynamic-agents.svg)

## CAIPE Authorization Flow

### Authz High Level 

![](images/caipe-mcp-auth.svg)

### Authz OpenFGA

![](images/interaction-model.svg)


## CAIPE Supporting Services

![](images/supporting-services.svg)
