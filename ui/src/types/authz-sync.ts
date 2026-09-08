export type AuthzSyncState = "pending" | "ready" | "error";

/** Persisted reconciliation metadata shared by user-owned resources. */
export interface AuthzSyncMetadata {
  authz_revision?: number;
  authz_sync_state?: AuthzSyncState;
  authz_last_synced_revision?: number;
  authz_last_error_code?: string;
  authz_sync_started_at?: string;
  authz_previous_state?: Record<string, unknown>;
}
