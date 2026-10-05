# MongoDB Envelope Credential Store

## Status

Accepted

## Context

CAIPE needs to store user- and team-scoped BYO credentials for Dynamic Agent MCP servers and internal service callers. The design also needs external OAuth provider connections for GitHub, Atlassian, Webex, and similar standard OAuth 2.0 providers.

OpenBao was considered as the primary credential store, but it introduces a new stateful datastore, operational backup/restore procedures, auth bootstrapping, and chart lifecycle concerns. The platform already depends on MongoDB for UI/Dynamic Agent state, and the credential feature can be isolated to dedicated collections with explicit envelope encryption interfaces.

## Decision

Use MongoDB-backed envelope encryption for the initial credential store:

- Store only encrypted credential payloads in `credential_encrypted_payloads`.
- Store metadata and references separately in `credential_secret_refs`, `oauth_connectors`, and `provider_connections`.
- Wrap data encryption keys through AWS KMS CMKs in production.
- Keep a `local-cmk` key-wrapper option for non-production testing only, with `dev-local` retained as a compatibility alias.
- Restrict raw credential retrieval to server-to-server bearer callers with the configured credential-service audience.
- For ingestion's `internal_service` fallback, require a verified service account whose signed `azp` claim matches the existing `KEYCLOAK_RESOURCE_SERVER_ID` platform client. Other service accounts need an explicit credential `use` grant.
- Limit that fallback to credentials referenced by a saved ingestion source or covered by an active preview grant. No Keycloak subject allow-list is required; authorization-service failures deny retrieval.
- Preserve clean store/key-wrapper interfaces so OpenBao can replace the storage backend later without changing browser/API contracts.

## Consequences

This avoids adding a new datastore for the first credential release and lets CAIPE reuse existing MongoDB backup, migration, and health-check paths. It also means production deployments must configure KMS CMK permissions correctly and must monitor both MongoDB availability and KMS unwrap failures.

OpenBao remains a viable future backend when credential-management requirements outgrow the MongoDB envelope model, especially if the platform needs native lease engines, dynamic secrets, or Vault-compatible operational workflows.
