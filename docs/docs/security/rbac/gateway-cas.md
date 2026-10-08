# Gateway authorization through CAS

**Status: additive foundation, not a deployment cutover.** The existing gRPC
bridge still serves configured gateways. This change introduces the replacement
decision module and proves the HTTP path without switching production traffic.

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
  This is a shared bearer secret in the foundation, not a Keycloak workload JWT.
  It must be separate from caller credentials and context-signing keys.
- Caller and route assertions must be generated from the verified JWT and actual
  request. Call the BFF's internal service endpoint, not the public UI ingress;
  keep this gateway-only route private at cutover. Use authenticated TLS in
  deployment. A stolen gateway
  credential permits caller assertions; protect and rotate it accordingly.
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

## Proof and remaining cutover

The opt-in native test uses AgentGateway **v1.1.0**, the actual BFF handler over a
local HTTP fixture, OpenFGA **1.15.1** with the chart model, and a stub MCP server.
It is not a deployment test of a running Next.js server. It proves ALLOW/deny,
trusted assertions, invalid JWT/context, revocation, BFF outage and timeout.

From `ui/`, with an isolated loopback OpenFGA and a verified gateway binary:

```sh
CAIPE_GATEWAY_TEST_BINARY=/path/to/agentgateway \
OPENFGA_GATEWAY_TEST_URL=http://127.0.0.1:18083 \
npm test -- --config jest.gateway.config.js --runInBand
```

Before switching the gateway and removing the old bridge:

- Migrate Dynamic Agents and BFF/direct-client context producers together. The
  old context format is intentionally rejected by the new endpoint.
- Wire workload/key secrets, trusted headers, body forwarding and TLS through
  gateway configuration and deployment; remove superseded fallback modes.
- Align gateway/CAS deadlines and measure load. The pinned gateway's default
  HTTP authorization timeout is 200 ms; the CAS check budget is five seconds.
  The current fixture proves timeout denial, not a production latency guarantee.
- Validate human/service-account journeys and errors in the deployment, then
  retire the bridge. Keep interrupted/late permission writes
  [#2854](https://github.com/caipe-io/ai-platform-engineering/issues/2854) as a
  release gate before promoting the combined CAS integration to main.

Work item: [#2892](https://github.com/caipe-io/ai-platform-engineering/issues/2892).
