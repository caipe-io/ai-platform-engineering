import { ApiError } from "@/lib/api-error";
import { authorize, authorizeMany, type Action, type Subject } from "@/lib/authz";
import type { UniversalRebacResourceType } from "@/types/rbac-universal";

import { type OpenFgaCheckResult, type OpenFgaTupleKey } from "./openfga";
import { openFgaResourceObject } from "./openfga-resource-ids";
import { caipeOrgKey, organizationObjectId } from "./organization";

export type ResourcePermissionAction =
  | "list"
  | "discover"
  | "read"
  | "read-metadata"
  | "use"
  | "write"
  | "admin"
  | "manage"
  | "share"
  | "delete"
  | "ingest"
  | "call"
  | "invoke"
  | "audit";

export interface ResourcePermissionTarget {
  type: UniversalRebacResourceType;
  id: string;
  action: ResourcePermissionAction;
}

export interface ResourceAuthzSession {
  sub?: unknown;
  user?: { email?: string | null } | null;
  role?: string;
  /**
   * Set by the Bearer-auth path for OAuth2 client-credentials tokens
   * (Keycloak service accounts, e.g. the Slack bot). When true the subject
   * is graphed as `service_account:<sub>` instead of `user:<sub>` so it
   * matches the relationships those callers are granted in OpenFGA.
   */
  isServiceAccount?: boolean;
  principalType?: 'oidc_user' | 'service_account' | 'catalog_api_key' | 'skills_api_key';
}

export interface ResourcePermissionOptions {
  check?: (tuple: OpenFgaTupleKey) => Promise<OpenFgaCheckResult>;
  /**
   * When true, the resource-permission helpers short-circuit to allow if the
   * caller holds `user:<sub> can_manage organization:<caipeOrgKey>` in OpenFGA.
   *
   * This is the documented super-grant for org admins on the KB / Search /
   * Data Sources / Graph / MCP Tools surfaces. It is OFF by default; call
   * sites must explicitly opt in so the bypass is auditable in code review.
   *
   * Set the env var `RAG_ADMIN_BYPASS_DISABLED=true` to force the bypass off
   * everywhere as a kill switch (the helper falls back to pure per-resource
   * OpenFGA checks).
   */
  bypassForOrgAdmin?: boolean;
}

function isOrgAdminBypassKillSwitchEnabled(): boolean {
  const raw = process.env.RAG_ADMIN_BYPASS_DISABLED;
  if (!raw) return false;
  return raw === "1" || raw.trim().toLowerCase() === "true";
}

function casSubjectFromSession(session: ResourceAuthzSession): Subject | null {
  if (session.principalType === 'catalog_api_key' || session.principalType === 'skills_api_key') {
    return null;
  }
  if (typeof session.sub !== "string" || !session.sub.trim()) return null;
  const id = session.sub.trim();
  return { type: session.isServiceAccount === true ? "service_account" : "user", id };
}

/** Maps legacy route actions onto CAS {@link Action} values. */
export function resourcePermissionActionToCasAction(action: ResourcePermissionAction): Action {
  switch (action) {
    case "list":
      return "discover";
    case "admin":
      return "manage";
    default:
      return action;
  }
}

function authzUnavailableError(): ApiError {
  return new ApiError(
    "Authorization service temporarily unavailable.",
    503,
    "AUTHZ_UNAVAILABLE",
    "pdp_unavailable",
    "retry",
  );
}

async function tupleAllowed(
  subject: string,
  target: ResourcePermissionTarget,
  check: (tuple: OpenFgaTupleKey) => Promise<OpenFgaCheckResult>,
): Promise<boolean> {
  const result = await check({
    user: subject,
    relation: openFgaRelationForResourceAction(target.action),
    object: resourceObject(target.type, target.id),
  });
  return result.allowed === true;
}

async function casAllowed(subject: Subject, target: ResourcePermissionTarget): Promise<boolean> {
  const result = await authorize({
    subject,
    resource: { type: target.type, id: target.id },
    action: resourcePermissionActionToCasAction(target.action),
  });
  return result.decision === "ALLOW";
}

async function resourceAllowed(
  subjectString: string,
  casSubject: Subject,
  target: ResourcePermissionTarget,
  options: ResourcePermissionOptions,
): Promise<boolean> {
  if (options.check) {
    return tupleAllowed(subjectString, target, options.check);
  }
  return casAllowed(casSubject, target);
}

