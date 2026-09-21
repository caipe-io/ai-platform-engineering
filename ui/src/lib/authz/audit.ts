// assisted-by Codex Codex-sonnet-4-6
//
// CAS decision audit. Writes ONE event per decision through audit-service,
// conforming to the UnifiedAuditEvent contract that the admin audit tab
// (`UnifiedAuditTab`) renders, so CAS decisions appear typed and filterable
// alongside existing auth/openfga_rebac events.
//
// Best-effort + fire-and-forget: an audit-service failure is logged but never blocks
// or changes the decision (the decision is the authoritative output).

import { createHash, randomUUID } from "crypto";

import { getAuditBackend } from "@/lib/audit";

import type {
  Action,
  AuthorizeResult,
  DecisionContext,
  GrantIntent,
  Resource,
  Subject,
  TrustedAuthorizeContext,
} from "./contract";

const SUBJECT_SALT = process.env.AUDIT_SUBJECT_SALT ?? "caipe-098-audit";

/**
 * Conforms to `AuditEventDocument` in the audit-events route. `outcome`
 * (not `decision`) and `resource_ref` (not split fields) are what the tab
 * reads; split resource fields, workflow context, and decision path are kept
 * so exports can explain where workflow-scoped CAS decisions came from.
 */
export interface CasDecisionEvent {
  audit_event_id: string;
  ts: Date;
  type: "cas_decision";
  tenant_id: string;
  subject_hash: string;
  subject_ref: string;
  action: Action;
  outcome: "allow" | "deny";
  reason_code: AuthorizeResult["reason"];
  correlation_id: string;
  component: "cas";
  resource_ref: string;
  resource_type: string;
  resource_id: string;
  workflow_run_id?: string;
  decision_via?: string;
  pdp: "openfga";
  source: "cas";
  trace_id?: string;
  span_id?: string;
}

function hashSubject(id: string): string {
  return "sha256:" + createHash("sha256").update(`${SUBJECT_SALT}:${id}`).digest("hex");
}

function writeAuditEvent(event: Record<string, unknown>): void {
  try {
    getAuditBackend().write(event);
  } catch (err) {
    console.warn("[cas/audit] Failed to enqueue audit event:", err);
  }
}

export function buildDecisionEvent(
  subject: Subject,
  resource: Resource,
  action: Action,
  result: AuthorizeResult,
  ctx: DecisionContext = {},
  trustedContext: TrustedAuthorizeContext = {},
): CasDecisionEvent {
  return {
    audit_event_id: randomUUID(),
    ts: new Date(),
    type: "cas_decision",
    tenant_id: ctx.tenantId ?? process.env.TENANT_ID ?? "default",
    subject_hash: hashSubject(subject.id),
    subject_ref: principalRef(subject.type, subject.id),
    action,
    outcome: result.decision === "ALLOW" ? "allow" : "deny",
    reason_code: result.reason,
    correlation_id: ctx.correlationId ?? randomUUID(),
    component: "cas",
    resource_ref: `${resource.type}:${resource.id}`,
    resource_type: resource.type,
    resource_id: resource.id,
    pdp: "openfga",
    source: "cas",
    ...(trustedContext.workflowRunId ? { workflow_run_id: trustedContext.workflowRunId } : {}),
    ...(result.via ? { decision_via: result.via } : {}),
    ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
    ...(ctx.spanId ? { span_id: ctx.spanId } : {}),
  };
}

// Every authorize() call produces a decision, so one durable row per decision
// makes audit volume scale with request count rather than with anything
// security-relevant. Denials stay full-fidelity — they're rare and are the
// signal reviewers actually need. Routine allows are counted in memory, keyed
// by subject/action/resource/reason, and flushed as periodic aggregate rows
// carrying `count`. Consumers must SUM `count` rather than count rows.
//
// Rollups live in the process, so a recycle can drop an unflushed window: that
// undercounts an allow metric, and never loses a denial or a policy change.
// AUDIT_FULL_FIDELITY_ALLOWS=true restores one row per allow for a bounded
// investigation or compliance window.
const ALLOW_ROLLUP_FLUSH_MS = parseInt(process.env.AUDIT_ALLOW_ROLLUP_FLUSH_MS ?? "60000", 10);

function fullFidelityAllows(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.AUDIT_FULL_FIDELITY_ALLOWS ?? "").trim().toLowerCase(),
  );
}

interface AllowRollupEntry {
  sample: CasDecisionEvent;
  count: number;
  windowStart: Date;
  windowEnd: Date;
}

