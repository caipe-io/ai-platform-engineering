import type { PlatformIdentity } from "@/lib/auth/platform-identity";
import type { Action, AuthorizeResult, Resource } from "./contract";

export const DELEGATION_POLICY = "cas-delegation/v1";
export const DELEGATION_MAX_SCOPE = 16;
export const DELEGATION_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface DelegatedPermission { resource: Resource; action: Action }
export interface DelegationIntent {
  service: { id: string; client_id: string };
  job_id: string;
  scope: DelegatedPermission[];
  expires_at: string;
}
export interface DelegationRecord extends DelegationIntent {
  _id: string;
  issuer: string;
  user_id: string;
  created_at: string;
  revoked_at: string | null;
  version: number;
}
/** Safe approval snapshot, not a token or proof that a job actually executed. */
export interface DelegationSnapshot extends DelegationIntent {
  user_ref: string;
  service_ref: string;
  issuer: string;
  created_at: string;
  revoked_at: string | null;
  version: number;
}
export type DelegationReason = AuthorizeResult["reason"] | "DELEGATION_NOT_FOUND" |
  "DELEGATION_BINDING_MISMATCH" | "DELEGATION_EXPIRED" | "DELEGATION_REVOKED" |
  "DELEGATION_SCOPE_MISMATCH" | "SERVICE_NOT_ALLOWED" | "USER_NOT_ALLOWED";
export interface DelegationCheck {
  gate: "binding" | "approval" | "scope" | "service_permission" | "user_permission" | "approval_recheck";
  decision: "ALLOW" | "DENY";
  reason: DelegationReason;
}
export interface DelegationDecision {
  decision: "ALLOW" | "DENY";
  reason: DelegationReason;
  retriable: boolean;
  ttl_seconds: 0;
  decision_id: string;
  delegation_id: string;
}
export interface DelegatedRequest extends DelegatedPermission { job_id: string }
export type DelegationIdentity = Pick<PlatformIdentity, "issuer" | "subject" | "clientId" | "expiresAt">;

/** Server-derived authority, never accepted from request JSON or unsigned claims.
 * Identity/delegation evidence is distinct from the job's approved boundaries. */
export interface DelegationEvidence { kind: "cas_approval"; reference: string }
export interface DelegationApproval {
  effectiveSubject: { type: "user"; id: string };
  evidence: DelegationEvidence;
  approval: DelegationSnapshot;
}
export interface DelegationAuthority extends DelegationApproval {
  issuer: string;
  actor: { type: "service_account"; id: string };
  clientId: string;
  credentialExpiresAt: number;
}

export function delegationSnapshot(record: DelegationRecord): DelegationSnapshot {
  return {
    user_ref: `user:${record.user_id}`, service_ref: `service_account:${record.service.id}`,
    issuer: record.issuer, service: record.service, job_id: record.job_id, scope: record.scope,
    expires_at: record.expires_at, created_at: record.created_at, revoked_at: record.revoked_at, version: record.version,
  };
}

/** Display metadata only; unknown evidence formats are not silently trusted. */
export function safeDelegationEvidence(value: unknown): DelegationEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.kind !== "cas_approval" || typeof item.reference !== "string" || !item.reference || item.reference.length > 256) return undefined;
  return { kind: "cas_approval", reference: item.reference };
}

/** Audit ingestion is not a trust boundary. Allowlist display fields and never
 * forward arbitrary nested producer data (particularly credentials) to the UI. */
export function safeDelegationSnapshot(value: unknown): DelegationSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
  if (!text(item.user_ref) || !text(item.service_ref) || !text(item.issuer) || !text(item.job_id) ||
    !text(item.created_at) || !text(item.expires_at) || (item.revoked_at !== null && !text(item.revoked_at)) ||
    !Number.isSafeInteger(item.version) || (item.version as number) < 1 ||
    !item.service || typeof item.service !== "object" || !Array.isArray(item.scope) || item.scope.length > DELEGATION_MAX_SCOPE) return undefined;
  const service = item.service as Record<string, unknown>;
  if (!text(service.id) || !text(service.client_id)) return undefined;
  const scope: DelegatedPermission[] = [];
  for (const entry of item.scope) {
    if (!entry || typeof entry !== "object") return undefined;
    const { action, resource } = entry;
    if (!text(action) || !resource || typeof resource !== "object" || !text(resource.type) || !text(resource.id)) return undefined;
    scope.push({ action: action as Action, resource: { type: resource.type as Resource["type"], id: resource.id } });
  }
  return { user_ref: item.user_ref, service_ref: item.service_ref, issuer: item.issuer, job_id: item.job_id,
    created_at: item.created_at, expires_at: item.expires_at, revoked_at: item.revoked_at as string | null,
    version: item.version as number, service: { id: service.id, client_id: service.client_id }, scope };
}

export function safeDelegationChecks(value: unknown): DelegationCheck[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const gates = ["binding", "approval", "scope", "service_permission", "user_permission", "approval_recheck"];
  const checks: DelegationCheck[] = [];
  for (const item of value) {
    if (!item || !gates.includes(item.gate) || !["ALLOW", "DENY"].includes(item.decision) ||
      typeof item.reason !== "string" || item.reason.length > 80) return undefined;
    checks.push({ gate: item.gate, decision: item.decision, reason: item.reason });
  }
  return checks;
}
