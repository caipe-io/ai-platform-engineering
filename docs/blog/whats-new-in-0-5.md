---
slug: whats-new-in-0-5
title: "What's New in 0.5 — Workflows, Scheduled Agents, BYO Credentials, Custom Agents, Fine-Grained Authorization, and Webex"
date: 2026-06-18
authors: [sriaradhyula]
tags: [articles, release]
---

<!-- assisted-by claude code claude-sonnet-4-6 -->

The 0.5 series is the biggest leap since the initial release. It ships a new workflow engine, agent-driven scheduled jobs, bring-your-own credentials for MCP tools, fully custom agent management from the UI, relationship-based access control across every resource, and a first-class Webex bot — alongside a dramatically improved admin experience. This post covers all of it.

<!-- truncate -->

> **Release notes:** see the [0.5.0 release notes](/releases/release-0.5.0) for the full
> summary, breaking changes, and the upgrade guide. The
> [releases page](/releases) lists every release.

---

## Workflow Engine

The platform now ships a first-class workflow engine backed by LangGraph. You can build multi-step agentic workflows that fan out to sub-agents, pause for human input, and resume — tracked in a live UI timeline.

- **Inline HITL**: When a workflow reaches a `waiting_for_input` state, the approval form renders directly inside the chat card. No page navigation required. (0.5.43/0.5.45)
- **Subagent timeline correlation**: Each sub-agent's output is pinned to its triggering step so you can trace execution at a glance. (0.5.41)
- **Workflow run sharing**: Share a run with one or more teams for collaborative debugging. Team members can view and resume shared runs through OpenFGA access grants. (0.5.39)
- **Non-admin workflow creation**: Team members can create, edit, and run workflows scoped to their team without platform-wide grants. (0.5.18)
- **Live status links in chat**: When an agent kicks off a workflow, the response includes a direct URL to the run and polls for live status updates. (0.5.18)

The previous Task Builder is superseded by this engine. The legacy standalone supervisor and A2A agents are removed as of 0.5.22 — all routing flows through the dynamic agent layer.

---

## Scheduled Agents

Agents can now create, manage, and run scheduled jobs without any manual intervention. (0.5.36)

- **Scheduler MCP server**: A new `mcp-scheduler` tool exposes create, list, update, and delete operations. Each schedule is owned by the creating user — only they (or their team members) can manage it.
- **Kubernetes CronJob backend**: Each schedule maps to a CronJob in the platform namespace. A lightweight `caipe-cron-runner` pod fires once per interval and exits.
- **Owner impersonation**: The scheduler uses Keycloak token exchange to mint a real owner-user bearer on each firing. If the owner's access was revoked, the run fails closed — identical to an interactive run.
- **Conversation history**: Each scheduled run creates a Web UI conversation owned by the schedule's creator.
- **One-shot and recurring**: Supports standard cron expressions and delayed one-off jobs with optional retry metadata.

Enable with `scheduler.enabled: true`.

---

## BYO Credentials and Impersonation for MCP Servers

You can now attach credentials directly to MCP tool calls — as personal OAuth tokens, service account credentials, or PKCE public-client flows for integrations that don't support a fixed scope.

- **Envelope-encrypted credential store**: AES-GCM with KMS-style data-key wrapping in MongoDB. AWS KMS is recommended for production; `local-cmk` for non-production only. (0.5.0)
- **Pin OAuth connections to MCP servers**: Attach a GitHub, Jira, Confluence, or other OAuth provider connection directly to a custom MCP server. The platform forwards credentials automatically on every tool call. (0.5.18)
- **PKCE public-client OAuth**: For integrations where a fixed connection scope is not appropriate, the user's OAuth session scope is used directly. (0.5.29)
- **Service account credential passthrough**: Service accounts carry their own credentials into tool calls so integrations authenticate as the service account, not the invoking user. (0.5.13)
- **Fail-closed enforcement**: If a caller-scoped MCP tool requires OAuth credentials and none are present, the request fails with a clear error rather than silently proceeding. (0.5.18)
- **Credentials panel**: Single scrollable pane for all credential types, with secret hash tabs for reviewing stored hashes. (0.5.27/0.5.29)

Enable with `CAIPE_CREDENTIALS_ENABLED: "true"` and `CREDENTIAL_KEY_PROVIDER: "aws-kms"` for production.

