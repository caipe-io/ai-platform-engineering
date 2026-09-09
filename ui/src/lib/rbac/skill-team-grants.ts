import { ObjectId } from "mongodb";

import { getCollection } from "@/lib/mongodb";
import { teamSlugsFromSkillTuples } from "@/lib/rbac/agent-skill-openfga-reconcile";
import {
  isOpenFgaReconciliationEnabled,
  readOpenFgaTuples,
  writeOpenFgaTupleDiff,
  type OpenFgaReconcileResult,
  type OpenFgaTupleKey,
} from "@/lib/rbac/openfga";
import { reconcileShareableResource } from "@/lib/rbac/openfga-owned-resources-reconcile";
import type { TupleReconcileContext } from "@/lib/authz";

interface TeamDoc {
  _id?: ObjectId | string;
  slug?: string;
  name?: string;
}

export interface GrantSkillsToTeamsInput {
  teamRefs: string[] | undefined | null;
  skillIds: string[] | undefined | null;
}

export interface GrantSkillsToTeamsResult {
  teamSlugs: string[];
  skillIds: string[];
  writesPlanned: number;
  writesApplied: number;
  enabled: boolean;
}

function normalizeList(values: string[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function teamDocKey(doc: TeamDoc): string | null {
  if (!doc._id) return null;
  if (doc._id instanceof ObjectId) return doc._id.toHexString();
  return String(doc._id);
}

async function resolveTeamSlugs(teamRefs: string[]): Promise<string[]> {
  const refs = normalizeList(teamRefs);
  if (refs.length === 0) return [];

  const objectIds = refs
    .filter((ref) => ObjectId.isValid(ref))
    .map((ref) => new ObjectId(ref));
  const teams = await getCollection<TeamDoc>("teams");
  const docs = await teams
    .find({
      $or: [
        ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
        { slug: { $in: refs } },
      ],
    })
    .project({ _id: 1, slug: 1, name: 1 })
    .toArray();

  const slugById = new Map<string, string>();
  const slugBySlug = new Map<string, string>();
  for (const doc of docs) {
    if (!doc.slug) continue;
    const key = teamDocKey(doc);
    if (key) slugById.set(key, doc.slug);
    slugBySlug.set(doc.slug, doc.slug);
  }

  return refs.map((ref) => slugById.get(ref) ?? slugBySlug.get(ref) ?? ref);
}

export function buildSkillTeamGrantTuples(
  teamSlugs: string[],
  skillIds: string[],
): OpenFgaTupleKey[] {
  const tuples: OpenFgaTupleKey[] = [];
  for (const teamSlug of normalizeList(teamSlugs)) {
    for (const skillId of normalizeList(skillIds)) {
      tuples.push({
        user: `team:${teamSlug}#member`,
        relation: "user",
        object: `skill:${skillId}`,
      });
    }
  }
  return tuples;
}

export type SkillShareVisibility = "private" | "team" | "global";

export interface ReconcileSkillTeamSharesInput {
  skillId: string;
  /** Keycloak `sub` of the skill author → `user:<sub> owner skill:<id>` (and creator). */
  ownerSubject?: string | null;
  /** Team refs (slug or ObjectId) the skill was shared with before this write. */
  previousTeamRefs?: string[] | null;
  /** Team refs the skill should be shared with after this write ([] = revoke all). */
  nextTeamRefs?: string[] | null;
  /**
   * When set, drives the desired team set (`team` only) and org-wide grant
   * (`global`). `private` revokes all team shares and org-wide grants.
   */
  nextVisibility?: SkillShareVisibility;
  /** Prior visibility so demoting from `global` revokes org-wide tuples. */
  previousVisibility?: SkillShareVisibility;
}

/**
 * Reconcile a single skill's team-share grants through the shared shareable-
 * resource reconciler (spec 2026-06-03, the same tuple-core agents / RAG KBs /
 * MCP tools use). Unlike the write-only `grantSkillsToTeams` (kept for bulk
 * import / hub-refresh fan-out where there is no previous state), this diffs
 * `previousTeamRefs` against `nextTeamRefs` so un-sharing or re-sharing a skill
 * genuinely REVOKES the dropped `team:<slug>#member user skill:<id>` tuples
 * instead of orphaning them. Skills are user-owned (no owner team), so
 * `ownerTeamSlug` is null and only the shared-team set is reconciled with the
 * skill member relation `user`.
 */
export async function reconcileSkillTeamShares(
  input: ReconcileSkillTeamSharesInput,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  const visibilityDriven = input.nextVisibility !== undefined;
  const nextVisibility = input.nextVisibility ?? "private";
  const previousVisibility = input.previousVisibility ?? nextVisibility;

  const nextTeamRefs =
    visibilityDriven && nextVisibility !== "team"
      ? []
      : normalizeList(input.nextTeamRefs);
  const previousTeamRefs = normalizeList(input.previousTeamRefs);

  const [previousSharedTeamSlugs, nextSharedTeamSlugs] = await Promise.all([
    resolveTeamSlugs(previousTeamRefs),
    resolveTeamSlugs(nextTeamRefs),
  ]);
  const ownerSubject =
    typeof input.ownerSubject === "string" && input.ownerSubject.trim()
      ? input.ownerSubject.trim()
      : null;
  const resource = {
    objectType: "skill",
    objectId: input.skillId,
    creatorSubject: ownerSubject,
    ownerSubject,
    ownerTeamSlug: null,
    nextSharedTeamSlugs,
    previousSharedTeamSlugs,
    memberRelations: ["user"],
    sharedWithOrg: visibilityDriven ? nextVisibility === "global" : undefined,
    previousSharedWithOrg: visibilityDriven
      ? previousVisibility === "global"
      : undefined,
  };
  return ctx
    ? reconcileShareableResource(resource, ctx)
    : reconcileShareableResource(resource);
}

/**
 * Team slugs currently granted `team:<slug>#member user skill:<id>` in OpenFGA.
 * Used instead of Mongo `shared_with_teams` (authorization state lives in FGA only).
 */
export async function readSkillSharedTeamSlugsFromOpenFga(
  skillId: string,
): Promise<string[]> {
  if (!isOpenFgaReconciliationEnabled()) return [];
  const object = `skill:${skillId}`;
  const tuples: OpenFgaTupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({
      tuple: { object },
      continuationToken,
      pageSize: 100,
    });
    for (const entry of page.tuples) {
      tuples.push(entry.key);
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return teamSlugsFromSkillTuples(skillId, tuples);
}

export async function grantSkillsToTeams(
  input: GrantSkillsToTeamsInput,
): Promise<GrantSkillsToTeamsResult> {
  const skillIds = normalizeList(input.skillIds);
  const teamRefs = normalizeList(input.teamRefs);
  if (skillIds.length === 0 || teamRefs.length === 0) {
    return {
      teamSlugs: [],
      skillIds,
      writesPlanned: 0,
      writesApplied: 0,
      enabled: false,
    };
  }

  const teamSlugs = await resolveTeamSlugs(teamRefs);
  const writes = buildSkillTeamGrantTuples(teamSlugs, skillIds);
  const result = await writeOpenFgaTupleDiff({ writes, deletes: [] });
  return {
    teamSlugs,
    skillIds,
    writesPlanned: writes.length,
    writesApplied: result.writes,
    enabled: result.enabled,
  };
}
