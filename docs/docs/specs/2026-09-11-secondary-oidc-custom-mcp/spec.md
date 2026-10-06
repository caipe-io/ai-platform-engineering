# End-to-end design: secondary OIDC identity and user-curated MCP surfaces

**Status:** Proposed  
**Date:** 2026-09-11  
**Owner:** Sri Aradhyula  
**Related:** [AgentGateway as MCP Proxy](../../architecture/gateway.md),
[MCP pinned provider credentials](../2026-06-22-mcp-pinned-provider-credentials/spec.md),
[enterprise identity architecture](../093-agent-enterprise-identity/spec.md),
and [centralized authorization](../2026-06-05-centralized-bff-authz-pdp-agnostic/spec.md)

## 1. Summary

CAIPE should expose provider-neutral MCP endpoints that can accept either the
normal CAIPE/Keycloak identity or one configured secondary OIDC identity. A
verified secondary identity is linked once to an existing Keycloak user and
thereafter resolves to the same canonical Keycloak subject used by OpenFGA,
auditing, and connected-provider credentials.

The first endpoint using this mechanism is TOME, but neither the authentication
code nor its configuration is TOME-specific:

~~~text
CAIPE_SECONDARY_OIDC_JWKS_URI
CAIPE_SECONDARY_OIDC_ISSUER
CAIPE_SECONDARY_OIDC_AUDIENCES
CAIPE_SECONDARY_OIDC_PROVIDER_ID
~~~

The target public surface is:

~~~text
/api/mcp/:serverId           one registered MCP server
/api/mcp/custom              the caller's default curated virtual server
/api/mcp/custom/:profileId   an optional named curated virtual server
/api/mcp/servers             authenticated server catalog (not an MCP transport)
~~~

A curated endpoint federates tools from multiple registered MCP servers. Its
**tools/list** result is the intersection of the user's saved selection,
current OpenFGA permissions, server health, and available credentials. Every
**tools/call** repeats authorization and resolves the canonical user's
connected credentials at call time. Saving a tool in a profile never grants
permission.

## 2. Problem

CAIPE currently assumes that callers present a Keycloak bearer token at the MCP
gateway. Enterprise assistant clients may instead present a valid JWT from a
different trusted issuer. The external JWT can prove an identity within that
issuer, but its **sub** is not the Keycloak **sub** used by CAIPE authorization.
Treating those values as interchangeable would either deny legitimate users or
authorize the wrong subject.

Publishing a separate endpoint for every backing MCP server also forces
external clients to configure many servers and exposes tools users do not want
in a particular assistant. Users need a stable endpoint containing only tools
they selected, while preserving per-user RBAC and per-user connected
credentials.

These are related boundary problems:

1. authenticate an external caller;
2. resolve it to one canonical CAIPE user;
3. authorize that user for each server and tool;
4. select only the tools the user chose;
5. invoke with that user's connected-resource credentials; and
6. return a bounded, client-friendly MCP response.

## 3. Goals and non-goals

### Goals

- Validate secondary bearer tokens locally with JWKS. Do not call an
  introspection or authorizer endpoint and do not issue or exchange a token.
- Link a trusted secondary identity to exactly one existing Keycloak user.
- Use the linked Keycloak **sub** for all OpenFGA decisions and audit records.
- Make secondary OIDC reusable by any CAIPE MCP endpoint.
- Provide direct and per-user curated MCP endpoints with Streamable HTTP.
- Resolve provider credentials for the canonical user on each tool call.
- Keep tool selection, authorization, and credentials as separate controls.
- Fail closed and avoid logging or forwarding reusable secondary bearer tokens.
- Bound responses and exclude images/binary payloads unless explicitly
  requested.

### Non-goals

- Making the secondary provider a Keycloak identity provider.
- Persisting secondary access or refresh tokens.
- OAuth token exchange or minting a Keycloak token for the caller.
- Replacing AgentGateway or OpenFGA.
- Using email as a permanent authorization identifier.
- Giving an unlinked identity access to project, data, or mutation tools.
- Allowing a curated profile to bypass server, tool, team, or agent policy.

## 4. Design principles

