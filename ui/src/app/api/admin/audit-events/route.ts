import { ApiError, requireRbacPermission, withErrorHandler } from "@/lib/api-middleware";
import { authOptions } from "@/lib/auth-config";
import { AuditServiceError, getAuditClient, type AuditQuery } from "@/lib/audit";
import type { GatewayCheck } from "@/lib/authz";
import type {
  AuditEventType,
  UnifiedAuditEvent,
  UnifiedAuditOutcome,
} from "@/lib/rbac/types";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { createHash } from "crypto";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

// assisted-by Codex Codex-sonnet-4-6

const VALID_TYPES: string[] = [
  "auth",
  "tool_action",
  "agent_delegation",
  "openfga_rebac",
  "cas_decision",
  "cas_grant",
  "cas_reconcile",
  "credential_action",
];
const VALID_OUTCOMES: UnifiedAuditOutcome[] = ["allow", "deny", "success", "error"];
const VALID_WINDOWS = new Map<string, number>([
  ["5m", 5 * 60 * 1000],
  ["15m", 15 * 60 * 1000],
  ["30m", 30 * 60 * 1000],
  ["1h", 60 * 60 * 1000],
  ["6h", 6 * 60 * 60 * 1000],
  ["12h", 12 * 60 * 60 * 1000],
  ["24h", 24 * 60 * 60 * 1000],
  ["48h", 48 * 60 * 60 * 1000],
  ["7d", 7 * 24 * 60 * 60 * 1000],
]);
const SUBJECT_SALT = process.env.AUDIT_SUBJECT_SALT ?? "caipe-098-audit";

interface AuditEventDocument {
  audit_event_id?: string;
  ts: Date | string;
  type: string;
  tenant_id: string;
  subject_hash?: string;
  subject_ref?: string;
  user_email?: string;
  action?: string;
  capability?: string;
  agent_name?: string;
  tool_name?: string;
  outcome: UnifiedAuditOutcome;
  reason_code?: string;
  duration_ms?: number;
  correlation_id: string;
  context_id?: string;
  component?: string;
  resource_ref?: string;
  resource_type?: string;
  resource_id?: string;
  workflow_run_id?: string;
  decision_via?: string;
  decision_id?: string;
  failed_gate?: string;
  gateway_operation?: string;
  agent_ref?: string;
  gateway_checks?: unknown;
  gateway_policy?: string;
  pdp?: string;
  source?: string;
  source_system?: string;
  trace_id?: string;
  span_id?: string;
  trace_url?: string;
  actor_hash?: string;
  actor_ref?: string;
  caller_ref?: string;
  grantee_ref?: string;
  operation?: "grant" | "revoke";
  reconcile_scope?: string;
  requested_writes?: number;
  requested_deletes?: number;
  writes?: number;
  deletes?: number;
  count?: number;
  window_start?: Date | string;
  window_end?: Date | string;
  resources?: Array<{ action?: string; resource_ref?: string; count?: number }>;
  batch?: boolean;
  /** Marks a list-objects reverse-lookup row — see `batch` for the per-candidate-check equivalent. */
  list_objects?: boolean;
  evaluated_count?: number;
  allowed_count?: number;
  denied_count?: number;
  allowed_ids?: string[];
  allowed_truncated?: boolean;
  denied_reasons?: Record<string, number>;
}

interface CurrentPrincipal {
  hash: string;
  ref: string;
  email?: string;
}

interface UserIdentityDocument {
  email?: string;
  name?: string;
  keycloak_sub?: string;
  metadata?: {
    keycloak_sub?: string;
  };
}

interface TeamMembershipIdentityDocument {
  user_subject?: string;
  user_email?: string;
  status?: string;
}

interface ServiceAccountIdentityDocument {
  sa_sub?: string;
  client_id?: string;
  name?: string;
  status?: string;
}

function normalizeAuditSource(
  source: string | undefined,
  sourceSystem?: string,
): UnifiedAuditEvent["source"] {
  const value = sourceSystem || source;
  return (value === "bff" || !value ? "webui_backend" : value) as UnifiedAuditEvent["source"];
}

