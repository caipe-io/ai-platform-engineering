// assisted-by Cursor:composer-2.5
//
// CAS-backed OpenFGA tuple reconciliation (PAP batch writes). Routes tuple
// diffs through the CAS module so graph mutations invalidate the decision
// cache and emit durable audit events — instead of calling openfga.ts directly.

import {
  writeOpenFgaTupleDiff,
  isOpenFgaReconciliationEnabled,
  isOpenFgaConfigured,
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
  readonly statusCode = 503;
  readonly code = "ACCESS_WRITES_DISABLED";
  readonly action = "contact_admin";
  constructor(message = "Cannot save this change because permission updates are disabled. Ask an administrator to enable permission updates before changing access.") {
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
 * An optional persist callback saves matching resource metadata after the
 * graph write; a rejected save triggers restrictive cleanup, never restoration
 * of revoked grants from a potentially stale configuration snapshot.
 * Do not use this as a distributed transaction or retry ambiguous writes.
 */
export async function reconcileTupleDiff(
  diff: TeamResourceTupleDiff,
  ctx: TupleReconcileContext = {},
  persist?: () => Promise<void>,
): Promise<OpenFgaReconcileResult> {
  let result: OpenFgaReconcileResult;
  try {
    result = persist ? await writeOpenFgaTupleDiff(diff, persist) : await writeOpenFgaTupleDiff(diff);
  } catch (error) {
    // A partial write/failed compensation may have changed the graph.
    invalidateDecisionCache();
    emitReconcileAudit(diff, { enabled: true, writes: 0, deletes: 0 }, ctx, {
      outcome: "error",
      reasonCode: error instanceof Error ? error.message : "PDP_WRITE_FAILED",
    });
    throw error;
  }

  try {
    // The writer already invoked persistence in storage-only mode. Never call
    // it twice, and never apply this exception when FGA still enforces access.
    if (persist && !result.enabled && !isOpenFgaConfigured()) return result;
    if (persist && !result.enabled) throw new OpenFgaReconcileRequiredError();
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
