# Roles vs Scopes — How CAIPE RBAC Decides What You Can Do

**Audience:** Anyone who has heard the words "role" and "scope" thrown around and isn't 100% sure why we have both, or what actually happens when you click "Create team" in the admin UI.

This doc has two layers: a plain-English explanation first, then the precise technical detail. Read the analogy, then the technical section — they describe the same thing.

---

## The Plain-English Version

Imagine CAIPE is a corporate office building. To get something done you need two things at every door:

1. **A badge that lists what you're qualified to do.** You're trained to operate the espresso machine, you have first-aid certification, you're authorized to enter Lab B. These are your **roles**.
2. **A name tag that says which team you're representing right now.** You might belong to *both* the Platform team and the Security team. Today you're attending the Security team's standup, so your name tag says "Security." Tomorrow it might say "Platform." This is your **active team**, set by a **scope**.

The security guard at every door checks **both**:

> "Does your badge say you can enter Lab B?  ✅
>  And does your name tag say you're representing a team that's allowed in Lab B today?  ✅
>  OK, go in."

If you have the qualification but you're representing the wrong team — denied. If your name tag is right but you don't have the qualification — denied. You need both.

That's the whole model. The rest of this doc is just the technical mapping of those two ideas onto Keycloak.

### Why both? Why not just one?

Because qualifications and team context are different things that change at different rates.

- **Qualifications (roles)** are about *you as a person*: "Sri can use the Jira search tool." That's stable; it travels with you.
- **Team context (active team scope)** is about *which hat you're wearing right now*: "Sri is acting as a member of the Platform team in this request." That can change request-to-request, especially in Slack where the same user might post in `#platform-eng` (Platform team) and `#security-ops` (Security team) within minutes.

If we tried to bake team context into the role list ("Sri-can-use-Jira-as-Platform", "Sri-can-use-Jira-as-Security"), the role explosion would be quadratic in users × teams, and switching teams would mean rewriting your role assignments. With the scope-as-context-tag design, your roles stay constant; only the per-request `active_team` claim changes.

---

## What is a "slug"?

A **slug** is a URL-safe, lowercase, ASCII-only short identifier derived from a human-readable name. Think of it as the team's machine-readable handle.

| Human name | Slug |
|---|---|
| `Platform Engineering` | `platform-engineering` |
| `SRE — On Call` | `sre-on-call` |
| `🚀 Rocket Squad` | rejected — produces empty slug |

The rules (enforced by `isValidTeamSlug` and `deriveSlug` in `ui/src/app/api/admin/teams/route.ts`):

- Lowercase letters, digits, and hyphens only
- No leading or trailing hyphens
- Maximum 63 characters
- Must produce a non-empty result after stripping non-ASCII

We use slugs (not display names) inside Keycloak and JWT claims for three reasons:

1. **Stable identifier.** A team can be renamed in MongoDB without breaking every JWT in flight or every OpenFGA relationship tuple.
2. **Safe in URLs, headers, and identifiers.** Keycloak client scope names, role names, and JWT claim values shouldn't contain spaces or Unicode.
3. **One canonical form.** No ambiguity between "Platform Eng" / "platform-eng" / "platform engineering" — the slug is the only string the system actually uses for matching.

The display name is a UI concern; the slug is the identity.

---

## What is a Keycloak "client scope"?

In OpenID Connect, a **client** is anything that asks Keycloak for a token (CAIPE UI, Slack bot, AgentGateway). A **scope** is a *named bundle of claims* — when a client requests a token "with scope X," Keycloak attaches whatever claims scope X is configured to inject.

In stock OIDC, scopes usually look like `openid` (gives you `sub`), `email` (gives you `email`), `profile` (gives you `given_name`, `family_name`, etc.). The pattern is: **the client asks for the scope, the scope adds claims to the token**.

We use that exact mechanism for team context. We define one client scope per team:

- `team-personal` — when present, injects `active_team=__personal__` into the JWT.
- `team-platform-eng` — injects `active_team=platform-eng`.
- `team-security-ops` — injects `active_team=security-ops`.
- …one per team.

Each scope is just a Keycloak object with a single **protocol mapper** of type `oidc-hardcoded-claim-mapper` configured to write `active_team=<slug>` into the access token. The scope itself has no permission semantics — it's purely a claim-injection vehicle.

