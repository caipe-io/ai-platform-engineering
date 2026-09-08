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
  ResourceType,
  Subject,
} from "./contract";
import { compose } from "./compose";
import { emitDecisionAudit, emitGrantAudit } from "./audit";
import { createOpenFgaEngine, createOpenFgaAdmin } from "./engines/openfga";
import { workflowDelegationPreCheck } from "./domains/workflow";

// ─── Singleton engine (module-level, reused across requests) ──────────────────

const engine = compose(createOpenFgaEngine(), {
  preCheck: async (req) => {
    // Keep Mongo-backed product policy out of the module-load path used by
    // pure tuple builders and CLI tooling. Runtime decisions still load and
    // evaluate persisted visibility before the OpenFGA check.
    const { privateResourcePreCheck } = await import("./domains/private-resource");
    return (await privateResourcePreCheck(req)) ?? workflowDelegationPreCheck(req);
  },
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
 * Uses bounded-parallel checks internally. Each decision is audited.
 */
export async function authorizeMany(
  subject: Subject,
  action: Action,
  resourceType: ResourceType,
  ids: string[],
  ctx: DecisionContext = {},
  trustedContext?: AuthorizeRequest["trustedContext"],
): Promise<Map<string, AuthorizeResult>> {
  const { privateResourceBatchPreChecks } = await import("./domains/private-resource");
  const preChecks = await privateResourceBatchPreChecks({
    subject,
    action,
    resourceType,
    ids,
    trustedContext,
  });
  const uncheckedIds = ids.filter((id) => !preChecks.has(id));
  const results = await engine.batchCheck(subject, action, resourceType, uncheckedIds);
  for (const [id, decision] of preChecks) results.set(id, decision);
  for (const [id, result] of results) {
    emitDecisionAudit(subject, { type: resourceType, id }, action, result, ctx, trustedContext);
  }
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
  TrustedAuthorizeContext,
} from "./contract";
