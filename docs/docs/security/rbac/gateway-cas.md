# Gateway authorization through CAS

**Status: opt-in dev cutover; default deployments are unchanged.** One Helm
setting switches the gateway and trusted context producers together. The old
gRPC bridge remains available until deployment validation is complete.

## One policy owner; two paths

The gateway asks permission. It still executes the forwarding decision.

```mermaid
sequenceDiagram
    participant Client as Agent / client
    participant Gateway as AgentGateway
    participant CAS as BFF (HTTP adapter + CAS)
    participant FGA as OpenFGA
    participant MCP as MCP server
    Client->>Gateway: Original tool request + caller JWT
    Gateway->>Gateway: Validate JWT
    Gateway->>CAS: Authorization side call
    CAS->>FGA: Required relationship checks
    FGA-->>CAS: Permission results
    CAS-->>Gateway: 200 ALLOW / 403 DENY / 503 unavailable
    alt ALLOW
        Gateway->>MCP: Forward original tool request
        MCP-->>Client: Tool result, through gateway
    else DENY or unavailable
        Gateway-->>Client: Reject; tool is not executed
    end
```

- **AgentGateway:** validates identity, supplies trusted request metadata, and
  enforces the HTTP response. It does not select CAIPE product-policy checks.
- **BFF adapter:** authenticates the gateway workload and parses the request.
- **CAS gateway domain:** selects all required checks and explains the result.
- **OpenFGA:** evaluates relationships. MCP/downstream permissions still apply.

## The complete decision

For `tools/call`, all applicable checks must pass:

1. Caller can access `mcp_gateway:list` and any configured restricted server.
2. Caller can use the signed-context agent, when executing through an agent.
3. That agent can call the exact tool or its server wildcard.
4. Caller can call the exact tool or wildcard, independently of the agent.
   The existing `knowledge-base` exception checks organization Search access.

The new path **always** enforces the caller-tool gate; it does not inherit the
legacy opt-out flag. Audit existing grants before cutover to avoid surprises.
`CAIPE_RESTRICTED_MCP_SERVERS` and `CAIPE_ORG_KEY` retain their policy roles.

- Every graph check is fresh (`HIGHER_CONSISTENCY`); no execution ALLOW cache.
- An unavailable dependency never falls back to a weaker gate or wildcard.
- Explicit direct-call context skips agent gates, not caller permissions.
  Missing agent context cannot silently become direct mode.
- Initialization, initialized notification, ping, tool listing and GET/DELETE
  transport checks require gateway/server access. They do not authorize execution
  or filter the tool catalog. Other MCP operations fail closed in this slice.

## Trust, responses and evidence

The gateway-only endpoint is `/api/access/gateway/check`. It does **not** use the
public self-check API, where HTTP 200 can legitimately contain a DENY result.

- A dedicated high-entropy workload credential authenticates the gateway.
  This is a shared bearer secret, not a Keycloak workload JWT.
  It must be separate from caller credentials and context-signing keys.
- Caller and route assertions must be generated from the verified JWT and actual
  request. Call the BFF's internal service endpoint, not the public UI ingress;
  exclude this gateway-only route from public ingress. The dev wiring uses
  internal HTTP: it does **not** automatically provide network isolation or TLS.
  Production requires authenticated TLS/mTLS and network restrictions.
  A stolen gateway credential permits caller assertions; protect and rotate it.
  An on-path actor can also forge an ALLOW response: protect response integrity,
  not just the token. Unprotected HTTP is limited to isolated dev testing with
  explicit risk acceptance. Verify any service-mesh protection; do not assume it.
- Signed execution context binds caller type/ID, audience, agent or explicit
  direct mode, and a maximum five-minute lifetime. It proves context, not grants.
- Only ALLOW gets HTTP 200. Invalid requests, authentication failures, denials,
  oversized bodies, unsupported methods and outages return non-2xx responses.
- Completed decisions include a decision ID, reason and failed gate. CAS records
  caller, verified agent and gateway workload separately, never tool arguments,
  tokens or signatures. Denials are individual events; routine ALLOWs are rolled
  up unless full-fidelity audit is enabled. Delivery remains best-effort; this is
  not yet a complete forensic record or the planned Admin decision view.

