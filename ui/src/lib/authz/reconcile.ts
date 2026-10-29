// assisted-by Cursor:composer-2.5
//
// CAS-backed OpenFGA tuple reconciliation (PAP batch writes). Routes tuple
// diffs through the CAS module so graph mutations invalidate the decision
// cache and emit durable audit events — instead of calling openfga.ts directly.

import {
  writeOpenFgaTupleDiff,
  isOpenFgaReconciliationEnabled,
  isOpenFgaConfigured,
  readOpenFgaTuples,
  deleteExactOpenFgaTuples,
  type OpenFgaReconcileResult,
  type TeamResourceTupleDiff,
} from "@/lib/rbac/openfga";

import { emitReconcileAudit } from "./audit";
import type { DecisionContext, Subject } from "./contract";
import { invalidateDecisionCache } from "./engines/openfga";

export interface TupleReconcileContext extends DecisionContext {
  /** Who triggered the reconcile (for audit). */
  caller?: Subject;
  /** Short label for the audit tab (e.g. mcp_server_create, team_resources). */
  source?: string;
}

export class OpenFgaReconcileRequiredError extends Error {
  constructor(message = "OpenFGA reconciliation is required for this mutation") {
    super(message);
    this.name = "OpenFgaReconcileRequiredError";
  }
}

function assertReconciliationApplied(
  diff: TeamResourceTupleDiff,
  result: OpenFgaReconcileResult,
): void {
  if (
    !result.enabled &&
    (diff.writes.length > 0 || diff.deletes.length > 0) &&
    !isOpenFgaReconciliationEnabled()
  ) {
    throw new OpenFgaReconcileRequiredError();
  }
}

/**
 * Apply an OpenFGA tuple diff through CAS: write to the PDP, invalidate cached
 * decisions, and audit policy mutations or failed attempts. Filtered no-ops
 * do not represent policy changes and stay out of the audit trail.
 */
export async function reconcileTupleDiff(
  diff: TeamResourceTupleDiff,
  ctx: TupleReconcileContext = {},
): Promise<OpenFgaReconcileResult> {
  let result: OpenFgaReconcileResult;
  try {
    result = await writeOpenFgaTupleDiff(diff);
  } catch (error) {
    emitReconcileAudit(diff, { enabled: true, writes: 0, deletes: 0 }, ctx, {
      outcome: "error",
      reasonCode: error instanceof Error ? error.message : "PDP_WRITE_FAILED",
    });
    throw error;
  }

  try {
    assertReconciliationApplied(diff, result);
  } catch (error) {
    if (error instanceof OpenFgaReconcileRequiredError) {
      emitReconcileAudit(diff, result, ctx, {
        outcome: "error",
        reasonCode: error.message,
      });
    }
    throw error;
  }

  if (result.enabled && (result.writes > 0 || result.deletes > 0)) {
    invalidateDecisionCache();
  }
  if (result.writes > 0 || result.deletes > 0) {
    emitReconcileAudit(diff, result, ctx);
  }
  return result;
}

/** Bounded, monotonic cleanup of this conversation's stored relationships. */
export async function purgeConversationRelationships(conversationId: string): Promise<boolean> {
  if (!isOpenFgaConfigured()) return true;
  if (!isOpenFgaReconciliationEnabled()) throw new OpenFgaReconcileRequiredError();
  const object = `conversation:${conversationId}`;
  for (let page = 0; page < 10; page++) {
    // Read a fresh first page after each deletion; continuation cursors may
    // become stale as tuples disappear or another expired lease is reclaimed.
    const result = await readOpenFgaTuples({ tuple: { object }, pageSize: 100, signal: AbortSignal.timeout(5_000) });
    const deletes = result.tuples.map(tuple => tuple.key);
    if (deletes.some(tuple => tuple.object !== object)) throw new Error("Unexpected resource in conversation tuple cleanup");
    if (!deletes.length) return true;
    const diff = { writes: [], deletes };
    const ctx = { source: "conversation_purge" };
    try {
      const applied = await deleteExactOpenFgaTuples(deletes, { monotonic: true, timeoutMs: 5_000 });
      emitReconcileAudit(diff, applied, ctx);
    } catch (error) {
      emitReconcileAudit(diff, { enabled: true, writes: 0, deletes: 0 }, ctx, { outcome: "error", reasonCode: "PDP_WRITE_FAILED" });
      throw error;
    } finally {
      // A failed bounded chunk may already have removed earlier keys.
      invalidateDecisionCache();
    }
    if (!result.continuationToken) return true;
  }
  return false;
}