function reconcileScope(doc: AuditEventDocument): string | undefined {
  if (doc.reconcile_scope) return doc.reconcile_scope;
  if (doc.type !== "cas_reconcile" || !doc.source_system) return undefined;
  return doc.source && doc.source !== doc.source_system ? doc.source : undefined;
}

function hashSubject(id: string): string {
  return "sha256:" + createHash("sha256").update(`${SUBJECT_SALT}:${id}`).digest("hex");
}

function principalRef(type: "user" | "service_account", id: string): string {
  return `${type}:${id}`;
}

function currentPrincipalFromSession(session: {
  sub?: string;
  isServiceAccount?: boolean;
  user?: { email?: string | null };
} | null): CurrentPrincipal | undefined {
  const sub = session?.sub?.trim();
  if (!sub) return undefined;
  const type = session?.isServiceAccount === true ? "service_account" : "user";
  const email = type === "user" ? session?.user?.email?.trim() || undefined : undefined;
  return {
    hash: hashSubject(sub),
    ref: principalRef(type, sub),
    email,
  };
}

function withReadablePrincipalFields(
  doc: AuditEventDocument,
  currentPrincipal?: CurrentPrincipal,
): AuditEventDocument {
  if (!currentPrincipal) return doc;

  const enriched = { ...doc };
  if (!enriched.subject_ref && enriched.subject_hash === currentPrincipal.hash) {
    enriched.subject_ref = currentPrincipal.ref;
  }
  if (!enriched.actor_ref && enriched.actor_hash === currentPrincipal.hash) {
    enriched.actor_ref = currentPrincipal.ref;
  }
  if (!enriched.user_email && enriched.subject_hash === currentPrincipal.hash && currentPrincipal.email) {
    enriched.user_email = currentPrincipal.email;
  }
  return enriched;
}

function refId(ref: string | undefined, type: "user" | "service_account"): string | undefined {
  const prefix = `${type}:`;
  if (!ref?.startsWith(prefix)) return undefined;
  const id = ref.slice(prefix.length).split("#", 1)[0]?.trim();
  return id || undefined;
}

function displayLabelFromUser(user: UserIdentityDocument): string | undefined {
  return user.email?.trim() || user.name?.trim() || undefined;
}

function displayLabelFromServiceAccount(serviceAccount: ServiceAccountIdentityDocument): string | undefined {
  return serviceAccount.name?.trim() || serviceAccount.client_id?.trim() || undefined;
}

function setIfPresent(map: Map<string, string>, key: string | undefined, value: string | undefined): void {
  if (!key || !value || map.has(key)) return;
  map.set(key, value);
}

function collectPrincipalRefs(docs: AuditEventDocument[]): Set<string> {
  const refs = new Set<string>();
  for (const doc of docs) {
    for (const ref of [doc.subject_ref, doc.actor_ref, doc.caller_ref, doc.grantee_ref]) {
      if (refId(ref, "user") || refId(ref, "service_account")) refs.add(ref);
    }
  }
  return refs;
}

