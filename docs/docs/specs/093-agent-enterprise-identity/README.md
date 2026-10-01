# Spec 093 (`093-agent-enterprise-identity`): Policy Engines and Enterprise Authorization Architecture for Agentic AI

This folder contains the feature specification and all supporting research for policy engine comparison (Cedar, CEL, Casbin, OPA/Rego, AgentGateway, IBAC, OpenFGA), enterprise identity federation and OBO (Keycloak, token exchange, connector management), AgentGateway + Keycloak + 3LO + **Slack and Webex** bots + external authz, bot authorization and I/O guardrails, and CAIPE architecture evolution.

## Architecture (single source of truth)

- **[architecture.md](./architecture.md)** — **Single source of architecture truth** for this capability: one canonical Mermaid diagram and narrative covering Slack and Webex as entry points, Keycloak, AgentGateway, external authz, and CAIPE; flow summary; optional vs required components.

## Specification

- **[spec.md](./spec.md)** — Feature spec: user stories, requirements, success criteria, scope.

## Deliverables

- **[policy-engine-comparison.md](./policy-engine-comparison.md)** — Main comparison document (Cedar, CEL, Casbin, OPA/Rego) with Keycloak integration, recommendations, implementation checklists.

## Documentation site and contributor workflow

Former spec **`095-enterprise-identity-federation-docs`** is **merged into this folder**: see **[spec.md](./spec.md)** section *Documentation site and contributor workflow (merged from former `095-enterprise-identity-federation-docs`)* for scope, acceptance criteria, and phased implementation checklist.

Quick links: published architecture includes [`enterprise-identity-federation.md`](../../architecture/enterprise-identity-federation.md). Contributor git conventions live in the repository root **`CLAUDE.md`** and **`.cursorrules`**.

## Research (this spec)

| Document | Description |
|----------|-------------|
| [research-agentgateway-keycloak-slack-external-authz.md](./research-agentgateway-keycloak-slack-external-authz.md) | AgentGateway + Keycloak + Enterprise Auth + 3LO + Slack/Webex + External Authz; Mermaid diagrams; GitHub/Atlassian identity brokering and OBO. |
| [research-enterprise-identity-federation.md](./research-enterprise-identity-federation.md) | Enterprise identity federation and user impersonation (Keycloak, OBO, token exchange, connector management). From [PR #975](https://github.com/caipe-io/ai-platform-engineering/pull/975). |
| [research-slack-bot-authorization.md](./research-slack-bot-authorization.md) | Slack bot authorization architecture, scope validation gates, pre-authorization binding. From PR #975. |
| [research-slack-io-guardrails.md](./research-slack-io-guardrails.md) | Slack input/output guardrails (secrets, PII, prompt injection, content policy). From PR #975. |
| [research-architecture-evolution.md](./research-architecture-evolution.md) | CAIPE architecture evolution roadmap (Gantt, phases). From PR #975. |

## Source

- Policy engine comparison and AgentGateway/IBAC/OpenFGA research: produced for this spec.
- Enterprise identity federation, Slack bot authorization, Slack I/O guardrails, and architecture evolution: pulled from [caipe-io/ai-platform-engineering PR #975](https://github.com/caipe-io/ai-platform-engineering/pull/975) (docs/architecture) into this specification research for a single reference set.
