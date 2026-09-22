// assisted-by Codex Codex-sonnet-4-6
//
// Public API for the Centralized Authorization Service (CAS).
// Everything inside the BFF imports from here — never from engines/,
// compose.ts, or audit.ts directly. The ESLint boundary rule enforces this.

import type {
  Action,
  AuthorizeRequest,
  AuthorizeResult,
  DecisionContext,
  GrantIntent,
  ReasonCode,
  ResourceType,
  Subject,
} from "./contract";
import { compose } from "./compose";
import { emitBatchDecisionAudit, emitDecisionAudit, emitGrantAudit, emitListObjectsDecisionAudit } from "./audit";
import { createOpenFgaEngine, createOpenFgaAdmin } from "./engines/openfga";
import { workflowDelegationPreCheck } from "./domains/workflow";

// ─── Singleton engine (module-level, reused across requests) ──────────────────

const engine = compose(createOpenFgaEngine(), {
  preCheck: async (req) => workflowDelegationPreCheck(req),
});

const admin = createOpenFgaAdmin();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a single authorization request. Never throws for DENY — returns
 * the decision in the result. The decision is always audited.
 */
export async function authorize(
  req: AuthorizeRequest,
  ctx: DecisionContext = {},
): Promise<AuthorizeResult> {
  const result = await engine.check(req);
  emitDecisionAudit(req.subject, req.resource, req.action, result, ctx, req.trustedContext);
  return result;
}

/**
 * Batch evaluation: same subject + action across multiple resource ids.
 * Uses bounded-parallel checks internally.
 *
 * Audited as ONE row summarizing the filter, not one row per id — see
 * `CasBatchDecisionEvent`. A single access decision still gets its own row
 * via `authorize`/`authorizeOrThrow`.
 */
export async function authorizeMany(
  subject: Subject,
  action: Action,
  resourceType: ResourceType,
  ids: string[],
  ctx: DecisionContext = {},
): Promise<Map<string, AuthorizeResult>> {
  const results = await engine.batchCheck(subject, action, resourceType, ids);
  emitBatchDecisionAudit(subject, action, resourceType, results, ctx);
  return results;
}

/**
 * Guard variant. Throws {@link AuthzDeniedError} on DENY (including
 * AUTHZ_UNAVAILABLE). Use inside BFF route handlers where a denial should
 * stop the request.
 */
export async function authorizeOrThrow(
  req: AuthorizeRequest,
  ctx: DecisionContext = {},
): Promise<void> {
  const result = await authorize(req, ctx);
  if (result.decision === "DENY") {
    throw new AuthzDeniedError(result);
  }
}

/** Returns only the ids from `ids` that the subject may access. */
export async function filterAccessible(
  subject: Subject,
  action: Action,
  resourceType: ResourceType,
  ids: string[],
  ctx: DecisionContext = {},
): Promise<string[]> {
  if (ids.length === 0) return [];
  const results = await authorizeMany(subject, action, resourceType, ids, ctx);
  return ids.filter((id) => results.get(id)?.decision === "ALLOW");
}

export interface ListAccessibleResult {
  accessible: string[];
  /**
   * "AUTHZ_UNAVAILABLE" when the PDP could not be reached. Below the
   * reverse-lookup threshold, `accessible` still reflects whichever
   * candidates independently resolved to ALLOW (matching plain
   * per-candidate check semantics — one candidate's outage doesn't hide
   * another's already-resolved allow). At/above the threshold, one
   * list-objects call is all-or-nothing, so `accessible` is empty.
   * Callers that need to distinguish "PDP down" from "no access" (e.g. to
   * fail the request instead of rendering a possibly-partial list) must
   * check this rather than only inspecting `accessible`.
   */
  reason: ReasonCode;
}

/**
 * Below this many candidates, checking each one directly is cheap, and a
 * full reverse expansion of the subject's WHOLE accessible set is not
 * guaranteed to be cheaper — for a broadly-authorized subject it can cost
 * more than a handful of direct checks. 100 is the API's own hard cap on
 * page size (`getPaginationParams`), so every already-paginated or
 * single-item caller stays on the per-candidate path unchanged; only an
 * actual pre-pagination catalog scan (hundreds+ candidates) crosses it.
 */
