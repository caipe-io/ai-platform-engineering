/**
 * Adopt application-config RAG sources into UI-managed database records.
 *
 * Startup seeding already persists each valid `rag_sources` entry as a
 * read-only `config_driven` row. Adoption transfers configuration ownership
 * to MongoDB and, when the admin picks one, grants Search Access directly -
 * both applied straight to the source rather than inherited from a
 * destination collection (a collection is a saved search-time filter and
 * grants no access to its members) - and makes the source editable without
 * re-ingesting its indexed content.
 */

import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  extractIngestionSourceTypeFields,
  validateSourceSpecificInputFields,
} from "@/lib/ingestion-source-config";
import { computeIngestionSourceId } from "@/lib/ingestion-source-id";
import { getCollection } from "@/lib/mongodb";
import {
  isValidTeamSlug,
  loadOwnerTeam,
  normalizeString,
  OPENFGA_ID_PATTERN,
} from "@/lib/rag-admin-access.server";
import {
  adoptConfigImportedRagSources,
  loadSeedConfig,
  type RagSourceAdoptSkipReason,
} from "@/lib/seed-config";
import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type {
  IngestionSourceConfig,
  IngestionSourceType,
} from "@/types/ingestion-source";

const MAX_ADOPTION_SOURCES = 500;

type PreviewUnavailableReason = "not_seeded" | "not_config_driven";

interface ConfigSourcePreview {
  source_id: string;
  name: string;
  source_type: IngestionSourceType;
  in_db: boolean;
  already_adopted: boolean;
  importable: boolean;
  unavailable_reason?: PreviewUnavailableReason;
}

type AdoptSkipReason =
  | RagSourceAdoptSkipReason
  | "not_in_config"
  | "not_seeded";

interface AdoptSkip {
  source_id: string;
  reason: AdoptSkipReason;
}

interface AdoptFromConfigResult {
  sources: ConfigSourcePreview[];
  adopted?: string[];
  skipped?: AdoptSkip[];
  configured_source_count: number;
}

const MAX_ADOPTION_SEARCH_TEAMS = 50;
const MAX_ADOPTION_SEARCH_USERS = 200;

async function parseOwner(body: Record<string, unknown>): Promise<{
  ownerTeamSlug: string | null;
  ownerSubject: string | null;
}> {
  const ownerTeamSlug = normalizeString(body.owner_team_slug);
  const ownerSubject = ownerTeamSlug
    ? null
    : normalizeString(body.owner_subject);
  if (ownerTeamSlug) {
    if (!isValidTeamSlug(ownerTeamSlug)) {
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
  }
  if (!ownerTeamSlug && !ownerSubject) {
    throw new ApiError(
      "An Owner (team or person) is required to adopt sources",
      400,
      "OWNER_REQUIRED",
    );
  }
  return { ownerTeamSlug, ownerSubject };
}

async function parseSearchAccess(body: Record<string, unknown>): Promise<{
  teamSlugs: string[];
  userSubjects: string[];
}> {
  const rawTeamSlugs = body.search_team_slugs;
  const teamSlugs = Array.isArray(rawTeamSlugs)
    ? Array.from(
        new Set(
          rawTeamSlugs.map((value) => {
            const slug = normalizeString(value);
            if (!slug || !isValidTeamSlug(slug)) {
              throw new ApiError(
                "search_team_slugs must contain valid team slugs",
                400,
                "INVALID_SEARCH_TEAM_SLUGS",
              );
            }
            return slug;
          }),
        ),
      )
    : [];
  if (teamSlugs.length > MAX_ADOPTION_SEARCH_TEAMS) {
    throw new ApiError(
      `Search Access can include at most ${MAX_ADOPTION_SEARCH_TEAMS} teams`,
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
  const rawUserSubjects = body.search_user_subjects;
  const userSubjects = Array.isArray(rawUserSubjects)
    ? Array.from(
        new Set(
          rawUserSubjects.map((value) => {
            const subject = normalizeString(value);
            if (!subject || !OPENFGA_ID_PATTERN.test(subject)) {
              throw new ApiError(
                "search_user_subjects must contain valid user subjects",
                400,
                "INVALID_SEARCH_USER_SUBJECTS",
              );
            }
            return subject;
          }),
        ),
      )
    : [];
  if (userSubjects.length > MAX_ADOPTION_SEARCH_USERS) {
    throw new ApiError(
      `Search Access can include at most ${MAX_ADOPTION_SEARCH_USERS} people`,
      400,
      "TOO_MANY_SEARCH_USERS",
    );
  }
  return { teamSlugs, userSubjects };
}

function parseSourceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(
      "source_ids must be an array",
      400,
      "INVALID_SOURCE_IDS",
    );
  }
  const ids = Array.from(
    new Set(
      raw.map((value) => {
        const id = normalizeString(value);
        if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
          throw new ApiError(
            "source_ids must contain datasource ids",
            400,
            "INVALID_SOURCE_IDS",
          );
        }
        return id;
      }),
    ),
  );
  if (ids.length > MAX_ADOPTION_SOURCES) {
    throw new ApiError(
      `An adoption can include at most ${MAX_ADOPTION_SOURCES} sources`,
      400,
      "TOO_MANY_SOURCE_IDS",
    );
  }
  return ids;
}

