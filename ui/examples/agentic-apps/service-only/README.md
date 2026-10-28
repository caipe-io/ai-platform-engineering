# Native resources through CAS

This service-only App Contract example needs no UI package or proxy origin.
Iframe and native apps use the same backend APIs. The service stores its business
data and enforces each CAS decision; it receives no OpenFGA credentials.

| File | Purpose |
| --- | --- |
| `manifest.json` | Declares `host.access.resources@1.0` |
| `model.fga` | Native OpenFGA module with separate execution/termination permissions |
| `model.json` | Equivalent native type used by the API integration tests |

## Operator installation

Bind the existing App Contract installation to:

```yaml
bindings:
  serviceAccountClientId: example-client
  authorizationModule: example-service
```

Module names come from OpenFGA metadata. A module may be bound to one installation;
its type names cannot redefine core policy. `bindings.resources` remains the
App Contract's resource-reference map, not a model declaration.

Compile the reviewed core and application sources with OpenFGA's
[modular tooling](https://openfga.dev/docs/modeling/modular-models). In the modular
project, the core source is `deploy/openfga/model.fga` with its standalone
`model / schema 1.1` header replaced by `module core`. Keep every approved app in
that project's `fga.mod`. Run the model's tests, then export the composed artifact:

```bash
fga model test --tests 'policy-tests/*.fga.yaml'
fga model transform --file fga.mod --output-format json > composed-model.json
```

The implementation was verified with OpenFGA CLI 0.8.2 and OpenFGA server 1.15.1.
The publisher validates that compilation has preserved the bundled core policy.
From the CAIPE repository root, against an existing store:

```bash
python3 charts/ai-platform-engineering/charts/openfga/files/publish_model.py \
  --model composed-model.json \
  --core charts/ai-platform-engineering/charts/openfga/authorization-model.json \
  --module example-service \
  --store-id "$OPENFGA_STORE_ID" \
  --url "$OPENFGA_HTTP" \
  --output model-receipt.json
```

Repeat `--module` for every approved module. Run one deployment-owned publisher
at a time. Preserve the receipt with the release configuration. It contains the
store ID, immutable model ID, compiled-model hash and approved modules. Repeating
unchanged publication reuses the existing ID.

Set `OPENFGA_STORE_ID` and `OPENFGA_AUTHORIZATION_MODEL_ID` on **all BFF replicas**
from that receipt, then enable the installation. Startup rejects enabled module
bindings absent from the selected model. Model-dependent BFF requests all carry
the selected ID; native registration cannot fall back to latest-model selection.

The default Helm/Compose initializers reuse this same publisher. For a controlled
composed-model rollout, publish first and set `openfga.init.authorizationModelId`
to that same model ID and `openfga.init.storeId` to the receipt's store ID in the
parent chart, or disable the initializer. A pinned
initializer verifies core compatibility and only seeds tuples; it never replaces
app modules. Compose forwards `OPENFGA_AUTHORIZATION_MODEL_ID` to its initializer
for the same behavior. Update the BFF pins and app bindings together. Services never publish or repair the shared model.

Changing/removing an existing app's policy, including rollback, requires
`--migration-receipt path.json` with `from_model_id`, `to_sha256` and a reviewed
`description`. The receipt records an operator's migration decision; it does not
run or prove a tuple migration. Keep tuple migration/rollback scripts with the
release. Publication alone does not activate a model for pinned BFF replicas.

## Register before storing business data

A human browser session calls `POST /api/access/resources` from the BFF's origin:

```json
{"resource":{"type":"example_agent_sandbox","id":"sandbox-123"}}
```

Optional `owner_team` selects a team the user currently belongs to. Otherwise the
verified user owns it. A service cannot nominate a user owner. The native model
must admit that user or `team#member` on its `owner` relationship.

Registration and native grants require permission updates to be enabled
(`OPENFGA_RECONCILE_ENABLED=true`). CAS reserves `example_agent_sandbox:sandbox-123` in Mongo, verifies that the graph
is empty, writes the owner tuple and marks the reservation active. A retry must
match the same resource, owner and creator. A different registration returns
409; pre-existing graph relationships require an explicit migration. An
unconfirmed owner projection remains pending and returns 503 with its native
handle. Check it with `GET /api/access/resources/example_agent_sandbox:sandbox-123`
or retry the same registration. Inspection requires the current owner; the
original creator may also inspect a pending reservation.

## Permissions and relationships

`POST /api/access/check` uses the exact model permission:

```json
{"resource":{"type":"example_agent_sandbox","id":"sandbox-123"},"action":"can_exec"}
```

`POST /api/access/query` filters caller-supplied candidate IDs for that native type
and permission. `POST /api/access/grants` writes a direct relationship:

```json
{"resource":{"type":"example_agent_sandbox","id":"sandbox-123"},"relationship":"executor","grantee":{"type":"service_account","id":"example-service-subject"}}
```

`DELETE` with the same body revokes it. CAS checks `can_grant_executor` on the
resource first. Granting `terminator` instead checks `can_grant_terminator`. Missing
authority denies the write; organization-admin status supplies no override.
Only model-admitted user, service-account, `team#member` and explicitly declared
wildcard grants are writable. Conditioned tuple grants, ownership changes,
computed permissions and structural object links cannot be written this way.

Service callers present a verified Keycloak bearer credential for `caipe-access`
and match an enabled installation's client binding. App-scoped host-to-app tokens
are not CAS credentials. User requests use the existing strict user identity
profile. Request JSON cannot choose an effective user.

## Background work and audit

Grant the service its native permission, then approve the exact resource,
permission, service, job and expiry using `/api/access/delegations`. Its existing
request shapes remain unchanged; the scope's `action` is now the native
permission. Execution uses `/api/access/delegations/{id}/check`.

CAS requires active approval **AND** current service permission **AND** current
user permission. Logout alone does not cancel approved work. Expiry, revocation,
loss of either permission, pending resource state or disabled installation does.
Audit preserves the actor/user chain, approval scope, native resource and selected
model ID. The Admin resource inventory uses that same selected model; the audit
item shows its model ID.

## Existing environments

This replaces the unreleased generic draft, with no permanent `app_resource` or
hash aliases. If that draft was deployed, stop and inventory its records, tuples
and delegation scopes. A migration needs an explicit service-supplied native
mapping; CAS cannot infer the domain type from a hash. Existing core-service
migrations and controlled ownership/parent-link lifecycle commands are separate
work items.