const LIST_OBJECTS_MIN_CANDIDATES = Number(process.env.AUTHZ_LIST_OBJECTS_MIN_CANDIDATES ?? 100);

/**
 * Filters `candidateIds` to those the subject may access.
 *
 * Below `LIST_OBJECTS_MIN_CANDIDATES`, delegates to `authorizeMany`'s
 * per-candidate batch (audited as its own `batch: true` row — unchanged
 * behavior, unchanged cost). At/above it, asks the PDP for the subject's
 * whole accessible set of `resourceType` in ONE call instead of checking
 * each candidate (audited as one `CasListObjectsEvent` row) — the reverse
 * of `filterAccessible`'s per-candidate batch, correct only where the
 * relation is a pure relationship-graph computation with no product-policy
 * preCheck: see `PolicyEngine.listObjects`.
 */
export async function listAccessible(
  subject: Subject,
  action: Action,
  resourceType: ResourceType,
  candidateIds: string[],
  ctx: DecisionContext = {},
): Promise<ListAccessibleResult> {
  if (candidateIds.length === 0) return { accessible: [], reason: "OK" };

  if (candidateIds.length <= LIST_OBJECTS_MIN_CANDIDATES) {
    const results = await authorizeMany(subject, action, resourceType, candidateIds, ctx);
    const accessible = candidateIds.filter((id) => results.get(id)?.decision === "ALLOW");
    const unavailable = Array.from(results.values()).some((result) => result.reason === "AUTHZ_UNAVAILABLE");
    return { accessible, reason: unavailable ? "AUTHZ_UNAVAILABLE" : "OK" };
  }

  const { ids: accessibleIds, reason } = await engine.listObjects(subject, action, resourceType);
  emitListObjectsDecisionAudit(subject, action, resourceType, candidateIds, accessibleIds, reason, ctx);
  if (reason === "AUTHZ_UNAVAILABLE") return { accessible: [], reason };
  return { accessible: candidateIds.filter((id) => accessibleIds.has(id)), reason };
}

// ─── Grant / Revoke (PAP) ─────────────────────────────────────────────────────

export async function grant(intent: GrantIntent, ctx: DecisionContext = {}): Promise<void> {
  try {
    await admin.grant(intent);
    await emitGrantAudit("grant", intent, ctx, { outcome: "success" });
  } catch (err) {
    await emitGrantAudit("grant", intent, ctx, { outcome: "error", reasonCode: "PDP_WRITE_FAILED" });
    throw err;
  }
}

export async function revoke(intent: GrantIntent, ctx: DecisionContext = {}): Promise<void> {
  try {
    await admin.revoke(intent);
    await emitGrantAudit("revoke", intent, ctx, { outcome: "success" });
  } catch (err) {
    await emitGrantAudit("revoke", intent, ctx, { outcome: "error", reasonCode: "PDP_WRITE_FAILED" });
    throw err;
  }
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class AuthzDeniedError extends Error {
  readonly result: AuthorizeResult;
  constructor(result: AuthorizeResult) {
    super(`Authorization denied: ${result.reason}`);
    this.name = "AuthzDeniedError";
    this.result = result;
  }
}

// ─── Tuple reconciliation (PAP batch writes) ──────────────────────────────────

export { reconcileTupleDiff, OpenFgaReconcileRequiredError } from "./reconcile";
export type { TupleReconcileContext } from "./reconcile";

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { describeFgaCheck, getEngineStats } from "./engines/openfga";
export type { EngineStats } from "./engines/openfga";

export type {
  Action,
  AuthorizeRequest,
  AuthorizeResult,
  DecisionContext,
  DecisionValue,
  Grantee,
  GrantIntent,
  ReasonCode,
  Resource,
  ResourceType,
  Subject,
  SubjectType,
} from "./contract";