async function isOrgAdmin(
  subject: string,
  casSubject: Subject,
  options: ResourcePermissionOptions,
): Promise<boolean> {
  if (isOrgAdminBypassKillSwitchEnabled()) return false;
  try {
    if (options.check) {
      const result = await options.check({
        user: subject,
        relation: "can_manage",
        object: organizationObjectId(),
      });
      return result.allowed === true;
    }
    const result = await authorize({
      subject: casSubject,
      resource: { type: "organization", id: caipeOrgKey() },
      action: "manage",
    });
    return result.decision === "ALLOW";
  } catch {
    return false;
  }
}

/**
 * Authorize an ownership transfer (spec 2026-06-03, US3 / contract R3). The
 * caller may transfer a shareable resource only if they can manage it
 * (current owner-team admin — `<type>:<id>#can_manage`) OR they are an org
 * admin. Returns true/false rather than throwing so callers can shape their
 * own error. Reuses the same `check` injection as `requireResourcePermission`
 * for testability.
 */
export async function canTransferResourceOwnership(
  session: ResourceAuthzSession,
  target: { type: UniversalRebacResourceType; id: string },
  options: ResourcePermissionOptions = {},
): Promise<boolean> {
  const subject = subjectFromSession(session);
  const casSubject = casSubjectFromSession(session);
  if (!subject || !casSubject) return false;
  if (await isOrgAdmin(subject, casSubject, options)) return true;
  try {
    return await resourceAllowed(
      subject,
      casSubject,
      { type: target.type, id: target.id, action: "manage" },
      options,
    );
  } catch {
    return false;
  }
}

export function openFgaRelationForResourceAction(action: ResourcePermissionAction): string {
  switch (action) {
    case "list":
    case "discover":
      return "can_discover";
    case "read":
      return "can_read";
    case "read-metadata":
      return "can_read_metadata";
    case "use":
      return "can_use";
    case "write":
      return "can_write";
    case "admin":
    case "manage":
      return "can_manage";
    case "share":
      return "can_share";
    case "delete":
      return "can_delete";
    case "ingest":
      return "can_ingest";
    case "call":
      return "can_call";
    case "invoke":
      return "can_invoke";
    case "audit":
      return "can_audit";
  }
}

export function resourceObject(type: UniversalRebacResourceType, id: string): string {
  return openFgaResourceObject(type, id);
}

export function subjectFromSession(session: ResourceAuthzSession): string | null {
  if (session.principalType === 'catalog_api_key' || session.principalType === 'skills_api_key') {
    return null;
  }
  if (typeof session.sub !== "string" || !session.sub.trim()) return null;
  const sub = session.sub.trim();
  // Service-account (client-credentials) callers are graphed under the
  // `service_account:` namespace, matching the OpenFGA relationships seeded
  // for first-party services (e.g. the Slack bot's read grant on
  // `system_config:platform_settings`). Interactive users stay `user:`.
  return session.isServiceAccount === true ? `service_account:${sub}` : `user:${sub}`;
}

/**
 * Per-skill OpenFGA gate for workspace routes. Org admins and holders of
 * `admin_surface:skills#can_manage` (bootstrap grant for app admins) may
 * mutate any skill without a per-resource owner tuple; everyone else is
 * checked against `skill:<id>#can_*`.
 */
export async function requireSkillPermission(
  session: ResourceAuthzSession,
  skillId: string,
  action: ResourcePermissionAction,
  options: ResourcePermissionOptions = {},
): Promise<void> {
  const subject = subjectFromSession(session);
  const casSubject = casSubjectFromSession(session);
  if (!subject || !casSubject) {
    throw new ApiError(
      "A stable user subject is required for this resource authorization check.",
      401,
      "NO_SUBJECT",
      "session_expired",
      "sign_in",
    );
  }

  if (!isOrgAdminBypassKillSwitchEnabled() && (await isOrgAdmin(subject, casSubject, options))) {
    return;
  }

  if (session.role === "admin") {
    try {
      const surfaceAllowed = await resourceAllowed(
        subject,
        casSubject,
        { type: "admin_surface", id: "skills", action: "manage" },
        options,
      );
      if (surfaceAllowed) {
        return;
      }
    } catch {
      // Fall through to per-skill check.
    }
  }

  await requireResourcePermission(session, { type: "skill", id: skillId, action }, options);
}

/**
 * Per-agent OpenFGA gate for Dynamic Agent routes. Organization admins
 * (including Super Admins team members with `organization#admin`) may
 * read, write, manage, or delete any agent without a per-resource tuple;
 * everyone else is checked against `agent:<id>#can_*`.
 */
