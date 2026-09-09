/**
 * OpenFGA projection for workflow_configs (stored as `task:<wf-id>`).
 *
 * Workflow configs historically only lived in MongoDB; runs enforced
 * `task#read` in OpenFGA without ever writing tuples on create. This module
 * reconciles visibility on write and applies Mongo visibility rules for run
 * access (global = any signed-in user; team = shared team members; private = owner).
 */

import { getCollection } from "@/lib/mongodb";
import { ApiError } from "@/lib/api-error";
import {
  authzSyncPreCheck,
  type AuthzSyncDocument,
} from "@/lib/authz/resource-sync";
import type { TupleReconcileContext } from "@/lib/authz";
import type { OpenFgaReconcileResult } from "./openfga";
import { reconcileShareableResource } from "./openfga-owned-resources-reconcile";
import { listUserTeamSlugs } from "./openfga-team-membership";
import {
  requireResourcePermission,
  subjectFromSession,
  type ResourceAuthzSession,
} from "./resource-authz";
import type { WorkflowConfigVisibility } from "@/types/workflow-config";

export interface WorkflowConfigRebacSnapshot extends AuthzSyncDocument {
  _id: string;
  visibility?: WorkflowConfigVisibility | null;
  shared_with_teams?: string[] | null;
  owner_id: string;
  owner_subject?: string;
  config_driven?: boolean;
}

/**
 * Resolve Mongo visibility for run/discover policy checks. Legacy rows may omit
 * `visibility`; platform-seeded workflows (`owner_id: system`) default to global.
 */
export function effectiveWorkflowVisibility(
  config: Pick<
    WorkflowConfigRebacSnapshot,
    "visibility" | "owner_id" | "config_driven"
  >,
): WorkflowConfigVisibility {
  const raw =
    typeof config.visibility === "string"
      ? config.visibility.trim().toLowerCase()
      : "";
  if (raw === "global" || raw === "team" || raw === "private") {
    return raw;
  }
  if (
    config.owner_id?.trim().toLowerCase() === "system" ||
    config.config_driven
  ) {
    return "global";
  }
  return "private";
}

export function normalizeTeamSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function normalizeTeamSlugs(slugs: string[] | null | undefined): string[] {
  if (!slugs?.length) return [];
  return [...new Set(slugs.map(normalizeTeamSlug).filter(Boolean))];
}

/** Maps team slug and Mongo `_id` string to canonical slug (lowercase). */
export type TeamRefToSlugMap = Map<string, string>;

export async function buildTeamRefToSlugMap(): Promise<TeamRefToSlugMap> {
  const teams = await getCollection<{ _id: unknown; slug?: string }>("teams");
  const rows = await teams.find({}).project({ slug: 1 }).toArray();
  const map: TeamRefToSlugMap = new Map();
  for (const row of rows) {
    const slug = row.slug?.trim().toLowerCase();
    if (!slug) continue;
    map.set(slug, slug);
    map.set(String(row._id), slug);
  }
  return map;
}

/** Resolve stored team refs (slug or legacy Mongo id) to slugs for FGA and visibility checks. */
export function resolveSharedTeamSlugs(
  refs: string[] | null | undefined,
  teamRefToSlug?: TeamRefToSlugMap,
): string[] {
  if (!refs?.length) return [];
  const resolved = refs.map((ref) => {
    const trimmed = ref.trim();
    if (!trimmed) return "";
    const fromMap =
      teamRefToSlug?.get(trimmed) ??
      teamRefToSlug?.get(normalizeTeamSlug(trimmed));
    if (fromMap) return fromMap;
    return normalizeTeamSlug(trimmed);
  });
  return normalizeTeamSlugs(resolved);
}

export async function normalizeSharedWithTeamSlugs(
  refs: string[] | undefined,
): Promise<string[] | undefined> {
  if (!refs?.length) return undefined;
  const map = await buildTeamRefToSlugMap();
  const slugs = resolveSharedTeamSlugs(refs, map);
  return slugs.length > 0 ? slugs : undefined;
}

