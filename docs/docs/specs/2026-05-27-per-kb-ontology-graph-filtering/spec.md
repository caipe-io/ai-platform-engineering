# Per-KB Ontology Graph Filtering (Phase 4 Follow-Up)

**Branch**: TBD &middot; **Date**: 2026-05-27 &middot; **Status**: Partially implemented

> **2026-08 update:** datasource-provenance filtering is implemented for the
> data graph. The ontology store still has no datasource provenance; bounded
> callers now fail closed on ontology REST/MCP reads and use the scoped Data
> view. This spec remains open for a provenance-aware ontology design.

**Origin**: Phase 5 of the 2026-05-27 fine-grained KB ReBAC plan
deliberately deferred per-entity ontology-graph filtering. That phase
gates the Knowledge Bases &rarr; Graph tab on "the caller can read at
least one KB" (or is `organization#admin`) and shows an info banner
warning that the entities displayed are the global ontology. This spec
covers the RAG-server work required to actually narrow the Neo4j result
set to the KBs the caller is granted on.

## Goal

A non-admin user with `knowledge_base:k1#can_read` (and no other KB
grants) should see only entities whose `_datasource_id == k1` when they
load the Graph tab. Admins (`organization#admin`) keep the unfiltered
view and the existing banner. The caipe-ui BFF must not perform a
client-side post-filter on entities &mdash; the filter must be applied
inside the Neo4j query so the response size scales with the
authorisation scope.

## Non-Goals

- Editing the ontology model itself.
- Per-entity ACLs (entities below the KB layer keep KB-level
  authorisation).
- Cross-tenant or cross-org graph isolation. That stays single-org for
  this delivery.
- UI redesign of the Graph view. The existing controls and overlays
  stay.

## Background &mdash; what exists today

- The RAG server exposes graph endpoints under
  `ai_platform_engineering/knowledge_bases/rag/server/src/server/restapi.py`
  (`/v1/graph/explore`, `/v1/graph/schema`, related entity-detail
  routes).
- Each ingested entity already carries a `_datasource_id` property
  written by the ingestor pipeline (Neo4j label / property naming may
  vary across entity types &mdash; see the ingestor module for the
  authoritative list).
- The caipe-ui BFF proxies these endpoints via
  `ui/src/app/api/rag/[...path]/route.ts` and already applies KB-level
  filtering on `GET /v1/datasources` and `GET /v1/mcp/custom-tools`.
- The Knowledge Bases &rarr; Graph page (`ui/src/app/(app)/knowledge-bases/graph/page.tsx`)
  now consumes `useKbTabGates` and shows an amber "global entity graph"
  banner.
- OpenFGA exposes per-KB reader grants as `knowledge_base:<id>#can_read`
  (model in `deploy/openfga/model.fga`).

## Proposed design

### 1. Authorisation surface

The caipe-ui BFF resolves the caller's readable-KB set with the
existing helper `loadReadableKnowledgeBases` (or a thin wrapper that
returns just the IDs). For org admins the set is the literal sentinel
`"__all__"` &mdash; the BFF must not enumerate every KB in the deployment
when the caller is allowed everything.

The BFF forwards the resolved scope to the RAG server on every graph
request as either:

- header `X-Caipe-Kb-Scope: <comma-separated ids>` for the bounded case,
  or
- header `X-Caipe-Kb-Scope: *` for the org-admin case.

The header is added by the BFF only after the BFF itself has performed
the OpenFGA check &mdash; the RAG server must treat the header as advisory
and re-derive scope from its own OpenFGA client when the request is
direct (no BFF). The two paths converge on the same scope helper inside
the RAG server.

### 2. RAG server filter

In `restapi.py` graph handlers:

1. Resolve `allowed_ids: list[str]` from either the BFF header (when
   the request carries a valid signed BFF identity) or via a direct
   OpenFGA `list_objects` call keyed on `knowledge_base#can_read`.
2. If `allowed_ids == []` &rarr; return `204 No Content` with an empty
   graph payload. The caipe-ui Graph view already renders an empty
   canvas in this case.
3. If `allowed_ids == "*"` (admin bypass) &rarr; skip the Cypher filter
   and run the existing query unchanged.
4. Otherwise rewrite the Cypher to constrain on `_datasource_id`:

```cypher
MATCH (n)
WHERE n._datasource_id IN $allowed_ids
WITH n
... existing graph traversal ...
```

Edges that cross the boundary (entity inside scope &harr; entity
outside scope) must be elided so the caller does not learn that an
out-of-scope entity exists. The implementation must add a second
`WHERE m._datasource_id IN $allowed_ids` on the relationship target.

### 3. Performance budget

