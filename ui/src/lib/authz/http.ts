// assisted-by Codex Codex-sonnet-4-6
//
// Shared HTTP-layer helpers for the /api/authz/v1 routes: caller resolution,
// input validation, and subject-binding. These enforce the trust boundary —
// see spec §6 (threats 1–3). The rule of thumb: FAIL CLOSED. If we cannot
// positively establish the caller's verified subject, we reject.

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";

import { emitGrantAudit, type GrantOperation } from "./audit";
import { authorize } from "./index";
import { isSupportedResourceAction, listResourceTypeDefinitions } from "@/lib/rbac/resource-model";
import type {
  Action,
  AuthorizeResult,
  DecisionContext,
  Grantee,
  GrantIntent,
  Resource,
  ResourceType,
  Subject,
  SubjectType,
} from "./contract";

const ORG_KEY = process.env.CAIPE_ORG_KEY ?? "caipe";
const ID_MAX_LEN = 256;
const RAW_ID_MAX_LEN = 512;

// Safe id charset: alnum plus the characters that appear in Keycloak subs
// (UUID), emails (`. _ % + - @`). Deliberately EXCLUDES:
//   *  — wildcard (would let a caller probe `agent:*` public-share tuples)
//   #  — OpenFGA relation separator
//   :  — OpenFGA type separator
//   /  — path traversal
// so a caller can never smuggle OpenFGA structure through an id field.
const ID_PATTERN = /^[A-Za-z0-9._%+\-@]+$/;
const RESERVED_ADVISORY_CONTEXT_KEYS = new Set(["workflow_run_id"]);

const SUBJECT_TYPES: ReadonlySet<string> = new Set<SubjectType>(["user", "service_account"]);
const RESOURCE_DEFINITIONS = listResourceTypeDefinitions();
const RESOURCE_TYPES: ReadonlySet<string> = new Set(RESOURCE_DEFINITIONS.map((definition) => definition.type));
const ACTIONS: ReadonlySet<string> = new Set(RESOURCE_DEFINITIONS.flatMap((definition) => definition.actions));
const PUBLIC_GRANTABLE_EVERYONE_RESOURCE_ACTIONS: ReadonlySet<string> = new Set([
  "admin_surface:discover",
  "agent:discover",
  "agent:use",
  "audit_log:discover",
  "data_source:discover",
  "document:discover",
  "external_group:discover",
  "knowledge_base:discover",
  "llm_model:discover",
  "mcp_server:discover",
  "mcp_tool:discover",
  "organization:discover",
  "policy:discover",
  "secret_ref:discover",
  "skill:discover",
  "slack_channel:discover",
  "slack_workspace:discover",
  "system_config:discover",
  "task:discover",
  "team:discover",
  "tool:discover",
  "user_profile:discover",
  "webex_space:discover",
  "webex_workspace:discover",
]);

// ─── Meta errors (HTTP-level failures, distinct from a DENY decision) ─────────

export type MetaCode = "NOT_AUTHENTICATED" | "FORBIDDEN" | "INVALID_REQUEST" | "AUTHZ_UNAVAILABLE";

export class HttpAuthzError extends Error {
  constructor(
    readonly status: number,
    readonly code: MetaCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpAuthzError";
  }
}

export function metaErrorResponse(err: HttpAuthzError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, retriable: err.code === "AUTHZ_UNAVAILABLE" },
    { status: err.status },
  );
}

// ─── Caller resolution (fail-closed) ──────────────────────────────────────────

export interface Caller {
  type: SubjectType;
  id: string;
}

/**
 * Returns the verified caller identity, or null if no stable human/service
 * subject can be established. Scoped catalog credentials remain distinct
 * principals even when they carry their owner's `sub`, so they cannot be
 * promoted into general per-subject authorization decisions.
 */
export function resolveCaller(session: unknown): Caller | null {
  if (!session || typeof session !== "object") return null;
  const s = session as {
    sub?: unknown;
    isServiceAccount?: unknown;
    principalType?: unknown;
  };
  if (s.principalType === 'catalog_api_key' || s.principalType === 'skills_api_key') {
    return null;
  }
  const sub = typeof s.sub === "string" ? s.sub.trim() : "";
  if (!sub) return null;
  return { type: s.isServiceAccount === true ? "service_account" : "user", id: sub };
}

export function decisionContext(session: unknown, caller?: Caller, request?: Request): DecisionContext {
  let tenantId: string | undefined;
  if (session && typeof session === "object") {
    const org = (session as { org?: unknown }).org;
    if (typeof org === "string" && org.trim()) tenantId = org.trim();
  }
  const headerCorrelation = request?.headers.get("x-correlation-id")?.trim();
  return {
    tenantId,
    correlationId: headerCorrelation || randomUUID(),
    ...(caller ? { caller: { type: caller.type, id: caller.id } } : {}),
  };
}

// ─── Input validation ─────────────────────────────────────────────────────────

export function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ID_MAX_LEN &&
    ID_PATTERN.test(value)
  );
}

function isValidRawObjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= RAW_ID_MAX_LEN &&
    !value.includes("*") &&
    !value.includes("#") &&
    !value.includes("\0")
  );
}

export function isValidResourceId(type: ResourceType, value: unknown): value is string {
  if (type === "llm_model") return isValidRawObjectId(value);
  return isValidId(value);
}

export function sanitizeAdvisoryContext(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_ADVISORY_CONTEXT_KEYS.has(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseSubject(raw: unknown): Subject {
  if (!raw || typeof raw !== "object") {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "subject is required");
  }
  const r = raw as Record<string, unknown>;
  if (!SUBJECT_TYPES.has(r.type as string)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "subject.type must be 'user' or 'service_account'");
  }
  if (!isValidId(r.id)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "subject.id is missing or contains invalid characters");
  }
  return { type: r.type as SubjectType, id: r.id as string };
}