/**
 * Product policy: who may run (and discover) a workflow from Mongo visibility alone.
 */
export function agentListedInWorkflowSteps(
  config: Pick<WorkflowConfigRebacSnapshot, "_id"> & {
    steps?: Array<{ type?: string; agent_id?: string }>;
  },
  agentId: string,
): boolean {
  for (const step of config.steps ?? []) {
    if (step?.type === "step" && step.agent_id === agentId) {
      return true;
    }
  }
  return false;
}

/** Agent use delegated from an in-flight workflow run the user may execute. */
export function workflowDelegatesAgentUse(
  config: WorkflowConfigRebacSnapshot & {
    steps?: Array<{ type?: string; agent_id?: string }>;
  },
  agentId: string,
  userEmail: string,
  userTeamSlugs: string[],
): boolean {
  if (!agentListedInWorkflowSteps(config, agentId)) {
    return false;
  }
  return workflowRunAllowedByVisibility(config, userEmail, userTeamSlugs);
}

export function workflowRunAllowedByVisibility(
  config: Pick<
    WorkflowConfigRebacSnapshot,
    "visibility" | "shared_with_teams" | "owner_id" | "config_driven"
  >,
  userEmail: string,
  userTeamSlugs: string[],
  teamRefToSlug?: TeamRefToSlugMap,
): boolean {
  const visibility = effectiveWorkflowVisibility(config);

  if (visibility === "global") {
    return true;
  }

  if (visibility === "team") {
    const owner = config.owner_id?.trim().toLowerCase();
    const email = userEmail.trim().toLowerCase();
    if (owner && email && owner !== "system" && owner === email) {
      return true;
    }

    const shared = resolveSharedTeamSlugs(
      config.shared_with_teams,
      teamRefToSlug,
    );
    if (shared.length === 0) {
      return false;
    }
    const memberSlugs = new Set(normalizeTeamSlugs(userTeamSlugs));
    return shared.some((slug) => memberSlugs.has(slug));
  }

  const owner = config.owner_id?.trim().toLowerCase();
  return Boolean(owner && owner === userEmail.trim().toLowerCase());
}

function privateWorkflowOwnerMatches(
  config: WorkflowConfigRebacSnapshot,
  session: ResourceAuthzSession,
  userEmail: string,
): boolean {
  if (effectiveWorkflowVisibility(config) !== "private") return true;
  const subject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (config.owner_subject) return Boolean(subject && config.owner_subject === subject);
  return config.owner_id.trim().toLowerCase() === userEmail.trim().toLowerCase();
}

export async function resolveUserTeamSlugsForWorkflow(
  userEmail: string,
  session: ResourceAuthzSession,
): Promise<string[]> {
  const subject = subjectFromSession(session);
  if (subject) {
    try {
      const slugs = await listUserTeamSlugs({ subject });
      if (slugs.length > 0) {
        return slugs;
      }
    } catch {
      // Fall through to Mongo membership lookup.
    }
  }

  try {
    const teams = await getCollection<{ slug?: string }>("teams");
    const rows = await teams
      .find({ "members.user_id": userEmail })
      .project({ slug: 1 })
      .toArray();
    return rows
      .map((team) => team.slug?.trim())
      .filter((slug): slug is string => Boolean(slug));
  } catch {
    return [];
  }
}

export function filterWorkflowConfigsByRunAccess<
  T extends WorkflowConfigRebacSnapshot,
>(
  configs: T[],
  userEmail: string,
  userTeamSlugs: string[],
  teamRefToSlug?: TeamRefToSlugMap,
): T[] {
  return configs.filter(
    (config) =>
      authzSyncPreCheck(config) === null &&
      workflowRunAllowedByVisibility(
        config,
        userEmail,
        userTeamSlugs,
        teamRefToSlug,
      ),
  );
}

export function mergeWorkflowConfigsById<T extends { _id: string }>(
  ...groups: T[][]
): T[] {
  const byId = new Map<string, T>();
  for (const group of groups) {
    for (const config of group) {
      byId.set(String(config._id), config);
    }
  }
  return [...byId.values()];
}

