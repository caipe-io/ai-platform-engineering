# Secondary auth

CAIPE owns secondary JWT trust and canonical user linking. Applications use
`POST /api/auth/secondary` with a secondary bearer token and a JSON `resource` URL.
This endpoint does not authenticate ordinary CAIPE APIs or issue platform tokens.

## Operator configuration

Disabled by default. Set all of these server-only variables in the UI service:

```dotenv
CAIPE_SECONDARY_OIDC_PROVIDER_ID=example
CAIPE_SECONDARY_OIDC_ISSUER=https://identity.example.test
CAIPE_SECONDARY_OIDC_JWKS_URI=https://identity.example.test/.well-known/jwks.json
CAIPE_SECONDARY_OIDC_AUDIENCES=example-api
CAIPE_SECONDARY_AUTH_RESOURCES={"https://host.example.test/apps/example/api/mcp":["example-api"]}
```

- Only configure an issuer whose email namespace you trust to identify existing users.
- Issuer/JWKS and resource URLs require HTTPS. Resource URLs must match exactly.
- Every resource binding must contain only audiences from the configured allowlist.
- JWT signatures, issuer, audience, expiry and subject are required. JWKS are cached;
  there is no browser token storage or external introspection request per validation.
- `CAIPE_SECONDARY_OIDC_REQUIRE_VERIFIED_EMAIL` defaults to `true`. Explicitly set
  `false` only for a trusted provider whose email claim is authoritative even when
  it omits `email_verified`. This enables first-request linking; it does not import
  provider roles or grant permissions.
- Compose forwards these variables; Helm uses `caipe-ui.env`. External Keycloak
  installations must apply the protected attribute migration below before enabling.

## Identity and permissions

- First use resolves a unique persisted CAIPE user by verified email and confirms
  that user's current Keycloak email and enabled status.
- Subsequent requests resolve the immutable hash of `(issuer, subject)`; changing
  the external email never reassigns an existing link.
- The MongoDB `secondary_auth_identity_links` collection atomically reserves both
  the external identity and canonical subject. Index creation must succeed.
- Existing Keycloak secondary identity attributes are adopted only after active
  user checks and atomic reservation; duplicate or conflicting owners fail closed.
- Keycloak `caipe_secondary_oidc_*` attributes are admin-only. Admission checks
  these permissions before trusting any link, so an incomplete migration fails closed. The independent
  `reconcile-secondary-auth.sh` job runs on Helm installs/upgrades and as a Compose
  `rbac` service, including installations without an external IdP. It preserves
  unrelated profile attributes and the unmanaged-attribute policy.
- An administrator using an external Keycloak must run this script against that
  realm and review existing secondary links before enabling secondary auth.
- Responses contain canonical subject/email/name only. External groups, roles and
  organizations cannot grant admin access; application authorization uses existing
  CAIPE/OpenFGA permissions.
- A verified identity without an existing user returns `linked:false` and no subject.
  Applications must deny normal resource access; they may explicitly permit their
  own restricted account-linking/bootstrap flow.

## Application contract

```http
POST /api/auth/secondary
Authorization: Bearer <secondary JWT>
Content-Type: application/json

{"resource":"https://host.example.test/apps/example/api/mcp"}
```

Successful response: `{"success":true,"data":{"linked":true,"resource":"...",
"identity":{"sub":"...","email":"...","name":"..."}}}`. Errors and successes
are `private, no-store`. Applications must verify the exact resource echo and
`linked:true` before accepting a canonical subject, use HTTPS without redirects,
and keep forwarding proofs private and bound to the token and resource.

This is explicit audience admission, not OAuth token exchange: no new delegated
JWT is minted. A secondary token with an audience approved for several resources
can access those resources subject to their authorization checks. For cryptographic
per-resource isolation, the secondary issuer must issue distinct resource audiences.
Primary MCP resource-indicator tokens keep their existing strict audience checks.

## Recovery

A reservation survives a failed Keycloak write. Retrying the same binding is safe.
Do not delete reservations automatically or reassign links by email. An administrator
must investigate conflicts and update the protected Keycloak attributes and the
Mongo reservation together while secondary admission is disabled. No automatic
account creation, merge, unlinking, or permission migration is performed.
