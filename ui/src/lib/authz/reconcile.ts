// assisted-by Cursor:composer-2.5
//
// CAS-backed OpenFGA tuple reconciliation (PAP batch writes). Routes tuple
// diffs through the CAS module so graph mutations invalidate the decision
// cache and emit durable audit events — instead of calling openfga.ts directly.

import {
  writeOpenFgaTupleDiff,
  isOpenFgaReconciliationEnabled,
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