### Default vs optional client scopes

A client (e.g. `agentgateway`, `caipe-slack-bot`) can have client scopes attached two ways:

- **Default scope** — always added to every token issued for that client.
- **Optional scope** — only added when the client explicitly requests it via the `scope` parameter.

We bind `team-<slug>` scopes as **default scopes on the `CAIPE_PLATFORM_AUDIENCE` client** (`caipe-platform` by default) because Keycloak's RFC 8693 token-exchange (used in OBO — On-Behalf-Of) silently drops the `scope` request parameter. The audience client's default scopes are the only reliable way to inject the claim during token-exchange.

The known caveat (documented in `architecture.md` around line 625): with multiple `team-<slug>` scopes all bound as defaults, every hardcoded mapper fires on every token, and the *last one wins* (Keycloak does not guarantee mapper ordering). We compensate by having the Slack bot's OBO module **verify** the returned JWT's `active_team` claim matches what was requested — mismatch raises `OboExchangeError`. Follow-up work tracked in Spec 104 is to switch to a script-mapper that reads the requested team from a custom request parameter rather than per-team default scopes.

---

## Why do we still need OpenFGA membership if the JWT already has `active_team`?

Excellent question — and this is the security crux of the design.

The `active_team` claim in the JWT only says **what team this token claims to represent**. It does **not** prove the user actually belongs to that team. The claim is injected by a hardcoded mapper that doesn't check anything.

So if we trusted `active_team` alone, an attacker (or a buggy client) who could trigger a token-exchange with `scope=team-finance-prod` would get a token claiming `active_team=finance-prod` — even if they've never been added to the Finance team.

The OpenFGA tuple `user:<sub> member team:<slug>` is the **proof of membership**. It is written by team membership APIs and identity-group sync. Unlike the scope-injected claim, this tuple is stored server-side in the authorization graph and cannot be self-asserted by manipulating the token request.

AgentGateway now delegates the gateway decision to OpenFGA through `ext_authz`.
The equivalent relationship facts are represented as tuples:

```text
user:<sub> member team:<slug>
team:<slug>#member can_call tool:<tool-or-prefix>
```

The `active_team` claim says "this request is acting as team X." OpenFGA and the team-membership source store now say "this user is actually a member of team X." The conjunction is what makes the system safe.

### Defense-in-depth recap

| Layer | What it asserts | Who controls it | Can it be forged? |
|---|---|---|---|
| `active_team=<slug>` claim | "This request is on behalf of team `<slug>`" | The OBO token-exchange request (via scope binding) | Indirectly — but the slack-bot verifies the returned claim matches the requested scope, raising `OboExchangeError` on mismatch |
| `user:<sub> member team:<slug>` tuple | "OpenFGA records this user as a member of team `<slug>`" | Team membership APIs and identity-group sync | No — it is checked server-side in OpenFGA |
| `team:<slug>#member can_call tool:<tool>` tuple | "Members of this team may invoke `<tool>`" | Team Resources / ReBAC policy authoring | No — OpenFGA evaluates stored tuples, not client-provided claims |

Compromise any one and you still don't get in. That's the point.

---

## What happens to `team_member:<slug>` now?

`team_member:<slug>` is now a **temporary compatibility role**, not the source of truth for new writes. Unlike `active_team` (which is a hardcoded-claim mapper on a `team-<slug>` client scope), `team_member:<slug>` is just a standard Keycloak realm role. Existing assignments may still appear in `realm_access.roles`, but new manual team membership writes no longer create or assign the role.

So the question has two parts.

### What is written when a user joins a team?

When an admin adds the user to a team via `POST /api/admin/teams/<id>/members`, the handler at `ui/src/app/api/admin/teams/[id]/members/route.ts`:

1. Updates MongoDB `teams.members` for the product UI.
2. Resolves the Keycloak `sub` for the user's email when the user exists.
3. Stores a manual team-membership source record.
4. Writes an OpenFGA tuple: `user:<sub> member team:<slug>`.

The mirror happens on remove: after the last active source is gone, the route deletes the OpenFGA membership tuple. It does not remove or create Keycloak `team_member:<slug>` assignments.

Existing `team_member:<slug>` roles can remain until every older consumer is gone, but they should not be used for new authorization design.

### What appears in the JWT?

