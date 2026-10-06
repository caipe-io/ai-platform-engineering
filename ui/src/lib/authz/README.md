# BFF authorization and Access API

Ongoing consolidation uses the [CAS integration workflow](../../../../.github/CAS_INTEGRATION.md).

## Access API contract

Foundation routes for remote consumers; BFF callers use CAS in process:

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
- All responses have `Cache-Control: no-store`. Single `agent/use` decisions
  bypass the BFF decision cache; other actions and queries retain their caches.
  This API does not promise immediate system-wide revocation.

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

The shared agent-use guard now calls CAS in process with the canonical subject;
it never retries email or enumerates teams. Single `agent/use` checks ignore
cached batch decisions, send `consistency: HIGHER_CONSISTENCY`, and return
`ttl_seconds: 0` on a definitive answer. A five-second abort signal covers
discovery and check response consumption. Shared store discovery also has its
own five-second timeout, including when initiated by a legacy caller.
Batch/list queries retain existing caching; do not use them to enforce execution.
The existing workflow trusted-context policy is unchanged; the guard supplies none.

Other actions, model selection and migration of remaining legacy checks are
separate work. Writes are not replayed and do not inherit the check deadline.
The platform health route keeps its independent diagnostic probe. Python services
and the gateway authorization bridge are outside this BFF change.

## Agent grant lifecycle — recovery draft

```text
Save → Mongo: settings + pending operation (one atomic write)
                    ↓
             CAS → OpenFGA → mark applied → UI confirms completion
                    ↓ unavailable / interrupted
             pending operation → another BFF replica retries

Picker GET → read candidates → permission filter (no grant writes)
```

- Agent editor, deletion and default-selection saves use `permission-sync.ts`.
  Settings and a private recovery journal are committed together, before graph
  writes. No Mongo transaction or separate microservice is required.
- Snapshot conflicts and an already-pending operation return HTTP **409** without
  starting a new graph write. Do not stack changes while a save is pending.
- HTTP **202**, `permission_sync.state: pending`, means settings were accepted,
  **not** that access changed. Previous access can still work until revocation
  completes. A normal success response follows confirmed application.
- The Save spinner runs only during the request. Pending status survives reload
  and polls `GET /api/access/operations/:id` (read-only, no-store). The initiating
  principal or a resource manager can read the safe reference/state/timestamps;
  tuple intent, leases and actor context remain server-side. Deleted/superseded
  references return 404: reload resource state, do not infer completion.
- Each BFF starts recovery on boot and scans due work every 15 seconds, at most
  100 documents per collection per scan. A 30-second renewable Mongo lease
  coordinates attempts; projection requests have a five-second abort signal.
  These intervals are **not** a recovery SLA during outages or backlog.
- Retries remove access before adding access, using exact stored-tuple reads.
  They never undo a revocation by restoring an old configuration snapshot.
  Completed operations discard their old diffs so later unrelated grants are
  not removed by replaying historical deletes.
- A public human grant survives while the agent is global **or** the effective
  platform default. Clearing a database default restores `DEFAULT_AGENT_ID`, if
  configured. Default selection does not itself grant service-account access.
- Startup agent sweeps use the same journal and skip pending resources. Login
  retains baseline user/team grants but no longer repairs the default-agent tuple.

Without `OPENFGA_HTTP`, storage-only saves still run once; this does not
bypass route authentication or permission checks or make those routes usable
without their existing dependencies. If OpenFGA **is configured** but
`OPENFGA_RECONCILE_ENABLED` is false or invalid, permission-changing saves fail
with `ACCESS_WRITES_DISABLED`. An unset flag defaults to enabled. A reachable
authorization service with writes disabled is not a no-authorization mode.

### Must resolve before merging this draft

[#2854](https://github.com/caipe-io/ai-platform-engineering/issues/2854) remains
an open release gate. This is not an atomic Mongo/OpenFGA transaction.

- **Late writes:** a Mongo lease fences journal completion, not an OpenFGA write
  already in flight. A delayed old worker could write after a newer operation.
  Aborting an HTTP request does not prove the server cancelled it. Resolve and
  test this ordering before calling recovery safe across replicas.
- **All writers:** complete the ownership audit, including Hello World bootstrap,
  raw grant administration and concurrent default/visibility changes. Reading
  shared reasons again reduces races but is not a cross-document lock.
- **Real crash proof:** kill a worker at the persistence/write/ack boundaries;
  recover on a second replica against real MongoDB and OpenFGA. Unit tests with
  mocked I/O do not establish this guarantee or a bounded recovery time.
- **Operations:** pending status/reference and correlated server errors are
  visible today. Retention of completed deletion receipts, backlog monitoring
  and the Admin decision/recovery view need explicit rollout coverage.

Other callers of `reconcileTupleDiff` retain their existing write-then-persist
and repair-required **503** contract. Do not interpret that response as a safe
409 or assume this migration covers every resource. Existing picker caches and
team-membership writers are unchanged.

## Isolated agent-use model tests

Start a disposable local OpenFGA server (the chart currently uses v1.15.1):

```sh
openfga run --datastore-engine memory --http-addr 127.0.0.1:18080 --grpc-addr 127.0.0.1:18081 --metrics-enabled=false --playground-enabled=false
```

From `ui/`, run:

```sh
OPENFGA_AGENT_USE_TEST_URL=http://127.0.0.1:18080 npm test -- --config jest.openfga.config.js --runInBand
```

This exercises the real guard, CAS and chart model, with only audit delivery mocked.
It creates and deletes its own test store. Use an isolated server, never a tunnel
to a shared deployment. Without the URL, ordinary unit runs skip this suite.
