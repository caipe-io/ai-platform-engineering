# Research: Private Resources and Personal Execution

## Executive Finding

The repository already has pieces of private ownership, but not one end-to-end policy:

- Dynamic agents deliberately retired private visibility in favor of team ownership.
- MCP servers can already receive a direct human owner tuple, but lack an explicit visibility/share experience.
- User-owned secret credentials are already private by default and support team sharing.
- Slack and Webex already distinguish direct from group conversations and link platform identities to an OIDC subject.
- CAS centralizes decisions and tuple administration, but its trusted context currently carries only workflow data and its OpenFGA adapter does not forward request context.

Therefore the recommended design is:

- model personal ownership with stored direct-user tuples;
- allow authenticated owner use in the Web UI and enforce direct-message-only use in Slack and Webex through a CAS product-policy deny based on server-derived context;
- keep resource configuration as source of truth;
- reconcile every lifecycle tuple change through CAS;
- fail closed while Mongo and OpenFGA are not at the same authorization revision.

## Repository Evidence

### Dynamic agents

- `ui/src/types/dynamic-agent.ts` defines `VisibilityType = 'team' | 'global'`.
- Legacy `private` documents are accepted only for compatibility and coerced to `team`.
- Commit `096a8b159` retired private agent visibility and documented the policy: use a one-person team for personal ownership.
- The agent OpenFGA type already has:
  - audit-only `creator`;
  - functional `owner` for a direct user or service account;
  - team/channel/bot-installation grants;
  - `can_use` and `can_manage` derived from `owner`.
- Agent tuple reconciliation still has direct calls to `writeOpenFgaTupleDiff`; private-resource work should move all lifecycle mutations behind CAS.

### MCP servers

- The create route accepts an optional owner team and always records the creator/owner subject.
- `reconcileMcpServerRelationships` already uses CAS `reconcileTupleDiff`.
- The OpenFGA `mcp_server` model already derives read/use/invoke/manage from direct `owner`.
- The editor does not expose resource owner/share controls; the visible team picker is for AgentGateway routing, not ownership.
- `mcp_server` has no audit-only `creator` relation, unlike `agent`.

### Credentials

- `POST /api/credentials/secrets` defaults ownership to the signed-in user identified by stable `session.sub`.
- Secret metadata stores an owner and `sharedWithTeams`; the credentials UI already includes a sharing panel.
- The `secret_ref` model deliberately separates metadata read, use, manage/share, and audit capabilities.
- `secret-openfga.ts` still writes tuple diffs directly rather than through CAS.
- OAuth provider connections are caller-scoped and resolved at runtime. Copying or team-sharing their token sets would weaken the current isolation model.

### Slack direct messages

- The bot distinguishes DMs from shared contexts and has direct-message-only commands/preferences.
- The current bot-facing `/api/user/check_agent_access` route checks the linked user's direct grant plus team union.
- The endpoint does not receive a trusted DM assertion. It is safe only because callers currently decide when to invoke it; that boundary should become explicit and centrally auditable in CAS.
- Channel flows use separate team/channel mapping. Private resources require a strict rule that channel paths never fall back to direct human ownership.

### Webex direct messages

- Webhook parsing treats `roomType=direct` as 1:1 and everything else as shared.
- Direct users are mapped to a Keycloak/OIDC subject before OBO authorization.
- Group spaces resolve a team and check a space grant separately.
- Missing room type currently yields `is_direct=false`, which is the correct fail-closed baseline.

### CAS

- `TrustedAuthorizeContext` currently contains only `workflowRunId`.
- CAS `compose()` supports a `preCheck`, which can deny before OpenFGA and is the correct seam for private-surface policy.
- Public advisory `context` is documented as narrowing-only.
- The OpenFGA adapter includes advisory context in its cache key but sends only the tuple key to `/check`; it does not send OpenFGA `context`.
- CAS tuple reconciliation already provides centralized audit and cache invalidation for callers that use it.

## OpenFGA Research

Only official OpenFGA documentation was used.

### Direct ownership is a standard relationship pattern

OpenFGA's roles/permissions guidance models a user assigned directly to an owner relation and derives permissions from that relation. This matches the existing `agent` and `mcp_server` models and is sufficient for answering “is this human the private owner?”

