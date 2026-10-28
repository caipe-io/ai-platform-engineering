# Native resources through CAS

This service-only App Contract example is a bundled policy package with no UI
or proxy origin. Iframe and native apps use the same runtime APIs for installed types. The service stores its business
data and enforces each CAS decision; it receives no OpenFGA credentials.

| File | Purpose |
| --- | --- |
| `manifest.json` | Declares the policy files and `host.access.resources@1.0` |
| `package.json` | Pinned policy-only package; exports its manifest |
| `model.fga.yaml` | Permission assertions run against the composed host model |
| `model.fga` | Native OpenFGA module with separate execution/termination permissions |
| `model.json` | Equivalent native type used by the API integration tests |

## Package and build

The app developer publishes this package from their own repository. Its
`./manifest` export declares packaged policy and test files:

```json
"authorization": {
  "module": "example-service",
  "model": "model.fga",
  "tests": "model.fga.yaml"
}
```

A policy-only package needs no React component, styles export or framework peers.
A package with an iframe UI can use the same bundled-policy contract. An iframe
manifest installed only at runtime cannot declare policy.

The CAIPE build maintainer reviews the package, pins it in `ui/package.json` and
the lockfile, then includes it in the existing extension allowlist. For this
in-repository example, from the CAIPE root:

```bash
npm pack ./ui/examples/agentic-apps/service-only \
  --pack-destination ./ui/native-extension-artifacts
cd ui
npm install --save-exact ./native-extension-artifacts/example-service-policy-1.0.0.tgz
cd ..
docker build -f build/Dockerfile.caipe-ui \
  --target runner \
  --build-arg CAIPE_NATIVE_EXTENSION_MODULES=@example/service-policy \
  -t registry.example.test/caipe-ui:service-1 .
```

Publish that image through your normal registry workflow. The Docker build
uses pinned OpenFGA CLI 0.8.2 to combine the host's core policy with packaged
modules, rejects changes to core types, and runs each package's tests against
the combined model. A failed permission assertion fails the image build.
Non-Docker builds need `fga` on PATH (or `FGA_CLI`); builds without policy
extensions need no compiler.

## Operator deployment

The operator selects the built image in the parent Helm chart:

```yaml
global:
  caipeUiImage: registry.example.test/caipe-ui:service-1
```

For private registries, `global.imagePullSecrets` supplies the pull-secret list
to both the UI and the artifact-export job. Configure an installation using
the existing App Contract configuration source:

```yaml
agentic_apps:
  installations:
    - app_id: example-service
      enabled: true
      visible: false
      bindings:
        serviceAccountClientId: example-client
```

No `authorizationModule` setting is needed: the build registry derives module
custody from the packaged manifest. `bindings.resources` remains a resource-reference
map. Hosted UIs configure their runtime origin through the existing installation
contract; this service-only example needs no proxy origin.

The chart runs `export-authorization-model` as an init container of the OpenFGA
initializer. It copies `/app/authorization` from **the same image** into a shared
volume. The initializer publishes that model using its bundled module list and
prints the immutable model ID and hash. Repeated unchanged deployment reuses the
same model. The BFF resolves exactly that artifact; no manual model-ID transfer
or app-specific model ConfigMap is needed. If `OPENFGA_AUTHORIZATION_MODEL_ID`
is explicitly set, it must identify that exact artifact. The BFF starts before
publication, but protected requests fail closed until publication succeeds.

For the canonical production Compose file, the equivalent override is:

```bash
CAIPE_UI_IMAGE=registry.example.test/caipe-ui:service-1 \
docker compose -f docker-compose.yaml \
  -f deploy/openfga/bundled-extensions.compose.yaml up -d
```

Keep your normal `.env` and profiles. Recreate `export-authorization-model` and
`openfga-init` when changing the host image. The named volume is an artifact
handoff, not a place to edit policy. The default core-only install is unchanged.

Policy changes/removal and rollback are controlled upgrades: the publisher
requires a migration receipt with `from_model_id`, `to_sha256` and `description`.
Use the repository's publisher CLI and the release's tuple migration in that
case; the receipt records approval, not proof that migration ran. See
[#2953](https://github.com/caipe-io/ai-platform-engineering/issues/2953).
First-time module addition and identical redeployment need no such receipt.

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
