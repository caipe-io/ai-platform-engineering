/**
 * Client-side helpers for the structured Web UI backend auth-error contract.
 *
 * The Web UI backend (api-middleware.ts, da-proxy.ts) emits a stable JSON shape on
 * authentication / authorization failures:
 *
 *   {
 *     success: false,
 *     error:   "Your session has expired. Please sign in again.",
 *     code:    "BEARER_EXPIRED",
 *     reason:  "session_expired",   // machine-readable category
 *     action:  "sign_in"            // UI hint
 *   }
 *
 * This module gives the web UI a stable way to:
 *   1. Recognise that a fetch failure is an auth failure (vs a backend error
 *      or network blip), so it can use a toast instead of inlining the error
 *      into chat output.
 *   2. Render a user-actionable message + recovery affordance ("Sign in",
 *      "Contact admin", "Retry") without parsing brittle English error
 *      strings.
 *
 * Server side: see `ui/src/lib/api-middleware.ts` (`AuthFailureReason`,
 * `AuthFailureAction`, `ApiError`).
 */

/** Mirror of the server-side {@link AuthFailureReason} union. */
export type AuthFailureReason =
  | "not_signed_in"
  | "session_expired"
  | "session_unavailable"
  | "bearer_invalid"
  | "audience_mismatch"
  | "missing_role"
  | "missing_required_group"
  | "missing_relationship"
  | "pdp_denied"
  | "pdp_unavailable"
  | "cel_denied"
  | "forbidden";

/** Mirror of the server-side {@link AuthFailureAction} union. */
export type AuthFailureAction = "sign_in" | "contact_admin" | "retry" | "none";

/** Parsed, type-safe view of a structured auth-error response body. */
export interface AuthError {
  status: number;
  message: string;
  code?: string;
  reason?: AuthFailureReason;
  action?: AuthFailureAction;
}

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "not_signed_in",
  "session_expired",
  "session_unavailable",
  "bearer_invalid",
  "audience_mismatch",
  "missing_role",
  "missing_required_group",
  "missing_relationship",
  "pdp_denied",
  "pdp_unavailable",
  "cel_denied",
  "forbidden",
]);

const KNOWN_ACTIONS: ReadonlySet<string> = new Set([
  "sign_in",
  "contact_admin",
  "retry",
  "none",
]);

/**
 * Extract a structured {@link AuthError} from a non-OK fetch `Response`.
 *
 * Returns `null` for non-auth statuses (treat the failure as a normal
 * backend/network error and surface it inline). Returns an `AuthError` for
 * 401 / 403 / 503-with-pdp-unavailable, even when the body lacks
 * `reason`/`action` — falls back to a sensible default so callers never
 * need a second code path for "old-shape" servers.
 *
 * Consumes the response body. Pass a clone if you need it again.
 */
export async function parseAuthError(res: Response): Promise<AuthError | null> {
  if (res.status !== 401 && res.status !== 403 && res.status !== 503) {
    return null;
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON 401/403 (e.g. proxy intercept) — still treat as auth, with a
    // generic message. The user shouldn't see "Unexpected token < in JSON".
  }

  const message =
    typeof body.error === "string" && body.error.length > 0
      ? body.error
      : defaultMessageForStatus(res.status);
  const code = typeof body.code === "string" ? body.code : undefined;
  const explicitReason =
    typeof body.reason === "string" && KNOWN_REASONS.has(body.reason)
      ? (body.reason as AuthFailureReason)
      : undefined;

  // Auth infrastructure outages need a retry hint, not a sign-in redirect.
  // Other 503s remain ordinary backend failures.
  if (res.status === 503 && explicitReason !== "pdp_unavailable" && explicitReason !== "session_unavailable") {
    return null;
  }

  const reason = explicitReason ?? defaultReasonForStatus(res.status);
  const action =
    typeof body.action === "string" && KNOWN_ACTIONS.has(body.action)
      ? (body.action as AuthFailureAction)
      : defaultActionForReason(reason);

  return { status: res.status, message, code, reason, action };
}

/**
 * Build a toast title for an {@link AuthError}. Kept short enough for the
 * toast UI; the full server message goes in the toast body.
 */
export function authErrorToastTitle(err: AuthError): string {
  switch (err.reason) {
    case "not_signed_in":
      return "Sign in required";
    case "session_expired":
      return "Session expired";
    case "bearer_invalid":
    case "audience_mismatch":
      return "Authentication failed";
    case "missing_role":
    case "missing_required_group":
    case "missing_relationship":
    case "pdp_denied":
    case "cel_denied":
    case "forbidden":
      return "Access denied";
    case "pdp_unavailable":
      return "Authorization service unavailable";
    case "session_unavailable":
      return "Sign-in service unavailable";
    default:
      return err.status === 403 ? "Access denied" : "Authentication failed";
  }
}

function defaultMessageForStatus(status: number): string {
  if (status === 401) return "You are not signed in. Please sign in to continue.";
  if (status === 403) return "You do not have access to this resource.";
  if (status === 503) return "Authorization service is temporarily unavailable.";
  return "Request failed.";
}

function defaultReasonForStatus(status: number): AuthFailureReason {
  if (status === 401) return "not_signed_in";
  if (status === 503) return "pdp_unavailable";
  return "forbidden";
}

function defaultActionForReason(reason: AuthFailureReason): AuthFailureAction {
  switch (reason) {
    case "not_signed_in":
    case "session_expired":
    case "bearer_invalid":
      return "sign_in";
    case "audience_mismatch":
    case "missing_role":
    case "missing_required_group":
    case "missing_relationship":
    case "pdp_denied":
    case "cel_denied":
    case "forbidden":
      return "contact_admin";
    case "pdp_unavailable":
    case "session_unavailable":
      return "retry";
    default:
      return "none";
  }
}
