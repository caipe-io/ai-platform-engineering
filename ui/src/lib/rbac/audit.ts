import { createHash,randomUUID } from "crypto";
import { getAuditBackend } from "@/lib/audit";
import { withAuditImpersonationActor } from "@/lib/audit/impersonation-context";
import {
createAuthzTraceContext,
emitAuthzSpan,
getCurrentAuthzTraceContext,
} from "./authz-tracing";
import type {
AuditEvent,
AuditEventSource,
AuditEventType,
AuditOutcome,
AuditPdp,
AuditReasonCode,
RbacResource,
} from "./types";

const SUBJECT_SALT = process.env.AUDIT_SUBJECT_SALT || "caipe-098-audit";

const WEBUI_BACKEND_SOURCE: AuditEventSource = "webui_backend";

function hashSubject(sub: string): string {
  return `sha256:${createHash("sha256").update(`${SUBJECT_SALT}:${sub}`).digest("hex")}`;
}

export interface LogAuthzDecisionParams {
  tenantId: string;
  sub: string;
  actorSub?: string;
  subjectRef?: string;
  impersonationStartedAt?: string;
  resource: RbacResource;
  scope: string;
  outcome: AuditOutcome;
  reasonCode: AuditReasonCode;
  pdp: AuditPdp;
  resourceRef?: string;
  correlationId?: string;
  email?: string;
  auditType?: AuditEventType;
  source?: AuditEventSource;
  auditEventId?: string;
  traceId?: string;
  spanId?: string;
  traceUrl?: string;
}

/**
 * Emit a structured authorization decision audit event.
 * Sends the event to audit-service for durable storage (fire-and-forget).
 */
export function logAuthzDecision(params: LogAuthzDecisionParams): AuditEvent {
  const currentTrace = getCurrentAuthzTraceContext();
  const fallbackTrace = currentTrace ?? createAuthzTraceContext();
  const traceId = params.traceId ?? fallbackTrace.traceId;
  const spanId = params.spanId ?? fallbackTrace.spanId;
  const auditEventId = params.auditEventId ?? randomUUID();
  const event: AuditEvent = {
    audit_event_id: auditEventId,
    ts: new Date().toISOString(),
    tenant_id: params.tenantId,
    subject_hash: hashSubject(params.sub),
    actor_hash: params.actorSub ? hashSubject(params.actorSub) : undefined,
    actor_ref: params.actorSub ? `user:${params.actorSub}` : undefined,
    impersonation: Boolean(params.actorSub),
    impersonation_started_at: params.impersonationStartedAt,
    capability: `${params.resource}#${params.scope}`,
    component: params.resource,
    resource_ref: params.resourceRef,
    outcome: params.outcome,
    reason_code: params.reasonCode,
    pdp: params.pdp,
    correlation_id: params.correlationId || randomUUID(),
    trace_id: traceId,
    span_id: spanId,
    trace_url: params.traceUrl,
  };

  if (params.auditType === "openfga_rebac" || params.pdp === "openfga") {
    emitAuthzSpan("authz.audit.persist", {
      "audit.event_id": auditEventId,
      "authz.action": event.capability,
      "authz.outcome": event.outcome,
      "authz.reason_code": event.reason_code,
      "authz.resource_ref": event.resource_ref,
      "authz.component": event.component,
      "authz.source": params.source ?? WEBUI_BACKEND_SOURCE,
    }, fallbackTrace);
  }
  const auditType: AuditEventType = params.auditType ?? "auth";
  const auditSource: AuditEventSource = params.source ?? WEBUI_BACKEND_SOURCE;
  getAuditBackend().write(withAuditImpersonationActor({
    ts: event.ts,
    type: auditType,
    tenant_id: event.tenant_id,
    subject_hash: event.subject_hash,
    action: event.capability,
    outcome: event.outcome,
    reason_code: event.reason_code,
    correlation_id: event.correlation_id,
    component: event.component,
    resource_ref: event.resource_ref,
    pdp: event.pdp,
    source: auditSource,
    ...(event.audit_event_id ? { audit_event_id: event.audit_event_id } : {}),
    ...(event.trace_id ? { trace_id: event.trace_id } : {}),
    ...(event.span_id ? { span_id: event.span_id } : {}),
    ...(event.trace_url ? { trace_url: event.trace_url } : {}),
    ...(event.actor_hash ? { actor_hash: event.actor_hash } : {}),
    ...(event.actor_ref ? { actor_ref: event.actor_ref } : {}),
    ...(params.subjectRef ? { subject_ref: params.subjectRef } : {}),
    ...(event.impersonation ? { impersonation: true } : {}),
    ...(event.impersonation_started_at
      ? { impersonation_started_at: event.impersonation_started_at }
      : {}),
    ...(params.email ? { user_email: params.email } : {}),
  }, params.actorSub ? { actorSub: params.actorSub } : undefined));
  return event;
}

