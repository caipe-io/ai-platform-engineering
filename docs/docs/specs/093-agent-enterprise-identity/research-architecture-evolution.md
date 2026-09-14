# CAIPE Architecture Evolution

This document tracks the architecture evolution roadmap for the Cisco AI Platform Engineering (CAIPE) system, from the current static distributed model through dynamic agent unification and persona-based profiles. Pulled from [PR #975](https://github.com/caipe-io/ai-platform-engineering/pull/975) for spec 093 (`093-agent-enterprise-identity`).

## Roadmap

```mermaid
gantt
    title CAIPE Architecture Evolution
    dateFormat YYYY-MM
    axisFormat %b %Y

    section Foundation
    Static Distributed Agents (current)           :done,    sda,   2026-01, 2026-06
    Static Single Agent                            :active,  ssa,   2026-03, 2026-06
    Task Config                                    :active,  tc,    2026-03, 2026-06

    section Agent Capabilities
    Skills Integration                             :active,  si,    2026-03, 2026-06
    Separate Dynamic Agent                         :active,  sep,   2026-03, 2026-06

    section Security and Governance
    RAG Authorization                              :         ra,    2026-03, 2026-06
    I/O Guardrails                                 :         iog,   2026-03, 2026-06
    Per Agent LLM Budget                           :         plb,   2026-03, 2026-06

    section Unification
    Dynamic/Single Unification with BYO Remote     :         uni,   2026-04, 2026-06
    Persona-based Dynamic Agent Profiles           :         pdap,  2026-05, 2026-06
```

## Phases

### Phase 1: Current — Static Distributed Agents

The baseline CAIPE architecture.

- Remote distributed agents and MCP servers
- Customized via Agent Registry and Helm config

### Phase 2: March 2026 — Single Node and Dynamic Agents

Consolidation and extensibility in parallel.

| Feature | Description |
|---------|-------------|
| **Static Single Agent** | Single node architecture for more efficient agent communication and tracing; continue remote BYO agent support |
| **Task Config** | Support for deterministic task configuration |
| **Skills Integration** | Skills middleware with CAIPE supervisor |
| **Separate Dynamic Agent** | Users can create their own dynamic agents with custom personas and chosen MCP tools |

### Phase 3: March 2026 — Security and Governance

Cross-cutting concerns that apply to all agent types.

| Feature | Description |
|---------|-------------|
| **RAG Authorization** | Per knowledge-base RBAC; user context authorization |
| **I/O Guardrails** | Slackbot input/output compliance guardrails |
| **Per Agent LLM Budget** | Per agent LLM configuration and budget controls |

### Phase 4: April 2026 — Unification

| Feature | Description |
|---------|-------------|
| **Dynamic/Single Unification with BYO Remote** | Unify the static single agent and dynamic agent architecture |

### Phase 5: May 2026 — Persona-based Profiles

| Feature | Description |
|---------|-------------|
| **Persona-based Dynamic Agent Profiles** | Support team-based default dynamic agents; team/user-based MCP tool access |

## Related Documents (within this spec)

- [Policy Engine Comparison](./policy-engine-comparison.md)
- [Research: AgentGateway + Keycloak + Slack + External Authz](./research-agentgateway-keycloak-slack-external-authz.md)
- [Enterprise Identity Federation](./research-enterprise-identity-federation.md)
- [Slack Bot Authorization](./research-slack-bot-authorization.md)
