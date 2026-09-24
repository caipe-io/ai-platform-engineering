# BFF authorization and Access API

## Access API contract

Foundation routes, with no consumer migration in this change:

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /api/access/check` | `{resource: {type, id}, action}` | CAS `{decision, reason, retriable, ttl_seconds?, via?}` |
| `POST /api/access/query` | `{resource_type, action, ids}` | `{ids: [...]}` containing allowed candidates only |
| `POST /api/access/grants` | `{resource: {type, id}, grantee: {type, id?}, capability}` | `{granted: true}` |
| `DELETE /api/access/grants` | Same as POST grants | `{revoked: true}` |

- Authenticate with a verified bearer token or the existing session cookie.
  The subject is always the authenticated caller. No body `subject`, `context`,
  `trustedContext` or delegation headers are consumed by this API.
- Send `Content-Type: application/json`. Cookie authentication additionally
  requires `Origin` matching `NEXTAUTH_URL` (or the request origin when unset).
  Set `NEXTAUTH_URL` to the public BFF URL when behind a reverse proxy.
  Server-to-server bearer requests do not need an Origin header.
- Actions/resource types reuse `rbac/resource-model.ts`; IDs reuse CAS validation.
  Unknown top-level fields and unsupported action/resource pairs are rejected.
- Query accepts 0–200 candidate IDs; output is deduplicated in input order.
  It is a filter, not a resource catalog, existence check or pagination service.
  Do not use an empty result to hide an unavailable authorization dependency.
- Grants reuse CAS management checks, public-grant restrictions and audit.
  A successful revoke removes that direct grant; team or other grants may still
  authorize the principal. Resource creation/deletion remains with its owner.
- All responses have `Cache-Control: no-store`. CAS's internal cache behavior
  is unchanged; this API does not promise immediate cross-replica revocation.

### Failure semantics

| Status | Meaning |
| --- | --- |
| `200` | Completed check (ALLOW **or DENY**), complete query, or acknowledged mutation |
| `400` | Invalid JSON, fields, identifiers, content type or unsupported action |
| `401` | Missing/invalid authentication or no usable subject |
| `403` | Credential/origin rejected, or insufficient permission to change grants |
| `503` | Authentication/authorization unavailable; never an ALLOW or partial query |
| `500` | Unexpected failure; a mutation's outcome may be unknown |

Errors have `{error, code, retriable}`. A failed mutation is not automatically
retried: an upstream write might have succeeded before its response was lost.
Callers must enforce decisions server-side; this is not a browser-only gate.

### Examples

Check your own agent access:

```json
{"resource":{"type":"agent","id":"example"},"action":"use"}
```

Filter a page of agents:

```json
{"resource_type":"agent","action":"use","ids":["example","secondary"]}
```

Grant or revoke team access (caller needs management permission):

```json
{"resource":{"type":"agent","id":"example"},"grantee":{"type":"team","id":"example-team"},"capability":"use"}
```

TypeScript contracts: `access-contract.ts`. HTTP handlers: `access-http.ts`.
Routes are thin entry points. Existing `/api/authz/v1/*` consumers are unchanged;
their eventual migration should remove obsolete paths rather than maintain
permanent aliases. Trusted gateway/delegation APIs are not implemented here.

## OpenFGA transport

One connection layer; permission rules still belong to the callers.

```text
CAS policy engine ──────────────┐
                               ├─ engines/openfga-client.ts ─ OpenFGA
RBAC relationship helpers ──────┘
```

- `engines/openfga-client.ts` owns the endpoint, HTTP headers, trace propagation
  and shared store discovery. Concurrent callers share one discovery request.
- `engines/openfga.ts` retains CAS decisions, decision caches, circuit breaker
  and grant/revoke behavior.
- `../rbac/openfga.ts` retains relationship construction, batch limits, exact
  tuple reads and compensating writes. Its existing exports remain available.
- API routes use CAS or the relationship helpers, never the private client.
  ESLint permits only the existing RBAC helper to cross that boundary.

Discovery failures can be retried on the next call. A 404 forgets the discovered
store for both callers; no operation is automatically replayed. An explicitly
configured `OPENFGA_STORE_ID` remains authoritative. CAS now propagates an active
authorization trace, as RBAC already did.

This is transport consolidation, not yet policy consolidation. Cache freshness,
model selection, timeouts and migration of legacy checks remain separate work.
The platform health route keeps its independent diagnostic probe. Python services
and the gateway authorization bridge are outside this BFF change.