1. **One canonical authorization subject.** External identity is authentication
   evidence; Keycloak **sub** is the CAIPE authorization identity.
2. **Selection can only subtract.** A profile allowlist is not an entitlement.
3. **Credentials follow the canonical user.** The incoming secondary bearer is
   never an upstream GitHub, Jira, TOME, or other provider credential.
4. **Enforce at listing and invocation.** Filtering **tools/list** improves UX;
   checking **tools/call** provides security.
5. **No bearer token passthrough.** The edge consumes the external token. Only
   signed, short-lived canonical identity context crosses internal boundaries.
6. **Fail closed.** Invalid trust configuration, ambiguous links, unavailable
   authorization, and missing credentials deny access.

## 5. Components

~~~mermaid
flowchart LR
  C[External MCP client]
  E[CAIPE MCP edge/BFF]
  J[Secondary issuer JWKS]
  K[Keycloak user directory]
  P[(MCP profiles)]
  G[AgentGateway]
  B[OpenFGA authz bridge]
  F[OpenFGA]
  R[Credential resolver]
  V[(Provider connections)]
  M1[MCP server A]
  M2[MCP server B]

  C -->|secondary or Keycloak bearer| E
  E -->|cached JWKS read| J
  E -->|link/resolve canonical sub| K
  E -->|load selected tools| P
  E -->|service auth + signed user context| G
  G --> B
  B --> F
  E --> R
  R --> V
  G -->|provider credential header| M1
  G -->|provider credential header| M2
~~~

### 5.1 MCP edge/BFF

The edge terminates public MCP transports, validates the presented identity,
implements virtual tool aggregation, resolves profile configuration, obtains
provider credentials, and creates internal signed identity context.

### 5.2 Keycloak

Keycloak remains the canonical user directory. Secondary identity links are
admin-only custom user attributes; they are not Keycloak federated identities
because Keycloak does not authenticate the external client in this flow.

### 5.3 AgentGateway and authz bridge

AgentGateway remains the MCP policy enforcement and routing point. Because the
design explicitly does not mint or exchange a Keycloak user token, the BFF
calls AgentGateway with a CAIPE service credential plus a signed delegated-user
context. The authz bridge verifies both, checks that the service actor may
delegate, and evaluates OpenFGA as the canonical user.

### 5.4 Credential resolver

The existing MCP credential-source resolver exchanges the canonical user's
provider connection at call time. The resulting provider token is sent through
the existing provider-specific internal header and rewritten by AgentGateway
for the selected upstream.

## 6. Secondary OIDC authentication

### 6.1 Trust configuration

All four settings are required if any one is present:

| Setting | Meaning |
| --- | --- |
| **CAIPE_SECONDARY_OIDC_JWKS_URI** | HTTPS JWKS endpoint |
| **CAIPE_SECONDARY_OIDC_ISSUER** | exact expected **iss** |
| **CAIPE_SECONDARY_OIDC_AUDIENCES** | comma-separated accepted audiences |
| **CAIPE_SECONDARY_OIDC_PROVIDER_ID** | stable operator-defined provider key |

The first implementation supports one secondary provider per CAIPE deployment.
The module and stored schema allow a later list of providers without changing
the endpoint contract.

Validation requires a valid signature, **iss**, **aud**, **exp**, and **sub**.
JWKS keys are cached using the JWT library's refresh behavior. The issuer and
JWKS endpoint must use HTTPS.

### 6.2 One-time identity linking

The immutable lookup key is:

~~~text
sha256(issuer + NUL + external_sub)
~~~

Keycloak stores:

~~~text
caipe_secondary_oidc_identity_key
caipe_secondary_oidc_provider_id
caipe_secondary_oidc_issuer
caipe_secondary_oidc_sub
caipe_secondary_oidc_email
caipe_secondary_oidc_linked_at
~~~

All attributes are admin-view/admin-edit only.

Resolution order:

1. Find a Keycloak user by the immutable identity key.
2. Reject duplicate owners, a missing owner, or a disabled owner.
3. If no link exists, require a usable email claim and reject an explicitly
   unverified email.
4. Resolve exactly one existing CAIPE/Keycloak user by normalized corporate
   email.
