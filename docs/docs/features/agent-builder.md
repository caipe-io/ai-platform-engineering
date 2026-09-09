---
sidebar_position: 1
---

# Agent Builder

Use Agent Builder to create team-owned agents without writing application code.
The guided UI brings together instructions, configured models, tools,
organizational knowledge, reusable skills, and runtime guardrails.

**Quick links**:
[Dynamic Agents Helm chart](../installation/helm-charts/ai-platform-engineering/dynamic-agents-chart) ·
[Developer guide](../development/creating-an-agent)

## What you can do

- Create an agent for a focused job, such as answering team questions or
  investigating an operational issue.
- Give it a clear identity, instructions, model, approved tools, knowledge,
  and reusable skills.
- Test changes immediately in Chat before sharing the agent with a team.
- Limit who can discover, use, or manage the agent with team or global sharing.

Agent Builder is the no-code path for managed agents. Choose the [developer
guide](../development/creating-an-agent.md) when you need to package an agent
as application code or control its deployment yourself.

## Watch the demo

<a href="https://app.vidcast.io/share/70f22189-0a44-42d3-b601-b5730504a8e3">
  <img src="https://raw.githubusercontent.com/wiki/caipe-io/ai-platform-engineering/agent-builder-demo.gif" alt="Agent Builder demo showing agent configuration steps" loading="lazy" />
</a>

<div style={{paddingBottom: '56.25%', position: 'relative', display: 'block', width: '100%'}}>
  <iframe src="https://app.vidcast.io/share/embed/70f22189-0a44-42d3-b601-b5730504a8e3?disableAMA=1" width="100%" height="100%" title="CAIPE.io Agent Builder Demo" loading="lazy" allow="fullscreen *;autoplay *;clipboard-write *;" style={{position: 'absolute', top: 0, left: 0, border: 'solid', borderRadius: '12px'}}></iframe>
</div>

[Watch the full Agent Builder demo on Vidcast ↗](https://app.vidcast.io/share/70f22189-0a44-42d3-b601-b5730504a8e3)

## How it works

```mermaid
flowchart LR
  subgraph BUILD["Design time · Agent Builder"]
    direction TB
    D["1 · Define<br/>identity · instructions · model"]
    E["2 · Equip<br/>tools · knowledge · skills"]
    G["3 · Govern<br/>owner · visibility · approvals"]
    D --> E --> G
  end

  C(["Authenticated<br/>caller"])
  R(["Dynamic Agents<br/>runtime"])
  X["Authorized capabilities<br/>tools · knowledge · workflows"]
  O(["Agent response"])
  P{"OpenFGA<br/>policy"}

  G -->|"Save"| R
  C -->|"Start chat"| R
  R <-->|"Authorized calls"| X
  R --> O
  P -. "Can use agent?" .-> R
  P -. "May access resource?" .-> X

  classDef buildStep fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px
  classDef actor fill:#f1f5f9,stroke:#64748b,color:#1e293b,stroke-width:2px
  classDef runtime fill:#ede9fe,stroke:#7c3aed,color:#4c1d95,stroke-width:3px
  classDef capability fill:#ccfbf1,stroke:#0f766e,color:#134e4a,stroke-width:2px
  classDef policy fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px
  classDef outcome fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px

  class D,E,G buildStep
  class C actor
  class R runtime
  class X capability
  class P policy
  class O outcome
  style BUILD fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a,stroke-width:2px
```

Agent Builder saves the agent definition. The Dynamic Agents runtime loads that
definition when an authenticated caller starts a chat. At runtime, CAIPE checks
the caller's access to both the agent and the resources it uses.

## Build an agent

To create an agent, open **Agents → Create Agent**, complete the steps below,
and select **Create Agent**. You can return to earlier steps before saving.

Agent Builder guides you through six steps:

| Step | Configure |
|------|-----------|
| **Basic Info** | Name, description, owner team, and team or global visibility |
| **Instructions** | System prompt, model, and model parameters |
| **Tools** | Registered MCP tools and CAIPE built-in tools |
| **Knowledge** | Individual data sources and reusable collections |
| **Skills** | Reusable instructions and packaged capabilities |
| **Advanced** | Subagents, human approval rules, middleware, and workflow access |

After you save an agent, you can test it in chat without redeploying the runtime.
You can also clone it, enable or disable it, and export it as YAML.

### A practical first agent

1. Give the agent a specific name and describe the job it should perform.
2. Write instructions that define its role, boundaries, and expected response.
3. Select a model and add only the tools it needs.
4. Attach a data source or collection when answers should use organizational
   information.
5. Add a skill when the agent should follow a repeatable procedure.
6. Save it, test a representative request in Chat, then share it with the
   intended team.

Start with the smallest useful capability set. You can add tools, knowledge,
and skills later without rebuilding the agent.

## Knowledge and tool scope

- MCP servers can connect over `stdio`, SSE, or Streamable HTTP.
- Built-in tools include URL fetch, current date and time, user information,
  wait, human input requests, and workflow execution.
- Selecting data sources or collections narrows the knowledge available to the agent.
- The effective knowledge scope is the intersection of the agent's selection and
  the invoking caller's search access. Configuring knowledge never grants the
  caller additional access.
- Sensitive tools can require human approval before execution.

## Ownership and sharing

Every agent has an owner team.

- **Team visibility** grants use according to the selected team relationships.
- **Global visibility** makes the agent discoverable across the organization
  while retaining team ownership for management.
- OpenFGA relationships control who can discover, use, manage, share, or delete an agent.
- Resource authorization is checked when the agent runs; hiding an action in the UI is not a security boundary.

## GitOps bootstrap

Use `appConfig` in the `caipe-ui` chart to preconfigure resources at installation time.

| Key | Purpose |
|-----|---------|
| `appConfig.models` | Model endpoints available for agent selection |
| `appConfig.mcp_servers` | MCP server registrations |
| `appConfig.agents` | Agent definitions, capabilities, and visibility |
| `appConfig.workflow_configs` | Workflow definitions that agents can run when granted access |

Bootstrapped resources are marked `config_driven` and initially remain read-only
in the UI. An admin can adopt supported config-driven agents into database-backed
management when interactive editing is required.

Applying the configuration is idempotent: upgrades do not duplicate entries, and removed config-driven entries are cleaned up on a later startup.

## Runtime and operations

- REST and SSE APIs support browser, bot, workflow, and service callers.
- MongoDB stores UI-managed definitions, agent state, and conversation history.
- The Dynamic Agents Helm chart supports replicas, resource settings, and horizontal autoscaling.
- `AGENT_RUNTIME_TTL_SECONDS` expires idle agent runtimes.
- Kubernetes Secrets or External Secrets Operator can supply model and integration credentials.
- Prometheus metrics are exposed at `/metrics`.