export function parseResource(raw: unknown): Resource {
  if (!raw || typeof raw !== "object") {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "resource is required");
  }
  const r = raw as Record<string, unknown>;
  const type = r.type as ResourceType;
  if (!RESOURCE_TYPES.has(type)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "resource.type is not a recognized resource type");
  }
  if (!isValidResourceId(type, r.id)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "resource.id is missing or contains invalid characters");
  }
  return { type, id: r.id as string };
}

export function parseAction(raw: unknown): Action {
  if (!ACTIONS.has(raw as string)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "action is not a recognized action");
  }
  return raw as Action;
}

export function parseResourceType(raw: unknown): ResourceType {
  if (!RESOURCE_TYPES.has(raw as string)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "resource_type is not a recognized resource type");
  }
  return raw as ResourceType;
}

// ─── Subject-binding (the core trust-boundary control) ────────────────────────

/**
 * A caller may only evaluate decisions for its OWN subject. Cross-subject
 * evaluation (one principal asking about another) requires `can_audit` on the
 * organization — the admin/explain capability. This single rule closes both
 * forged-subject (threat #1) and impersonation (threat #2): the OBO flow works
 * naturally because a bot presents the *user's* token, so caller == subject.
 */
export async function enforceSubjectBinding(
  caller: Caller,
  subject: Subject,
  ctx: DecisionContext,
): Promise<void> {
  if (subject.type === caller.type && subject.id === caller.id) return;

  const audit = await authorize(
    { subject: caller, resource: { type: "organization", id: ORG_KEY }, action: "audit" },
    ctx,
  );
  if (audit.decision !== "ALLOW") {
    throw new HttpAuthzError(403, "FORBIDDEN", "You may only evaluate decisions for your own subject");
  }
}

/** Unconditional can_audit gate for the admin /explain endpoint. */
export async function requireAuditCapability(caller: Caller, ctx: DecisionContext): Promise<void> {
  const audit = await authorize(
    { subject: caller, resource: { type: "organization", id: ORG_KEY }, action: "audit" },
    ctx,
  );
  if (audit.decision !== "ALLOW") {
    throw new HttpAuthzError(403, "FORBIDDEN", "can_audit permission is required to use /explain");
  }
}

// ─── Grant / Revoke helpers ───────────────────────────────────────────────────

const GRANTEE_TYPES_WITH_ID: ReadonlySet<string> = new Set(["user", "service_account", "team"]);

export function parseGrantee(raw: unknown): Grantee {
  if (!raw || typeof raw !== "object") {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "grantee is required");
  }
  const r = raw as Record<string, unknown>;
  if (r.type === "everyone") return { type: "everyone" };
  if (!GRANTEE_TYPES_WITH_ID.has(r.type as string)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "grantee.type must be user, service_account, team, or everyone");
  }
  if (!isValidId(r.id)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "grantee.id is missing or contains invalid characters");
  }
  return { type: r.type as "user" | "service_account" | "team", id: r.id as string };
}

export function parseGrantIntent(raw: unknown): GrantIntent {
  if (!raw || typeof raw !== "object") {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "request body must be an object");
  }
  const b = raw as Record<string, unknown>;
  const resource = parseResource(b.resource);
  const grantee = parseGrantee(b.grantee);
  const capability = parseAction(b.capability);
  if (!isSupportedResourceAction(resource.type, capability)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "capability is not supported for this resource type");
  }
  if (grantee.type === "everyone" && !isPublicEveryoneGrantable(resource, capability)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "everyone grants are limited to low-risk resource capabilities");
  }
  return { resource, grantee, capability };
}

function isPublicEveryoneGrantable(resource: Resource, capability: Action): boolean {
  return PUBLIC_GRANTABLE_EVERYONE_RESOURCE_ACTIONS.has(`${resource.type}:${capability}`);
}

/** Optional grant/revoke audit context when meta-authz fails before the PAP write. */
export interface GrantAuditRequest {
  operation: GrantOperation;
  intent: GrantIntent;
}

/** Per-resource meta-authz: the caller must hold `manage` on the resource to grant/revoke. */
export async function requireManage(
  caller: Caller,
  resource: Resource,
  ctx: DecisionContext,
  audit?: GrantAuditRequest,
): Promise<void> {
  const check = await authorize({ subject: caller, resource, action: "manage" }, ctx);
  if (check.decision === "ALLOW") return;
  if (check.reason === "AUTHZ_UNAVAILABLE" || check.retriable) {
    if (audit) {
      await emitGrantAudit(audit.operation, audit.intent, ctx, {
        outcome: "error",
        reasonCode: check.reason,
      });
    }
    throw metaAuthzDecisionError(check, "You must have manage permission on the resource to grant or revoke access");
  }

  const orgAdmin = await authorize(
    { subject: caller, resource: { type: "organization", id: ORG_KEY }, action: "manage" },
    ctx,
  );
  if (orgAdmin.decision === "ALLOW") return;

  if (audit) {
    await emitGrantAudit(audit.operation, audit.intent, ctx, {
      outcome: "error",
      reasonCode: orgAdmin.reason,
    });
  }
  throw metaAuthzDecisionError(orgAdmin, "You must have manage permission on the resource to grant or revoke access");
}

function metaAuthzDecisionError(result: AuthorizeResult, forbiddenMessage: string): HttpAuthzError {
  if (result.reason === "AUTHZ_UNAVAILABLE" || result.retriable) {
    return new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Authorization service temporarily unavailable");
  }
  return new HttpAuthzError(403, "FORBIDDEN", forbiddenMessage);
}
