---
title: "CNCF Sandbox resubmission draft for CAIPE"
description: Draft application for Community AI Platform Engineering to join the CNCF Sandbox.
authors: [sriaradhyula]
tags: [articles]
draft: true
---

# [Sandbox] CAIPE Community AI Platform Engineering

> Draft for the current [CNCF Sandbox application form](https://github.com/cncf/sandbox/issues/new?template=application.yml). Copy each response into the matching field only after the source review notes below are resolved.

<!-- truncate -->

<!--
SOURCE REVIEW NOTES - remove this comment and `draft: true` before publication.

Submission blockers and confirmations:

1. Parent-project separation evidence: add the public CNOE maintainer vote URL. The
   migration tracker says the vote has not yet been recorded publicly, while the
   governance transfer plan says "Approval issue: Not yet recorded." The new CNCF
   form identifies this evidence as a critical requirement for subproject splits.
2. Dependency licenses: resolve or obtain CNCF guidance for the MongoDB, Redis,
   Neo4j, and MinIO runtime services disclosed below. MongoDB remains a core
   persistence dependency in the current deployment; the others are optional or
   transitive profiles. Do not replace the disclosure with "N/A" without a fresh,
   published license inventory.
3. Maintainers file: rename the columns to the form's exact required labels:
   "Name", "GitHub ID", and "Company/Organization". Confirm current employer and
   controlling-organization affiliations, including the Cisco/Splunk relationship.
4. Governance: merge or close caipe-io/governance#2 after its required review and
   vote, then link adopted contributor-lifecycle and decision records as evidence.
5. Scope: this draft scopes only caipe-io/ai-platform-engineering. Confirm whether
   caipe-cli or agentic-apps should also be included before submission.
6. Contacts and assets: confirm the application contacts, legal signatory, and the
   present owners of the CAIPE trademark, domain, GitHub organization, and package
   accounts. Replace the proposed signatory row if asset ownership differs.
7. Domain review and CNCF contacts: add public meeting notes, a recording, or a
   completed Day 0 GTR if one exists. Name only CNCF leaders who have confirmed
   familiarity with the project.
8. Website cleanup: update remaining cnoe-io repository, chart, roadmap, Slack, and
   governance links before pointing reviewers to caipe.io as the source of truth.
9. Refresh time-sensitive figures immediately before submission.
-->

---

## Basic project information

### Project summary

CAIPE is a self-hosted open source platform for teams to build, govern, and operate AI agents and workflows across cloud native systems.

### Project description

CAIPE, pronounced "cape," is a reusable software platform that organizations can deploy to build, govern, and operate AI agents and agentic workflows. It ships runnable services, APIs, a web application, Helm charts, Docker Compose configurations, reusable skills, knowledge services, workflow automation, and MCP integrations for platform and operations tools.

Administrators use CAIPE to configure models, agents, skills, workflows, knowledge bases, credentials, identities, and access policies. Users invoke those capabilities through the web application, Slack, Webex, APIs, or a CLI. MCP, A2A, and AG-UI provide open integration boundaries, while Keycloak, OpenFGA, AgentGateway integration, audit services, and Prometheus-compatible metrics provide controls needed for shared operational use.

Platform teams can assemble an agent with a framework, but they still need a multi-user control plane, secure tool access, credential handling, persistence, knowledge ingestion, auditability, and delivery channels. CAIPE provides that product layer as installable open source software. Its default execution service currently uses Deep Agents and LangGraph, but those libraries are runtime dependencies rather than the project's identity; CAIPE owns the surrounding lifecycle, policy, integration, and user experience. Different organizations can deploy the same platform, select their own models and tools, and extend it without adopting a company-specific architecture.

### Project vs Reference Architecture or Implementation

- [x] This is a reusable open source project designed for broad adoption, not a reference architecture, reference implementation, or demonstration of patterns.

CAIPE is distributed as executable, versioned software. Users install and operate the platform; they do not use the repository as a blueprint for recreating a particular organization's system. The project provides stable user-facing services and extension points for agents, skills, workflows, knowledge sources, MCP servers, identity providers, and clients. Examples and deployment guidance document the product but are not the product itself.

---

## Project details

### Org repo URL

N/A. Not every repository under the [caipe-io organization](https://github.com/caipe-io) is in scope of this application.

### Project repo URL in scope of application

https://github.com/caipe-io/ai-platform-engineering

### Additional repos in scope of the application

N/A. This application scopes only the primary CAIPE platform repository.

### Website URL

https://caipe.io/

### Roadmap

https://github.com/orgs/caipe-io/projects/1

### Roadmap context

The public project board is the authoritative roadmap and links initiatives to implementation issues and pull requests. Current themes include:

- portable agent runtimes and SDK adapters behind a common lifecycle boundary;
- LLM routing, provider choice, budgets, and quotas;
- agent and retrieval evaluation with regression signals;
- safe autonomous and scheduled execution with human-in-the-loop controls;
- reusable workflows and agentic application extensibility;
- knowledge bases, RAG, GraphRAG, memory, and portable persistence;
- enterprise identity, relationship-based authorization, credential isolation, and auditability; and
- Kubernetes deployment, release engineering, documentation, and contributor experience.

The board includes delivered work as evidence as well as planned work, so reviewers can trace a roadmap item to its issue history and implementation.

### Contributing guide

https://github.com/caipe-io/ai-platform-engineering/blob/main/CONTRIBUTING.md

### Code of Conduct

https://github.com/caipe-io/governance/blob/main/CODE_OF_CONDUCT.md

### Adopters

https://github.com/caipe-io/ai-platform-engineering/blob/main/ADOPTERS.md

### Maintainers file

https://github.com/caipe-io/ai-platform-engineering/blob/main/MAINTAINERS.md

### Security policy file

https://github.com/caipe-io/ai-platform-engineering/blob/main/SECURITY.md

### Standard or specification

N/A. CAIPE is software, not a standard or specification. It implements and connects existing protocols, including MCP, A2A, AG-UI, OAuth/OIDC, and OpenTelemetry, without claiming ownership of those specifications.

### Business product or service to project separation

CAIPE is not an upstream edition of a commercial product or service. The source, issues, pull requests, releases, roadmap, governance documents, and community discussions are public, and the project is licensed under Apache 2.0. Organizations represented among maintainers may deploy CAIPE internally, provide integrations, or build their own services on it, but those deployments do not define the open source project's release or feature boundaries.

The project repository and governance are being consolidated under the vendor-neutral `caipe-io` organization. CAIPE's public charter and decision-making rules separate project decisions from any sponsoring employer. Before submission, the project will link the completed parent-project separation vote and confirm custody and donation authority for the trademark, domain, GitHub organization, and package accounts.

---

## Cloud native context

### Why CNCF

CAIPE's users and contributors are platform engineers, SREs, DevOps practitioners, and teams operating Kubernetes and adjacent cloud native systems. CNCF is the natural home because CAIPE's value depends on trustworthy integration across this ecosystem rather than control by one model vendor, agent framework, cloud, or operations-tool company.

CNCF stewardship would help CAIPE:

- establish durable, neutral governance and broaden ownership beyond its originating contributors;
- collaborate directly with the communities whose projects CAIPE operates and observes, turning integration experience into documented patterns, tests, and upstream feedback;
- make agent-to-tool authorization, auditability, observability, and human oversight shared cloud native concerns rather than proprietary add-ons; and
- give end users a neutral place to contribute operational agents, workflows, skills, and connectors that can be reused across organizations.

CAIPE would bring CNCF a working application platform where cloud native projects are consumed together in real operational workflows. The project does not ask CNCF to endorse one agent framework. It provides an open integration and governance layer in which multiple runtimes, models, tools, and clients can participate.

### Benefit to the landscape

CAIPE benefits the Cloud Native Landscape by reducing repeated, organization-specific engineering at the point where AI agents meet production operations.

- **A reusable operational control plane.** Teams receive agent and workflow lifecycle management, user and service identity, relationship-based permissions, credential handling, knowledge ingestion, audit history, health, and multi-channel access as one installable project.
- **More accessible CNCF capabilities.** CAIPE lets authorized users invoke tools such as Kubernetes, Argo CD, Backstage, Keycloak, OpenFGA, Helm, OpenTelemetry, and Prometheus through governed agents and workflows. It complements those projects rather than reimplementing their core functions.
- **Community-owned integrations.** MCP servers, skills, and workflows turn operational knowledge into reviewable open source artifacts. A connector or runbook contributed for one environment can be adapted by other users instead of rebuilt behind company firewalls.
- **A practical safety and interoperability venue.** The project exercises open agent and tool protocols in multi-user environments where authorization, audit, failure handling, and human approval matter. Findings can improve integrations and inform adjacent project communities without CAIPE becoming a standards body.
- **Lower adoption barriers.** Helm, Docker Compose, a web interface, APIs, and chat integrations give organizations multiple entry points while preserving the ability to bring their own model provider, MCP servers, knowledge sources, and agent runtime.

This creates a community feedback loop: cloud native project users gain reusable automation, and upstream projects gain concrete integration use cases, tests, and issues from agent-driven operations.

### Cloud native fit

CAIPE is designed to be installed and operated as a distributed cloud native application:

- Platform services are containerized and packaged through Helm for Kubernetes, with Docker Compose for local and single-node evaluation.
- UI, agent execution, scheduling, audit, knowledge, identity, authorization, gateway, and optional integration services have explicit service boundaries, APIs, health checks, and configuration.
- Agents, skills, models, workflows, integrations, and access relationships are managed declaratively or through APIs and can be reconciled by deployment automation.
- Compute services externalize durable conversations, checkpoints, workflow state, knowledge indexes, and audit data to configured backing services.
- Components expose structured logs, health endpoints, Prometheus-compatible metrics, and OpenTelemetry-compatible tracing paths.
- MCP, A2A, AG-UI, HTTP/SSE, OAuth/OIDC, and JWT boundaries allow independently deployed clients, agents, and tools to interoperate.
- Deployments can select model providers, enable only required MCP servers and optional services, and run on local, public-cloud, or on-premises Kubernetes infrastructure.

The platform applies cloud native properties to agentic operations: independently deployable services, API-based composition, declarative delivery, observable execution, externalized state, identity-aware access, and replaceable integrations.

### Cloud native integration

| CNCF project | Current CAIPE integration |
| --- | --- |
| **Kubernetes** | Primary orchestration target for the Helm deployment. CAIPE agents and MCP integrations can inspect or operate Kubernetes-backed platform services under configured credentials and authorization policy. |
| **Helm** | CAIPE publishes a parent chart and component charts for installing and configuring platform services and optional integrations. |
| **Argo CD** | A maintained MCP server exposes GitOps application, sync, health, and deployment operations to authorized agents. |
| **Backstage** | CAIPE includes a Backstage MCP server. The Agent Forge client integration was also contributed to the upstream Backstage community plugins repository. |
| **Keycloak** | Provides OIDC identity, service clients, and token-exchange flows for browser, API, bot, and agent access paths. |
| **OpenFGA** | Provides relationship-based authorization for teams and resources; CAIPE uses it in user-facing APIs and the agent-to-tool policy path. |
| **OpenTelemetry** | CAIPE emits and forwards tracing context for agent, service, and tool execution and integrates with OpenTelemetry-compatible observability backends. |
| **Prometheus** | Dynamic Agent services expose Prometheus-compatible request, model, tool-call, streaming, cache, and authorization metrics, and the admin UI can query a configured Prometheus endpoint. |

CAIPE does not replace any of these projects. It composes their capabilities into governed agent and workflow experiences and provides integration code that their users can operate and extend.

### Cloud native overlap

The closest CNCF overlap is [kagent](https://kagent.dev/). Both projects support agents for cloud native operations, MCP tools, skills, multi-agent composition, user interfaces, and Kubernetes deployment. CAIPE does not characterize that overlap as merely incidental.

kagent is Kubernetes-native and manages agents, runtimes, skills, and MCP servers as Kubernetes resources. CAIPE is an application and control plane spanning web and chat clients, agent and workflow authoring, scheduled and event-driven execution, knowledge ingestion, user and service identities, team/resource sharing, credential brokering, relationship-based tool authorization, and audit administration. CAIPE can also run outside Kubernetes for local or single-node use. Its roadmap introduces a harness boundary so the platform can use multiple runtimes rather than defining a competing agent framework.

There is also functional adjacency with:

- **Backstage**, for a unified platform-engineering interface. CAIPE integrates with Backstage and focuses on governed agent execution rather than replacing the software catalog or developer portal framework.
- **Argo and other workflow or GitOps projects**, for automation. CAIPE invokes those systems through their APIs and MCP tools; it does not replace their reconciliation, rollout, or workflow engines.
- **Keycloak and OpenFGA**, for identity and authorization. CAIPE consumes them as security building blocks and adds agent-, skill-, workflow-, knowledge-, credential-, and tool-specific resource models and enforcement paths.

The overlap is useful: CAIPE gives these projects a shared, end-user-facing environment for agentic operational workflows, while retaining their native APIs and control planes as the source of truth.

### Similar projects

- **[kagent](https://kagent.dev/)**, a CNCF Sandbox project, is a Kubernetes-native runtime and framework for agents, skills, memory, and MCP tools. It has meaningful overlap with CAIPE's agent and tool layer; CAIPE differentiates through a broader multi-user application control plane, knowledge and workflow management, multi-channel clients, and resource-level governance across Kubernetes and non-Kubernetes environments.
- **[Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview)** and **LangGraph** are developer libraries and runtimes for planning, tools, subagents, durable execution, streaming, and human-in-the-loop behavior. CAIPE currently uses them in its default execution service and adds installable platform services, integrations, policy, knowledge, administration, and user experiences around that runtime boundary.
- **[Dify](https://docs.dify.ai/)** is a general-purpose open source platform for building AI applications with models, workflows, RAG, and agents. CAIPE is narrower in domain and deeper in cloud native platform operations, with maintained operations-tool integrations and identity-aware agent-to-tool enforcement.

### Landscape

No. CAIPE is not currently listed on the [Cloud Native Landscape](https://landscape.cncf.io/).

The closest current fit is the AI Agents portion of the AI Native Landscape, with a secondary relationship to provisioning, automation, and platform engineering. The final category should be selected with the CNCF landscape and reviewing TAG communities rather than asserted by the applicant.

### Insights

No. CAIPE is not currently listed on LFX Insights.

---

## CNCF policies

### Trademark and accounts

- [x] If the project is accepted, I agree to donate all project trademarks and accounts to the CNCF.

### IP policy

- [x] If the project is accepted, I agree the project will follow the CNCF IP Policy.

### Will the project require a license exception

N/A. CAIPE's source code is licensed under Apache 2.0. The project is not requesting an exception for its own license.

### Dependencies with licenses not on the allowlist or an approved exception

The current deployment manifests reference separately deployed runtime services whose licenses are not on the CNCF dependency allowlist:

- **MongoDB server 7.0** - SSPL; currently used for core conversations, checkpoints, configuration, scheduling, and other persistent platform state.
- **Neo4j** - GPLv3; optional GraphRAG and ontology service.
- **Redis** - current unpinned or Redis 7 image references require exact-version review because later Redis releases use RSALv2/SSPLv1; used by optional RAG, cache, and third-party observability profiles.
- **MinIO** - AGPLv3; optional or transitive object storage in Milvus and Langfuse profiles.

These services run out of process and are not linked into CAIPE's Apache-2.0 source, but the project is disclosing them because they are represented in supported deployment configurations. The project is tracking a fresh dependency inventory and license-compatible deployment strategy. This answer must be updated with the resolved, tested configuration before submission; CAIPE will not characterize the current state as fully allowlisted without that evidence.

### Project Domain Technical Review

N/A at present. The prior application stated that CAIPE had been reviewed with the CNAI community but did not link public meeting notes, a recording, or a completed Day 0 General Technical Review. Add those links here if available; otherwise this response should remain N/A and the application should not imply a formal review.

---

## Contact information

### Application contact emails

sraradhy@cisco.com, haskalpa@cisco.com, nvlatko@cisco.com, tiswanso@cisco.com

### Contributing or sponsoring entity signatory information

Proposed signatory from the prior application; confirm this entity owns or is authorized to transfer the project assets before submission.

| Name | Address | Type | Signatory name and title | Email address |
| --- | --- | --- | --- | --- |
| Cisco Systems, Inc. | 170 W Tasman Dr, San Jose, CA 95134 | Delaware corporation | Cisco OSPO Legal representative, to be confirmed | oss-legal@cisco.com |

---

## Additional information

### CNCF contacts

No confirmed contacts are listed in this draft. Before submission, add only CNCF TOC, TAG, or other leadership participants who are familiar with CAIPE and have agreed they can answer reviewer questions.

### Additional information

#### Direct response to the previous review

The [first Sandbox application](https://github.com/cncf/sandbox/issues/475) described CAIPE as a "reference implementation" and a "reference architecture." Reviewers therefore reasonably evaluated it as an opinionated assembly of Deep Agents and LangGraph rather than as a reusable project.

This application corrects the terminology and clarifies the software boundary. Deep Agents and LangGraph provide capabilities inside CAIPE's default agent execution service. CAIPE itself provides and maintains the surrounding product:

- a multi-user web application and APIs for agent, model, MCP server, skill, workflow, knowledge-base, credential, and access management;
- scheduling, event triggers, run history, artifacts, conversations, checkpoints, and human-in-the-loop workflow controls;
- Keycloak-based identity and service accounts, OpenFGA resource relationships, credential handling, and authorization at agent-to-tool boundaries;
- an audit service, platform health, Prometheus-compatible metrics, and OpenTelemetry-compatible tracing paths;
- maintained MCP servers for platform and operations tools;
- knowledge ingestion, retrieval, optional graph enrichment, and agent memory capabilities;
- Slack, Webex, web, API, and CLI access paths; and
- versioned Docker Compose and Helm deployment artifacts.

Those capabilities are executable, tested project code with public APIs and release artifacts. They are reusable across organizations and remain useful if the default agent runtime changes. Portable runtime adapters are an explicit roadmap item, further separating CAIPE's platform contract from one framework.

#### Changes since the first application

- The primary repository moved from `cnoe-io` to the dedicated [`caipe-io`](https://github.com/caipe-io) organization.
- The project established a dedicated [governance repository](https://github.com/caipe-io/governance) with a charter, Steering Committee, decision rules, security policy, and transfer plan.
- The website now leads with CAIPE as an open source platform for building, governing, and operating agents and workflows.
- The project published a new [roadmap board](https://github.com/orgs/caipe-io/projects/1) that connects initiatives, implementation issues, and completed evidence.
- Repository ownership expanded from one default individual to project and component maintainer teams in `CODEOWNERS`.
- The contributing guide documents DCO sign-off and the repository's conventional-commit and review expectations.
- The platform reached the [1.0.0 release](https://github.com/caipe-io/ai-platform-engineering/releases/tag/1.0.0).
- The application now acknowledges substantive overlap with kagent and separates current integrations from roadmap plans.
- The application discloses non-allowlisted runtime services instead of treating the Apache-2.0 license on CAIPE source as a complete dependency answer.

#### Current project evidence

As of September 8, 2026, the primary repository has more than 400 stars, about 80 forks, more than 50 contributors visible through GitHub's contributor API, an active issue and pull-request history, and a current 1.0.0 release. The project holds weekly public community meetings and maintains public documentation, an issue tracker, discussions, a roadmap, release notes, an adopters file, and contribution paths for code, documentation, skills, integrations, and testing.

#### Parent-project separation evidence

<!-- Replace this paragraph with the public CNOE maintainer vote URL and a one-sentence result before submission. -->

The primary repository has moved to `caipe-io`, but the required public record of the CNOE maintainer vote approving the separation is not yet linked. The application must not be submitted until that evidence is available and included here.