5. Write the link, re-read owners, and roll back the write if a concurrent
   claim produced ambiguity.
6. Return the linked Keycloak **sub**; subsequent requests do not authorize by
   email.

The deployment assumption for automatic linking is that corporate email is
unique and asserted by the trusted secondary issuer. Operators that cannot
make that guarantee must disable automatic linking and use an interactive,
signed one-time link flow instead.

### 6.3 Unlinked users

An unlinked but cryptographically valid caller may:

- initialize the MCP session;
- ping;
- list the limited bootstrap catalog; and
- call **caipe_server_info**.

The bootstrap response explains that the user must sign in to the CAIPE portal
once with the same corporate email. No project, data, credential, resource, or
mutation tool is advertised or callable. The next request after the Keycloak
profile exists performs the one-time link.

### 6.4 Dual authentication

MCP endpoints attempt secondary validation only when secondary OIDC is
configured. A failed secondary validation may still be a valid Keycloak token,
so normal CAIPE bearer validation remains the fallback. A token that satisfies
neither trust domain receives HTTP 401.

## 7. Internal delegated-user context

The public secondary bearer stops at the MCP edge. For the AgentGateway hop,
the BFF uses a CAIPE service JWT and adds:

~~~text
X-CAIPE-Delegated-User-Context: base64url(canonical JSON)
X-CAIPE-Delegated-User-Signature: base64url(HMAC-SHA256)
~~~

The payload contains:

~~~json
{
  "v": 1,
  "actor_sub": "service-account-sub",
  "user_sub": "canonical-keycloak-sub",
  "provider_id": "corporate-assistant",
  "external_identity_hash": "sha256:...",
  "mcp_server_id": "github",
  "mcp_profile_id": "default",
  "iat": 1789135200,
  "exp": 1789135260,
  "nonce": "..."
}
~~~

The signature key is a dedicated deployment secret shared only by the BFF and
authz bridge. The bridge:

1. rejects delegated-user headers unless the bearer is an allowlisted service
   actor;
2. verifies canonical encoding, signature, expiry, and actor binding;
3. checks **service_account:actor can_delegate user:user**;
4. uses **user_sub** as the effective OpenFGA subject;
5. binds authorization to the requested MCP server/profile; and
6. strips the context before forwarding upstream.

This is distinct from **X-CAIPE-Agent-Context**: delegated-user context answers
“which human is represented,” while agent context answers “which configured
agent is invoking.” When both exist, both sets of checks must pass.

The implementation may reuse a common signed-context envelope, but it must not
overload one field with both meanings. Context lifetime should be at most 60
seconds. Replay resistance is provided by short expiry, route/profile binding,
TLS, service-actor binding, and optional nonce caching at the bridge.

## 8. Public MCP surfaces

### 8.1 Direct server endpoint

**/api/mcp/:serverId** resolves a registered **mcp_servers** row and exposes
that server's authorized tool catalog. Reserved IDs include **custom** and
**servers**.

The same resource URL supports MCP Streamable HTTP POST, GET, and DELETE.
OAuth protected-resource metadata is published at:

~~~text
/.well-known/oauth-protected-resource/api/mcp/:serverId
~~~

### 8.2 Curated virtual endpoint

**/api/mcp/custom** resolves the authenticated user's default profile.
**/api/mcp/custom/:profileId** resolves a named profile owned by that user.
Profiles are not shareable in the first release.

Backing tool names are namespaced to prevent collision:

~~~text
serverId__toolName
~~~

The BFF rewrites a virtual tool call to the backing server and original tool
name only after all checks pass.

### 8.3 Profile schema

~~~json
{
  "id": "default",
  "owner_subject": "keycloak-sub",
  "name": "My assistant tools",
  "enabled": true,
  "revision": 7,
  "tools": [
    { "server_id": "github", "names": ["search_repositories", "get_file_contents"] },
    { "server_id": "tome", "names": ["tome_list_projects", "tome_get_page"] }
  ],
  "output_policy": {
    "max_result_bytes": 1000000,
    "allow_images": false
  },
  "created_at": "2026-09-11T12:00:00Z",
  "updated_at": "2026-09-11T12:15:00Z"
}
~~~