async function previewSourcesFromConfig(): Promise<ConfigSourcePreview[]> {
  const configPath = process.env.APP_CONFIG_PATH;
  if (!configPath) return [];

  const definitions = new Map<
    string,
    Pick<ConfigSourcePreview, "source_id" | "name" | "source_type">
  >();
  for (const sourceData of loadSeedConfig(configPath).rag_sources) {
    try {
      validateSourceSpecificInputFields(sourceData);
      const extracted = extractIngestionSourceTypeFields(sourceData);
      if (!extracted) continue;
      const sourceId = computeIngestionSourceId(extracted.identity);
      definitions.set(sourceId, {
        source_id: sourceId,
        name: normalizeString(sourceData.name) ?? sourceId,
        source_type: extracted.fields.source_type as IngestionSourceType,
      });
    } catch (error) {
      console.warn(
        `[rag-config-adoption] Skipping invalid source ${String(sourceData.name ?? "unknown")}:`,
        error,
      );
    }
  }
  if (definitions.size === 0) return [];

  const collection = await getCollection<IngestionSourceConfig>(
    "rag_ingestion_sources",
  );
  const existingDocs = await collection
    .find({ source_id: { $in: Array.from(definitions.keys()) } } as never)
    .project({
      source_id: 1,
      config_driven: 1,
      config_import_adopted: 1,
    })
    .toArray();
  const existingById = new Map(
    existingDocs.map((source) => [source.source_id, source]),
  );

  return Array.from(definitions.values()).map((definition) => {
    const existing = existingById.get(definition.source_id);
    const alreadyAdopted = existing?.config_import_adopted === true;
    const importable =
      existing?.config_driven === true && !alreadyAdopted;
    const unavailableReason: PreviewUnavailableReason | undefined = !existing
      ? "not_seeded"
      : !alreadyAdopted && existing.config_driven !== true
        ? "not_config_driven"
        : undefined;
    return {
      ...definition,
      in_db: Boolean(existing),
      already_adopted: alreadyAdopted,
      importable,
      ...(unavailableReason
        ? { unavailable_reason: unavailableReason }
        : {}),
    };
  });
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  await requireResourcePermission(session, {
    type: "organization",
    id: caipeOrgKey(),
    action: "manage",
  });

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

  const previews = await previewSourcesFromConfig();
  if (body.dry_run !== false) {
    return successResponse<AdoptFromConfigResult>({
      sources: previews,
      configured_source_count: previews.length,
    });
  }

  const [owner, search] = await Promise.all([
    parseOwner(body),
    parseSearchAccess(body),
  ]);

  const requestedIds = Object.prototype.hasOwnProperty.call(body, "source_ids")
    ? parseSourceIds(body.source_ids)
    : previews.filter((source) => source.importable).map((source) => source.source_id);
  const previewById = new Map(previews.map((source) => [source.source_id, source]));
  const eligibleIds: string[] = [];
  const skipped: AdoptSkip[] = [];
  for (const sourceId of requestedIds) {
    const preview = previewById.get(sourceId);
    if (!preview) {
      skipped.push({ source_id: sourceId, reason: "not_in_config" });
    } else if (preview.already_adopted) {
      skipped.push({ source_id: sourceId, reason: "already_adopted" });
    } else if (!preview.in_db) {
      skipped.push({ source_id: sourceId, reason: "not_seeded" });
    } else if (!preview.importable) {
      skipped.push({ source_id: sourceId, reason: "not_config_driven" });
    } else {
      eligibleIds.push(sourceId);
    }
  }

  const adoption = await adoptConfigImportedRagSources(eligibleIds, owner, {
    teamSlugs: search.teamSlugs,
    userSubjects: search.userSubjects,
  });
  skipped.push(...adoption.skipped);

  return successResponse<AdoptFromConfigResult>({
    sources: previews,
    adopted: adoption.adopted,
    skipped,
    configured_source_count: previews.length,
  });
});
