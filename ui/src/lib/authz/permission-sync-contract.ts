/** Public status only: never expose the stored tuple journal or actor context. */
export interface PermissionSyncStatus {
  id: string;
  state: "pending" | "applied";
  requested_at: string;
  applied_at?: string;
}

export const PERMISSIONS_PENDING_MESSAGE =
  "Settings saved. Permissions are pending and will retry automatically. Previous access may still work until this update completes.";