The document stores tool identifiers and credential-selection references, not
access tokens, refresh tokens, secrets, or copied tool schemas. Updates use
optimistic concurrency through **revision**.

## 9. Tool discovery and invocation

### 9.1 tools/list

For each saved tool, CAIPE computes:

~~~text
visible =
  profile.enabled
  AND server.enabled
  AND server/tool exists
  AND user can_call server
  AND user can_call tool
  AND agent can_call tool (when agent context is present)
  AND required credential source is available
~~~

Unauthorized tools are omitted rather than annotated. A bounded diagnostic
extension may report counts such as “3 hidden by policy” without revealing
tool names the caller cannot discover.

The catalog is cached by user, profile revision, authorization model, and
server catalog revision for a short TTL. Permission or credential failure at
invocation still wins over any cached listing.

### 9.2 tools/call

Every call:

1. resolves the current profile and exact namespaced tool;
2. verifies the tool remains selected;
3. repeats user/server/tool OpenFGA checks;
4. repeats agent restrictions if present;
5. resolves the current user's credential sources;
6. sends service auth, signed delegated-user context, signed agent context, and
   provider credential headers to AgentGateway;
7. invokes the backing MCP server; and
8. sanitizes and bounds the result.

Missing or disconnected user credentials return a structured MCP tool error
with a CAIPE reconnection URL. CAIPE never falls back from a required caller
credential to another user's connection. Existing explicitly configured
**pinned** connections remain an administrator-owned server behavior and are
not created by personal profiles.

## 10. Authorization model

The minimum checks are:

~~~text
user:<sub> can_call mcp:<serverId>
user:<sub> can_call mcp_tool:<serverId>/<toolName>
~~~

If the call originates from a configured CAIPE agent:

~~~text
user:<sub> can_use agent:<agentId>
agent:<agentId> can_call mcp_tool:<serverId>/<toolName>
~~~

For a curated profile, profile ownership is checked before reading or updating
it. Selection is an application-level allowlist and does not need to be copied
into OpenFGA in the first release. If profiles become shareable, they should
adopt the standard CAIPE owner-team/share-with-teams model.

Once identity linking is reliable, secondary callers receive the same
read/write tool eligibility as the canonical portal user. Until a link exists,
they receive only the bootstrap tool. No blanket “secondary users are
read-only” exception remains after linking; ordinary OpenFGA and tool policies
are authoritative.

## 11. Connected credentials

Credential resolution uses **user_sub**, never secondary **sub** or email.
For a provider connection with caller scope, CAIPE finds the canonical user's
current provider connection and performs the normal exchange/refresh path. The
profile may select among that user's multiple connections by storing a
connection reference, but cannot reference another user's connection.

The incoming secondary bearer is identity evidence only. It must never be
persisted, sent to an MCP backend, used as a provider token, returned in a
result, or logged in full.

## 12. Response and streaming policy

External assistant clients should not receive multi-megabyte inline artifacts
by default.

- Default tool-result limit: 1,000,000 UTF-8 bytes after sanitization.
- Strip inline data-image and binary content by default.
- Images are included only when both the tool call explicitly asks for them
  (for example **include_images=true**) and the profile permits images.
- Prefer resource links, artifact IDs, summaries, and paginated follow-up
  tools over inline files.
- Oversized results return a compact structured tool error naming the
  pagination or artifact-retrieval alternative.
- Notification-only requests return bodyless HTTP 202.
- Finite JSON responses carry a definite body length; clients do not need
  connection EOF to detect completion.
- Streaming responses send the protocol's normal terminal event and close
  cleanly.

The output limit is enforced at the aggregation edge and should also be
enforced by backing servers as defense in depth.

## 13. Errors

| Condition | HTTP / MCP behavior |
| --- | --- |
| Missing or invalid identity | HTTP 401 with protected-resource metadata |
| Valid but unlinked secondary identity | bootstrap MCP catalog only |
| Disabled or ambiguous identity link | HTTP 403 and operator audit event |
| Server or tool denied | MCP authorization error without upstream invocation |
| Tool absent from profile | MCP invalid-params or authorization error |
| Credential missing or expired | structured tool error with reconnect action |
| OpenFGA unavailable | fail closed |
| Backing server unavailable | bounded retriable MCP tool error |
| Result exceeds output policy | bounded error with retrieval alternative |

