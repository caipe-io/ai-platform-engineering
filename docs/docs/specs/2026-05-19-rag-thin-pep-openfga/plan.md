# RAG Thin PEP Around OpenFGA Plan

## Goal

Refactor RAG authorization so the vector service behaves as a policy enforcement point
(PEP), not a policy engine. OpenFGA remains the source of truth for datasource and
knowledge-base access, while the BFF constrains browser/UI requests before proxying.

## Current State

`server/rbac.py` currently combines several responsibilities:

- token validation and role mapping
- Keycloak realm-role compatibility checks
- OpenFGA `check` and `list-objects`
- MongoDB `team_kb_ownership` reads
- datasource filter injection
- optional document ACL filtering

That coupling makes query serving depend on multiple policy stores and creates duplicate
PDP calls for BFF-proxied UI requests.

## Target Call Paths

| Caller | Expected RAG behavior |
|--------|-----------------------|
| Browser through BFF | Validate forwarded JWT, trust BFF-constrained datasource IDs, run vector search. |
| Direct API user | Validate JWT, run one OpenFGA check/list for requested datasource action, run vector search. |
| Ingestor service account | Validate service token, check `service:<id> can_ingest knowledge_base:<id>`, run ingest. |
| Agent/MCP caller | Validate JWT, check/constrain datasource access before tool execution. |

## Migration Slices

1. Add explicit tests for UI-proxied search, direct API search, ingestor access, and MCP search.
2. Extract token parsing from `server/rbac.py` into a small identity helper.
3. Extract OpenFGA datasource checks into a small PEP helper with no MongoDB dependency.
4. Remove `team_kb_ownership` reads from query hot paths after backfill/drift checks exist.
5. Keep document ACL as an optional second filter only if it is explicitly enabled and documented.

## Non-Goals

- Do not remove BFF datasource filtering.
- Do not remove direct-client RAG OpenFGA checks.
- Do not use Keycloak realm roles as the long-term source of product authorization.
- Do not require document reindexing for team membership changes.

## Acceptance Checklist

- [ ] BFF-proxied UI search avoids redundant OpenFGA list/check calls when datasource IDs are already constrained.
- [ ] Direct clients and ingestors still fail closed through explicit OpenFGA checks.
- [ ] MongoDB `team_kb_ownership` is no longer required in the query hot path.
- [ ] Legacy `kb_reader:*` / `kb_ingestor:*` role parsing is removed or isolated as a temporary fallback.
- [ ] Tests cover allowed and denied datasource access for UI, direct API, ingestor, and MCP flows.

Tracked by [#1457](https://github.com/caipe-io/ai-platform-engineering/issues/1457).
