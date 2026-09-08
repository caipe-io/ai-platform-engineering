import type { AuthorizeResult, ReasonCode } from "./contract";

export type AuthzSyncState = "pending" | "ready" | "error";

export const AUTHZ_SYNC_GATED_ACTIONS = new Set([
  "discover",
  "use",
  "invoke",
  "call",
]);

export interface AuthzSyncDocument {
  authz_revision?: number;
  authz_sync_state?: AuthzSyncState;
  authz_last_synced_revision?: number;
  authz_last_error_code?: string;
  authz_sync_started_at?: string;
}

export class AuthzSyncSupersededError extends Error {
  constructor() {
    super("Authorization state changed while it was being reconciled");
    this.name = "AuthzSyncSupersededError";
  }
}

export function currentAuthzRevision(document: AuthzSyncDocument): number {
  return Number.isSafeInteger(document.authz_revision) && document.authz_revision! >= 0
    ? document.authz_revision!
    : 0;
}

export function nextAuthzRevision(document: AuthzSyncDocument): number {
  return currentAuthzRevision(document) + 1;
}

export function authzRevisionFilter(document: AuthzSyncDocument): Record<string, unknown> {
  return document.authz_revision === undefined
    ? { authz_revision: { $exists: false } }
    : { authz_revision: currentAuthzRevision(document) };
}

const ACTIVE_SYNC_WINDOW_MS = 90_000;

export function hasActiveAuthzSync(
  document: AuthzSyncDocument,
  now = Date.now(),
): boolean {
  if (document.authz_sync_state !== "pending") return false;
  const started = Date.parse(document.authz_sync_started_at ?? "");
  return Number.isFinite(started) && now - started < ACTIVE_SYNC_WINDOW_MS;
}

export function authzSyncPreCheck(
  document: AuthzSyncDocument,
): AuthorizeResult | null {
  const readyRevisionMismatch = document.authz_sync_state === "ready"
    && currentAuthzRevision(document) !== document.authz_last_synced_revision;
  if (
    document.authz_sync_state !== "pending"
    && document.authz_sync_state !== "error"
    && !readyRevisionMismatch
  ) {
    return null;
  }
  const reason: ReasonCode = document.authz_sync_state === "pending"
    ? "AUTHZ_SYNC_PENDING"
    : "AUTHZ_SYNC_ERROR";
  return {
    decision: "DENY",
    reason,
    retriable: true,
    via: "authz_sync_state",
  };
}

export function sanitizedAuthzErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "OpenFgaReconcileRequiredError") return "OPENFGA_RECONCILIATION_REQUIRED";
  if (name === "OpenFgaVerificationError") return "OPENFGA_VERIFICATION_FAILED";
  return "OPENFGA_RECONCILIATION_FAILED";
}

export async function runRevisionedAuthzSync<T>(input: {
  reconcile: () => Promise<void>;
  markReady: () => Promise<T | null>;
  markError: (errorCode: string) => Promise<void>;
}): Promise<T> {
  try {
    await input.reconcile();
  } catch (error) {
    await input.markError(sanitizedAuthzErrorCode(error)).catch((markError) => {
      console.error("[authz-sync] failed to persist reconciliation error state", markError);
    });
    throw error;
  }

  const ready = await input.markReady();
  if (!ready) throw new AuthzSyncSupersededError();
  return ready;
}
