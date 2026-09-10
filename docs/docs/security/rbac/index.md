# CAIPE RBAC

**Audience:** Junior engineers getting oriented + security architects reviewing the design.

This is the canonical reference for how authentication and authorization work in CAIPE. Start with the feature guide if you need one linear explanation, then use the focused docs for deeper reference:

| If you want to… | Read |
|---|---|
| Explain the feature front to back to CAIPE users, admins, operators, or security reviewers | [Enterprise RBAC and ReBAC Feature Guide](./feature-guide.md) |
| Understand each component (Keycloak, UI, AgentGateway, Dynamic Agents) and how they're wired | [Architecture](./architecture.md) |
| Get the short end-to-end summary of the Comprehensive RBAC refactor, including Keycloak roles, AgentGateway, and OpenFGA | [Comprehensive RBAC Refactor](./comprehensive-rbac-refactor.md) |
| Understand how JWT identity and OpenFGA relationship checks work together | [JWT and OpenFGA](./jwt-and-openfga.md) |
| Understand exactly where OpenFGA union/computed permissions are evaluated, what gets stored vs. computed, and follow a worked end-to-end Probe-button example | [OpenFGA Permission Evaluation](./openfga-permission-evaluation.md) |
| See which authorization decisions and relationship mutations still bypass CAS, why, and in what order to migrate them | [CAS Coverage and Migration Gaps](./cas-coverage-gaps.md) |
| Trace a request — login, OBO token-exchange, end-to-end Slack/Webex flow, Slack channel or Webex space → agent routing | [Workflows](./workflows.md) |
| Log in, exercise a role, verify a denial, link a Slack/Webex user, run the demo | [Usage](./usage.md) |
| Find the file that owns a specific piece of the auth path | [File map](./file-map.md) |
| Understand the difference between Keycloak **roles** and **client scopes**, what a slug is, and what happens when you create a team | [Roles vs Scopes](./roles-scopes-comparison.md) |
| Install or upgrade the RBAC/OpenFGA refactor with Helm, including optional Keycloak, AgentGateway, OpenFGA, and bridge runtime components | [Helm installation and upgrade guide](./helm-install-upgrade.md) |
| **Install CAIPE on a real K8s cluster** — bootstrap admin, IdP, and slack-bot client secrets via dev defaults, manual K8s Secrets, or ESO (Vault / AWS-SM / GCP-SM) | [Secrets bootstrap](./secrets-bootstrap.md) |
| Understand the audit log backend options (local vs S3), benchmark numbers, and the OpenFGA N+1 fix on `admin-tab-gates` | [Audit Log Performance](./audit-log-performance.md) |

For the live `caipe/rbac` GitOps upgrade, see
[CAIPE RBAC Helm Migration Guide](./caipe-rbac-migration.md).

Every component-level doc opens with a **badge analogy** to build intuition, followed by the precise technical detail. Read the analogy first, then the technical section — they describe the same thing at different levels of abstraction.

---

## The Big Picture

Think of CAIPE like a **secure corporate office building**:

- **Keycloak** is HR + the front desk. It issues ID badges, manages who works here, and verifies contractors through a partner agency (your enterprise IdP — typically **Okta** or **Duo SSO**).
- **Every service** is a room with its own badge reader. You prove who you are once at the front desk, get a badge, and that badge is checked at every door — no calling HR again each time.
- **AgentGateway** is the armed security checkpoint between the office and the server room. Everyone must show their badge, and the checkpoint calls **OpenFGA** through `ext_authz` for the PDP decision before proxying.
- **Team Resources** and **OpenFGA ReBAC** in the Admin UI are the rich ReBAC authoring surfaces: admins assign agents and MCP tool prefixes to a team, preview effective OpenFGA access, inspect all relationships in a full-screen graph, edit relationships on a drag/drop graph canvas, and inspect materialized tuples.
- **CEL policy editing is retired** for the management plane. Admins use OpenFGA/ReBAC relationships instead of editing AgentGateway or admin-tab CEL rules.
- **Identity Group Sync** maps enterprise groups into CAIPE team memberships using a hybrid source model: `memberOf` / `groups` claims refresh the signed-in user's memberships at login, while direct Okta directory queries power full admin dry-runs, removals, and drift detection.
- **Slack channels and Webex spaces** are external messaging rooms. They are not identity providers; each bot maps the messaging surface to a Keycloak user, exchanges an OBO token, and checks OpenFGA before dispatching.
- **The badge itself** is a JWT — a tamper-proof, digitally signed card that any badge reader can verify independently without phoning HR.