New access is represented in OpenFGA, not in `realm_access.roles`. The next token issued for the user still carries coarse roles such as `chat_user` or `admin_user`, plus the signed `active_team` claim when a team context is requested. It does not need a new resource or team-membership role to make the OpenFGA check work.

- **Web UI (`caipe-platform`)** — on the next NextAuth login, or on the next refresh-token grant. Practically: the user sees the new role after their session refreshes (or after they log out and back in).
- **Slack bot (`caipe-slack-bot`)** — on the next OBO token-exchange. The bot does a fresh exchange on every Slack message and doesn't cache OBO tokens across requests, so the role appears on the user's *next* Slack message.
- **Other flows** — on the next `client_credentials` or password grant for that user.

There is **no cached realm-role list** in the clients. Keycloak reads `realm_access.roles` from its database at token-mint time, but OpenFGA relationship updates take effect as soon as the tuple write succeeds.

### Summary table

| Step | What happens | Where |
|---|---|---|
| 1. Admin clicks "Add member" in team UI | `POST /api/admin/teams/<id>/members` | `ui/src/app/api/admin/teams/[id]/members/route.ts` |
| 2. Mongo `teams.members` updated | source of truth for the admin UI | `teams` collection |
| 3. Keycloak user is resolved by email | gives the stable `sub` used in OpenFGA subjects | `ui/src/lib/rbac/keycloak-admin.ts` |
| 4. OpenFGA membership tuple is written | `user:<sub> member team:<slug>` | `ui/src/app/api/admin/teams/[id]/members/route.ts` |
| 5. Next team-scoped token mint | Keycloak signs `active_team=<slug>` when requested | Keycloak client scope mapper |
| 6. AgentGateway ext_authz evaluates | OpenFGA checks the subject/resource tuple graph | `deploy/openfga/bridge/main.py` |

---

## Are team memberships embedded in the token?

**Not for new writes.** Existing `team_member:<slug>` compatibility roles may still appear in `realm_access.roles`, but the authoritative membership set now lives in OpenFGA and the team-membership source store.

A user who belongs to teams `platform-eng`, `security-ops`, and `infra` should have a compact JWT like:

```json
{
  "iss": "http://localhost:7080/realms/caipe",
  "sub": "...",
  "aud": "agentgateway",
  "realm_access": {
    "roles": [
      "chat_user"
    ]
  },
  "active_team": "platform-eng"
}
```

Only **one** `active_team` claim is present — the one corresponding to the team the bot requested via the `team-<slug>` scope on this specific token-exchange. The fact that the user belongs to `platform-eng` is stored as an OpenFGA tuple:

```text
user:<sub> member team:platform-eng
```

### Why this is correct (and intentional)

The two pieces of information have different lifetimes and different semantics:

| Property | What it represents | When it changes | Cardinality on a token |
|---|---|---|---|
| OpenFGA membership tuples | "The relationship graph records which teams this user belongs to" | When team membership APIs or identity sync reconcile | **0 in the token — stored in OpenFGA** |
| `active_team` claim | "Which team this single request is on behalf of" | On every token-exchange (every Slack message, potentially) | **1 — exactly one value** |

The OpenFGA relationship check at AgentGateway is what reduces N memberships to a single allow/deny decision:

```text
check(user:<sub>, can_call, tool:<tool>)
```

The selected team context is the key bit. OpenFGA doesn't ask "is the user a member of any team?" — it asks whether the user, through the current team/resource relationship graph, can call *this specific* tool. The `active_team` claim selects which of the user's memberships is being exercised; the relationship tuples are the universe of what the user *could* exercise.

### Implications

1. **Token size does not grow with team count.** Membership fan-out is stored in OpenFGA instead of `realm_access.roles`.

2. **The "last mapper wins" caveat is only about `active_team`.** With multiple `team-<slug>` scopes bound as defaults on the `CAIPE_PLATFORM_AUDIENCE` client, every hardcoded mapper fires on every token and the *last one wins* (Keycloak does not guarantee mapper ordering). The slack-bot's `obo_exchange.impersonate_user` **verifies** the returned `active_team` matches the requested team and raises `OboExchangeError` on mismatch.

3. **AGW gets the right answer from OpenFGA.** If Keycloak minted a wrong `active_team`, the OpenFGA check would evaluate the wrong team context. The bot's pre-flight check (requested != returned -> reject) is what prevents that privilege confusion.