export async function reconcileWorkflowConfigAccess(
  session: ResourceAuthzSession,
  config: Pick<
    WorkflowConfigRebacSnapshot,
    "_id" | "visibility" | "shared_with_teams" | "owner_subject"
  >,
  previous?: Pick<
    WorkflowConfigRebacSnapshot,
    "visibility" | "shared_with_teams" | "owner_subject"
  > | null,
  options: {
    ownerSubject?: string | null;
    context?: TupleReconcileContext;
  } = {},
): Promise<OpenFgaReconcileResult> {
  const sessionSubject =
    typeof session.sub === "string" ? session.sub.trim() : "";
  const ownerSubject =
    options.ownerSubject === undefined
      ? (config.owner_subject ?? (sessionSubject || null))
      : options.ownerSubject;
  const creatorSubject = ownerSubject ?? (sessionSubject || null);
  if (!creatorSubject && !ownerSubject) {
    return { enabled: false, writes: 0, deletes: 0 };
  }

  const teamRefToSlug =
    config.visibility === "team" || previous?.visibility === "team"
      ? await buildTeamRefToSlugMap()
      : undefined;

  const resource = {
    objectType: "task",
    objectId: config._id,
    creatorSubject,
    ownerSubject,
    previousOwnerSubject: previous?.owner_subject,
    memberRelations: ["reader", "user"],
    sharedWithOrg: config.visibility === "global",
    previousSharedWithOrg: previous?.visibility === "global",
    nextSharedTeamSlugs:
      config.visibility === "team"
        ? resolveSharedTeamSlugs(config.shared_with_teams, teamRefToSlug)
        : [],
    previousSharedTeamSlugs:
      previous?.visibility === "team"
        ? resolveSharedTeamSlugs(previous.shared_with_teams, teamRefToSlug)
        : [],
  };
  return options.context
    ? reconcileShareableResource(resource, options.context)
    : reconcileShareableResource(resource);
}

function requireWorkflowAuthorizationReady(config: AuthzSyncDocument): void {
  const decision = authzSyncPreCheck(config);
  if (!decision) return;
  throw new ApiError(
    "Workflow access is still being synchronized. Retry shortly.",
    503,
    decision.reason,
    "pdp_unavailable",
    "retry",
  );
}

/** Who may edit/delete a workflow (stricter than run). */
export function workflowWriteAllowedByVisibility(
  config: Pick<
    WorkflowConfigRebacSnapshot,
    "visibility" | "shared_with_teams" | "owner_id"
  >,
  userEmail: string,
): boolean {
  const owner = config.owner_id?.trim().toLowerCase();
  const email = userEmail.trim().toLowerCase();
  if (!owner || !email) {
    return false;
  }
  // Seeded / platform workflows use a non-user owner id.
  if (owner === "system") {
    return false;
  }
  return owner === email;
}

