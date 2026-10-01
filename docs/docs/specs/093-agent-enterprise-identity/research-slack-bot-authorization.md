# Slack Bot Authorization Architecture

**Pulled from [PR #975](https://github.com/caipe-io/ai-platform-engineering/pull/975) for spec 093 (`093-agent-enterprise-identity`).**

This document provides a visual reference for the end-to-end authorization flow when a user interacts with CAIPE through Slack. It covers the trust chain from Okta enterprise SSO through Slack, Keycloak token exchange, CAIPE orchestration, and user scope validation at every boundary.

For the full design rationale and implementation details, see [Enterprise Identity Federation](./research-enterprise-identity-federation.md).

---

## Authorization Topology

The following diagram shows every actor in the authorization chain, the trust relationships between them, and what credentials or tokens flow across each boundary.

```mermaid
graph LR
    subgraph IDP["Enterprise IdP"]
        OKTA["Okta<br/>(Source of Truth)<br/>─────────────<br/>• SAML/OIDC IdP<br/>• Groups & Attributes<br/>• MFA Enforcement"]
    end

    subgraph SLACK_PLATFORM["Slack App (Client)"]
        SLACK_APP["Slack Workspace<br/>─────────────<br/>• User sends @mention<br/>• SAML SP (via Okta)<br/>• Delivers events to bot<br/>• Renders bot responses"]
    end

    subgraph BOT_BACKEND["Slack Bot Backend Server"]
        BOT["Bot Server<br/>(Confidential Client)<br/>─────────────<br/>• WebSocket listener<br/>• Extracts slack_user_id<br/>• Token exchange with KC<br/>• Forwards user token"]
    end

    subgraph IDENTITY["Identity Broker"]
        KC["Keycloak<br/>─────────────<br/>• OIDC IdP Broker (Okta)<br/>• RFC 8693 Token Exchange<br/>• OBO Scope Narrowing<br/>• Broker Token Store"]
    end

    subgraph CAIPE["CAIPE Agent Platform"]
        ORCH["Orchestrator<br/>(A2A Server)<br/>─────────────<br/>• Parses intent & routes<br/>• OBO exchange per agent<br/>• Scope narrowing"]
        AGENTS["Domain Agents<br/>─────────────<br/>• GitHub / Jira / ArgoCD<br/>• Retrieves service token<br/>• Calls downstream APIs"]
    end

    subgraph DS_SVC["Downstream Services"]
        DS["GitHub · Jira · ArgoCD<br/>PagerDuty · K8s"]
    end

    OKTA ==>|"① SAML SSO<br/>(user login)"| SLACK_APP
    OKTA ==>|"② OIDC Broker<br/>(groups, attributes)"| KC
    SLACK_APP ==>|"③ WebSocket<br/>(Slack Socket Mode)<br/>user_id, message"| BOT
    BOT ==>|"④ Token Exchange<br/>(RFC 8693 / HTTPS)"| KC
    KC ==>|"⑤ Scoped User Token<br/>(JWT + groups)"| BOT
    BOT ==>|"⑥ A2A Protocol<br/>(message/stream)<br/>user token + request"| ORCH
    ORCH ==>|"⑦ OBO Exchange<br/>(HTTPS)"| KC
    KC ==>|"⑧ Agent Token<br/>(min scope, short TTL)"| ORCH
    ORCH ==>|"⑨ A2A / direct<br/>narrowed token + task"| AGENTS
    AGENTS ==>|"⑩ Token Exchange<br/>(HTTPS)"| KC
    KC ==>|"⑪ External Token<br/>(e.g. ghp_xxx)"| AGENTS
    AGENTS ==>|"⑫ API Call<br/>(as user)"| DS

    style OKTA fill:#007DC1,color:#fff,stroke:#005a8c
    style KC fill:#4A90D9,color:#fff,stroke:#2d6da3
    style BOT fill:#E67E22,color:#fff,stroke:#bf6516
    style ORCH fill:#2ECC71,color:#fff,stroke:#1a9c54
    style AGENTS fill:#9B59B6,color:#fff,stroke:#7d3c98
    style SLACK_APP fill:#611f69,color:#fff,stroke:#4a154b
    style DS fill:#34495E,color:#fff,stroke:#2c3e50
```

### Trust Boundaries

| Boundary | Protocol | Trust Mechanism | What Crosses |
|---|---|---|---|
| Okta → Slack App | SAML 2.0 / OIDC | SAML assertion | Authenticated user session |
| Okta → Keycloak | OIDC | Signed tokens | `id_token`, groups, email |
| Slack App → Bot Backend | **WebSocket** (Socket Mode) | Slack-signed payloads (HMAC-SHA256) | `user_id`, `team_id`, message |
| Bot Backend → Keycloak | HTTPS | Client credentials + signed JWT assertion | `slack_user_id` claim |
| Keycloak → Bot Backend | HTTPS | Signed Keycloak access token | `sub`, `groups`, `scope`, `act` |
| Bot Backend → Orchestrator | **A2A Protocol** (`message/stream`) | Bearer token (user JWT) | User token + request payload |
| Orchestrator → Keycloak | HTTPS | OBO token exchange | Parent token + requested scope |
| Orchestrator → Agents | A2A / internal | Narrowed token + task payload | Scoped JWT + task context |
| Agent → Keycloak | HTTPS | Token exchange (`requested_issuer`) | Narrowed token → external token |
| Agent → Downstream | HTTPS | Provider-specific auth (OAuth, API key, JWT) | User's own credentials |

---

## Pre-Authorization: User Identity Binding

Before any runtime authorization can happen, the user must complete a **one-time identity binding** that links their Slack identity to a Keycloak account (backed by Okta SSO). This is analogous to how Deno apps pre-authorize with Keycloak — the user proves who they are once, and all subsequent interactions are frictionless.

This step creates a permanent mapping: `slack_user_id ↔ keycloak_sub ↔ okta_uid`.

```mermaid
sequenceDiagram
    autonumber
    participant U as 👤 User
    participant SA as Slack App<br/>(Workspace)
    participant SB as Slack Bot Backend<br/>(WebSocket listener)
    participant KC as Keycloak<br/>(Identity Broker)
    participant OK as Okta<br/>(Enterprise IdP)

    Note over U,OK: ── Pre-Authorization: One-Time Identity Binding ──

    U->>SA: First @caipe message
    SA->>SB: WebSocket event<br/>(user_id=U12345, no KC identity linked)

    SB->>SB: Check Keycloak:<br/>Is U12345 bound to a KC account?
    Note over SB: Not found → trigger binding flow

    SB->>SA: Post Slack message with button:<br/>"To use CAIPE, verify your identity"
    SA->>U: Display "Connect Identity" button

    Note over U,OK: User clicks button → browser opens

    U->>KC: Browser → /auth/realms/caipe/broker/enterprise-idp/link<br/>(includes state: slack_user_id=U12345)
    KC->>OK: OIDC redirect → Okta authorization
    OK->>U: Okta login page<br/>(SSO / MFA if required)
    U->>OK: Authenticate (password + MFA)
    OK->>KC: OIDC callback<br/>(id_token with sub, email, groups)

    Note over KC: Keycloak creates identity binding:<br/>┌─────────────────────────────────────┐<br/>│ slack_user_id: U12345               │<br/>│ keycloak_sub: kc-uuid-abc123        │<br/>│ okta_uid: okta-uid-xyz789           │<br/>│ email: user@example.com             │<br/>│ groups: [sre-team, caipe-admins]    │<br/>└─────────────────────────────────────┘

    KC->>SB: Auth code callback (redirect)
    SB->>KC: Exchange code → tokens<br/>(validates binding succeeded)

    SB->>SA: Post Slack message:<br/>"Identity verified as user@example.com"
    SA->>U: Display confirmation

    Note over U,OK: ── Binding is permanent until revoked ──<br/>All future @caipe interactions skip this step
```

### What the Binding Enables

Once bound, the Bot Backend can perform **RFC 8693 token exchanges** on every subsequent interaction without any user involvement:

```mermaid
graph LR
    subgraph BEFORE["Before Binding"]
        B1["slack_user_id: U12345<br/>──────────<br/>No Keycloak identity<br/>No token exchange possible<br/>Bot cannot act on behalf of user"]
    end

    subgraph BINDING["One-Time Binding"]
        B2["User authenticates via Okta<br/>──────────<br/>Keycloak creates mapping:<br/>U12345 ↔ kc-sub ↔ okta-uid<br/>Imports Okta groups"]
    end

    subgraph AFTER["After Binding (every request)"]
        B3["Bot sends: slack_user_id=U12345<br/>──────────<br/>Keycloak resolves to user@example.com<br/>Mints scoped JWT with groups<br/>No user interaction needed"]
    end

    BEFORE -->|"User clicks<br/>Connect Identity"| BINDING
    BINDING -->|"Frictionless<br/>from now on"| AFTER

    style BEFORE fill:#e74c3c,color:#fff,stroke:#c0392b
    style BINDING fill:#f39c12,color:#fff,stroke:#d68910
    style AFTER fill:#2ecc71,color:#fff,stroke:#27ae60
```

### Service Connector Pre-Authorization

Beyond identity binding, users can also **pre-authorize downstream service connectors** (GitHub, Jira, PagerDuty, etc.) through the CAIPE UI Connections page or via Slack commands. Each connector follows a similar one-time OAuth consent pattern:

```mermaid
graph LR
    subgraph CONNECTORS["Pre-Authorized Service Connectors"]
        C_ID["Identity Binding<br/>(required)<br/>──────────<br/>Slack ↔ Keycloak ↔ Okta<br/>OIDC consent flow"]
        C_GH["GitHub Connector<br/>(optional)<br/>──────────<br/>OAuth App consent<br/>Scopes: repo, read:org<br/>Token stored in KC"]
        C_JIRA["Jira Connector<br/>(optional)<br/>──────────<br/>OAuth 2.0 3LO consent<br/>Scopes: read/write jira-work<br/>Token + refresh in KC"]
        C_ARGO["ArgoCD<br/>(automatic)<br/>──────────<br/>OIDC passthrough<br/>No separate consent<br/>Uses Keycloak JWT directly"]
        C_PD["PagerDuty<br/>(optional)<br/>──────────<br/>User enters API key<br/>Stored encrypted in KC"]
    end

    C_ID --> C_GH
    C_ID --> C_JIRA
    C_ID --> C_ARGO
    C_ID --> C_PD

    style C_ID fill:#e74c3c,color:#fff,stroke:#c0392b
    style C_GH fill:#2ecc71,color:#fff,stroke:#27ae60
    style C_JIRA fill:#2ecc71,color:#fff,stroke:#27ae60
    style C_ARGO fill:#3498db,color:#fff,stroke:#2980b9
    style C_PD fill:#2ecc71,color:#fff,stroke:#27ae60
```

---

## Runtime Authorization Sequence

After pre-authorization is complete, this sequence diagram traces a single user message from Slack through every authorization gate at runtime. No user interaction is required — the Bot Backend resolves identity and obtains tokens automatically.

```mermaid
sequenceDiagram
    autonumber
    participant U as 👤 User
    participant SA as Slack App<br/>(Workspace)
    participant SB as Slack Bot Backend<br/>(caipe-slack-bot)
    participant KC as Keycloak<br/>(Identity Broker)
    participant OR as CAIPE Orchestrator<br/>(A2A Server)
    participant AG as Domain Agent<br/>(e.g. GitHub Agent)
    participant DS as Downstream API<br/>(e.g. GitHub)

    Note over U,DS: ── Phase 1: Slack → Bot Backend (WebSocket / Socket Mode) ──

    U->>SA: @caipe "Review PR #42"
    SA->>SA: Resolve user identity<br/>(user_id, team_id, email)
    SA-->>SB: WebSocket (Socket Mode)<br/>(user_id=U12345, team_id=T789,<br/>text, channel, thread_ts)

    Note over SB: ✅ Validate Slack request signature<br/>(HMAC-SHA256 of payload)

    Note over U,DS: ── Phase 2: Identity Resolution via Pre-Authorized Binding ──

    SB->>SB: Lookup pre-authorized binding:<br/>U12345 → keycloak identity

    Note over SB: User was pre-authorized<br/>(identity binding already exists)

    Note over SB,KC: RFC 8693 Token Exchange (HTTPS)

    SB->>KC: POST /token<br/>grant_type=token-exchange<br/>client_id=caipe-slack-bot<br/>client_secret=***<br/>subject_token=signed_jwt{slack_user_id:U12345}<br/>audience=caipe-backend

    Note over KC: ✅ Scope Validation Gate 1:<br/>• Verify bot client credentials<br/>• Validate signed assertion (exp, iss)<br/>• Resolve binding: U12345 → user@example.com<br/>• Load Okta groups (via federation)<br/>• Check: user has required realm roles<br/>• Mint token with allowed scopes only

    KC->>SB: Access Token (JWT)<br/>{sub: "user@example.com",<br/> groups: ["sre-team"],<br/> scope: "github jira argocd",<br/> act: {sub: "caipe-slack-bot"},<br/> exp: +30min}

    Note over U,DS: ── Phase 3: Bot Backend → CAIPE (A2A Protocol) ──

    SB->>OR: A2A message/stream (HTTP)<br/>Authorization: Bearer <user_jwt><br/>{"message": "Review PR #42"}

    Note over OR: Parse intent → requires:<br/>• github-pr-reader (github:repo:read)<br/>• github-pr-commenter (github:pr:write)

    OR->>KC: POST /token (OBO)<br/>subject_token=user_token<br/>client_id=caipe-github-agent<br/>scope=github:repo:read github:pr:write<br/>audience=caipe-github-agent

    Note over KC: ✅ Scope Validation Gate 2:<br/>• Verify agent client credentials<br/>• Validate parent token (not expired)<br/>• Check: requested ⊆ parent scope<br/>  (github:repo:read ⊆ "github")? ✅<br/>• Check: agent allowed these scopes? ✅<br/>• Narrow scope (never widen)<br/>• Set short TTL (5 min)<br/>• Chain delegation: act.act.sub

    KC->>OR: Narrowed Agent Token (JWT)<br/>{sub: "user@example.com",<br/> scope: "github:repo:read github:pr:write",<br/> act: {sub: "caipe-github-agent",<br/>       act: {sub: "caipe-slack-bot"}},<br/> exp: +5min}

    Note over U,DS: ── Phase 4: Agent Execution & Service Token Retrieval ──

    OR->>AG: Execute task + narrowed token

    AG->>KC: POST /token<br/>subject_token=narrowed_token<br/>requested_issuer=github

    Note over KC: ✅ Scope Validation Gate 3:<br/>• Validate narrowed token<br/>• Check: agent authorized for github?<br/>• Retrieve pre-authorized GitHub OAuth<br/>  token for user@example.com<br/>• Verify: stored token not revoked

    KC->>AG: GitHub OAuth Token (ghp_xxx)

    AG->>DS: GET /repos/cnoe-io/caipe/pulls/42<br/>Authorization: Bearer ghp_xxx

    Note over DS: ✅ Scope Validation Gate 4:<br/>• GitHub validates OAuth token<br/>• Check: token has 'repo' scope<br/>• Check: user has repo access<br/>• Return data scoped to user's perms

    DS->>AG: PR #42 data (as user)
    AG->>OR: Results

    Note over U,DS: ── Phase 5: Response Delivery (A2A → WebSocket) ──

    OR-->>SB: A2A streaming response (HTTP SSE)
    SB->>SA: Post message via Slack API<br/>(formatted blocks + feedback buttons)
    SA->>U: "PR #42: 3 files changed, LGTM"
```

---

## Scope Validation Gates

Every authorization boundary enforces scope validation. This flowchart shows the decision logic at each gate and what happens when validation fails.

```mermaid
flowchart LR
    START([Slack App<br/>delivers event]) --> G1

    subgraph G1["Gate 1: Bot Backend → Keycloak<br/>(Token Exchange)"]
        direction TB
        G1_1{Bot client<br/>credentials valid?}
        G1_2{Signed JWT<br/>assertion valid?<br/>(exp, iss, sig)}
        G1_3{slack_user_id<br/>linked in KC?}
        G1_4{User has<br/>required realm<br/>roles?}
        G1_5[Mint scoped token<br/>with Okta groups]

        G1_1 -->|Yes| G1_2
        G1_1 -->|No| G1_F1[/"401: Invalid client"/]
        G1_2 -->|Yes| G1_3
        G1_2 -->|No| G1_F2[/"400: Invalid assertion"/]
        G1_3 -->|Yes| G1_4
        G1_3 -->|No| G1_F3[/"Trigger identity<br/>linking flow"/]
        G1_4 -->|Yes| G1_5
        G1_4 -->|No| G1_F4[/"403: Insufficient<br/>realm roles"/]
    end

    G1_5 --> G2

    subgraph G2["Gate 2: Orchestrator → Keycloak<br/>(OBO / Scope Narrowing)"]
        direction TB
        G2_1{Agent client<br/>credentials valid?}
        G2_2{Parent token<br/>valid & not<br/>expired?}
        G2_3{Requested scope<br/>⊆ parent scope?}
        G2_4{Agent allowed<br/>these scopes<br/>in KC policy?}
        G2_5[Mint narrowed token<br/>TTL ≤ 5 min]

        G2_1 -->|Yes| G2_2
        G2_1 -->|No| G2_F1[/"401: Invalid<br/>agent client"/]
        G2_2 -->|Yes| G2_3
        G2_2 -->|No| G2_F2[/"401: Token expired,<br/>re-exchange needed"/]
        G2_3 -->|Yes| G2_4
        G2_3 -->|No| G2_F3[/"403: Scope escalation<br/>denied (never widen)"/]
        G2_4 -->|Yes| G2_5
        G2_4 -->|No| G2_F4[/"403: Agent not<br/>authorized for scope"/]
    end

    G2_5 --> G3

    subgraph G3["Gate 3: Agent → Keycloak<br/>(External Token Retrieval)"]
        direction TB
        G3_1{Narrowed token<br/>valid?}
        G3_2{Agent authorized<br/>for requested_issuer?}
        G3_3{User has stored<br/>token for service?}
        G3_4{Stored token<br/>valid / refreshable?}
        G3_5[Return external<br/>service token]

        G3_1 -->|Yes| G3_2
        G3_1 -->|No| G3_F1[/"401: Token<br/>invalid"/]
        G3_2 -->|Yes| G3_3
        G3_2 -->|No| G3_F2[/"403: Agent cannot<br/>access this issuer"/]
        G3_3 -->|Yes| G3_4
        G3_3 -->|No| G3_F3[/"Prompt user to<br/>connect service"/]
        G3_4 -->|Yes| G3_5
        G3_4 -->|No| G3_F4[/"Trigger re-consent<br/>(refresh expired)"/]
    end

    G3_5 --> G4

    subgraph G4["Gate 4: Downstream Service<br/>(Provider Validation)"]
        direction TB
        G4_1{Token / API key<br/>valid?}
        G4_2{User has access<br/>to resource?}
        G4_3[Return data<br/>scoped to user perms]

        G4_1 -->|Yes| G4_2
        G4_1 -->|No| G4_F1[/"401: Revoked or<br/>expired upstream"/]
        G4_2 -->|Yes| G4_3
        G4_2 -->|No| G4_F2[/"403: User lacks<br/>provider-level access"/]
    end

    G4_3 --> DONE([Result returned<br/>via Slack App])

    style G1 fill:#1a3a5c,color:#fff,stroke:#0d2137
    style G2 fill:#1a5c3a,color:#fff,stroke:#0d3721
    style G3 fill:#5c3a1a,color:#fff,stroke:#37210d
    style G4 fill:#3a1a5c,color:#fff,stroke:#210d37
    style START fill:#611f69,color:#fff
    style DONE fill:#611f69,color:#fff
```

---

## Token Lifecycle & Scope Narrowing

This diagram visualizes how the token transforms as it flows through the CAIPE authorization chain — showing scope reduction, TTL shortening, and delegation chain growth at each hop.

```mermaid
graph LR
    subgraph T1["① Slack Event"]
        S1["No token<br/>─────────────<br/>Identifiers only:<br/>• slack_user_id: U12345<br/>• team_id: T789<br/>• email: user@example.com"]
    end

    subgraph T2["② Keycloak User Token"]
        S2["Full-scope JWT<br/>─────────────<br/>sub: user@example.com<br/>scope: github jira argocd pagerduty<br/>groups: [sre-team, caipe-admins]<br/>act: {sub: caipe-slack-bot}<br/>TTL: 30 min"]
    end

    subgraph T3["③ Agent Token (OBO)"]
        S3["Narrowed JWT<br/>─────────────<br/>sub: user@example.com<br/>scope: github:repo:read github:pr:write<br/>groups: [sre-team]<br/>act: {sub: caipe-github-agent,<br/>      act: {sub: caipe-slack-bot}}<br/>TTL: 5 min"]
    end

    subgraph T4["④ Service Token"]
        S4["External credential<br/>─────────────<br/>GitHub OAuth: ghp_xxx<br/>Scopes: repo, read:org<br/>Issued to: user@example.com<br/>TTL: until revoked"]
    end

    T1 -->|"Token Exchange<br/>(RFC 8693)"| T2
    T2 -->|"OBO Exchange<br/>(scope narrowing)"| T3
    T3 -->|"requested_issuer<br/>(stored token retrieval)"| T4

    style T1 fill:#95a5a6,color:#fff,stroke:#7f8c8d
    style T2 fill:#e74c3c,color:#fff,stroke:#c0392b
    style T3 fill:#f39c12,color:#fff,stroke:#d68910
    style T4 fill:#2ecc71,color:#fff,stroke:#27ae60
```

### Scope Reduction Guarantee

```
User Token scope:     github  jira  argocd  pagerduty    (4 services)
                         ↓
GitHub Agent scope:   github:repo:read  github:pr:write   (2 fine-grained)
                         ↓
Service Token:        repo  read:org                       (GitHub-native scopes)
```

At every exchange, Keycloak enforces: **requested scope ⊆ parent scope**. Scope can only narrow, never widen. An agent that holds `github:repo:read` cannot request `github:repo:write` — the exchange fails with 403.

---

## Multi-Agent Scope Isolation

When the orchestrator routes a user request to multiple agents, each agent receives an independently scoped token. A compromised agent token cannot access services beyond its granted scope.

```mermaid
graph LR
    subgraph CLIENT["Slack App"]
        USER["User Message"]
    end

    subgraph BOT["Bot Backend Server"]
        BOT_SVC["Slack Bot Backend<br/>──────────<br/>Token Exchange<br/>→ User Token"]
    end

    ORCH["Orchestrator<br/>──────────<br/>A2A Server<br/>OBO per agent"]

    subgraph AGENTS["Isolated Agent Tokens"]
        GH_TOKEN["GitHub Agent<br/>──────────<br/>scope: github:repo:read<br/>         github:pr:write<br/>TTL: 5 min<br/>Cannot access: Jira ✗ ArgoCD ✗"]

        JIRA_TOKEN["Jira Agent<br/>──────────<br/>scope: jira:comment:write<br/>TTL: 5 min<br/>Cannot access: GitHub ✗ ArgoCD ✗"]

        ARGO_TOKEN["ArgoCD Agent<br/>──────────<br/>scope: argocd:app:get<br/>TTL: 5 min<br/>Cannot access: GitHub ✗ Jira ✗"]

        PD_TOKEN["PagerDuty Agent<br/>──────────<br/>scope: pagerduty:incidents:read<br/>TTL: 3 min<br/>Cannot access: GitHub ✗ Jira ✗"]
    end

    subgraph DS["Downstream Services"]
        GH_API["GitHub API"]
        JIRA_API["Jira API"]
        ARGO_API["ArgoCD"]
        PD_API["PagerDuty API"]
    end

    USER -->|"WebSocket<br/>(Socket Mode)"| BOT_SVC
    BOT_SVC -->|"A2A Protocol<br/>(message/stream)"| ORCH
    ORCH -->|"OBO: scope=github:*"| GH_TOKEN
    ORCH -->|"OBO: scope=jira:*"| JIRA_TOKEN
    ORCH -->|"OBO: scope=argocd:*"| ARGO_TOKEN
    ORCH -->|"OBO: scope=pagerduty:*"| PD_TOKEN

    GH_TOKEN -->|"ghp_xxx"| GH_API
    JIRA_TOKEN -->|"atlassian_xxx"| JIRA_API
    ARGO_TOKEN -->|"Keycloak JWT<br/>(OIDC passthrough)"| ARGO_API
    PD_TOKEN -->|"pd_api_key"| PD_API

    style USER fill:#611f69,color:#fff,stroke:#4a154b
    style BOT_SVC fill:#E67E22,color:#fff,stroke:#bf6516
    style ORCH fill:#f39c12,color:#fff,stroke:#d68910
    style GH_TOKEN fill:#2ecc71,color:#fff,stroke:#27ae60
    style JIRA_TOKEN fill:#2ecc71,color:#fff,stroke:#27ae60
    style ARGO_TOKEN fill:#2ecc71,color:#fff,stroke:#27ae60
    style PD_TOKEN fill:#2ecc71,color:#fff,stroke:#27ae60
    style GH_API fill:#34495e,color:#fff,stroke:#2c3e50
    style JIRA_API fill:#34495e,color:#fff,stroke:#2c3e50
    style ARGO_API fill:#34495e,color:#fff,stroke:#2c3e50
    style PD_API fill:#34495e,color:#fff,stroke:#2c3e50
```

---

## JWT Delegation Chain (Audit Trail)

The `act` (actor) claim in each JWT records the full delegation chain, providing a complete audit trail from the original user through every intermediary.

```mermaid
graph LR
    subgraph "User Token (issued at Gate 1)"
        J1["act: {<br/>  sub: caipe-slack-bot<br/>}"]
    end

    subgraph "Agent Token (issued at Gate 2)"
        J2["act: {<br/>  sub: caipe-github-agent,<br/>  act: {<br/>    sub: caipe-slack-bot<br/>  }<br/>}"]
    end

    subgraph "Audit Log Entry"
        J3["who: user@example.com<br/>what: GET /repos/.../pulls/42<br/>via: caipe-github-agent<br/>  → caipe-slack-bot<br/>  → user@example.com<br/>when: 2026-03-16T10:30:00Z<br/>scope: github:repo:read"]
    end

    J1 -->|"OBO exchange<br/>adds layer"| J2
    J2 -->|"Logged at<br/>downstream call"| J3

    style J1 fill:#e74c3c,color:#fff,stroke:#c0392b
    style J2 fill:#f39c12,color:#fff,stroke:#d68910
    style J3 fill:#2ecc71,color:#fff,stroke:#27ae60
```

Every action taken by a CAIPE agent is attributable to the human user who initiated it. The delegation chain is embedded in the JWT and logged at every boundary for forensic traceability.

---

## Error Handling & Recovery Flows

When authorization fails at any gate, the system responds with specific recovery actions rather than generic errors.

```mermaid
flowchart LR
    subgraph "Failure Scenarios"
        F1["Identity not linked<br/>(Gate 1)"]
        F2["Scope escalation<br/>(Gate 2)"]
        F3["Service not connected<br/>(Gate 3)"]
        F4["Token revoked upstream<br/>(Gate 4)"]
    end

    subgraph "Bot Backend Recovery"
        R1["Bot Backend → Slack App:<br/>'Click to verify identity'<br/>→ OIDC consent flow"]
        R2["Log + reject request<br/>Alert: possible misconfigured<br/>agent scope declaration"]
        R3["Bot Backend → Slack App:<br/>'Connect GitHub to proceed'<br/>→ Deep link to /connections"]
        R4["Bot Backend → Slack App:<br/>'Re-authorize GitHub'<br/>→ Re-consent flow via UI"]
    end

    F1 --> R1
    F2 --> R2
    F3 --> R3
    F4 --> R4

    style F1 fill:#e74c3c,color:#fff
    style F2 fill:#e74c3c,color:#fff
    style F3 fill:#e74c3c,color:#fff
    style F4 fill:#e74c3c,color:#fff
    style R1 fill:#3498db,color:#fff
    style R2 fill:#e67e22,color:#fff
    style R3 fill:#3498db,color:#fff
    style R4 fill:#3498db,color:#fff
```

---

## Related Documentation

- [Enterprise Identity Federation](./research-enterprise-identity-federation.md) — full design, Keycloak configuration, CRD definitions, and implementation code
- A2A Authentication — bot-to-supervisor OAuth2 client credentials setup (removed with the legacy supervisor)
- [Slack Bot Integration](../../integrations/slack-bot.md) — deployment, configuration, and channel setup (main repo)
- [CAIPE UI Auth Flow](../../security/auth-flow.md) — browser-based OIDC authentication for the web UI (main repo)