## 14. Audit and observability

Record request ID, authentication method, provider ID, external identity-key
hash, canonical Keycloak subject, profile revision, server/tool ID, OpenFGA
decision, credential source type and connection ID, duration, result status,
and response bytes.

Never record bearer tokens, provider tokens, HMAC signatures, request bodies by
default, email in routine auth diagnostics, or inline image data. Debug mode
may record bounded unverified JWT metadata such as algorithm, key ID, issuer,
audience, time claims, token length, and a truncated SHA-256 fingerprint.

Suggested metrics:

~~~text
caipe_secondary_oidc_validation_total [provider, result]
caipe_secondary_oidc_link_total [provider, result]
caipe_mcp_tool_call_total [surface, server, tool, result]
caipe_mcp_tool_result_bytes [surface, server, tool]
caipe_mcp_profile_visible_tools [profile]
caipe_mcp_authz_duration_seconds [decision]
~~~

## 15. Security analysis

| Threat | Control |
| --- | --- |
| Forged external JWT | HTTPS JWKS verification plus exact issuer/audience |
| Email spoofing or reassignment | trusted issuer; one-time immutable issuer/sub link |
| Duplicate or racing links | duplicate detection, post-write check, rollback, audit |
| External sub collides with Keycloak sub | never authorize directly from external sub |
| Caller injects canonical user header | edge strips it; bridge requires service actor and HMAC |
| Service actor chooses arbitrary user | explicit delegation relation and actor-bound context |
| Saved profile grants access | list and call intersect with live OpenFGA decisions |
| Stale list cache | invocation always reauthorizes |
| Credential confused deputy | resolve by canonical user and server source |
| Tool-name collision | server-prefixed virtual names |
| Data exfiltration through output | image stripping, byte cap, explicit opt-in |
| Sensitive auth logs | metadata allowlist; no subject, email, token, or signature |

An operator changing issuer configuration must treat existing identity links as
security state. Provider rotation requires an explicit runbook and audit; it
must not silently relink by email.

## 16. Rollout

### Phase 0 — provider-neutral authentication foundation

- Add generic secondary OIDC validator and Keycloak linker.
- Add generic Keycloak custom attributes.
- Rename configuration to **CAIPE_SECONDARY_OIDC_***.
- Make TOME call the shared MCP auth helper.
- Keep the limited unlinked bootstrap behavior.

### Phase 1 — generic direct MCP surface

- Add **/api/mcp/:serverId** and protected-resource metadata.
- Route registered servers through AgentGateway.
- Add signed delegated-user context and bridge verification.
- Prove secondary and Keycloak callers receive identical OpenFGA outcomes.

### Phase 2 — default curated profile

- Add profile persistence and management API/UI.
- Add **/api/mcp/custom**, namespaced discovery, and call dispatch.
- Reuse caller-scoped connected-provider credential resolution.

### Phase 3 — named profiles and output controls

- Add **/api/mcp/custom/:profileId**.
- Add per-profile image/output controls and optional connection selection.
- Add revision-aware caching and catalog-health feedback.

### Phase 4 — hardening and broader providers

- Add interactive linking where trusted unique email is unavailable.
- Add multiple secondary issuer configurations if demanded.
- Add key rotation, link revocation, admin inspection, and migration tooling.

Each phase is independently feature-gated. Shadow metrics should compare the
canonical subject and OpenFGA decision with the existing Keycloak path before
secondary callers can invoke mutation tools.

## 17. Test strategy

### Unit

- incomplete config, non-HTTPS JWKS/issuer, bad provider ID;
- issuer/audience/expiry/signature failures;
- first link, existing link, disabled user, ambiguous owner, email mismatch,
  explicit unverified email, and concurrent-link rollback;
- delegated context tampering, expiry, wrong actor/server/profile;
- profile ownership, namespace collisions, stale selection, and output limits.

### Integration