/** Authorize updating or deleting a workflow config. */
export async function requireWorkflowConfigWriteAccess(
  session: ResourceAuthzSession,
  config: WorkflowConfigRebacSnapshot,
  userEmail: string,
): Promise<void> {
  if (workflowWriteAllowedByVisibility(config, userEmail)) {
    return;
  }

  try {
    await requireResourcePermission(
      session,
      { type: "task", id: config._id, action: "write" },
      { bypassForOrgAdmin: true },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.statusCode === 403 &&
      config.owner_id &&
      config.owner_id.toLowerCase() === userEmail.toLowerCase()
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Whether the caller may list or view workflow runs for a config (visibility +
 * OpenFGA `task#read` or `task#use`). Matches the list-runs filter in
 * `/api/workflow-runs`.
 */
export async function canViewWorkflowRunsForConfig(
  session: ResourceAuthzSession,
  config: WorkflowConfigRebacSnapshot,
  userEmail: string,
  userTeamSlugs?: string[],
  teamRefToSlug?: TeamRefToSlugMap,
): Promise<boolean> {
  if (authzSyncPreCheck(config)) return false;
  if (!privateWorkflowOwnerMatches(config, session, userEmail)) return false;
  const slugs =
    userTeamSlugs ??
    (await resolveUserTeamSlugsForWorkflow(userEmail, session));
  const map =
    teamRefToSlug ??
    (effectiveWorkflowVisibility(config) === "team"
      ? await buildTeamRefToSlugMap()
      : undefined);

  if (workflowRunAllowedByVisibility(config, userEmail, slugs, map)) {
    return true;
  }

  for (const action of ["read", "use"] as const) {
    try {
      await requireResourcePermission(
        session,
        { type: "task", id: config._id, action },
        { bypassForOrgAdmin: true },
      );
      return true;
    } catch {
      // try next action
    }
  }
  return false;
}

/** Authorize viewing or polling workflow runs for a config. */
export async function requireWorkflowConfigRunViewAccess(
  session: ResourceAuthzSession,
  config: WorkflowConfigRebacSnapshot,
  userEmail: string,
  userTeamSlugs?: string[],
): Promise<void> {
  if (
    await canViewWorkflowRunsForConfig(
      session,
      config,
      userEmail,
      userTeamSlugs,
    )
  ) {
    return;
  }
  throw new ApiError(
    "You do not have permission to view workflow runs for this workflow.",
    403,
    "task#read",
    "pdp_denied",
    "contact_admin",
  );
}

/** Authorize starting or viewing a workflow config (run / discover / read). */
export async function requireWorkflowConfigRunAccess(
  session: ResourceAuthzSession,
  config: WorkflowConfigRebacSnapshot,
  userEmail: string,
  userTeamSlugs?: string[],
): Promise<void> {
  requireWorkflowAuthorizationReady(config);
  if (!privateWorkflowOwnerMatches(config, session, userEmail)) {
    throw new ApiError(
      "You do not have permission to run this private workflow.",
      403,
      "task#use",
      "pdp_denied",
      "contact_admin",
    );
  }
  const slugs =
    userTeamSlugs ??
    (await resolveUserTeamSlugsForWorkflow(userEmail, session));
  const teamRefToSlug =
    effectiveWorkflowVisibility(config) === "team"
      ? await buildTeamRefToSlugMap()
      : undefined;

  if (workflowRunAllowedByVisibility(config, userEmail, slugs, teamRefToSlug)) {
    return;
  }

  try {
    await requireResourcePermission(
      session,
      { type: "task", id: config._id, action: "use" },
      { bypassForOrgAdmin: true },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.statusCode === 403 &&
      config.owner_id &&
      config.owner_id.toLowerCase() === userEmail.toLowerCase()
    ) {
      return;
    }
    throw error;
  }
}

/**
 * One-time style repair: rewrite `shared_with_teams` from legacy Mongo ids to slugs.
 * Safe to run on UI startup after seed.
 */
export async function repairWorkflowConfigTeamSlugRefs(): Promise<number> {
  const collection =
    await getCollection<WorkflowConfigRebacSnapshot>("workflow_configs");
  const map = await buildTeamRefToSlugMap();
  const teamConfigs = await collection.find({ visibility: "team" }).toArray();
  let repaired = 0;

  for (const config of teamConfigs) {
    const resolved = resolveSharedTeamSlugs(config.shared_with_teams, map);
    if (resolved.length === 0) continue;

    const before = normalizeTeamSlugs(config.shared_with_teams);
    const changed =
      before.length !== resolved.length ||
      before.some((slug, index) => slug !== resolved[index]);

    if (!changed) continue;

    await collection.updateOne(
      { _id: config._id as unknown },
      { $set: { shared_with_teams: resolved, updated_at: new Date() } },
    );
    repaired += 1;
  }

  return repaired;
}

/** @deprecated Use requireWorkflowConfigRunAccess */
export const requireWorkflowConfigRead = requireWorkflowConfigRunAccess;