- `allowed_ids` length limit: **256 KBs**. Beyond that, return `400 Bad
  Request` from the BFF with guidance to either ask an org admin to add
  the user to a team-scoped KB group or contact platform engineering to
  raise the limit. 256 keeps the Neo4j `IN` clause comfortably within
  the per-query planning budget on the current deployment size.
- Cypher must use a parameterised `IN $allowed_ids` rather than string
  interpolation (security + plan cache hits).
- For org admins the unfiltered query path is unchanged from today, so
  no regression for the existing common case.

### 4. Caching

The BFF caches the resolved scope per session for **30 seconds**
(matches the existing KB-tab-gate hook). Cache key includes the user
subject and the OpenFGA store id. Cache busts on team-membership
change events the BFF already publishes.

### 5. Telemetry

- `rag_graph_scope_size` &mdash; histogram of `len(allowed_ids)` per
  request, with a label `scope=admin|bounded|empty`.
- `rag_graph_request_total{scope}` &mdash; counter.
- `rag_graph_filter_rewrites_total` &mdash; counter, increments on every
  bounded-scope query so we can see filter coverage.

## Files we expect to touch

- `ai_platform_engineering/knowledge_bases/rag/server/src/server/restapi.py`
  &mdash; add scope resolver and rewrite graph Cypher.
- `ai_platform_engineering/knowledge_bases/rag/server/src/server/rbac.py`
  &mdash; add `list_readable_kb_ids(user_sub)` OpenFGA helper.
- `ai_platform_engineering/knowledge_bases/rag/server/src/server/graph.py`
  (or wherever the Cypher templates live today) &mdash; parameterise.
- `ui/src/app/api/rag/[...path]/route.ts` &mdash; resolve KB scope and
  attach `X-Caipe-Kb-Scope` for graph paths.
- `ui/src/app/(app)/knowledge-bases/graph/page.tsx` &mdash; refine the
  banner copy once filtering is live (e.g. "Showing entities from N
  knowledge bases you can read").
- `docs/docs/security/rbac/architecture.md` and `pdp-coverage-audit.md`
  &mdash; flip the Graph row from "covered (tab gate only)" to "covered
  (per-entity filter)".

## Acceptance criteria

1. A non-admin caller with `knowledge_base:k1#can_read` (and no other
   KB grant) calling `GET /v1/graph/explore` receives only entities with
   `_datasource_id=k1`. Verified with an integration test seeded with
   entities across at least 3 datasources.
2. An admin caller (`organization:caipe#admin`) calling the same
   endpoint receives entities across all datasources. Verified with the
   same integration test plus a privileged caller.
3. A caller with zero readable KBs receives `204 No Content` and the
   Graph view renders the existing empty state.
4. The Cypher generator emits parameterised `$allowed_ids`. Verified
   with a unit test on the query builder.
5. The BFF rejects requests where the resolved scope exceeds 256 KBs.
6. `rag_graph_request_total{scope="bounded"}` and
   `rag_graph_filter_rewrites_total` increment 1:1 in bounded mode.

## Risks &amp; trade-offs

- **Implicit graph holes.** Eliding cross-boundary edges means an
  entity may appear "disconnected" to a scoped caller when the bridging
  entity lives in a different KB. This is the intended behaviour but
  worth surfacing in the Graph tooltip.
- **Cypher plan churn.** Adding `IN $allowed_ids` may shift the
  optimiser onto an index scan on `_datasource_id`. We need to verify
  that index exists in all environments (it is created by the ingestor
  bootstrap script today; confirm before rollout).
- **256-KB ceiling.** For tenants with very large fan-out the BFF will
  start to 400. That is a deliberate forcing function to encourage team
  scoping; raising it requires explicit ops approval.

## Out of scope (explicit non-goals)

- Refactoring the ontology model.
- Per-entity ACLs.
- Changes to ingestion or the way `_datasource_id` is written.
- Multi-org/multi-tenant graph isolation.

## Open questions

1. Should the BFF cache the scope longer (5&nbsp;min) once the team
   membership eventing pipeline is fully live? Today 30&nbsp;s matches
   the tab-gate hook for predictable cache invalidation.
2. Do we need a richer scope header (e.g. signed JWT-shaped payload)
   for defence-in-depth, or is the BFF identity check enough?
3. Should we emit a per-KB `rag_graph_scope_kb_total{kb_id}` counter
   for utilisation analytics, or is the histogram on the size
   sufficient?

## Related work

- Cursor plan
  `.cursor/plans/caipe-fine-grained-rbac-kb-graph-mcp_b6961a8b.plan.md`
- Spec [2026-05-18 RAG Team ReBAC](../2026-05-18-rag-team-rebac/plan.md)
- [RBAC architecture](../../security/rbac/architecture.md)
- [PDP coverage audit](../../security/rbac/pdp-coverage-audit.md)

<!-- assisted-by Cursor claude-opus-4-7 -->
