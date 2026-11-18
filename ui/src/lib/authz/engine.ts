// assisted-by claude code claude-sonnet-4-6

import type { Action, AuthorizeRequest, AuthorizeResult, GrantIntent, ReasonCode, ResourceType, Subject } from "./contract";

/** A durable write intent exists, but its outcome needs operator verification. */
export class PolicyWritePendingError extends Error {
  readonly code = "AUTHZ_WRITE_PENDING";
  constructor(cause?: unknown) {
    super("The access change is pending verification. An administrator must recover it before another change.", { cause });
    this.name = "PolicyWritePendingError";
  }
}

export interface ListObjectsResult {
  ids: Set<string>;
  /** "OK" on success. On "AUTHZ_UNAVAILABLE", `ids` is empty — fail closed, not "no access". */
  reason: ReasonCode;
}

export interface PolicyEngine {
  check(req: AuthorizeRequest): Promise<AuthorizeResult>;
  batchCheck(
    subject: Subject,
    action: Action,
    resourceType: ResourceType,
    ids: string[],
  ): Promise<Map<string, AuthorizeResult>>;
  /**
   * Reverse lookup: every id of `resourceType` the subject holds `action` on,
   * computed by the PDP in one call instead of checking a candidate list.
   * Only correct where the relation is a pure relationship-graph computation —
   * no product-level preCheck (e.g. workflow delegation) participates, since
   * there is no per-candidate request for a preCheck to intercept. See
   * `compose()` for which resource/action pairs that excludes.
   */
  listObjects(subject: Subject, action: Action, resourceType: ResourceType): Promise<ListObjectsResult>;
}

export interface PolicyAdmin {
  grant(intent: GrantIntent): Promise<void>;
  revoke(intent: GrantIntent): Promise<void>;
}
