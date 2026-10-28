// assisted-by Codex Codex-sonnet-4-6

import type { PlatformPrincipal } from "@/lib/auth/platform-identity";

export type SubjectType = PlatformPrincipal["type"];

export type ResourceType = string;

export type Action = string;

export type DecisionValue = "ALLOW" | "DENY";

export type ReasonCode =
  | "OK"               // ALLOW
  | "NO_CAPABILITY"    // DENY — no relationship
  | "NOT_AUTHENTICATED"// caller token missing or invalid
  | "AUTHZ_UNAVAILABLE"// PDP error, retriable
  | "INVALID_REQUEST"; // bad id or malformed input

export type Subject = PlatformPrincipal;

export interface Resource {
  type: ResourceType;
  id: string;
}

export interface TrustedAuthorizeContext {
  workflowRunId?: string;
}

export interface AuthorizeRequest {
  subject: Subject;
  resource: Resource;
  action: Action;
  /** Advisory only. May only NARROW a grant, never expand it. */
  context?: Record<string, unknown>;
  /**
   * Internal-only context from trusted BFF callers. Never populated from the
   * public /api/authz/v1 body.
   */
  trustedContext?: TrustedAuthorizeContext;
}

export interface AuthorizeResult {
  decision: DecisionValue;
  reason: ReasonCode;
  retriable: boolean;
  ttl_seconds?: number;
  via?: string | null;
}

/**
 * Per-request metadata threaded into the audit trail. Never affects the
 * decision itself — only how it is recorded.
 */
export interface DecisionContext {
  tenantId?: string;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  /** Principal performing a grant/revoke (PAP). Recorded in grant audit events. */
  caller?: Subject;
}

// ─── Grant / Revoke (PAP) ─────────────────────────────────────────────────────

export type GranteeType = "user" | "service_account" | "team" | "everyone";

export type Grantee =
  | { type: "user"; id: string }
  | { type: "service_account"; id: string }
  | { type: "team"; id: string }
  | { type: "everyone" };

export type GrantIntent = {
  resource: Resource;
  grantee: Grantee;
} & ({ capability: Action; relationship?: never } | { relationship: string; capability?: never });
