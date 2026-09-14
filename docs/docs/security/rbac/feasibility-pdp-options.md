# Feasibility — Remote PDP options for CAIPE

**Status:** Historical decision note. The current implementation has adopted
OpenFGA behind AgentGateway `ext_authz`; this page remains useful as rationale
for why OpenFGA was selected over Keycloak UMA, OPA, Cedar, and keeping inline
AgentGateway rules as the long-term policy surface.

**Audience:** Anyone evaluating PDP choices (OpenFGA, OPA, Cedar, Cerbos, …) for CAIPE's authorization layer. Read [`roles-scopes-comparison.md`](./roles-scopes-comparison.md) first for the current model.

---

## TL;DR

1. **CAIPE is a two-PDP system today.** AgentGateway delegates data-plane MCP authorization to OpenFGA through `ext_authz`; Keycloak Authorization Services (UMA 2.0) handles management-plane checks via `require_rbac_permission()` (`ai_platform_engineering/utils/auth/keycloak_authz.py` and friends). No CEL is involved on the Keycloak side — it's role/group/aggregated policies and (deprecated) JS.
2. **AgentGateway already supports remote PDPs** out of the box — both gRPC ext_authz (Envoy-compatible, the same API OPA/OpenFGA/Cedar agents speak) and HTTP ext_authz, with `failureMode: FailOpen | FailClosed` (default closed). A remote PDP is a **config change**, not a code change in AGW. (See [AGW external authz docs](https://agentgateway.dev/docs/configuration/security/external-authz/).)
3. **CAIPE's data is genuinely relationship-shaped** — the simplified entity diagram in [roles-scopes-comparison.md](./roles-scopes-comparison.md#entity-diagram--how-roles-scopes-jwts-and-resources-relate) shows USER → TEAM → TOOL relationships that today are encoded by string-concatenating role names. ReBAC engines (OpenFGA, SpiceDB) express this natively.
4. **OpenFGA is the selected AGW data-plane PDP** for CAIPE specifically. OPA is the safer/more general choice if you're planning to layer many other policy domains (data, network, K8s admission). Cedar is intellectually elegant but smaller community. Keycloak's own PDP can be extended to the AGW hot path via ext_authz too — see the explicit "why not just use Keycloak" section below for the tradeoffs.

---

## What problem are we solving?

| Pain | Does a remote PDP help? |
|---|---|
| The slug-vs-ObjectId bug (`team_member:<oid>` vs `team_member:<slug>`) | ❌ No. That was an admin-API consistency bug. Phase A (`identity-service`) is the fix. |
| 5 services duplicating Keycloak Admin API calls | ❌ No. Same as above — `identity-service` problem. |
| Gateway policy rules getting hard to maintain as we add resources | ✅ Yes. ReBAC moved these relationship-shaped decisions into OpenFGA tuples instead of a growing inline rule set. |
| Want "who has access to X?" reverse queries (e.g. "show me everyone who can invoke jira_search") | ✅ Yes. ReBAC engines do this in ms; doing it against Keycloak today requires walking every user's roles. |
| Want hierarchical/delegated permissions ("team A admin can grant access to team A's resources") | ✅ Yes. ReBAC models this natively. |
| Want to swap Keycloak for another IdP later | 🟡 Partial. PDP separation makes the IdP-switch cleaner because the IdP no longer owns policy. But the PDP is not itself an IdP abstraction. |
| Want policy-as-code with versioning, signing, bundles | ✅ Yes. OPA in particular is built around this. |

If your "yes" rows are mostly the bottom three, a PDP makes sense. If they're mostly the top two, build `identity-service` first and revisit.

---

## The four families of PDPs

### Family A — Relationship/Graph PDPs (Zanzibar-style)

Store tuples like `(user, relation, object)`. Answer "is there a path from this user to this object via these relations?" Originally [Google Zanzibar](https://research.google/pubs/pub48190/).

| PDP | Status | License | Native ext_authz | Best for |
|---|---|---|---|---|
| **[OpenFGA](https://openfga.dev/)** | CNCF Sandbox; donated by Auth0/Okta | Apache 2.0 | ✅ gRPC + HTTP | Hierarchical resources, sharing/delegation, "who has access to X?" reverse queries |
| **[SpiceDB](https://authzed.com/spicedb)** | Open core; commercial backing (Authzed) | Apache 2.0 | ✅ gRPC | Same as OpenFGA + stronger consistency guarantees (zookies) |
| **[Permify](https://permify.co/)** | Open source | Apache 2.0 | ✅ gRPC | Smaller footprint, Postgres-backed |
| **[Warrant](https://warrant.dev/)** | Commercial-only (Auth0 acquired) | Closed | ✅ via Auth0 FGA | Companies already on Auth0 |

**Verdict for CAIPE:** OpenFGA edges out the rest because (a) the Keycloak event-publisher SPI exists out of the community ([keycloak-openfga-event-publisher](https://github.com/embesozzi/keycloak-openfga-event-publisher)), (b) CNCF Sandbox status, (c) Auth0/Okta support means the tooling around it (UI, SDKs, debugging) is well-funded.

### Family B — General-purpose policy engines

Evaluate **policies as code** against arbitrary input documents. Far more flexible, but you model both the data and the policy yourself.

| PDP | Language | Status | Native ext_authz | Best for |
|---|---|---|---|---|
| **[OPA (Open Policy Agent)](https://www.openpolicyagent.org/)** | Rego | CNCF **Graduated** | ✅ gRPC | When policies span many domains (auth + data + network + K8s admission); when "policies live next to code" with bundles + signing matters |
| **[Cedar](https://www.cedarpolicy.com/)** (AWS) | Cedar | CNCF Sandbox; AWS-designed | ✅ via [cedar-agent](https://github.com/permitio/cedar-agent) | Teams that find Rego painful; teams that want a formally verified type system |
| **[Topaz](https://www.topaz.sh/)** (Aserto) | Rego + relationship directory | Open source | ✅ gRPC | OPA's flexibility + pre-built RBAC/ReBAC scaffolding |

**Verdict for CAIPE:** OPA is overkill for the current 5-rule CEL footprint. Becomes attractive if you start adding many other policy domains (e.g. data-access policies, K8s admission, network policies). Cedar is intellectually clean but has a smaller community than OPA.

### Family C — Commercial / managed PDPs

| PDP | Model | Notable for |
|---|---|---|
| **[Cerbos](https://www.cerbos.dev/)** | Stateless decisions; YAML policies; sidecar | Apps that pass principal+resource attributes per request — no separate relationship store. Lowest latency. |
| **[Permit.io](https://www.permit.io/)** | OPA + OpenFGA underneath, with admin UI + SaaS | Teams that want the policy authoring UX more than the engine |
| **[Aserto](https://www.aserto.com/)** | Managed Topaz | OPA + directory as a service |
| **[Auth0 FGA](https://auth0.com/fine-grained-authorization)** | Hosted OpenFGA | Already on Auth0 |
| **[Casbin](https://casbin.org/)** | Embedded library, polyglot (Go/Python/Java/Rust/Node/etc.) | Embed-in-app use cases — *not* a gateway PDP |

**Verdict for CAIPE:** Cerbos is the most interesting commercial-friendly option if you want low latency and don't want a separate tuple store. Permit.io is worth a demo if the admin UX matters more than the engine choice.

### Family D — Use what you already ship

| Approach | Notable for |
|---|---|
| **Keep inline rules on AGW only** | Rejected for the current branch. Relationship-shaped grants now live in OpenFGA so the Admin UI can answer and explain "who has access to X?". |
| **Use Keycloak Authorization Services (UMA) more** | Already in production for management-plane checks (Web UI backend, MCP middleware, Slack bot — see `ai_platform_engineering/utils/auth/keycloak_authz.py`). Could be extended to AGW via ext_authz at the cost of latency and Keycloak-on-hot-path coupling. See [Why we don't use Keycloak's PDP for AGW today](#why-we-dont-use-keycloaks-pdp-for-agw-today) below. |
| **Roll your own** | The "small RBAC service we'll build in 2 weeks" is the most-rewritten artifact in the industry. Don't. |

### Why we don't use Keycloak's PDP for AGW today

Keycloak ships its own PDP (Keycloak Authorization Services, UMA 2.0). It's already on the management plane: `require_rbac_permission()` in `ai_platform_engineering/utils/auth/keycloak_authz.py` calls Keycloak's `/realms/<r>/protocol/openid-connect/token` endpoint with `grant_type=urn:ietf:params:oauth:grant-type:uma-ticket` for Web UI backend, MCP middleware, and bot permission checks. The data plane now uses OpenFGA behind AgentGateway `ext_authz`; Keycloak UMA remains off the hot path.

We **don't** put Keycloak's PDP on AGW's data plane for three reasons:

1. **Latency.** Every tool call would add a Keycloak RPC (~5-30ms). CAIPE issues many tool calls per chat turn.
2. **Policy expressiveness.** Gateway authorization references MCP resource names and per-request team context. To replicate this in Keycloak you'd pre-mint a resource per (tool × team), or use Keycloak's deprecated JS policies. Both are awkward.
3. **Operational coupling.** Putting Keycloak on the per-request decision path means every tool call hard-depends on Keycloak liveness. With OpenFGA, AGW only depends on Keycloak for JWT *signature* validation (JWKS, cached), while relationship decisions use the OpenFGA bridge.

These are the same reasons people picking **OpenFGA / OPA / Cedar** at scale don't pick Keycloak's PDP: those engines are purpose-built for low-latency decision RPCs with caching, sharding, and decision-keyed replication patterns Keycloak's UMA wasn't optimized for.

---

## Comparison matrix

| Dimension | OpenFGA | OPA | Cedar | Cerbos | Keycloak AuthZ (UMA) | Keep inline AGW rules |
|---|---|---|---|---|---|---|
| Relationship-shaped data fit | ✅ excellent | 🟡 you build it | 🟡 you build it | ❌ stateless model | 🟡 role/group only | 🟡 string roles work |
| Policy authoring complexity | DSL — moderate | Rego — high | Cedar — moderate | YAML — low | UI / JSON — low | CEL — low |
| ext_authz integration with AGW | ✅ native gRPC | ✅ native gRPC | ✅ via cedar-agent | ✅ HTTP | 🟡 HTTP, but awkward semantics | n/a (built-in) |
| "Who has access to X?" reverse queries | ✅ excellent | ❌ not really | 🟡 limited | ❌ no | 🟡 via Admin API | ❌ no |
| Per-request variables (e.g. `mcp.tool.name`) | ✅ via tuples or context | ✅ via input doc | ✅ via context | ✅ via input doc | ❌ requires pre-minting per-resource | ✅ native |
| Operational overhead | New service + DB | New service + bundles | New service | New sidecar | None — already deployed | None |
| Latency added per check | ~2-5ms | ~1-3ms | ~1-3ms | less than 1ms (sidecar) | ~5-30ms (JVM, JWT minting) | 0 |
| Maturity / community | High (CNCF Sandbox) | Highest (CNCF Graduated) | Medium | Medium | High (Red Hat) | n/a |
| Vendor lock | None | None | None | None (open core) | None | n/a |
| Multi-tenancy story | Good | DIY | DIY | Good | Per-realm isolation | DIY |
| When you outgrow CAIPE's scale | Scales well | Scales very well | Scales well | Scales (stateless) | UMA endpoint becomes a bottleneck | CEL scales fine |
| Custom policy logic | Yes (relations) | Yes (Rego — anything) | Yes (Cedar — typed) | Yes (YAML conditions) | 🟡 only via deprecated JS policies (KC ≤25) | Yes (CEL — anything) |

---

## Recommendation

### If you're committing to ReBAC long-term

Pick **OpenFGA**. Multi-team resource sharing, hierarchical agents, and complex delegation are all natural in ReBAC and painful in role-string concatenation. The data model in [roles-scopes-comparison.md](./roles-scopes-comparison.md#entity-diagram--how-roles-scopes-jwts-and-resources-relate) is already relationship-shaped — OpenFGA expresses it directly:

```fga
model
  schema 1.1

type user

type team
  relations
    define member: [user]

type tool
  relations
    define can_use: [team#member]
```

Tuples:
```
user:alice         member          team:platform
team:platform      can_use         tool:jira_search
```

Check:
```
check(user:alice, can_use, tool:jira_search)
  → true if alice is a member of any team that can_use that tool
```

### If you're staying RBAC-shaped but want a real PDP

Pick **OPA**. The investment in Rego pays off across many policy domains beyond just RBAC.

### Current decision

OpenFGA is now the selected data-plane PDP for AgentGateway. Keycloak
Authorization Services remains the management-plane PDP for Web UI backend,
MCP middleware, and Slack bot checks. Do not reintroduce a separate AG MCP
policy CRUD surface; model gateway access as OpenFGA tuples and let AG call the
bridge through `ext_authz`.

### Why not just lean harder on Keycloak's PDP and skip OpenFGA/OPA entirely?

It's the most defensible "do nothing new" answer. Keycloak's PDP is fine for management-plane checks and you already have the wiring (`require_rbac_permission()`, `mcp_agent_auth.pdp`, `keycloak-authz.ts`). You **can** put it on AGW's data plane via HTTP ext_authz too. The reasons not to are practical, not architectural — see [Why we don't use Keycloak's PDP for AGW today](#why-we-dont-use-keycloaks-pdp-for-agw-today). If you accept the latency budget (Keycloak UMA ~5-30ms × tool calls per chat turn) and live with the per-resource pre-minting limitation, this is the cheapest path.

The argument for OpenFGA/OPA over Keycloak as a *PDP* (separate from "as an IdP") is essentially:
- Sub-millisecond decisions vs Keycloak's tens of ms.
- Reverse queries ("who can do X?") that Keycloak's UMA doesn't support natively.
- Decision-shaped sharding/replication patterns built for hot-path PDP work.
- Per-request variables (like `mcp.tool.name`) without pre-minting a Keycloak resource per tool.

If those don't matter for CAIPE's expected scale and policy complexity, Keycloak's PDP for management-plane checks plus a simpler gateway policy can still be defensible. This branch chose OpenFGA because the team/resource graph and access explanation UI are now first-class requirements.

---

## Migration considerations (if you do introduce one)

These apply broadly to any remote PDP, but OpenFGA-flavored examples are given for concreteness.

### 1. Cache coherency between IdP and PDP

When admin operations write to Keycloak (via `identity-service`) **and** to the PDP, there's a window where the two disagree. Options:

- **Synchronous dual-write** — `identity-service` writes Keycloak then PDP in the same transaction. Failure on either rolls back. Simple but couples liveness.
- **Event-driven sync** — `identity-service` writes Keycloak, then enqueues a PDP-tuple-write event. PDP eventually consistent. Tolerates PDP outages but admins see "permission granted" before it actually takes effect.
- **PDP-as-source-of-truth** — `identity-service` writes only to PDP; Keycloak is reduced to identity-only (no realm roles for resources). Cleanest but requires policy code in CEL/AGW to no longer reference `realm_access.roles`.

For CAIPE, option 2 with a small staleness budget (≤2s) is the natural fit — admin operations are infrequent and the PDP is the load-bearing path, not Keycloak.

### 2. AGW fast-path / slow-path

Don't overcomplicate the gateway hot path. Keep AgentGateway focused on JWT validation and one `ext_authz` decision:

```yaml
extAuthz:
  host: openfga-authz-bridge:9100
  failureMode:
    denyWithStatus: 403
```

Admin bypasses and resource relationships should be modeled in OpenFGA, not in a second policy surface inside AgentGateway.

### 3. Decision caching

PDP decisions are deterministic given the same inputs. Cache `(sub, active_team, tool_name) → decision` for ~60s in AGW (or in the PDP itself). For CAIPE's call patterns this drops PDP load by ~95%.

### 4. Migration ordering

Recommended order — each step independently shippable:

1. Add OpenFGA and tuple writers.
2. Add AgentGateway `ext_authz` pointing at the OpenFGA bridge.
3. Flip AGW to enforce the OpenFGA decision.
4. Delete the AG MCP policy CRUD surface and the Mongo-backed config bridge.

This staging means you can abort at any point and roll back without data loss.

### 5. What stays in Keycloak no matter what

Even if you adopt a PDP, Keycloak still owns:

- JWT issuance and signing
- OIDC login flows
- User/identity management (JIT, federated identities)
- Token-exchange (OBO)
- IdP brokering (Duo SSO, Cisco SSO, etc.)

The PDP replaces only Keycloak's **AuthZ Services** (the UMA-based PDP), which CAIPE doesn't currently use anyway. So adoption is additive, not destructive.

---

## What this doc deliberately doesn't decide

- **Whether to introduce a PDP at all.** That's a roadmap decision; this doc only enumerates the options if/when you do.
- **Whether to build `identity-service`.** Tracked separately (TODO: write `feasibility-authz-service.md`).
- **Vendor selection if a commercial PDP is chosen.** Cerbos, Permit.io, Aserto, and Topaz all need product-level evaluation that exceeds this doc's scope.
- **The `model.fga` file for CAIPE's full rule set.** Once a decision is made, that becomes a spec deliverable.

---

## References

- [AgentGateway External Authorization docs](https://agentgateway.dev/docs/configuration/security/external-authz/)
- [Envoy External Authorization filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_authz_filter)
- [OpenFGA — Authorization Concepts](https://openfga.dev/docs/concepts)
- [Google Zanzibar paper (2019)](https://research.google/pubs/pub48190/)
- [OPA — Envoy ext_authz integration](https://www.openpolicyagent.org/docs/latest/envoy-introduction/)
- [Cedar — Language reference](https://docs.cedarpolicy.com/)
- [keycloak-openfga-event-publisher SPI](https://github.com/embesozzi/keycloak-openfga-event-publisher) — sync Keycloak roles to OpenFGA tuples via event listener
- [RBAC architecture](./architecture.md) — current AgentGateway and OpenFGA design