export async function requireAgentPermission(
  session: ResourceAuthzSession,
  agentId: string,
  action: ResourcePermissionAction,
  options: ResourcePermissionOptions = {},
): Promise<void> {
  const subject = subjectFromSession(session);
  const casSubject = casSubjectFromSession(session);
  if (!subject || !casSubject) {
    throw new ApiError(
      "A stable user subject is required for this resource authorization check.",
      401,
      "NO_SUBJECT",
      "session_expired",
      "sign_in",
    );
  }

  if (!isOrgAdminBypassKillSwitchEnabled() && (await isOrgAdmin(subject, casSubject, options))) {
    return;
  }

  await requireResourcePermission(session, { type: "agent", id: agentId, action }, options);
}

export async function requireResourcePermission(
  session: ResourceAuthzSession,
  target: ResourcePermissionTarget,
  options: ResourcePermissionOptions = {},
): Promise<void> {
  const subject = subjectFromSession(session);
  const casSubject = casSubjectFromSession(session);
  if (!subject || !casSubject) {
    throw new ApiError(
      "A stable user subject is required for this resource authorization check.",
      401,
      "NO_SUBJECT",
      "session_expired",
      "sign_in",
    );
  }

  if (options.bypassForOrgAdmin && (await isOrgAdmin(subject, casSubject, options))) {
    return;
  }

  if (options.check) {
    const allowed = await tupleAllowed(subject, target, options.check);
    if (!allowed) {
      throw new ApiError(
        "You do not have permission to access this resource.",
        403,
        `${target.type}#${target.action}`,
        "pdp_denied",
        "contact_admin",
      );
    }
    return;
  }

  const result = await authorize({
    subject: casSubject,
    resource: { type: target.type, id: target.id },
    action: resourcePermissionActionToCasAction(target.action),
  });
  if (result.decision === "ALLOW") {
    return;
  }
  if (result.reason === "AUTHZ_UNAVAILABLE" || result.retriable) {
    throw authzUnavailableError();
  }
  throw new ApiError(
    "You do not have permission to access this resource.",
    403,
    `${target.type}#${target.action}`,
    "pdp_denied",
    "contact_admin",
  );
}

export async function filterResourcesByPermission<T>(
  session: ResourceAuthzSession,
  resources: T[],
  target: {
    type: UniversalRebacResourceType;
    action: ResourcePermissionAction;
    id: (resource: T) => string;
  },
  options: ResourcePermissionOptions = {},
): Promise<T[]> {
  const subject = subjectFromSession(session);
  const casSubject = casSubjectFromSession(session);
  if (!subject || !casSubject) return [];

  if (options.bypassForOrgAdmin && (await isOrgAdmin(subject, casSubject, options))) {
    return [...resources];
  }

  if (options.check) {
    const decisions: Array<T | null> = await Promise.all(
      resources.map(async (resource) => {
        try {
          const allowed = await tupleAllowed(
            subject,
            { type: target.type, id: target.id(resource), action: target.action },
            options.check!,
          );
          return allowed ? resource : null;
        } catch {
          return null;
        }
      }),
    );
    return decisions.filter((resource): resource is T => resource !== null);
  }

  if (resources.length === 0) return [];

  const ids = resources.map((resource) => target.id(resource));
  const results = await authorizeMany(
    casSubject,
    resourcePermissionActionToCasAction(target.action),
    target.type,
    ids,
  );

  return resources.filter((resource) => results.get(target.id(resource))?.decision === "ALLOW");
}

export interface McpServerRowPermissions {
  can_manage: boolean;
  can_invoke: boolean;
  can_discover: boolean;
}

export interface McpServerListCapabilities {
  repair_agentgateway: boolean;
}

const DEFAULT_MCP_SERVER_ROW_PERMISSIONS: McpServerRowPermissions = {
  can_manage: false,
  can_invoke: false,
  can_discover: false,
};

/**
 * Batch-resolve MCP server row actions for the list UI without per-row OpenFGA
 * round-trips from the browser. Org admins receive full row permissions when
 * {@link ResourcePermissionOptions.bypassForOrgAdmin} is enabled.
 */