---

## Custom Agents

The dynamic agents runtime is the sole routing layer. You can define, deploy, and manage agents entirely from the UI without writing code or modifying Helm values.

- **Full CRUD from the UI**: Create agents with a system prompt, LLM config, and MCP tool selection. Persisted in MongoDB and live immediately. (0.5.0+)
- **MCP endpoint normalizer**: Accepts bare hostnames, trailing-slash URLs, or missing `/mcp` suffixes — canonicalized automatically. (0.5.0)
- **Editor blocker hints**: The agent editor surfaces actionable hints when required configuration is missing, and blocks deletion of the platform default agent. (0.5.0)
- **Agent owner team access**: Agent owners and their team members get full manage access automatically — no explicit admin grant required. (0.5.34)
- **MCP permissions panel**: Each MCP server shows which teams and users have access, with grant management inline. (0.5.18)
- **Deep links**: Agent, MCP server, and LLM model editors are URL-backed and shareable. (0.5.52)

---

## Fine-Grained Authorization

Every access decision — agents, knowledge bases, MCP tools, workflows, credentials — flows through a single authorization service backed by [OpenFGA](https://openfga.dev/) and Keycloak. (0.5.0)

### What's enforced

| Resource | Gate |
|----------|------|
| Agents | Team ownership + explicit shares |
| Knowledge Bases | Per-KB team shares + per-document ACLs at RAG retrieval |
| MCP Tools | First-class `mcp_tool` OpenFGA type |
| Skills | Team shares via Skill Builder |
| Workflows | Team-scoped ownership and run access |
| Credentials | Caller-keyed OAuth enforcement |

### Centralized Authorization Service (CAS) (0.5.12)

A dedicated CAS component makes permission checks faster and more consistent across agents, workflows, and MCP tools — one decision, same result everywhere.

### OpenFGA as source of truth (0.5.27)

Team resource access is read exclusively from OpenFGA. The admin team UI shows only what FGA knows, removing local-state drift.

### Access explorer and RBAC self-check (0.5.27)

- **Access explorer**: Browse effective permissions by user, team, and resource — no need to read raw FGA tuples.
- **RBAC self-check**: Runs a suite of authorization checks and reports pass/fail — diagnose why a user can't reach a resource in seconds.

### Identity and directory sync

- **Okta directory sync** (0.5.10): Full SDK-based group sync with JIT user provisioning. Map Okta groups to CAIPE teams from Admin → Identity Group Sync → Okta. Large-org syncs are parallelized and resilient to invalid names, already-linked identities, and event-loop stalls. (0.5.48/0.5.49/0.5.51)
- **Baseline access bootstrapped at sync**: Directory-synced users get the baseline OpenFGA grants needed to pass the AgentGateway ext_authz gate before their first interactive login. (0.5.51)
- **Stale grants cleaned up**: Deleted users and teams have their OpenFGA grants removed automatically. (0.5.27)

### Admin experience

- **Team-scoped admin views for non-admins** (0.5.15): Non-admin team members can see users, teams, stats, and feedback scoped to their own teams. Team members can also manage their team's Slack/Webex integrations.
- **Team-based user access view** (0.5.22): Replaces raw FGA tuple management with a team-centric view of who can reach what.
- **Policy manifest download** (0.5.15): Download the full authorization policy as YAML for audits and version control.

The entire stack ships **disabled by default**. Enable with:

```yaml
tags:
  keycloak: true
openfga:
  enabled: true
openfgaAuthzBridge:
  enabled: true
global:
  agentgateway:
    enabled: true
```

---

## Webex Bot

A full Webex bot ships as a first-class platform component alongside the Slack bot. (0.5.0)

- **Space-to-agent routing**: Webex spaces onboard to an agent and team from the Integrations tab — no admin involvement required for team members. (0.5.20)
- **Bulk onboarding**: Admins assign multiple spaces to agents in one step. (0.5.20)
- **Markdown support**: The bot renders rich markdown agent responses natively. (0.5.39)
- **Run As identity**: Spaces can be configured to send messages as a named service account for a consistent, auditable identity. (0.5.13)
- **Webex MCP auth**: The Webex MCP server forwards the provider token correctly so tool calls authenticate with the bot's Webex API token. (0.5.45)
- **Prometheus metrics**: Bot activity is exposed for scraping out of the box. (0.5.0)

Enable with `tags.webex-bot: true`.

---

## Service Accounts (0.5.13)

Teams can create non-personal bot identities for external systems and automation:

- Team-owned, scoped to selected agents and tools
- Carry their own credentials into tool calls
- One-time credential generation with rotation/revoke flows
- Caller-keyed tool authorization at the AgentGateway layer
- Slack channels can be set to "Run As" a service account for consistent bot-operated channel identity

---

## Platform Health and Observability

- **Per-dependency health view** (0.5.20): Platform Health probes each dependency — MongoDB, Keycloak, RAG, Webex, and others — independently. Failing items link directly to the recommended fix.
- **Profile-aware capabilities** (0.5.25): Health probes are now structured as named capabilities tied to the deployment profile. Integrations not in the active profile show as "not applicable" rather than failing.
- **Audit log retention controls** (0.5.27): Configure S3 lifecycle rules, view current storage usage, and tune log verbosity per event type from the platform admin panel.
- **Prometheus metrics**: Keycloak management metrics (0.5.34), OpenFGA metrics (0.5.35), and AgentGateway metrics (0.5.35) are all scrapeable with dedicated ServiceMonitors.

---

## AgentGateway MCP Routing — No CRDs Required

MCP traffic is proxied through AgentGateway in CRD-free static routing mode by default:

- One `/mcp/<id>` route per agent rendered automatically from Helm
- A built-in `/mcp/knowledge-base` route for the RAG server
- Dynamic route updates via config-bridge sidecar — no pod restarts
- Optional per-call JWT validation and OpenFGA ext_authz enforcement

```yaml
global:
  agentgateway:
    enabled: true
    # routingMode: static  (default — no CRDs required)
    # routingMode: gateway-api  (opt-in — requires CRDs + controller)
```

---

## Self-Service Channel Onboarding (0.5.20)

Team members can grant their own Slack or Webex channel access directly from the Integrations tab — no platform admin required. Admins get a bulk onboarding flow to connect multiple channels in a single step.

New channel onboardings default to **mention-only** listen mode (0.5.49) — the bot responds only when @mentioned, not to every message.

---

## Security Hardening

- Keycloak client secrets for service-account clients rotate on every `helm install`/`upgrade`. `keycloak.strictClientSecrets` fails the install if dev placeholders are in use. (0.5.0)
- MongoDB strict-password gate: `mongodb.auth.strictPasswords: true` fails fast on placeholder `rootPassword` values. (0.5.0)
- SSRF protection in RAG web ingestors — non-public start and redirect URLs are blocked. (0.5.2)
- HMAC-SHA256 for catalog API keys (0.5.8) — keys stored at rest use HMAC-SHA256. Existing keys minted before 0.5.8 must be rotated.
- NoSQL injection fix in the GridFS store (0.5.48).
- Session silent-refresh tolerance — users are no longer forced out on transient refresh failures. (0.5.52)

---

## Is This a Breaking Upgrade from 0.4.x?

**For most deployments: no.** Stock 0.4.18 `values.yaml` is a drop-in upgrade. Keycloak, OpenFGA, and the Webex bot are all opt-in. The only behavioral notes:

| Change | Impact | Action |
|--------|--------|--------|
| `active_team` JWT claim removed | Only matters if external code read this claim | None — claim was never issued in 0.4.x |
| AgentGateway `routingMode` defaults to `static` (0.5.3) | Only if you had `agentgateway.enabled: true` with CRD-based routing | Set `routingMode: gateway-api` explicitly |
| Catalog API key hash changed to HMAC-SHA256 (0.5.8) | Keys minted before 0.5.8 fail verification | Revoke old keys and mint new ones after upgrade |
| Legacy supervisor and A2A agents removed (0.5.22) | Drop the now-no-op values entries | Remove `supervisor.*` and `a2a-agents.*` from `values.yaml` |
| New channel onboardings default to mention-only (0.5.49) | Bot no longer responds to all messages in newly connected channels | Set `listen: "all"` explicitly to restore previous behavior |

---

## Upgrade

Use the Helm command and upgrade guide in the [0.5.0 release notes](/releases/release-0.5.0),
which cover breaking changes, values changes, and data migrations for the whole series.

---

*This post is a feature tour of the 0.5 series. For the current release, see the
[releases page](/releases).*
