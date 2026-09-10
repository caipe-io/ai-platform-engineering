# CAS Architecture Diagrams

**Date:** 2026-06-07
**Last reviewed:** 2026-08-15
**Companion to:** [`spec.md`](./spec.md) · [`research.md`](./research.md) · [`../2026-06-05-centralized-bff-authz-pdp-agnostic/solution-architecture.md`](../2026-06-05-centralized-bff-authz-pdp-agnostic/solution-architecture.md)

> One decision core, multiple transports, PDP-agnostic. Additive today; consumers migrate incrementally.

---

## 1. Component view

What's built (solid) vs. planned (dashed / "planned" labels). CAS lives **inside the BFF**; out-of-process callers reach it over HTTP.

```mermaid
flowchart TB
  subgraph BFF["BFF — caipe-ui (Next.js)"]
    R["Route handlers<br/>workflow-runs ✓ migrated"]
    V1["HTTP API<br/>/api/authz/v1<br/>decisions · batch · explain"]
    AD["Admin API<br/>/api/admin/authz<br/>stats · explain"]
    subgraph CAS["lib/authz — CAS core"]
      P["authorize · authorizeMany<br/>filterAccessible · grant (planned)"]
      CMP["compose — product policy layer"]
      ENG["PolicyEngine + PolicyAdmin (planned)"]
      OFA["OpenFGA adapter<br/>warm store-id · pooled client<br/>decision cache · circuit breaker"]
      AU["audit"]
      P --> CMP --> ENG --> OFA
      P --> AU
    end
    R -->|in-process| P
    V1 --> P
    AD --> P
  end

  DA["Dynamic Agents chat ✓ migrated"] -->|HTTP + user JWT| V1
  RB["RAG · Slack · Webex — later"] -->|HTTP| V1
  OFA --> STORE[("OpenFGA store")]
  AU --> M[("audit_events — Mongo")]
  M --> UIADMIN["Admin UI<br/>Authorization Insights · Permission Debugger · Audit tab"]
  AD --> UIADMIN
  BR["openfga-authz-bridge<br/>data-plane ext_authz (separate)"] -. Check .-> STORE
```

**Key points**
- The **OpenFGA adapter is private** to `lib/authz` (ESLint silo boundary). Swapping in Cedar/OPA later = a new adapter behind the same `PolicyEngine` / `PolicyAdmin` interfaces.
- The **bridge** stays data-plane (per-MCP-call `ext_authz`); it does **not** route through the BFF.
- Dynamic Agents chat and the workflow engine use CAS. Standard BFF
  resource-scoped helpers also use CAS by default.
- RAG, bots, legacy BFF gates, and the bridge are not fully migrated. See the
  [living CAS gap inventory](../../security/rbac/cas-coverage-gaps.md).

---

## 2. Decision request flow (read / PDP)

A DENY is a successful evaluation (`200` + body). HTTP error codes are reserved for meta-failures.

```mermaid
sequenceDiagram
  participant C as Caller (route / DA / bot)
  participant API as /api/authz/v1/decisions
  participant Core as CAS core
  participant FGA as OpenFGA
  participant Aud as audit_events

  C->>API: POST {subject, resource, action} + Bearer
  API->>API: verify JWT (JWKS)
  API->>API: subject-binding (caller.sub == subject, or can_audit)
  API->>Core: authorize()
  Core->>Core: decision cache lookup
  alt cache miss
    Core->>FGA: Check(user, relation, object)
    FGA-->>Core: allowed?
  end
  Core->>Aud: cas_decision event
  Core-->>API: {decision, reason, retriable}
  API-->>C: 200 ALLOW/DENY · 401/403 auth · 503 unavailable
```

---

## 3. Grant flow (write / PAP — planned, Phase 1 of the #1751 rewrite)

Intent-based and meta-authz'd: callers send `{resource, grantee, capability}`, never raw tuples. CAS verifies the caller may manage the resource, then writes via the adapter.

```mermaid
sequenceDiagram
  participant M as Workflow share / agent-access modal
  participant G as /api/authz/v1/grants
  participant Core as CAS core
  participant FGA as OpenFGA
  participant Aud as audit_events

  M->>G: POST {resource, grantee, capability} + Bearer
  G->>Core: meta-authz — caller may manage resource?
  Core->>FGA: Check(can_manage)
  FGA-->>Core: allow
  G->>Core: grant(intent)
  Core->>FGA: write tuple (team→agent, or user:* for global)
  G->>Aud: cas_grant event
  G-->>M: 200 {granted}
```

---

## 4. Migration posture

```mermaid
flowchart LR
  subgraph now["Today (additive)"]
    n1["workflow engine · DA chat<br/>BFF resource helpers → CAS"]
    n2["legacy paths remain<br/>RAG · bots · bridge · coarse BFF gates"]
  end
  subgraph next["Incremental"]
    x1["Internal CAS transport<br/>for AgentGateway"]
    x2["RAG → CAS"]
    x3["bots and legacy BFF gates → CAS"]
    x4["relationship mutations<br/>→ CAS reconcile"]
  end
  now --> next
```

Each surface flips independently; nothing is forced. The standalone service can ship and run with a single real consumer, then absorb the rest over time.

---

<!-- assisted-by claude code claude-opus-4-8 -->