- [Roles and permissions](https://openfga.dev/docs/modeling/roles-and-permissions)
- [Getting started modeling](https://openfga.dev/docs/modeling/getting-started)

### Contextual tuples are request-scoped, not durable ownership

Contextual tuples apply only to the request, are not persisted, have a bounded count, and can override the same stored tuple key for that request. They are useful when the relationship itself is ephemeral, but Slack/Webex conversation classification is better treated as trusted product context that narrows a durable owner grant.

- [Contextual tuples](https://openfga.dev/docs/interacting/contextual-tuples)
- [Organization-context authorization](https://openfga.dev/docs/modeling/organization-context-authorization)

### Conditions are possible, but not the phase-1 choice

OpenFGA conditions can use runtime context and could encode a surface condition on a relationship. They are not recommended here for phase 1 because:

- the current CAS OpenFGA adapter does not forward context;
- not all policy-enforcement points use CAS;
- conversation classification must come from a trusted event boundary, not arbitrary check input;
- a CAS product-policy deny is easier to apply consistently to discovery, manage, use, invoke, and secret resolution.

- [Conditions](https://openfga.dev/docs/modeling/conditions)

### Tuple writes are atomic inside OpenFGA

OpenFGA supports writes and deletes in one request; the operation succeeds or fails as a unit. This is appropriate for private ↔ team transitions that fit within the request tuple limit. It does not create a transaction with MongoDB, which is why the spec adds a revisioned pending state.

- [Update relationship tuples](https://openfga.dev/docs/getting-started/update-tuples)

### Revocation-sensitive checks need stronger consistency

OpenFGA's default latency-optimized consistency may serve cached results. Higher consistency should be used to verify a visibility transition or sensitive revocation before CAS marks the new authorization revision ready.

- [Consistency](https://openfga.dev/docs/interacting/consistency)

### MCP authorization must be checked at invocation

OpenFGA's MCP authorization guidance treats every tool call as an authorization decision for the calling principal. Discovery filtering is not sufficient; runtime invocation must independently check the MCP server/tool.

- [MCP server authorization](https://openfga.dev/docs/use-cases/mcp-server-authorization)

## Alternatives Considered

### Alternative A - One-person teams

Use today's agent policy and tell users to create a personal team.

**Rejected as the target design**:

- a team is an administrative group, not an ownership mode;
- accidental membership changes silently broaden personal access;
- Channel-aware execution still is not expressed;
- MCP and credential UX remain inconsistent.

One-person teams remain a backward-compatible workaround until rollout completes.

### Alternative B - OpenFGA conditions on every owner tuple

Write conditional owner tuples requiring a `surface` value.

**Deferred**:

- it would centralize the condition in the graph;
- however, the present adapter does not send context and several PEPs bypass CAS;
- callers could misclassify context unless the trusted envelope problem is solved first;
- conditions would not solve Mongo/OpenFGA lifecycle consistency.

Re-evaluate after all PEPs use CAS and the trusted context contract has been proven.

### Alternative C - Contextual tuples for each DM request

Do not store owner authority; inject an ephemeral user relationship into each request.

**Rejected**:

- ownership is durable and should be queryable/auditable;
- contextual tuples are request-local and add complexity to discovery and management checks;
- they do not replace the need for persisted source-of-truth ownership.

### Alternative D - Static owner tuples only

Use the existing direct owner relation and rely on each bot to call it only from DMs.

**Rejected**:

- group paths could accidentally fall back to the direct human grant;
- policy would be duplicated and difficult to audit;
- local/API/scheduled execution could reuse the same owner grant without a surface restriction.

### Alternative E - CAS product-policy gate plus static tuples

Store durable ownership in OpenFGA and have CAS allow private data-plane use only when trusted context proves authenticated personal web/API use or a Slack or Webex direct conversation.

**Selected**:

- matches existing CAS composition;
- separates relationships (“who”) from request environment (“where”);
- can deny before OpenFGA and cannot expand authority;
- works without an immediate OpenFGA model-wide conditional migration;
- creates one auditable, action-aware rule: authenticated owners may use private resources in the Web UI or user-scoped API; Slack/Webex use requires a direct conversation; group, service-account, delegated-agent, and scheduled contexts deny.

## Consistency Decision

### Problem

Resource config and OpenFGA cannot be committed in one distributed transaction.

### Selected approach

Use config-first desired state with a fail-closed revision gate:

1. write the new resource config with incremented `authz_revision` and `pending` state;
2. reconcile the complete desired tuple diff through CAS;
3. invalidate caches and verify with higher consistency;
4. mark ready only through a compare-and-set on the same revision;
5. retry pending/error revisions idempotently.

Here “compare-and-set” applies to publishing the reconciliation state. CAS in this repository continues to mean **Centralized Authorization Service**.

### Rejected sequencing

- **Mongo-only then best-effort OpenFGA**: can advertise access before enforcement is ready.
- **OpenFGA-first then Mongo**: can leave orphan grants if persistence fails.
- **Dual write without revision/pending state**: concurrent updates can publish stale policy.

## Security Invariants

- A direct-message label is trusted only when derived from a verified platform event or server-side platform lookup.
- A private resource has no wildcard, team, channel/space, organization, external-group, service-account, or agent-principal grant.
- Group authorization never evaluates a private owner's direct user tuple.
- An allow for an agent does not imply authority over its MCP server, tool, secret, or OAuth connection.
- A broader parent cannot depend on a narrower child.
- Credential values and resolved headers never enter CAS requests, OpenFGA tuples, or audit logs.
- Unknown context, stale projection, and authorization-service failure all deny private execution.

## Recommended Delivery Slices

1. **CAS and schema foundation**: trusted interaction context, visibility fields, revision/pending state, decision reasons.
2. **Credential normalization**: preserve existing user-private secrets, move tuple writes through CAS, keep OAuth connections caller-scoped.
3. **Private MCP**: explicit UI/model, creator provenance, CAS reconcile, per-invocation enforcement.
4. **Private agent**: restore private visibility, owner execution in web/direct messages, and prohibit defaults and group routing.
5. **Dependency enforcement and migrations**: validate parent/child visibility and classify existing MCP data.
6. **Rollout and observability**: feature flag, drift report, context-deny metrics, retry/admin repair.