export async function resolveMcpServerListPermissions(
  session: ResourceAuthzSession,
  serverIds: string[],
  options: ResourcePermissionOptions = {},
): Promise<{
  rows: Map<string, McpServerRowPermissions>;
  capabilities: McpServerListCapabilities;
}> {
  const subject = subjectFromSession(session);
  const casSubject = casSubjectFromSession(session);
  if (!subject || !casSubject) {
    return { rows: new Map(), capabilities: { repair_agentgateway: false } };
  }

  if (options.bypassForOrgAdmin && (await isOrgAdmin(subject, casSubject, options))) {
    const rows = new Map(
      serverIds.map((id) => [
        id,
        { can_manage: true, can_invoke: true, can_discover: true } satisfies McpServerRowPermissions,
      ]),
    );
    return { rows, capabilities: { repair_agentgateway: true } };
  }

  const uniqueIds = [...new Set(serverIds.filter((id) => id.trim().length > 0))];
  const [manageResults, invokeResults, discoverResults, repairResult] = await Promise.all([
    uniqueIds.length > 0
      ? authorizeMany(casSubject, "manage", "mcp_server", uniqueIds)
      : Promise.resolve(new Map<string, Awaited<ReturnType<typeof authorize>>>()),
    uniqueIds.length > 0
      ? authorizeMany(casSubject, "invoke", "mcp_server", uniqueIds)
      : Promise.resolve(new Map<string, Awaited<ReturnType<typeof authorize>>>()),
    uniqueIds.length > 0
      ? authorizeMany(casSubject, "discover", "mcp_server", uniqueIds)
      : Promise.resolve(new Map<string, Awaited<ReturnType<typeof authorize>>>()),
    resourceAllowed(subject, casSubject, { type: "mcp_server", id: "agentgateway", action: "admin" }, options),
  ]);

  const rows = new Map<string, McpServerRowPermissions>();
  for (const id of uniqueIds) {
    rows.set(id, {
      can_manage: manageResults.get(id)?.decision === "ALLOW",
      can_invoke: invokeResults.get(id)?.decision === "ALLOW",
      can_discover: discoverResults.get(id)?.decision === "ALLOW",
    });
  }

  return {
    rows,
    capabilities: { repair_agentgateway: repairResult },
  };
}

export function mcpServerRowPermissionsOrDefault(
  rows: Map<string, McpServerRowPermissions>,
  serverId: string,
): McpServerRowPermissions {
  return rows.get(serverId) ?? DEFAULT_MCP_SERVER_ROW_PERMISSIONS;
}

export interface AgentRowPermissions {
  can_manage: boolean;
  can_write: boolean;
  can_discover: boolean;
}

const DEFAULT_AGENT_ROW_PERMISSIONS: AgentRowPermissions = {
  can_manage: false,
  can_write: false,
  can_discover: false,
};

/**
 * Batch-resolve dynamic agent row actions for the list UI without per-row
 * OpenFGA round-trips from the browser. Org admins receive full row permissions
 * when {@link ResourcePermissionOptions.bypassForOrgAdmin} is enabled.
 */
export async function resolveAgentListPermissions(
  session: ResourceAuthzSession,
  agentIds: string[],
  options: ResourcePermissionOptions = {},
): Promise<{ rows: Map<string, AgentRowPermissions> }> {
  const subject = subjectFromSession(session);
  const casSubject = casSubjectFromSession(session);
  if (!subject || !casSubject) {
    return { rows: new Map() };
  }

  if (options.bypassForOrgAdmin && (await isOrgAdmin(subject, casSubject, options))) {
    const rows = new Map(
      agentIds.map((id) => [
        id,
        { can_manage: true, can_write: true, can_discover: true } satisfies AgentRowPermissions,
      ]),
    );
    return { rows };
  }

  const uniqueIds = [...new Set(agentIds.filter((id) => id.trim().length > 0))];
  const [manageResults, writeResults, discoverResults] = await Promise.all([
    uniqueIds.length > 0
      ? authorizeMany(casSubject, "manage", "agent", uniqueIds)
      : Promise.resolve(new Map<string, Awaited<ReturnType<typeof authorize>>>()),
    uniqueIds.length > 0
      ? authorizeMany(casSubject, "write", "agent", uniqueIds)
      : Promise.resolve(new Map<string, Awaited<ReturnType<typeof authorize>>>()),
    uniqueIds.length > 0
      ? authorizeMany(casSubject, "discover", "agent", uniqueIds)
      : Promise.resolve(new Map<string, Awaited<ReturnType<typeof authorize>>>()),
  ]);

  const rows = new Map<string, AgentRowPermissions>();
  for (const id of uniqueIds) {
    rows.set(id, {
      can_manage: manageResults.get(id)?.decision === "ALLOW",
      can_write: writeResults.get(id)?.decision === "ALLOW",
      can_discover: discoverResults.get(id)?.decision === "ALLOW",
    });
  }

  return { rows };
}

export function agentRowPermissionsOrDefault(
  rows: Map<string, AgentRowPermissions>,
  agentId: string,
): AgentRowPermissions {
  return rows.get(agentId) ?? DEFAULT_AGENT_ROW_PERMISSIONS;
}
