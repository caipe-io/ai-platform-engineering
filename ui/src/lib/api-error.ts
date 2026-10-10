/**
 * Server-runtime-free home for `ApiError`.
 *
 * `@/lib/api-middleware` imports `next/server`, which references the
 * global `Request` constructor at module load time. That isn't defined
 * in jsdom test environments, so any module imported into a client
 * component (and any test that renders such a component) used to fail
 * to load if it transitively pulled `ApiError` in via the middleware
 * file.
 *
 * Extracting the class to this leaf module breaks the chain: shared
 * helpers like `app/api/skill-hubs/_lib/normalize.ts` (used by both
 * server route handlers and the admin form) can import `ApiError`
 * here without dragging the Next.js server runtime into the client
 * bundle / test env.
 *
 * `@/lib/api-middleware` continues to re-export `ApiError` from this
 * file so existing route-handler imports (`import { ApiError } from
 * "@/lib/api-middleware"`) keep working unchanged.
 */
import type { AuthFailureAction,AuthFailureReason } from "./auth-error";
import type { PublicationDriftItem } from "@/types/publication-approval";

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string,
    /**
     * Machine-readable failure category. Optional for backward compat with
     * existing throw-sites; auth/authz code paths should set it.
     */
    public reason?: AuthFailureReason,
    /** UI recovery hint. */
    public action?: AuthFailureAction,
    /** Optional diff attached by publication adapters to a hard `PUBLICATION_REVISION_CONFLICT`. */
    public drift?: PublicationDriftItem[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Thrown by publication adapters when the live resource has soft drift
 * (approvable with confirmation) that the caller has not yet acknowledged.
 * Unlike a bare `PUBLICATION_REVISION_CONFLICT` ApiError, this always carries
 * a diff so the approve route can hand it back to the UI for confirmation
 * instead of superseding the request.
 */
export class PublicationDriftError extends ApiError {
  constructor(
    message: string,
    public drift: PublicationDriftItem[],
    public fingerprint: string,
  ) {
    super(message, 409, "PUBLICATION_DRIFT");
    this.name = "PublicationDriftError";
  }
}

/**
 * Attach a display diff to a hard `PUBLICATION_REVISION_CONFLICT`. Every
 * publication adapter uses this (with `[]` when no diff was computed yet)
 * so `error.drift` is a consistent, always-present array for the approve
 * route to hand back to the UI, rather than sometimes set and sometimes not.
 */
export function withDrift(error: ApiError, drift: PublicationDriftItem[]): ApiError {
  return Object.assign(error, { drift });
}
