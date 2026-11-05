---
sidebar_position: 1
---

# Solution Architecture

Users reach CAIPE through Slack, Webex, the UI, or CLI. Keycloak authenticates every path, CAIPE Agent(s) run the request, and AgentGateway routes MCP tool calls after OpenFGA authorization.

## CAIPE System Architecture

![CAIPE System Architecture](images/caipe-system-architecture.svg)

## Harness Engine

Harness Gateway preserves the existing CAIPE chat APIs while routing each
authorized agent to either the unchanged Dynamic Agents runtime or the
independent Harness Engine. Solid paths are implemented in PR #2401; dashed
paths are portable interfaces or sandbox capabilities planned for later work.

![Harness Engine system architecture](images/harness-engine-system-architecture.svg)

Editable source: [CAIPE system architecture](https://github.com/cnoe-io/ai-platform-engineering/blob/main/docs/excalidraw/caipe-system-architecture.excalidraw)

### Source graph

The source graph shows where the compatibility boundary, durable control plane,
provider adapters, deployment configuration, contracts, and regression tests
live in the repository.

![Harness Engine high-level source graph](images/harness-engine-source-graph.svg)

Editable source: [Harness Engine source graph](https://github.com/cnoe-io/ai-platform-engineering/blob/main/docs/excalidraw/harness-engine-source-graph.excalidraw)


## CAIPE Dynamic Agents

![](images/caipe-dynamic-agents.svg)

## CAIPE Authorization Flow

### Authz High Level 

![](images/caipe-mcp-auth.svg)

### Authz OpenFGA

![](images/interaction-model.svg)


## CAIPE Supporting Services

![](images/supporting-services.svg)