const allowRollups = new Map<string, AllowRollupEntry>();
let allowFlushTimer: ReturnType<typeof setInterval> | null = null;

function rollupKey(event: CasDecisionEvent): string {
  // JSON-encoded so a field containing the delimiter can't collide two
  // distinct decisions into one rollup.
  return JSON.stringify([
    event.tenant_id,
    event.subject_ref,
    event.action,
    event.resource_ref,
    event.reason_code,
    event.decision_via ?? "",
    event.workflow_run_id ?? "",
  ]);
}

/** Emit one aggregated row per distinct key accumulated since the last flush. */
export function flushAllowRollups(): void {
  if (allowRollups.size === 0) return;
  const pending = Array.from(allowRollups.values());
  allowRollups.clear();
  for (const entry of pending) {
    writeAuditEvent({
      ...entry.sample,
      audit_event_id: randomUUID(),
      ts: entry.windowEnd,
      // This row summarizes `count` decisions, not one request, so there is no
      // single correlation_id to attribute it to.
      correlation_id: `rollup:${randomUUID()}`,
      count: entry.count,
      window_start: entry.windowStart,
      window_end: entry.windowEnd,
    } as unknown as Record<string, unknown>);
  }
}

function recordAllow(event: CasDecisionEvent): void {
  const key = rollupKey(event);
  const existing = allowRollups.get(key);
  if (existing) {
    existing.count += 1;
    existing.windowEnd = event.ts;
  } else {
    allowRollups.set(key, { sample: event, count: 1, windowStart: event.ts, windowEnd: event.ts });
  }
  if (!allowFlushTimer) {
    allowFlushTimer = setInterval(() => flushAllowRollups(), ALLOW_ROLLUP_FLUSH_MS);
    if (allowFlushTimer.unref) allowFlushTimer.unref();
  }
}

export function emitDecisionAudit(
  subject: Subject,
  resource: Resource,
  action: Action,
  result: AuthorizeResult,
  ctx: DecisionContext = {},
  trustedContext: TrustedAuthorizeContext = {},
): void {
  const event = buildDecisionEvent(subject, resource, action, result, ctx, trustedContext);
  if (event.outcome === "allow" && !fullFidelityAllows()) {
    recordAllow(event);
    return;
  }
  writeAuditEvent(event as unknown as Record<string, unknown>);
}

export type GrantOperation = "grant" | "revoke";
export type GrantAuditOutcome = "success" | "error";

export interface GrantAuditOptions {
  outcome?: GrantAuditOutcome;
  /** Why the attempt failed (meta-authz deny, PDP error, etc.). */
  reasonCode?: string;
}

function principalRef(type: string, id?: string): string {
  if (type === "everyone") return "user:*";
  return `${type}:${id ?? ""}`;
}

function granteeLabel(g: GrantIntent["grantee"]): string {
  return principalRef(g.type, g.type === "everyone" ? undefined : g.id);
}

/**
 * Durable audit record for a grant/revoke attempt (success or failure).
 * Conforms to the unified audit tab — caller, grantee, resource, capability,
 * operation, outcome, reason, and tenant/correlation context are explicit.
 */
export interface CasGrantEvent {
  audit_event_id: string;
  ts: Date;
  type: "cas_grant";
  tenant_id: string;
  /** Hashed caller — who performed the policy change. */
  subject_hash: string;
  subject_ref: string;
  actor_hash: string;
  actor_ref: string;
  caller_ref: string;
  grantee_ref: string;
  action: Action;
  operation: GrantOperation;
  outcome: GrantAuditOutcome;
  reason_code?: string;
  resource_ref: string;
  resource_type: string;
  resource_id: string;
  correlation_id: string;
  component: "cas";
  pdp: "openfga";
  source: "cas";
  trace_id?: string;
  span_id?: string;
}

export function buildGrantEvent(
  operation: GrantOperation,
  intent: GrantIntent,
  ctx: DecisionContext = {},
  options: GrantAuditOptions = {},
): CasGrantEvent {
  if (!ctx.caller) {
    throw new Error("buildGrantEvent requires ctx.caller");
  }
  const outcome = options.outcome ?? "success";
  const callerRef = principalRef(ctx.caller.type, ctx.caller.id);
  return {
    audit_event_id: randomUUID(),
    ts: new Date(),
    type: "cas_grant",
    tenant_id: ctx.tenantId ?? process.env.TENANT_ID ?? "default",
    subject_hash: hashSubject(ctx.caller.id),
    subject_ref: callerRef,
    actor_hash: hashSubject(ctx.caller.id),
    actor_ref: callerRef,
    caller_ref: callerRef,
    grantee_ref: granteeLabel(intent.grantee),
    action: intent.capability,
    operation,
    outcome,
    resource_ref: `${intent.resource.type}:${intent.resource.id}`,
    resource_type: intent.resource.type,
    resource_id: intent.resource.id,
    correlation_id: ctx.correlationId ?? randomUUID(),
    component: "cas",
    pdp: "openfga",
    source: "cas",
    ...(options.reasonCode ? { reason_code: options.reasonCode } : {}),
    ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
    ...(ctx.spanId ? { span_id: ctx.spanId } : {}),
  };
}