Technically: CAIPE uses **OpenID Connect (OIDC)** for authentication and **JWT bearer tokens** for stateless authorization across all service boundaries. There is one token issuer (Keycloak), and every service verifies tokens against Keycloak's published JWKS public keys — no shared secrets, no per-hop re-authentication.

In `0.5.0`, the umbrella Helm chart can deploy the RBAC runtime components (`tags.keycloak`, `openfga.enabled`, `openfgaAuthzBridge.enabled`, and `agentgateway.enabled`) so release consumers do not need separate companion app manifests for the default stack.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CAIPE Trust Boundary                            │
│                                                                              │
│  ┌────────────┐    ┌──────────────┐    ┌──────────────┐                      │
│  │  Keycloak  │    │   CAIPE UI   │    │   Dynamic    │                      │
│  │  (OIDC IdP)│    │  (Next.js)   │    │   Agents     │                      │
│  │  port 7080 │    │  port 3000   │    │  port 8100   │                      │
│  └────────────┘    └──────────────┘    └──────────────┘                      │
│    Token issuer     NextAuth + RBAC     get_current_user                      │
│    JWKS endpoint    middleware          FastAPI Depends                       │
│    User profile     Session → API       JWKS validation                      │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                 AgentGateway  (Policy Enforcement Point)             │    │
│  │            port 4000 · ext_authz→OpenFGA · JWT passthrough           │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│             │                         │                                      │
│             ▼                         │                                      │
│     ┌──────────────┐                  │                                      │
│     │   OpenFGA    │                  │                                      │
│     │ Remote PDP   │                  │                                      │
│     └──────────────┘                  │                                      │
│         ┌─────────────────────────────┼──────────────────┐                   │
│         ▼                             ▼                  ▼                   │
│   ┌───────────┐                ┌───────────┐       ┌───────────┐             │
│   │  RAG MCP  │                │ ArgoCD MCP│       │GitHub MCP │  ...        │
│   │  Server   │                │  Server   │       │  Server   │             │
│   └───────────┘                └───────────┘       └───────────┘             │
│   JWKS validation at each MCP — tokens verified independently                │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Security properties the architecture is designed to guarantee:**

| Property | How it's achieved |
|----------|-------------------|
| Single source of truth for identity | Keycloak is the only token issuer; all services verify against its JWKS |
| No credentials in transit between services | JWT is a signed assertion — no password or secret is passed between hops |
| User identity preserved end-to-end | The same JWT travels Slack/Webex Bot → Dynamic Agents → AgentGateway → MCP unchanged |
| Delegation is auditable | OBO tokens carry `act.sub` (the delegating party) alongside `sub` (the real user) |
| Policy enforcement is centralised | AgentGateway is the single PEP for all MCP tool calls; tools don't implement their own authz |
| Remote PDP for relationships | AgentGateway `extAuthz` calls OpenFGA before proxying MCP traffic |
| Admin-configured ReBAC | Team Resources saves write OpenFGA `team`/`agent`/`tool` tuples from the same source of truth as Keycloak roles; OpenFGA ReBAC provides guided tuple creation, checks, full-screen all-relationship graph viewing, drag/drop graph editing, and tuple inspection |
| Group-to-team provenance | Identity Group Sync records whether a membership came from login claims, Okta sync, manual admin action, bootstrap, or policy rules |
| Least privilege at tool layer | OpenFGA ReBAC is the authoritative AgentGateway policy path; service-side checks provide defense in depth |
| Tenant isolation | `tenant` claim in JWT scopes data visible to the MCP server |

