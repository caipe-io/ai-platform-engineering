import { StreamError } from "@/lib/streaming";
import type { AuthFailureReason } from "@/lib/auth-error";

const SIGN_IN_AUTH_REASONS: ReadonlySet<AuthFailureReason> = new Set([
  "not_signed_in",
  "session_expired",
  "bearer_invalid",
]);

export function interruptedTurnFallbackText(error?: string): string {
  if (SIGN_IN_AUTH_REASONS.has(error as AuthFailureReason)) {
    return "Session expired - signing you in again...";
  }
  return error || "This response failed to complete. No content was generated.";
}

export function interruptedAuthReason(error: unknown): AuthFailureReason | undefined {
  if (error instanceof StreamError && error.isAuthError()) {
    if (error.reason && SIGN_IN_AUTH_REASONS.has(error.reason)) {
      return error.reason;
    }
    if (error.action === "sign_in") {
      return "session_expired";
    }
  }
  if (error instanceof Error && error.message.startsWith("Session expired:")) {
    return "session_expired";
  }
  return undefined;
}
