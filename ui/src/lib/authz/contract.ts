// assisted-by Codex Codex-sonnet-4-6

import type { UniversalRebacResourceAction, UniversalRebacResourceType } from "@/types/rbac-universal";

export type SubjectType = "user" | "service_account";

export type ResourceType = UniversalRebacResourceType;

export type Action = UniversalRebacResourceAction;

export type DecisionValue = "ALLOW" | "DENY";

export type ReasonCode =
  | "OK"               // ALLOW
  | "NO_CAPABILITY"    // DENY — no relationship
  | "NOT_AUTHENTICATED"// caller token missing or invalid
  | "AUTHZ_UNAVAILABLE"// PDP error, retriable
  | "INVALID_REQUEST"  // bad id or malformed input
  | "PRIVATE_RESOURCE_CONTEXT_DENIED"; // private use outside web/personal or a verified DM

export interface Subject {
  type: SubjectType;
  id: string;
}

export interface Resource {
  type: ResourceType;
  id: string;
}

export interface TrustedAuthorizeContext {
  workflowRunId?: string;
  interaction?: {
    source: "slack" | "webex" | "web" | "api";
    conversationKind: "direct" | "group" | "personal" | "unknown";
    verified: boolean;
  };
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

export interface GrantIntent {
  resource: Resource;
  grantee: Grantee;
  /** The capability to grant — must be a valid Action. */
  capability: Action;
}
