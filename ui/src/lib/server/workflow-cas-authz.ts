// assisted-by Codex Codex-sonnet-4-6
//
// Workflow PEP (Policy Enforcement Point) backed by the Centralized
// Authorization Service. This is the FIRST surface migrated onto CAS — it
// replaces the workflow-runs route's direct `requireResourcePermission` /
// `filterResourcesByPermission` calls (which leaked `task#read` / `pdp_denied`
// in error bodies) with CAS `authorize` / `authorizeMany`.
//
// Behavior preserved from the legacy path:
//   - org-admin bypass (mirrors `{ bypassForOrgAdmin: true }`)
//   - service_account vs user subject namespacing
//   - 401 on missing subject, 403 on deny
// What improves: clean reason codes (no OpenFGA vocabulary in responses) and
// one shared decision core + cache + audit.

import { ApiError } from "@/lib/api-error";
import {
  authorize,
  authorizeMany,
  type AuthorizeResult,
  type DecisionContext,
  type Subject,
} from "@/lib/authz";
import { emitDecisionAudit } from "@/lib/authz/audit";
import {
  authzSyncPreCheck,
  type AuthzSyncDocument,
} from "@/lib/authz/resource-sync";

const ORG_KEY = process.env.CAIPE_ORG_KEY ?? "caipe";

/** Workflow configs are modeled as the `task` resource type in OpenFGA. */
type WorkflowAction = "read" | "write" | "delete";

/** Structural subset of the session needed to resolve a subject. */
export interface WorkflowAuthzSession {
  sub?: string;
  isServiceAccount?: boolean;
  org?: string;
}

export function workflowSubjectFromSession(
  session: WorkflowAuthzSession,
): Subject | null {
  const sub = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!sub) return null;
  return {
    type: session.isServiceAccount === true ? "service_account" : "user",
    id: sub,
  };
}

function ctxFromSession(session: WorkflowAuthzSession): DecisionContext {
  return {
    tenantId:
      typeof session.org === "string" && session.org.trim()
        ? session.org.trim()
        : undefined,
  };
}

async function workflowAccessDecision(
  session: WorkflowAuthzSession,
  configId: string,
  action: WorkflowAction,
): Promise<AuthorizeResult> {
  const subject = workflowSubjectFromSession(session);
  if (!subject)
    return { decision: "DENY", reason: "NOT_AUTHENTICATED", retriable: false };
  const ctx = ctxFromSession(session);
  const orgAdmin = await authorize(
    {
      subject,
      resource: { type: "organization", id: ORG_KEY },
      action: "manage",
    },
    ctx,
  );
  if (orgAdmin.decision === "ALLOW") return orgAdmin;
  if (orgAdmin.reason === "AUTHZ_UNAVAILABLE") return orgAdmin;
  return authorize(
    { subject, resource: { type: "task", id: configId }, action },
    ctx,
  );
}

function unavailableError(): ApiError {
  return new ApiError(
    "Authorization service temporarily unavailable.",
    503,
    "AUTHZ_UNAVAILABLE",
    "pdp_unavailable",
    "retry",
  );
}

function workflowRunForbiddenError(): ApiError {
  return new ApiError(
    "You do not have permission to access this workflow run.",
    403,
    "WORKFLOW_RUN_FORBIDDEN",
    "forbidden",
    "contact_admin",
  );
}

function ownerMatches(
  run: WorkflowRunAccessDocument,
  subject: Subject,
): boolean {
  return (
    run.owner_subject?.type === subject.type &&
    run.owner_subject.id === subject.id
  );
}

function workflowActionForRunAction(
  action: "read" | "write" | "delete" | "resume" | "cancel",
): WorkflowAction {
  return action === "read" ? "read" : action === "delete" ? "delete" : "write";
}

function auditWorkflowRunDecision(
  session: WorkflowAuthzSession,
  subject: Subject,
  run: WorkflowRunAccessDocument,
  action: WorkflowAction,
  result: AuthorizeResult,
): void {
  emitDecisionAudit(
    subject,
    { type: "task", id: run.workflow_config_id },
    action,
    result,
    ctxFromSession(session),
    { workflowRunId: run._id },
  );
}

export interface WorkflowRunAccessDocument {
  _id: string;
  workflow_config_id: string;
  owner_subject?: Subject | null;
  shared_with?: "private" | "workspace" | "admin" | null;
}

/**
 * Boolean access check for a single workflow config. Org admins are allowed
 * unconditionally. Returns false (never throws) for missing subject or deny —
 * matching the legacy `userCanAccessConfig` try/catch idiom.
 */
export async function workflowAccessAllowed(
  session: WorkflowAuthzSession,
  configId: string,
  action: WorkflowAction,
): Promise<boolean> {
  const r = await workflowAccessDecision(session, configId, action);
  return r.decision === "ALLOW";
}