async function loadPrincipalDisplayMap(
  docs: AuditEventDocument[],
  currentPrincipal?: CurrentPrincipal,
): Promise<Map<string, string>> {
  const displayByRef = new Map<string, string>();
  if (currentPrincipal?.email) displayByRef.set(currentPrincipal.ref, currentPrincipal.email);
  if (!isMongoDBConfigured) return displayByRef;

  const refs = collectPrincipalRefs(docs);
  if (refs.size === 0) return displayByRef;

  const userSubjects = Array.from(refs).map((ref) => refId(ref, "user")).filter(Boolean) as string[];
  const serviceAccountSubjects = Array.from(refs)
    .map((ref) => refId(ref, "service_account"))
    .filter(Boolean) as string[];

  await Promise.all([
    (async () => {
      if (userSubjects.length === 0) return;
      try {
        const users = await getCollection<UserIdentityDocument>("users");
        const rows = await users
          .find({
            $or: [
              { keycloak_sub: { $in: userSubjects } },
              { "metadata.keycloak_sub": { $in: userSubjects } },
            ],
          })
          .project({ email: 1, name: 1, keycloak_sub: 1, "metadata.keycloak_sub": 1 })
          .toArray();
        for (const user of rows) {
          const label = displayLabelFromUser(user);
          setIfPresent(displayByRef, user.keycloak_sub ? `user:${user.keycloak_sub}` : undefined, label);
          setIfPresent(
            displayByRef,
            user.metadata?.keycloak_sub ? `user:${user.metadata.keycloak_sub}` : undefined,
            label,
          );
        }
      } catch (error) {
        console.warn("[audit-events] Could not resolve user identity display names", error);
      }
    })(),
    (async () => {
      if (userSubjects.length === 0) return;
      try {
        const sources = await getCollection<TeamMembershipIdentityDocument>("team_membership_sources");
        const rows = await sources
          .find({
            user_subject: { $in: userSubjects },
            user_email: { $type: "string" },
            status: "active",
          })
          .project({ user_subject: 1, user_email: 1 })
          .toArray();
        for (const source of rows) {
          setIfPresent(displayByRef, source.user_subject ? `user:${source.user_subject}` : undefined, source.user_email);
        }
      } catch (error) {
        console.warn("[audit-events] Could not resolve membership identity display names", error);
      }
    })(),
    (async () => {
      if (serviceAccountSubjects.length === 0) return;
      try {
        const serviceAccounts = await getCollection<ServiceAccountIdentityDocument>("service_accounts");
        const rows = await serviceAccounts
          .find({ sa_sub: { $in: serviceAccountSubjects } })
          .project({ sa_sub: 1, client_id: 1, name: 1 })
          .toArray();
        for (const serviceAccount of rows) {
          setIfPresent(
            displayByRef,
            serviceAccount.sa_sub ? `service_account:${serviceAccount.sa_sub}` : undefined,
            displayLabelFromServiceAccount(serviceAccount),
          );
        }
      } catch (error) {
        console.warn("[audit-events] Could not resolve service-account display names", error);
      }
    })(),
  ]);

  return displayByRef;
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function withPrincipalDisplayFields(
  event: UnifiedAuditEvent,
  displayByRef: Map<string, string>,
): UnifiedAuditEvent {
  const subjectDisplay = event.subject_ref ? displayByRef.get(event.subject_ref) : undefined;
  const actorDisplay = event.actor_ref ? displayByRef.get(event.actor_ref) : undefined;
  const callerDisplay = event.caller_ref ? displayByRef.get(event.caller_ref) : undefined;
  const granteeDisplay = event.grantee_ref ? displayByRef.get(event.grantee_ref) : undefined;

  const enriched: UnifiedAuditEvent = {
    ...event,
    ...(subjectDisplay ? { subject_display: subjectDisplay } : {}),
    ...(actorDisplay ? { actor_display: actorDisplay } : {}),
    ...(callerDisplay ? { caller_display: callerDisplay } : {}),
    ...(granteeDisplay ? { grantee_display: granteeDisplay } : {}),
  };

  if (!enriched.user_email && subjectDisplay && isEmailLike(subjectDisplay)) {
    enriched.user_email = subjectDisplay;
  }

  return enriched;
}

function parseIsoDate(value: string | null, label: string): Date {
  if (!value?.trim()) {
    throw new ApiError(`Invalid ${label}: expected ISO date string`, 400, "VALIDATION_ERROR");
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(`Invalid ${label}: not a valid ISO date`, 400, "VALIDATION_ERROR");
  }
  return d;
}

function parseWindow(value: string | null): { name: string; ms: number } {
  const name = (value ?? "5m").trim().toLowerCase();
  const ms = VALID_WINDOWS.get(name);
  if (ms === undefined) {
    throw new ApiError(
      "`window` must be one of: 5m, 15m, 30m, 1h, 6h, 12h, 24h, 48h, 7d",
      400,
      "VALIDATION_ERROR",
    );
  }
  return { name, ms };
}

function toIsoOrUndefined(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeGatewayChecks(value: unknown): GatewayCheck[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const checks: GatewayCheck[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const { gate, subject_ref, relation, resource_ref, decision, reason } = item;
    if (!["context", "gateway", "server", "agent", "agent_tool", "caller_tool"].includes(gate) ||
      typeof subject_ref !== "string" || !["ALLOW", "DENY"].includes(decision) ||
      !["OK", "NO_CAPABILITY", "AUTHZ_UNAVAILABLE", "NOT_AUTHENTICATED", "INVALID_REQUEST"].includes(reason) ||
      (relation !== undefined && !["can_call", "can_use", "can_invoke", "can_search"].includes(relation)) ||
      (resource_ref !== undefined && typeof resource_ref !== "string")) return undefined;
    // Nested audit payloads are allowlisted too; never return producer extras.
    checks.push({ gate, subject_ref, decision, reason,
      ...(relation ? { relation } : {}), ...(resource_ref ? { resource_ref } : {}) });
  }
  return checks;
}

function documentToEvent(doc: AuditEventDocument): UnifiedAuditEvent {
  const ts =
    doc.ts instanceof Date
      ? doc.ts.toISOString()
      : new Date(doc.ts).toISOString();

  return {
    audit_event_id: doc.audit_event_id,
    ts,
    type: doc.type as AuditEventType,
    tenant_id: doc.tenant_id,
    subject_hash: doc.subject_hash,
    subject_ref: doc.subject_ref,
    user_email: doc.user_email,
    action: doc.action ?? doc.capability ?? "",
    agent_name: doc.agent_name,
    tool_name: doc.tool_name,
    outcome: doc.outcome,
    reason_code: doc.reason_code,
    duration_ms: doc.duration_ms,
    correlation_id: doc.correlation_id,
    context_id: doc.context_id,
    component: doc.component,
    resource_ref: doc.resource_ref,
    resource_type: doc.resource_type,
    resource_id: doc.resource_id,
    workflow_run_id: doc.workflow_run_id,
    decision_via: doc.decision_via,
    decision_id: doc.decision_id,
    failed_gate: doc.failed_gate,
    gateway_operation: doc.gateway_operation,
    agent_ref: doc.agent_ref,
    gateway_checks: safeGatewayChecks(doc.gateway_checks),
    gateway_policy: typeof doc.gateway_policy === "string" ? doc.gateway_policy : undefined,
    pdp: doc.pdp,
    source: normalizeAuditSource(doc.source, doc.source_system),
    actor_hash: doc.actor_hash,
    actor_ref: doc.actor_ref,
    caller_ref: doc.caller_ref,
    grantee_ref: doc.grantee_ref,
    operation: doc.operation,
    reconcile_scope: reconcileScope(doc),
    requested_writes: doc.requested_writes,
    requested_deletes: doc.requested_deletes,
    writes: doc.writes,
    deletes: doc.deletes,
    trace_id: doc.trace_id,
    span_id: doc.span_id,
    // Aggregate-row fields. Omitting these silently flattened every rollup and
    // batch row into what looked like a single decision, in the tab and in
    // exports alike.
    count: doc.count,
    window_start: toIsoOrUndefined(doc.window_start),
    window_end: toIsoOrUndefined(doc.window_end),
    resources: doc.resources,
    batch: doc.batch,
    list_objects: doc.list_objects,
    evaluated_count: doc.evaluated_count,
    allowed_count: doc.allowed_count,
    denied_count: doc.denied_count,
    allowed_ids: doc.allowed_ids,
    allowed_truncated: doc.allowed_truncated,
    denied_reasons: doc.denied_reasons,
  };
}

async function queryAuditService(
  query: AuditQuery,
): Promise<{ records: AuditEventDocument[]; cursor?: string; next_cursor: string | null; since?: string; until?: string; as_of?: string; warning?: string }> {
  try {
    return await getAuditClient().queryPage<AuditEventDocument>(query);
  } catch (error) {
    if (error instanceof AuditServiceError && error.statusCode === 400) {
      throw new ApiError(error.message, 400, "VALIDATION_ERROR");
    }
    const warning = "Audit queries unavailable; no conclusions can be drawn from these results";
    console.warn("[audit-events]", warning, error);
    return { records: [], next_cursor: null, warning };
  }
}

export const GET = withErrorHandler(async (request: NextRequest): Promise<NextResponse> => {
  const session = (await getServerSession(authOptions)) as {
    accessToken?: string;
    sub?: string;
    isServiceAccount?: boolean;
    org?: string;
    user?: { email?: string | null };
  } | null;

  if (!session?.user?.email) {
    throw new ApiError("Unauthorized", 401);
  }

  await requireRbacPermission(
    {
      accessToken: session.accessToken,
      sub: session.sub,
      org: session.org,
      user: { email: session.user.email ?? undefined },
    },
    "admin_ui",
    "audit.view",
  );

  const url = new URL(request.url);
  const supportedParams = new Set(["from", "to", "window", "cursor", "limit", "type", "outcome", "agent_name", "tool_name", "user_email", "component", "correlation_id", "decision_id", "subject_ref", "resource_ref"]);
  for (const key of url.searchParams.keys()) {
    if (!supportedParams.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ApiError("Unsupported or repeated audit query parameter", 400, "VALIDATION_ERROR");
    }
  }
  const now = new Date();

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const requestedWindow = url.searchParams.get("window");
  const explicitRange = Boolean(fromParam || toParam);
  const window = parseWindow(requestedWindow);
  const responseWindow = explicitRange && !requestedWindow ? "custom" : window.name;
  const to = toParam ? parseIsoDate(toParam, "to") : now;
  const from = fromParam ? parseIsoDate(fromParam, "from") : new Date(to.getTime() - window.ms);

  if (from.getTime() > to.getTime()) {
    throw new ApiError("`from` must be before or equal to `to`", 400, "VALIDATION_ERROR");
  }

  const typeParam = url.searchParams.get("type")?.trim().toLowerCase();
  const agentName = url.searchParams.get("agent_name")?.trim();
  const toolName = url.searchParams.get("tool_name")?.trim();
  const outcomeParam = url.searchParams.get("outcome")?.trim().toLowerCase();
  const userEmail = url.searchParams.get("user_email")?.trim();
  const component = url.searchParams.get("component")?.trim();
  const correlationId = url.searchParams.get("correlation_id")?.trim();
  const decisionId = url.searchParams.get("decision_id")?.trim();
  const subjectRef = url.searchParams.get("subject_ref")?.trim();
  const resourceRef = url.searchParams.get("resource_ref")?.trim();

  if (typeParam && !VALID_TYPES.includes(typeParam)) {
    throw new ApiError(
      `\`type\` must be one of: ${VALID_TYPES.join(", ")}`,
      400,
      "VALIDATION_ERROR",
    );
  }

  if (outcomeParam && !VALID_OUTCOMES.includes(outcomeParam as UnifiedAuditOutcome)) {
    throw new ApiError(
      `\`outcome\` must be one of: ${VALID_OUTCOMES.join(", ")}`,
      400,
      "VALIDATION_ERROR",
    );
  }

  const limitRaw = url.searchParams.get("limit") ?? "50";
  const limit = Number(limitRaw);
  if (!/^\d+$/.test(limitRaw) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiError("`limit` must be between 1 and 200", 400, "VALIDATION_ERROR");
  }

  const query: AuditQuery = { limit, window: window.name };
  // Preserve relative parameters across pages. The service pins their range
  // and ingestion cutoff in its cursor; computing fresh dates here would drift.
  if (fromParam) query.since = from;
  if (toParam) query.until = to;
  const cursor = url.searchParams.get("cursor");
  if (cursor) query.cursor = cursor;
  if (session.org) query.tenant_id = session.org;
  if (typeParam) query.type = typeParam;
  if (agentName) query.agent_name = agentName;
  if (toolName) query.tool_name = toolName;
  if (outcomeParam) query.outcome = outcomeParam;
  if (userEmail) query.user_email = userEmail;
  if (component) query.component = component;
  if (correlationId) query.correlation_id = correlationId;
  if (decisionId) query.decision_id = decisionId;
  if (subjectRef) query.subject_ref = subjectRef;
  if (resourceRef) query.resource_ref = resourceRef;

  const { records: docs, cursor: pageCursor, next_cursor, since, until, as_of, warning } = await queryAuditService(query);
  const currentPrincipal = currentPrincipalFromSession(session);
  const pageDocs = docs.map((doc) => withReadablePrincipalFields(doc, currentPrincipal));
  const principalDisplays = await loadPrincipalDisplayMap(pageDocs, currentPrincipal);
  const records = pageDocs.map((doc) => withPrincipalDisplayFields(documentToEvent(doc), principalDisplays));

  return NextResponse.json({
    records,
    cursor: pageCursor, next_cursor, since, until, as_of,
    limit,
    window: responseWindow,
    ...(warning ? { warning, auditUnavailable: true } : {}),
  });
});