4. **There is no CEL or role-array iteration.** AgentGateway delegates to OpenFGA through `ext_authz`, and OpenFGA checks stored tuples.

### Mental model in one line

> OpenFGA says **what hats you own.** The `active_team` claim says **which hat you're wearing right now.** AGW checks the relationship graph for that selected context.

---

## Roles vs Scopes — the technical reference

### Roles — *what a caller is allowed to do*

Realm roles (carried in `jwt.realm_access.roles`) are assigned to users. They answer **"is this user permitted?"**

| Tier | Examples | Meaning |
|---|---|---|
| **Coarse identity** | `chat_user`, `admin_user` | Default user / global admin. `admin_user` bypasses every tool/agent/team gate. |
| **Resource-scoped** (legacy compatibility) | `tool_user:jira_search_issues`, `tool_user:jira_*`, `tool_user:*`, `agent_user:test-april-2025`, `agent_admin:test-april-2025` | Transitional JWT role shape. New grants are OpenFGA relationships, not new Keycloak realm roles. |
| **Team membership** (legacy compatibility) | `team_member:<slug>` | Older JWT role shape for membership. New writes use OpenFGA `user:<sub> member team:<slug>` tuples. |

**Materialization:** Team membership and Team Resources now write OpenFGA tuples. Keycloak remains responsible for coarse bootstrap/global roles and the `active_team` client-scope claim.

### Scopes — *which team context the token represents*

Client scopes are **not** permissions. They are per-team claim injectors that determine the value of the `active_team` claim in the issued JWT.

| Scope | `active_team` claim value | Bound to | Bound how |
|---|---|---|---|
| `team-personal` | `__personal__` | `caipe-slack-bot` | optional (provisioned by the realm-init script on every boot) |
| `team-<slug>` | `<slug>` | `caipe-platform` (`CAIPE_PLATFORM_AUDIENCE`) | **default** (auto-created on team creation, plus startup auto-sync for pre-existing teams) |
| `team-<slug>` | `<slug>` | `caipe-slack-bot` | optional (for code symmetry with `team-personal`) |

**Why we need scopes at all:** the `active_team` value has to be **signed into the JWT itself** so AgentGateway and Dynamic Agents can trust it without a callback to MongoDB. Keycloak's RFC 8693 token-exchange silently drops the `scope` request parameter, so the audience client's default scopes are the only reliable injection path.

### How they combine — the actual gate at AgentGateway

A typical relationship check for a tool call:

```text
check(user:<sub>, can_call, tool:<name>)
```

A request is allowed only if **all three line up**:

1. **Identity facts** say who the caller is (`sub`, email, realm roles).
2. **OpenFGA tuples** say the caller is related to the team/resource being used.
3. **Scope** caused the JWT to carry `active_team=<slug>` when a team context is required.

If a user belongs to teams A and B, the Slack bot picks the team via OBO — `obo_exchange.impersonate_user(active_team=...)` adds `scope=openid team-<slug>` to the exchange — and then **verifies** the returned JWT's `active_team` claim matches. Mismatch raises `OboExchangeError` (load-bearing security invariant).

---

## What happens when you click "Create team"?

End-to-end flow when an admin POSTs to `/api/admin/teams` (`ui/src/app/api/admin/teams/route.ts`):

1. **Validate input.** Derive `slug` from `name` if not provided; reject if the slug is invalid or already in use.
2. **Insert team document into MongoDB** (`teams` collection) with the creator as `owner`.
3. **Call `ensureTeamClientScope(slug)`** (`ui/src/lib/rbac/keycloak-admin.ts`), which idempotently:
   - Creates a Keycloak **client scope** named `team-<slug>` (`POST /client-scopes`).
   - Adds an `oidc-hardcoded-claim-mapper` to the scope, configured to inject `active_team=<slug>` into the access token.
   - Binds the scope as a **default scope** on the `CAIPE_PLATFORM_AUDIENCE` client (`caipe-platform` by default).
   - Binds the scope as an **optional scope** on the `caipe-slack-bot` client.
4. **If scope provisioning fails, the Mongo insert is rolled back.** We never want a team without its scope, because that team's channels would silently fail OBO token-exchange.

What is **not** done at team creation:

- **No realm role is created.** No `team_member:<slug>` role is auto-created at team-creation time, and new membership writes do not create one either.
- **No client roles are created.**
- **No users are auto-assigned to anything.** The team has zero members until MongoDB membership and OpenFGA tuples are written.

### TL;DR mental model

- **Role = capability.** Granted to users. Answers "can this human do X?"
- **Scope = context tag.** Bound to clients. Answers "which team is this token speaking on behalf of?"
- **Slug = the team's machine name.** Lowercase, hyphenated, ASCII. Used everywhere internal.
- **Team creation** = new client scope (so a JWT can be minted with `active_team=<slug>`).
- **Team membership** = OpenFGA tuple `user:<sub> member team:<slug>`.
- **Tool/agent permission** = OpenFGA tuple such as `team:<slug>#member can_call tool:<id>` or `team:<slug>#member can_use agent:<id>`.

---

## Entity diagram — how roles, scopes, JWTs, and resources relate

The data model in one picture. Everything below the dashed lines is owned by Keycloak; the diagram intentionally omits the IdP itself, the JWKS publishing channel, and the OpenFGA bridge code (those live in the [enforcement diagram](#enforcement--how-decisions-actually-get-made-pep--pdp) below) so the entities you can point at in admin or in a JWT payload stand out.

```mermaid
erDiagram
    USER          ||--o{ REALM_ROLE   : "has coarse role"
    USER          }o--o{ TEAM         : "is member of (OpenFGA tuple)"
    TEAM          ||--|| CLIENT_SCOPE : "1:1 — scope injects active_team=slug"

    TEAM          ||--o{ TOOL         : "team members can_call"
    TEAM          ||--o{ AGENT        : "team members can_use"

    USER          ||--o{ JWT          : "is issued"
    JWT           }o--|| CLIENT_SCOPE : "active_team claim sourced from"

    USER {
      string keycloak_sub
      string email
      string slack_user_id
    }
    REALM_ROLE {
      string name "admin_user | chat_user | compatibility roles"
    }
    TEAM {
      string slug
      string display_name
    }
    CLIENT_SCOPE {
      string name "team-slug"
      string injects "active_team=slug"
    }
    TOOL  { string id }
    AGENT { string agent_id }
    JWT {
      string sub
      list   realm_access_roles
      string active_team
    }
```

### How to read it

- A **`USER` is granted `REALM_ROLE`s** directly only for coarse/bootstrap behavior such as `admin_user` or `chat_user`.
- A **`USER` is a member of a `TEAM`** through an OpenFGA tuple `user:<sub> member team:<slug>`.
- A **`TEAM` has a 1:1 `CLIENT_SCOPE`** named `team-<slug>` whose only job is to inject `active_team=<slug>` into JWTs minted with that scope. The team and the scope are paired but live in different Keycloak collections (teams are in MongoDB; scopes are Keycloak objects).
- A **`JWT`** carries (a) the user's full role list at `realm_access.roles` and (b) at most one `active_team` claim sourced from whichever team scope was bound to the request.
- **`TOOL` and `AGENT`** are resource entities in OpenFGA. Team/resource relationships, not role names, grant access.

### Why both OpenFGA membership AND `active_team`?

This is the security crux and the only "redundancy" in the model worth keeping. OpenFGA stores who belongs to the team, while the JWT claim is the request's assertion of which team context is active. Both are needed so a caller cannot grant themselves team access by manipulating the token request.

### What's deliberately not in this diagram

| Thing | Why it's not here | Where it does live |
|---|---|---|
| Keycloak (the IdP itself) | It owns every other entity above; drawing it as a node adds clutter without information. | Implicit. Mentioned in [Component 1](./architecture.md#component-1-keycloak--hr--the-front-desk). |
| JWKS / signing keys | Cryptographic plumbing — concerns key rotation, not data shape. | [Workflows — JWT validation](./workflows.md). |
| AgentGateway ext_authz / per-agent auth code | Those are *enforcement code*, not data. | The [enforcement diagram](#enforcement--how-decisions-actually-get-made-pep--pdp) below, `deploy/agentgateway/config.yaml`, and `deploy/openfga/bridge/main.py`. |
| OIDC clients (`caipe-platform`, `caipe-slack-bot`, `agentgateway`) | The client mostly affects audience and which scopes are bound by default, not the per-request decision shape. | [Component 1 — OIDC clients table](./architecture.md#component-1-keycloak--hr--the-front-desk). |
| `ROLE_ASSIGNMENT` / `TEAM_MEMBERSHIP` join tables | These are mechanical M:N joins that the ER notation already represents with the relationship line. | n/a. |

---

## Enforcement — how decisions actually get made (PEP & PDP)

The data model says **what facts exist**. Decisions are made by separate components that consume the JWT.

```mermaid
flowchart LR
    JWT[/"JWT<br/>realm_access.roles<br/>active_team"/] --> AGW
    JWT --> DA

    subgraph PEP_PDP_today["PEP + PDP today"]
      AGW["AgentGateway<br/>jwtAuth + ext_authz"]
      FGA["OpenFGA bridge<br/>relationship checks"]
      DA["Dynamic Agents<br/>per-agent auth on jwt + agent_id"]
    end

    AGW --> FGA
    FGA -->|allow| MCP["MCP tool"]
    FGA -->|deny| AGW_403["403"]
    AGW -->|deny| AGW_403["403"]
    DA -->|allow| AGT["Agent runtime"]
    DA -->|deny| DA_403["403"]
```

AgentGateway is the MCP PEP: it validates the Keycloak JWT locally and then calls the OpenFGA bridge through Envoy-compatible `ext_authz`. Dynamic Agents still enforce per-agent route checks before forwarding user tokens downstream. Both depend on the JWT being trustworthy (signed by Keycloak, verified against JWKS), but gateway tool authorization is now relationship-backed rather than CEL-authored.

---

## What can each caller actually do?

Three entry points, three slightly different flows, but all converge on the same JWT-based PEP at AgentGateway.

### 1. Web UI user

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as CAIPE UI (Next.js)
    participant KC as Keycloak
    participant SUP as Supervisor / Dynamic Agent
    participant AGW as AgentGateway
    participant MCP as MCP Tool

    User->>UI: Browser session (NextAuth.js)
    UI->>KC: Authorization Code + PKCE
    KC-->>UI: ID token + access token (JWT)
    Note right of KC: JWT carries realm_access.roles
    Note right of KC: active_team is NOT set
    Note right of KC: caipe-platform has no team scope

    User->>UI: Click "Use Jira search issues"
    UI->>UI: Web UI backend checks route permission / ReBAC access
    alt Web UI backend allows
        UI->>SUP: HTTPS + Bearer JWT
        SUP->>AGW: Forward Bearer JWT
        AGW->>AGW: jwtAuth verifies signature against JWKS
        AGW->>AGW: ext_authz calls OpenFGA bridge
        Note over AGW: Web UI tokens have no active_team claim
        Note over AGW: OpenFGA relationship tuples determine access
        alt OpenFGA allows
            AGW->>MCP: Forward request
            MCP-->>User: Result
        else OpenFGA denies
            AGW-->>User: 403 Forbidden
        end
    else Web UI backend denies
        UI-->>User: UI hides action or 403
    end
```

**Key point about the Web UI:** today the UI client (`caipe-platform`) doesn't bind any `team-<slug>` scope, so its JWTs usually ship **without** an `active_team` claim. Web UI authorization is therefore mediated by Web UI backend route gates and OpenFGA relationship checks rather than by editing AgentGateway rules.

### 2. Slack user posting in a channel

```mermaid
sequenceDiagram
    autonumber
    actor SlackUser as Slack user
    participant Slack
    participant Bot as Slack bot
    participant KC as Keycloak
    participant SUP as Dynamic Agent
    participant AGW as AgentGateway
    participant MCP as MCP Tool

    SlackUser->>Slack: Message in #platform-eng
    Slack->>Bot: event payload (channel_id starts with C or G)
    Bot->>Bot: channel_team_resolver maps channel to team slug
    Bot->>Bot: identity_linker maps slack_user_id to keycloak sub
    Bot->>KC: token-exchange (RFC 8693)
    Note over Bot,KC: scope=openid team-platform-eng
    Note over Bot,KC: requested_subject is the keycloak sub
    KC-->>Bot: JWT for user
    Note right of KC: realm_access.roles includes chat_user
    Note right of KC: plus tool_user and team_member roles
    Note right of KC: active_team is platform-eng
    Bot->>Bot: Verify returned active_team matches requested
    Note over Bot: Mismatch raises OboExchangeError
    Note over Bot: Request is hard-rejected before the agent request

    Bot->>SUP: Agent request + Bearer JWT
    SUP->>AGW: Forward Bearer JWT (per-request)
    AGW->>AGW: jwtAuth verifies, ext_authz calls OpenFGA
    Note over AGW: OpenFGA checks user/team/resource tuples
    alt Relationship graph allows
        AGW->>MCP: Forward request
        MCP-->>SlackUser: Result (via bot)
    else Missing team/resource relationship
        AGW-->>SlackUser: 403 (bot surfaces structured error)
    end
```

**Key point about Slack channels:** the channel ID determines the team via MongoDB (`channel_team_resolver`), and the bot pre-checks team membership before OBO. AgentGateway then checks the OpenFGA tuple graph for the resulting user/team/resource relationship.

### 3. Slack user in a DM (1:1 with the bot)

```mermaid
sequenceDiagram
    autonumber
    actor SlackUser as Slack user
    participant Slack
    participant Bot as Slack bot
    participant KC as Keycloak
    participant SUP as Dynamic Agent
    participant AGW as AgentGateway
    participant MCP as MCP Tool

    SlackUser->>Slack: DM the bot
    Slack->>Bot: event payload (channel_id starts with D)
    Bot->>Bot: is_dm_channel returns true (personal context)
    Bot->>Bot: identity_linker maps slack_user_id to keycloak sub
    alt Identity not yet linked
        Bot-->>SlackUser: Pre-auth prompt (link Slack to Keycloak)
        SlackUser-->>Bot: Completes link via web flow
    end
    Bot->>KC: token-exchange
    Note over Bot,KC: scope=openid team-personal
    Note over Bot,KC: requested_subject is the keycloak sub
    KC-->>Bot: JWT for user
    Note right of KC: realm_access.roles includes chat_user
    Note right of KC: plus tool_user roles
    Note right of KC: active_team is the personal sentinel

    Bot->>SUP: Agent request + Bearer JWT
    SUP->>AGW: Forward Bearer JWT
    AGW->>AGW: jwtAuth, then ext_authz calls OpenFGA
    Note over AGW: Personal sentinel maps to user-scoped relationships
    Note over AGW: No channel team membership is required
    alt User has the required tool relationship
        AGW->>MCP: Forward request
        MCP-->>SlackUser: Result
    else No matching relationship
        AGW-->>SlackUser: 403
    end
```

**Key point about DMs:** the `__personal__` sentinel says "no channel team — this user is acting as themselves." AgentGateway still delegates the decision to OpenFGA, but the bridge evaluates user-scoped relationships instead of requiring a channel team membership.

---

## Side-by-side: who needs what?

| Caller | `active_team` claim | Required roles to invoke `tool_user:<X>` | Source of team context |
|---|---|---|---|
| **Web UI user (non-admin)** | ❌ absent | Matching OpenFGA relationship, usually via Web UI backend-mediated resource access | (no team context today; Spec 104 follow-up) |
| **Web UI user (admin)** | ❌ absent | `admin_user` (bypasses everything) | n/a — global admin |
| **Slack channel user** | ✅ `<team-slug>` | `tool_user:<X>` **AND** `team_member:<team-slug>` | MongoDB `channel_team_resolver` (channel ID → team slug) |
| **Slack DM user** | ✅ `__personal__` | `tool_user:<X>` only | sentinel `__personal__` (no team) |
| **Slack admin in any channel/DM** | varies | `admin_user` (bypasses everything) | sentinel or team slug, but bypassed |

---

## Cross-references

- [Architecture — Component 1 (Keycloak)](./architecture.md#component-1-keycloak--hr--the-front-desk) — full role/scope tables, env vars, IdP brokering.
- [Architecture — Spec 104 `active_team` section](./architecture.md#spec-104--active_team-jwt-claim-team-scope-refactor) — what changed, components touched, failure modes.
- [Spec 104 — team-scoped RBAC](../../specs/104-team-scoped-rbac/active-team-design.md) — original design doc.
- [Workflows — OBO token-exchange](./workflows.md) — sequence diagrams for how scopes turn into JWT claims at runtime.
- [File map](./file-map.md) — find the source file that owns any piece of the auth path.
