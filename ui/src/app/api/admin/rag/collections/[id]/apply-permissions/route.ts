/**
 * Bulk-apply an Owner and/or Search Access to every datasource currently in
 * a collection.
 *
 * A collection is a saved search-time filter, not an access grant - adding
 * a source to one never extends who can read it. Many existing datasources
 * may be missing a direct Search grant they used to get for free through
 * collection membership before that propagation was removed. This is a
 * superadmin-only remediation tool, not a per-source editor: it writes
 * tuples directly and bypasses the publication-approval workflow that
 * gates a normal single-source edit, so applying this to a large
 * collection does not generate one pending approval per datasource.
 */

import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  isValidTeamSlug,
  loadOwnerTeam,
  normalizeString,
  normalizeStringArray,
  OPENFGA_ID_PATTERN,
} from "@/lib/rag-admin-access.server";
import { mapWithConcurrency } from "@/lib/rbac/openfga";
import { caipeOrgKey } from "@/lib/rbac/organization";
import {
  reconcileDataSourceRelationships,
  reconcileIngestionSourceRelationships,
  reconcileKnowledgeBaseRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import {
  RAG_COLLECTIONS_COLLECTION,
  RAG_COLLECTION_ID_PATTERN,
  type RagCollection,
} from "@/types/rag-collection";

const MAX_SEARCH_TEAMS = 50;
const MAX_SEARCH_USERS = 200;
// Collections that lost implicit Search access after collection-membership
// propagation was removed can have hundreds of members - apply permissions
// with bounded concurrency instead of serializing every
// findOne/reconcile/updateOne round trip, or a large collection risks a
// platform request timeout.
const APPLY_CONCURRENCY = 10;

interface RouteContext {
  params: Promise<{ id: string }>;
}

type SourceResultStatus = "updated" | "skipped";
type SkipReason = "not_found" | "search_limit_exceeded" | "error";

interface SourceResult {
  source_id: string;
  status: SourceResultStatus;
  reason?: SkipReason;
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

async function parseOwner(body: Record<string, unknown>): Promise<{
  requested: boolean;
  ownerTeamSlug: string | null;
  ownerSubject: string | null;
}> {
  const requested =
    Object.prototype.hasOwnProperty.call(body, "owner_team_slug") ||
    Object.prototype.hasOwnProperty.call(body, "owner_subject");
  if (!requested) return { requested, ownerTeamSlug: null, ownerSubject: null };

  const ownerTeamSlug = normalizeString(body.owner_team_slug);
  const ownerSubject = ownerTeamSlug ? null : normalizeString(body.owner_subject);
  if (ownerTeamSlug) {
    if (!OPENFGA_ID_PATTERN.test(ownerTeamSlug)) {
      throw new ApiError(
        "owner_team_slug must be a valid team slug",
        400,
        "INVALID_OWNER_TEAM_SLUG",
      );
    }
    if (!(await loadOwnerTeam(ownerTeamSlug))) {
      throw new ApiError("Owner team not found", 404, "OWNER_TEAM_NOT_FOUND");
    }
  } else if (ownerSubject && !OPENFGA_ID_PATTERN.test(ownerSubject)) {
    throw new ApiError(
      "owner_subject must be a valid user subject",
      400,
      "INVALID_OWNER_SUBJECT",
    );
  } else if (!ownerTeamSlug && !ownerSubject) {
    throw new ApiError(
      "Provide owner_team_slug or owner_subject to apply an Owner",
      400,
      "OWNER_REQUIRED",
    );
  }
  return { requested, ownerTeamSlug, ownerSubject };
}

async function parseSearch(body: Record<string, unknown>): Promise<{
  requested: boolean;
  mode: "replace" | "additive";
  teamsRequested: boolean;
  teamSlugs: string[];
  usersRequested: boolean;
  userSubjects: string[];
}> {
  const teamsRequested = Object.prototype.hasOwnProperty.call(
    body,
    "search_team_slugs",
  );
  const usersRequested = Object.prototype.hasOwnProperty.call(
    body,
    "search_user_subjects",
  );
  const requested = teamsRequested || usersRequested;
  const mode = body.search_mode === "additive" ? "additive" : "replace";
  if (!requested) {
    return {
      requested,
      mode,
      teamsRequested,
      teamSlugs: [],
      usersRequested,
      userSubjects: [],
    };
  }

  const teamSlugs = normalizeStringArray(body.search_team_slugs);
  for (const slug of teamSlugs) {
    if (!isValidTeamSlug(slug)) {
      throw new ApiError(
        "search_team_slugs must contain valid team slugs",
        400,
        "INVALID_SEARCH_TEAM_SLUGS",
      );
    }
  }
  if (teamSlugs.length > MAX_SEARCH_TEAMS) {
    throw new ApiError(
      `Search Access can include at most ${MAX_SEARCH_TEAMS} teams`,
      400,
      "TOO_MANY_SEARCH_TEAMS",
    );
  }
  const teams = await Promise.all(teamSlugs.map((slug) => loadOwnerTeam(slug)));
  if (teams.some((team) => !team)) {
    throw new ApiError(
      "One or more Search teams do not exist",
      404,
      "SEARCH_TEAM_NOT_FOUND",
    );
  }
  const userSubjects = normalizeStringArray(body.search_user_subjects);
  for (const subject of userSubjects) {
    if (!OPENFGA_ID_PATTERN.test(subject)) {
      throw new ApiError(
        "search_user_subjects must contain valid user subjects",
        400,
        "INVALID_SEARCH_USER_SUBJECTS",
      );
    }
  }
  if (userSubjects.length > MAX_SEARCH_USERS) {
    throw new ApiError(
      `Search Access can include at most ${MAX_SEARCH_USERS} people`,
      400,
      "TOO_MANY_SEARCH_USERS",
    );
  }
  return { requested, mode, teamsRequested, teamSlugs, usersRequested, userSubjects };
}

export const POST = withErrorHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { id } = await context.params;
    if (!RAG_COLLECTION_ID_PATTERN.test(id)) {
      throw new ApiError("Collection id is invalid", 400, "INVALID_COLLECTION_ID");
    }
    const { session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, "admin_ui", "admin");
    await requireResourcePermission(session, {
      type: "organization",
      id: caipeOrgKey(),
      action: "manage",
    });

    const collections = await getCollection<RagCollection>(
      RAG_COLLECTIONS_COLLECTION,
    );
    const collection = await collections.findOne({ _id: id } as never);
    if (!collection) {
      throw new ApiError("Collection not found", 404, "COLLECTION_NOT_FOUND");
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ApiError("Request body must be an object", 400, "INVALID_BODY");
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("Invalid JSON body", 400, "INVALID_JSON");
    }

    const [owner, search] = await Promise.all([
      parseOwner(body),
      parseSearch(body),
    ]);
    if (!owner.requested && !search.requested) {
      throw new ApiError(
        "Specify an Owner and/or Search Access to apply",
        400,
        "NOTHING_TO_APPLY",
      );
    }

    const sourceIds = collection.source_ids ?? [];
    const sources = await getCollection<IngestionSourceConfig>(
      "rag_ingestion_sources",
    );

    const results = await mapWithConcurrency(
      sourceIds,
      APPLY_CONCURRENCY,
      async (sourceId): Promise<SourceResult> => {
        try {
          const existing = await sources.findOne({ source_id: sourceId } as never);
          if (!existing) {
            return { source_id: sourceId, status: "skipped", reason: "not_found" };
          }

          const mongoSet: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
          };
          const mongoUnset: Record<string, ""> = {};

          if (owner.requested) {
            const previousOwnerTeamSlug = existing.owner_team_slug ?? null;
            const previousOwnerSubject = existing.owner_subject ?? null;
            const sharedTeamSlugs = normalizeStringArray(
              existing.shared_with_teams,
            );
            await reconcileIngestionSourceRelationships({
              sourceId,
              ownerTeamSlug: owner.ownerTeamSlug,
              previousOwnerTeamSlug,
              ownerSubject: owner.ownerSubject,
              previousOwnerSubject,
              nextSharedTeamSlugs: sharedTeamSlugs,
              previousSharedTeamSlugs: sharedTeamSlugs,
              globalUserAccess: existing.visibility === "global",
              previousGlobalUserAccess: existing.visibility === "global",
            });
            if (owner.ownerTeamSlug) {
              mongoSet.owner_team_slug = owner.ownerTeamSlug;
              mongoUnset.owner_subject = "";
            } else if (owner.ownerSubject) {
              mongoSet.owner_subject = owner.ownerSubject;
              mongoUnset.owner_team_slug = "";
            }
          }

          if (search.requested) {
            // A source may still carry Search Access only in the legacy
            // `search_owner_team_slug` field if it predates
            // `search_with_teams` and hasn't been touched by a normal edit
            // since - fall back to it the same way every other call site
            // does, otherwise "replace" leaves that legacy grant unrevoked.
            const previousSearchTeamSlugs = Array.isArray(
              existing.search_with_teams,
            )
              ? normalizeStringArray(existing.search_with_teams)
              : existing.search_owner_team_slug
                ? [existing.search_owner_team_slug]
                : [];
            const previousSearchUserSubjects = normalizeStringArray(
              existing.search_with_users,
            );
            // Only the fields the caller actually specified are touched -
            // e.g. a request that only sends search_team_slugs must never
            // wipe an unrelated existing search_with_users grant, in either
            // replace or additive mode.
            const nextSearchTeamSlugs = !search.teamsRequested
              ? previousSearchTeamSlugs
              : search.mode === "additive"
                ? unique([...previousSearchTeamSlugs, ...search.teamSlugs])
                : search.teamSlugs;
            const nextSearchUserSubjects = !search.usersRequested
              ? previousSearchUserSubjects
              : search.mode === "additive"
                ? unique([...previousSearchUserSubjects, ...search.userSubjects])
                : search.userSubjects;
            if (
              nextSearchTeamSlugs.length > MAX_SEARCH_TEAMS ||
              nextSearchUserSubjects.length > MAX_SEARCH_USERS
            ) {
              return {
                source_id: sourceId,
                status: "skipped",
                reason: "search_limit_exceeded",
              };
            }
            await reconcileKnowledgeBaseRelationships({
              knowledgeBaseId: sourceId,
              ownerTeamSlug: null,
              previousOwnerTeamSlug: null,
              nextSharedTeamSlugs: nextSearchTeamSlugs,
              previousSharedTeamSlugs: previousSearchTeamSlugs,
              nextSharedUserSubjects: nextSearchUserSubjects,
              previousSharedUserSubjects: previousSearchUserSubjects,
            });
            await reconcileDataSourceRelationships({
              dataSourceId: sourceId,
              parentKnowledgeBaseId: sourceId,
            });
            mongoSet.search_with_teams = nextSearchTeamSlugs;
            mongoSet.search_with_users = nextSearchUserSubjects;
            if (existing.search_owner_team_slug) {
              mongoUnset.search_owner_team_slug = "";
            }
          }

          await sources.updateOne(
            { source_id: sourceId } as never,
            {
              $set: mongoSet,
              ...(Object.keys(mongoUnset).length > 0
                ? { $unset: mongoUnset }
                : {}),
            } as never,
          );
          return { source_id: sourceId, status: "updated" };
        } catch (error) {
          // Isolate a per-source failure (e.g. a transient OpenFGA/Mongo
          // error) so it doesn't fail sources that already succeeded
          // concurrently, and so the admin gets a full accounting of what
          // did and didn't apply instead of an opaque 500 with no results.
          console.error(
            `[rag-collection-apply-permissions] failed to apply permissions to ${sourceId}:`,
            error,
          );
          return { source_id: sourceId, status: "skipped", reason: "error" };
        }
      },
    );

    return successResponse({
      results,
      updated_count: results.filter((r) => r.status === "updated").length,
      skipped_count: results.filter((r) => r.status === "skipped").length,
    });
  },
);