- secondary JWT to Keycloak link to canonical OpenFGA subject;
- Keycloak JWT and linked secondary JWT produce the same tool catalog;
- unlinked JWT sees only bootstrap tools;
- BFF service token plus delegated context reaches AgentGateway and bridge;
- connected credentials resolve for the canonical user and are refreshed;
- denied tools never reach an MCP backend;
- notification requests terminate with bodyless HTTP 202;
- large and image responses are stripped or rejected according to policy.

### End to end

1. Create a portal user and provider connection.
2. Call **/api/mcp/custom** with a secondary JWT sharing the corporate email.
3. Verify one Keycloak link is created.
4. Select a read and write tool.
5. Verify **tools/list** contains only selected and authorized tools.
6. Invoke both and verify audit attribution to the Keycloak subject.
7. Revoke the write grant and verify the next call fails without upstream
   execution.
8. Disconnect the provider and verify a structured reconnect response.
9. Request an image explicitly and verify default denial/profile opt-in.
10. Submit an oversized result and verify the bounded response.

## 18. Alternatives considered

### Token exchange into Keycloak

Rejected for the first design because the external issuer does not provide or
require an exchange flow, and CAIPE does not need to issue a new token to
validate a signed bearer. It remains a possible future simplification if the
provider supports standards-compliant exchange.

### Validate the secondary JWT directly in AgentGateway

Insufficient by itself: AgentGateway would know the external subject, not the
canonical Keycloak subject. Teaching the data-plane bridge to query Keycloak
for every call would add directory availability and admin-read concerns to the
hot path. Edge resolution plus signed internal context avoids that dependency.

### Store links or profiles only in MongoDB

Profiles belong in application persistence, but the external-to-canonical
identity link is security identity state and should be visible and
administrator-controlled in Keycloak. This aligns with existing Slack/Webex
external identity attributes while remaining independent of an MCP server.

### One public endpoint per selected tool

Rejected because it creates unstable configuration, many OAuth resources, and
poor client UX. A stable virtual MCP resource with namespaced tools preserves
MCP discovery and centralized policy.

## 19. Relationship to the Bindery proposal

No document, issue, discussion, branch, or code reference named “Bindery” was
discoverable in the public CAIPE/CNOE repositories as of 2026-09-11. Public
search results with that name refer to unrelated book projects. A factual
architecture comparison requires the Bindery proposal URL or document.

Once supplied, compare it against this design using this decision matrix:

| Dimension | This proposal | Bindery |
| --- | --- | --- |
| Primary scope | external identity linking plus direct/curated MCP federation | Pending source |
| Canonical human identity | Keycloak subject after immutable external link | Pending source |
| Token model | local secondary JWT validation; no exchange/issuance | Pending source |
| Gateway propagation | service JWT plus signed delegated-user context | Pending source |
| Authorization | OpenFGA at server/tool call, fail closed | Pending source |
| User customization | per-user tool allowlist; selection only subtracts | Pending source |
| Connected credentials | canonical user's connection resolved at call time | Pending source |
| Upstream bearer handling | secondary token is never forwarded | Pending source |
| Response controls | bounded output; images off unless requested | Pending source |
| Deployment shape | BFF, Keycloak, AgentGateway, authz bridge | Pending source |

The comparison must distinguish complementary scope from competing scope. A
Bindery design focused on packaging or binding an MCP inventory could
complement this proposal, while one owning identity resolution, credential
brokering, or virtual tool federation would overlap.

## 20. Acceptance criteria

- [ ] No TOME- or provider-specific name exists in shared secondary auth code.
- [ ] All four **CAIPE_SECONDARY_OIDC_*** settings are required together.
- [ ] A verified secondary identity resolves to one canonical Keycloak subject.
- [ ] Unlinked identities receive bootstrap access only.
- [ ] The secondary bearer is never persisted, logged, or forwarded upstream.
- [ ] Direct MCP endpoints authorize every server/tool call through OpenFGA.
- [ ] Curated profiles can only reduce the caller's effective tool set.
- [ ] Provider credentials belong to and are resolved for the canonical user.
- [ ] Images are excluded by default and require explicit request plus policy.
- [ ] Oversized tool results return a bounded response.
- [ ] Keycloak and linked-secondary callers receive equivalent authorization.
- [ ] Bindery comparison is completed when its authoritative source is linked.