/**
 * Throwing access check. 401 on missing subject, 403 on deny — with clean
 * reason codes (no OpenFGA relation strings leaked).
 */
export async function requireWorkflowAccess(
  session: WorkflowAuthzSession,
  configId: string,
  action: WorkflowAction,
): Promise<void> {
  const result = await workflowAccessDecision(session, configId, action);
  if (result.reason === "NOT_AUTHENTICATED") {
    throw new ApiError(
      "A stable user subject is required for this workflow authorization check.",
      401,
      "NO_SUBJECT",
      "session_expired",
      "sign_in",
    );
  }
  if (result.reason === "AUTHZ_UNAVAILABLE" || result.retriable) {
    throw unavailableError();
  }
  if (result.decision !== "ALLOW") {
    throw new ApiError(
      "You do not have permission to access this workflow.",
      403,
      "WORKFLOW_FORBIDDEN",
      "forbidden",
      "contact_admin",
    );
  }
}

export async function requireWorkflowRunAccess(
  session: WorkflowAuthzSession,
  run: WorkflowRunAccessDocument,
  action: "read" | "write" | "delete" | "resume" | "cancel",
): Promise<void> {
  const subject = workflowSubjectFromSession(session);
  if (!subject) {
    throw new ApiError(
      "A stable user subject is required for this workflow run authorization check.",
      401,
      "NO_SUBJECT",
      "session_expired",
      "sign_in",
    );
  }
  const configAction = workflowActionForRunAction(action);

  if (ownerMatches(run, subject)) {
    auditWorkflowRunDecision(session, subject, run, configAction, {
      decision: "ALLOW",
      reason: "OK",
      retriable: false,
      via: "workflow_run_owner",
    });
    return;
  }

  // Org-admins can read and mutate any run regardless of sharing settings.
  if (run.owner_subject) {
    const ctx = ctxFromSession(session);
    const orgAdmin = await authorize(
      {
        subject,
        resource: { type: "organization", id: ORG_KEY },
        action: "manage",
      },
      ctx,
    );
    if (orgAdmin.reason === "AUTHZ_UNAVAILABLE" || orgAdmin.retriable) {
      throw unavailableError();
    }
    if (orgAdmin.decision === "ALLOW") {
      auditWorkflowRunDecision(session, subject, run, configAction, {
        decision: "ALLOW",
        reason: "OK",
        retriable: false,
        via: "workflow_run_org_admin",
      });
      return;
    }

    // Non-admins: apply sharing visibility (read-only).
    if (action === "read") {
      const visibility = run.shared_with ?? "private";
      if (visibility === "workspace") {
        auditWorkflowRunDecision(session, subject, run, configAction, {
          decision: "ALLOW",
          reason: "OK",
          retriable: false,
          via: "workflow_run_shared_workspace",
        });
        return;
      }
    }

    auditWorkflowRunDecision(session, subject, run, configAction, {
      decision: "DENY",
      reason: "NO_CAPABILITY",
      retriable: false,
      via: "workflow_run_owner_mismatch",
    });
    throw workflowRunForbiddenError();
  }

  await requireWorkflowAccess(session, run.workflow_config_id, configAction);
}

/**
 * Filters a list of workflow configs to those the subject may access.
 * Org admins see all. Uses one batched CAS call for the rest.
 */
export async function filterAccessibleWorkflowConfigs<T>(
  session: WorkflowAuthzSession,
  configs: T[],
  getId: (config: T) => string,
  action: WorkflowAction = "read",
): Promise<T[]> {
  const subject = workflowSubjectFromSession(session);
  if (!subject) return [];
  if (configs.length === 0) return [];
  const ctx = ctxFromSession(session);
  const reconciledConfigs = configs.filter(
    (config) => !authzSyncPreCheck(config as AuthzSyncDocument),
  );
  if (reconciledConfigs.length === 0) return [];
  const orgAdmin = await authorize(
    {
      subject,
      resource: { type: "organization", id: ORG_KEY },
      action: "manage",
    },
    ctx,
  );
  if (orgAdmin.decision === "ALLOW") return reconciledConfigs;
  if (orgAdmin.reason === "AUTHZ_UNAVAILABLE" || orgAdmin.retriable) {
    throw unavailableError();
  }

  const ids = reconciledConfigs.map(getId);
  const results = await authorizeMany(subject, action, "task", ids, ctx);
  for (const result of results.values()) {
    if (result.reason === "AUTHZ_UNAVAILABLE") throw unavailableError();
  }
  return reconciledConfigs.filter(
    (config) => results.get(getId(config))?.decision === "ALLOW",
  );
}