---

## Core Concept: The JWT

When you log in, Keycloak issues a **JWT (JSON Web Token)** signed with RS256 using its realm private key. It's a base64url-encoded envelope of three parts: `header.payload.signature`.

A decoded payload looks like this:

```json
{
  "iss": "http://localhost:7080/realms/caipe",
  "sub": "a3f9b2c1-...",
  "email": "alice@example.com",
  "name": "Alice Smith",
  "realm_access": {
    "roles": ["admin", "chat_user"]
  },
  "resource_access": {
    "caipe-ui": { "roles": ["uma_protection"] }
  },
  "tenant": "acme",
  "exp": 1713200000,
  "iat": 1713196400,
  "act": {
    "sub": "slack-bot-client"
  }
}
```

Key fields for security architects:

| Claim | Purpose | Where it's enforced |
|-------|---------|---------------------|
| `iss` | Token issuer — services reject tokens from unknown issuers | Dynamic agents JWKS validation, RAG server |
| `sub` | Opaque user ID (Keycloak UUID) — stable, not guessable | Conversation ownership, audit logs |
| `email` | Human-readable identity — used for display and Slack linking | UI, dynamic agents user context |
| `realm_access.roles` | Realm-level role assignments | Dynamic agents `is_admin`, Web UI backend fallback checks, service-side defense in depth |
| `exp` | Token expiry — enforced cryptographically | All JWKS validators, NextAuth refresh |
| `act.sub` | Delegation chain — set on OBO tokens only | Audit: proves bot acted on behalf of user |
| `tenant` | Multi-tenant data scoping | RAG server query isolation |

**Services never call Keycloak on each request.** They validate the signature offline using the cached JWKS public key. JWKS is refreshed on cache miss (unknown `kid`) or on a TTL (1 hour).

---

## Threat Model Considerations

| Threat | Mitigation |
|--------|-----------|
| JWT forgery | RS256 signature verified against Keycloak JWKS; private key never leaves Keycloak |
| JWT replay after expiry | `exp` claim enforced at every JWKS validation point |
| Token theft from browser | NextAuth stores tokens in httpOnly server-side session cookie; raw JWT never in JS context |
| Bot impersonating arbitrary user via OBO | Keycloak's `token-exchange` permission must be explicitly granted to the bot client; not available by default |
| Privilege escalation via claim manipulation | JWT is signed; any claim modification invalidates the RS256 signature |
| Tenant data leakage | `tenant` claim in JWT used for query scoping at MCP layer and service-side filters |
| PDP outage fail-open | AgentGateway `extAuthz.failureMode.denyWithStatus=403` fails closed if OpenFGA/bridge is unavailable |
| AgentGateway admin exposure | Only the data-plane listener (`4000`) should be ingress-exposed; the admin listener (`15000`) remains private inside the cluster |
| Unlinked Slack/Webex users bypassing RBAC | Bot runtime gates block unlinked users before any backend agent is called |
| `AUTH_ENABLED=false` in production | Startup log emits a `WARNING` when auth is disabled; also documented in [Architecture › Dynamic Agents env vars](./architecture.md#key-environment-variables-2) |
| Bootstrap admin left permanently enabled | No automatic enforcement — documented operational risk; must be removed post-setup |

---

## Where to next

- **[Architecture](./architecture.md)** — Component-by-component reference: Keycloak, UI, AgentGateway, Dynamic Agents.
- **[Workflows](./workflows.md)** — Sequence diagrams for login, OBO, end-to-end requests, Slack channel and Webex space routing.
- **[Usage](./usage.md)** — Bring up the stack, log in as test users, verify RBAC denials, run the demo.
- **[File map](./file-map.md)** — When you need to change something, this tells you which file to open.
