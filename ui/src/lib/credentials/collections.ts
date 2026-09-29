export const CREDENTIAL_COLLECTIONS = {
  secretRefs: "credential_secret_refs",
  encryptedPayloads: "credential_encrypted_payloads",
  oauthConnectors: "oauth_connectors",
  providerConnections: "provider_connections",
  migrationPreviews: "credential_migration_previews",
  ingestPreviewGrants: "credential_ingest_preview_grants",
} as const;

export type CredentialCollectionName =
  (typeof CREDENTIAL_COLLECTIONS)[keyof typeof CREDENTIAL_COLLECTIONS];

const CREDENTIAL_COLLECTION_NAME_SET = new Set<string>(Object.values(CREDENTIAL_COLLECTIONS));

export function isCredentialCollectionName(value: string): value is CredentialCollectionName {
  return CREDENTIAL_COLLECTION_NAME_SET.has(value);
}