export type ReconcileAuditOutcome = "success" | "error";

export interface ReconcileAuditOptions {
  outcome?: ReconcileAuditOutcome;
  reasonCode?: string;
}

/** Batch tuple reconcile (team resources, MCP ownership, etc.). */
export interface CasReconcileEvent {
  audit_event_id: string;
  ts: Date;
  type: "cas_reconcile";
  tenant_id: string;
  subject_hash?: string;
  subject_ref?: string;
  actor_hash?: string;
  actor_ref?: string;
  caller_ref?: string;
  /** CAS is the emitting subsystem; `reconcile_scope` identifies the caller. */
  source: "cas";
  reconcile_scope: string;
  action: "reconcile";
  resource_ref: "authorization_policy:openfga_relationship_tuples";
  resource_type: "authorization_policy";
  resource_id: "openfga_relationship_tuples";
  requested_writes: number;
  requested_deletes: number;
  writes: number;
  deletes: number;
  outcome: ReconcileAuditOutcome;
  reason_code?: string;
  correlation_id: string;
  component: "cas";
  pdp: "openfga";
  source_system: "cas";
  trace_id?: string;
  span_id?: string;
}

const DEFAULT_RECONCILE_SCOPE = "cas-reconciler";

function reconcileScope(source: string | undefined): string {
  return source?.trim() || DEFAULT_RECONCILE_SCOPE;
}

function systemPrincipalRef(scope: string): string {
  const normalized = scope
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `system:${normalized || DEFAULT_RECONCILE_SCOPE}`;
}

export function emitReconcileAudit(
  diff: { writes: unknown[]; deletes: unknown[] },
  result: { enabled: boolean; writes: number; deletes: number },
  ctx: DecisionContext & { caller?: Subject; source?: string } = {},
  options: ReconcileAuditOptions = {},
): void {
  const outcome = options.outcome ?? "success";
  if (outcome === "success" && result.writes === 0 && result.deletes === 0) return;

  const scope = reconcileScope(ctx.source);
  const callerRef = ctx.caller ? principalRef(ctx.caller.type, ctx.caller.id) : undefined;
  const systemRef = systemPrincipalRef(scope);
  const event: CasReconcileEvent = {
    audit_event_id: randomUUID(),
    ts: new Date(),
    type: "cas_reconcile",
    tenant_id: ctx.tenantId ?? process.env.TENANT_ID ?? "default",
    ...(ctx.caller
      ? {
          subject_hash: hashSubject(ctx.caller.id),
          subject_ref: callerRef,
          actor_hash: hashSubject(ctx.caller.id),
          actor_ref: callerRef,
          caller_ref: callerRef,
        }
      : {
          subject_ref: systemRef,
          actor_ref: systemRef,
        }),
    source: "cas",
    reconcile_scope: scope,
    action: "reconcile",
    resource_ref: "authorization_policy:openfga_relationship_tuples",
    resource_type: "authorization_policy",
    resource_id: "openfga_relationship_tuples",
    requested_writes: diff.writes.length,
    requested_deletes: diff.deletes.length,
    writes: result.writes,
    deletes: result.deletes,
    outcome,
    correlation_id: ctx.correlationId ?? randomUUID(),
    component: "cas",
    pdp: "openfga",
    source_system: "cas",
    ...(options.reasonCode ? { reason_code: options.reasonCode } : {}),
    ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
    ...(ctx.spanId ? { span_id: ctx.spanId } : {}),
  };

  writeAuditEvent(event as unknown as Record<string, unknown>);
}

/** One audit event per grant/revoke attempt through audit-service. */
export async function emitGrantAudit(
  operation: GrantOperation,
  intent: GrantIntent,
  ctx: DecisionContext = {},
  options: GrantAuditOptions = {},
): Promise<void> {
  if (!ctx.caller) return;

  const event = buildGrantEvent(operation, intent, ctx, options);
  writeAuditEvent(event as unknown as Record<string, unknown>);
}