Configuration/header details live in the
[BFF authorization README](https://github.com/caipe-io/ai-platform-engineering/blob/prebuild/feat/cas-gateway-authz/ui/src/lib/authz/README.md#gateway-authorization-foundation).

## Enable for dev

Use the PR's UI, Dynamic Agents and `agentgateway-config-bridge` images plus
the matching prebuild chart. Keep the gateway binary at the pinned **v1.1.0**.
The config bridge is the **route-discovery reconciler**, not the old authorization
service. Image references appear in the PR's prebuild artifact comment.

Create two distinct, single-line, high-entropy Kubernetes Secret values of at least 32
characters through your normal secret-management process. Do not commit values.
The following values supplement your existing issuer/JWKS and deployment config:

```yaml
global:
  agentgateway:
    enabled: true
    routingMode: static
    cas:
      enabled: true
      existingSecret:
        name: example-gateway-auth       # key: CAIPE_GATEWAY_AUTHZ_TOKEN
      contextSecret:
        name: example-execution-context  # key: CAIPE_AGENT_CONTEXT_HMAC_SECRET
    static:
      jwtAuth:
        enabled: true                   # keep your existing issuer/JWKS
      configBridge:
        image:
          tag: <PR-prebuild-tag>
caipe-ui:
  image:
    tag: <PR-prebuild-tag>
dynamic-agents:
  image:
    tag: <PR-prebuild-tag>
```

- Empty `cas.host` selects the internal `<release>-caipe-ui:3000` service.
  If you override the BFF service name, set its internal `host:port` here.
- The workload token reaches BFF as a Secret-backed environment variable and
  gateway as a read-only Secret file. It is not in the route ConfigMap, CEL
  expressions or gateway `/config` output. The HMAC key reaches BFF and Dynamic
  Agents only. Restart all affected replicas when rotating environment keys.
- Gateway waits at most six seconds; CAS graph checks share a five-second budget.
  These are failure bounds, not a performance guarantee.
- Dynamic Agents refresh context on every request, including reused connections.
  BFF probe/test calls use explicit direct-user context, without temporary agent
  grants. Local clients must renew `/api/mcp-servers/agent-context` before the
  returned `expires_at` (five minutes); their old cached headers are incompatible.
- Old authorization configuration is superseded when CAS is enabled. Flag-off
  deployments retain existing behavior; rollback is a coordinated restart, not
  mixed-version operation. No permission-data migration is performed.
- This slice supports static/standalone Helm routing only, not Gateway API or
  a Compose cutover. All external clients must adopt the new context before use.

## Dev acceptance

1. As a non-admin, make one allowed and one denied agent tool call. Check the
   denied response's reason, failed gate and decision ID; confirm no tool ran.
2. Revoke agent or caller-tool access and repeat: the next execution must deny.
3. Repeat with a service account, Search and a connection open over five minutes.
   Exercise BFF probe/test calls and direct-client context renewal too.
4. Make BFF/OpenFGA unavailable: no tool execution or weaker fallback. Confirm
   401 means invalid credentials, 403 a denial, and 503 unavailable authorization.
5. Add an MCP server at runtime. Confirm the config reconciler gives the new
   route the same CAS policy without exposing either secret through discovery.

Validate grant coverage **before** enabling this: caller-tool checks are always
required. Keep the old bridge until these journeys pass. Audit delivery remains
best-effort; the planned Admin decisions view is still separate work.

## Local proof and remaining work

The opt-in native test uses AgentGateway **v1.1.0**, the actual BFF handler over a
local HTTP fixture, OpenFGA **1.15.1** with the chart model, and a stub MCP server.
It uses the production route-config generator and real Python context producer.
It is not a deployment test of a running Next.js server. Twelve tests prove
ALLOW/deny, trusted assertions, invalid JWT/context, revocation, credential
redaction, runtime-route hot reload, BFF outage and the configured timeout.

From `ui/`, with an isolated loopback OpenFGA and a verified gateway binary:

```sh
CAIPE_GATEWAY_TEST_BINARY=/path/to/agentgateway \
CAIPE_GATEWAY_TEST_PYTHON=/path/to/dynamic-agents-venv/bin/python \
OPENFGA_GATEWAY_TEST_URL=http://127.0.0.1:18083 \
npm test -- --config jest.gateway.config.js --runInBand
```

Before retirement/main: validate actual deployment and load, complete transport
and network protections, migrate remaining clients, and remove superseded
configuration. Interrupted/late permission writes
[#2854](https://github.com/caipe-io/ai-platform-engineering/issues/2854) remain
a release gate for the combined CAS integration. The rollout flag is temporary.

Work item: [#2892](https://github.com/caipe-io/ai-platform-engineering/issues/2892).