export type RbacAdminAuditEventKind =
  | "identity_group_sync"
  | "policy_change"
  | "graph_query"
  | "access_check"
  | "slack_channel_rebac";

export interface LogRbacAdminAuditEventParams {
  tenantId: string;
  sub: string;
  actorSub?: string;
  kind: RbacAdminAuditEventKind;
  operation: string;
  outcome?: AuditOutcome;
  reasonCode?: AuditReasonCode;
  resourceRef?: string;
  correlationId?: string;
  email?: string;
}

function adminAuditResource(kind: RbacAdminAuditEventKind): RbacResource {
  return kind === "slack_channel_rebac" ? "slack" : "admin_ui";
}

function adminAuditScope(kind: RbacAdminAuditEventKind, operation: string): string {
  if (kind === "graph_query" || kind === "access_check") return "view";
  if (operation.startsWith("dry_run") || operation.startsWith("preview")) return "view";
  return kind === "slack_channel_rebac" ? "manage" : "admin";
}

export function logRbacAdminAuditEvent(params: LogRbacAdminAuditEventParams): AuditEvent {
  const resourceRef = params.resourceRef ?? `${params.kind}:${params.operation}`;
  return logAuthzDecision({
    tenantId: params.tenantId,
    sub: params.sub,
    actorSub: params.actorSub,
    resource: adminAuditResource(params.kind),
    scope: adminAuditScope(params.kind, params.operation),
    outcome: params.outcome ?? "allow",
    reasonCode: params.reasonCode ?? "OK",
    pdp: "local",
    resourceRef,
    correlationId: params.correlationId,
    email: params.email,
  });
}

export interface LogOpenFgaRebacAuditEventParams {
  tenantId?: string;
  sub: string;
  actorSub?: string;
  operation: string;
  outcome?: AuditOutcome;
  reasonCode?: AuditReasonCode;
  resource?: RbacResource;
  scope?: string;
  resourceRef?: string;
  correlationId?: string;
  email?: string;
  pdp?: AuditPdp;
  source?: AuditEventSource;
  auditEventId?: string;
  traceId?: string;
  spanId?: string;
  traceUrl?: string;
}

function openFgaScopeForOperation(operation: string): string {
  if (
    operation.startsWith("query") ||
    operation.startsWith("check") ||
    operation.startsWith("explain") ||
    operation.startsWith("list")
  ) {
    return "view";
  }
  return "admin";
}

export function logOpenFgaRebacAuditEvent(params: LogOpenFgaRebacAuditEventParams): AuditEvent {
  return logAuthzDecision({
    tenantId: params.tenantId ?? "default",
    sub: params.sub,
    actorSub: params.actorSub,
    resource: params.resource ?? "admin_ui",
    scope: params.scope ?? openFgaScopeForOperation(params.operation),
    outcome: params.outcome ?? "allow",
    reasonCode: params.reasonCode ?? "OK",
    pdp: params.pdp ?? "openfga",
    resourceRef: params.resourceRef ?? `openfga_rebac:${params.operation}`,
    correlationId: params.correlationId,
    email: params.email,
    auditType: "openfga_rebac",
    source: params.source ?? WEBUI_BACKEND_SOURCE,
    auditEventId: params.auditEventId,
    traceId: params.traceId,
    spanId: params.spanId,
    traceUrl: params.traceUrl,
  });
}

export function logIdentityGroupSyncAuditEvent(
  params: Omit<LogRbacAdminAuditEventParams, "kind">
): AuditEvent {
  return logRbacAdminAuditEvent({ ...params, kind: "identity_group_sync" });
}

export function logPolicyChangeAuditEvent(
  params: Omit<LogRbacAdminAuditEventParams, "kind">
): AuditEvent {
  return logRbacAdminAuditEvent({ ...params, kind: "policy_change" });
}

export function logGraphQueryAuditEvent(
  params: Omit<LogRbacAdminAuditEventParams, "kind">
): AuditEvent {
  return logOpenFgaRebacAuditEvent({ ...params, operation: params.operation });
}

export function logAccessCheckAuditEvent(
  params: Omit<LogRbacAdminAuditEventParams, "kind">
): AuditEvent {
  return logOpenFgaRebacAuditEvent({ ...params, operation: params.operation });
}

export function logSlackChannelRebacAuditEvent(
  params: Omit<LogRbacAdminAuditEventParams, "kind">
): AuditEvent {
  return logRbacAdminAuditEvent({ ...params, kind: "slack_channel_rebac" });
}
