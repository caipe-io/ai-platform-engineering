# Register app resources through CAS

This manifest describes the backend resource contract. It can be supplied in the
operator's runtime app catalog, with no npm package or CAIPE build integration.
An iframe UI uses the same APIs through the CAIPE origin; add its normal iframe
profile/runtime and origin binding using the App Contract.

## Install the app

The first platform rollout must include the updated standard OpenFGA model:
use the normal `<release>-openfga-init` Helm hook or `openfga-init` Compose service.
Deploy the matching BFF/model release before enabling resource integrations.
Subsequent app installs require only runtime configuration.

The app developer declares names in `manifest.json`:

```json
"resourceTypes": [{
  "name": "agent-sandbox",
  "actions": ["execute", "terminate"]
}]
```

It also declares `host.access.resources@1.0` in `consumes.platformApis`. These
are data declarations, not authorization grants or policy source.

The operator puts the manifest in `agentic_apps.packages` and enables its
installation in the existing app configuration file:

```yaml
agentic_apps:
  packages:
    - package_id: example-service
      manifest: # contents of manifest.json
  installations:
    - app_id: example-service
      enabled: true
      visible: false
      bindings:
        serviceAccountClientId: example-client
```

For an iframe, also select its declared UI profile and set
`bindings.runtimeOrigin`. The backend remains separately deployed. Its Keycloak
credential must meet the platform's service identity profile and `caipe-access`
audience. App-scoped host-to-app proxy tokens are not CAS credentials.

## Register while the user is present

The browser calls `POST /api/access/resources` with its CAIPE session and origin:

```json
{
  "app_id": "example-service",
  "resource_type": "agent-sandbox",
  "local_id": "sandbox-123"
}
```

The response includes:

```json
{
  "resource": {"type": "app_resource", "id": "12345678-1234-4000-8000-123456789012"},
  "app_id": "example-service",
  "resource_type": "agent-sandbox",
  "local_id": "sandbox-123",
  "owner": {"type": "user", "id": "test-user"},
  "state": "active"
}
```

Optional `owner_team` selects a team the verified user currently belongs to.
Services cannot nominate owners. Mongo enforces uniqueness of app/type/local ID;
retries by the same creator/owner return the same opaque handle. Store that handle
with the app's business data and send it to background jobs.

Registration requires permission writes enabled (`OPENFGA_RECONCILE_ENABLED=true`).
Until ownership is confirmed it remains pending: a 503 includes the handle and
state. Retry the same registration or inspect
`GET /api/access/resources/12345678-1234-4000-8000-123456789012`. The current owner
can inspect; the original creator can also inspect a pending reservation.

## Check, grant and query

`POST /api/access/check`:

```json
{"resource":{"type":"app_resource","id":"12345678-1234-4000-8000-123456789012"},"action":"execute"}
```

`POST /api/access/grants` grants action use:

```json
{"resource":{"type":"app_resource","id":"12345678-1234-4000-8000-123456789012"},"capability":"execute","grantee":{"type":"service_account","id":"test-service"}}
```

`DELETE` with the same body revokes it. The caller must have the resource's
`grant:execute` permission. `authority: "use"` is the default. To assign an
execution grantor, the **owner** sends the same shape with `authority: "grant"`
and the intended user/team/service grantee. Assigning grant authority for one
action does not authorize another action or allow assigning more grantors.

`action: "grant:execute"` checks grant authority; `action: "owner"` checks
ownership. Domain action names cannot contain `:` and `owner` is reserved.
Ownership, structural relationships and wildcard/public grants are unavailable
through the app grant API.

`POST /api/access/query` accepts `resource_type: "app_resource"`, `action` and
candidate `ids`; it returns permitted handles. Checks use fresh registry and
graph reads. Invalid actions return 400; dependency/pending-state failures return
503 rather than a successful empty result.

## What OpenFGA stores

For handle `R`, these are ordinary persisted relationships:

```text
user:test-user              owner    app_resource:R
service_account:test-service grantee app_permission:R/execute
user:execution-admin       grantor  app_permission:R/execute
```

At check time CAS supplies this **contextual**, non-persisted structural link:

```text
app_resource:R             resource app_permission:R/execute
```

The standard model evaluates `can_use` or `can_grant` on that permission object.
Only CAS derives the link from registered identity; request JSON cannot inject
contextual tuples. The business type and local ID are not OpenFGA schema names.

## Background jobs and audit

After granting the service access, the user approves `/api/access/delegations`
for the exact handle, domain action, service, job and expiry. The service calls
`/api/access/delegations/{id}/check` before each protected operation. CAS requires
active approval **AND** current service permission **AND** current user permission.
Logout alone does not cancel it. Revocation, expiry, lost permission or a disabled
installation blocks the next check.

Audit retains caller, grantee, handle, action, grant authority and delegated
actor/user chain. Registration events include the business mapping and owner;
Admin inventory resolves handles to app/type/local ID. The app enforces the result.

New apps/actions require no shared-model publication. CAIPE releases maintain the
fixed model through the normal initializer. Action names are durable contracts;
removal blocks access without destroying grants, and repurposing a name requires
migration review. Older unreleased registration records need an explicit release
migration if they exist; this API provides no old-contract aliases.
