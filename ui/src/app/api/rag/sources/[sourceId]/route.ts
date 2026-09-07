/**
 * `/api/rag/sources/[sourceId]` — GET/PATCH/DELETE on a single ingestion
 * source config record (spec 2026-07-21-rag-source-config-db).
 *
 * GET: 403 (not 404) for an existing-but-unreadable record — matches
 * `ui/src/app/api/rag/kbs/[id]/sharing/route.ts`'s GET, which lets
 * `requireResourcePermission`'s ApiError propagate unchanged.
 *
 * PATCH/DELETE: config-driven check before the can_manage check — an
 * owner-team admin still gets 403 CONFIG_DRIVEN_IMMUTABLE, matching
 * `ui/src/app/api/dynamic-agents/route.ts`'s existing agent PATCH/DELETE
 * ordering (config-driven guard runs first there too).
 *
 * Source-management grants (`ingestion_source`) are intentionally independent
 * from Search Access grants (`knowledge_base` + `data_source`). The only
 * cross-policy transition is personal -> team ownership: it revokes the
 * creator's implicit personal query-owner grant while retaining explicit
 * Search Access teams.
 * PATCH additionally accepts a person or team owner plus
 * `confirm_not_member` to transfer management ownership. The transfer guard
 * requires current source management (or organization administration), with
 * explicit confirmation when the destination may remove the caller's access.
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  createPublicationRequest,
  invalidatePublicationRequests,
  invalidatePublicationRequestsReferencingDatasource,
  publicationActorFromSession,
  recordAutoApprovedPublication,
  type RagPublicationState,
} from "@/lib/publication-approval.server";
import {
  enforceRagIngestorLimits,
  getRagIngestorLimits,
} from "@/lib/rag-ingestor-limits.server";
import {
  datasourceCollectionAudience,
  removeDatasourceFromAgentPins,
  removeDatasourceFromRagCollections,
} from "@/lib/rag-collections.server";
import {
  changedApprovalGatedSourceUpdate,
  prepareRagPublication,
  ragPublicationRevision,
} from "@/lib/rag-publication-approval.server";
import {
  deleteAllDataSourceRelationshipTuples,
  deleteAllIngestionSourceRelationshipTuples,
  deleteAllKnowledgeBaseRelationshipTuples,
  reconcileDataSourceRelationships,
  reconcileIngestionSourceRelationships,
  reconcileKnowledgeBaseRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import {
  canTransferResourceOwnership,
  requireResourcePermission,
} from "@/lib/rbac/resource-authz";
import { resolveUserIdentitiesBySubject } from "@/lib/rbac/user-identity-directory";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import { NextRequest } from "next/server";
import {
  optionalStringList,
  optionalStringMap,
  optionalWebSettings,
} from "../route";

const COLLECTION_NAME = "rag_ingestion_sources";
const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

interface TeamOwnershipDoc {
  _id?: unknown;
  slug?: string;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isValidTeamSlug(value: string): boolean {
  return OPENFGA_ID_PATTERN.test(value);
}

async function loadOwnerTeam(slug: string): Promise<TeamOwnershipDoc | null> {
  const teams = await getCollection<TeamOwnershipDoc>("teams");
  return teams.findOne({ slug } as never);
}

/** Fields that identify a source and may never change after creation. */
const IMMUTABLE_FIELDS = [
  "source_id",
  "source_type",
  "channel_id",
  "confluence_url",
  "space_key",
  "start_page_url",
  "whole_space",
  "page_configs",
  "project_key",
  "source_slug",
  "url",
  "space_id",
] as const;

/** Fields any caller with `can_manage` may update via PATCH. */
const MUTABLE_FIELDS = [
  "name",
  "description",
  "default_chunk_size",
  "default_chunk_overlap",
  "reload_interval",
  "lookback_days",
  "include_bots",
  "jql",
  "include_comments",
  "include_links",
  "custom_fields",
  "get_child_pages",
  "allowed_title_patterns",
  "denied_title_patterns",
  "settings",
] as const;

const TYPE_SPECIFIC_MUTABLE_FIELDS = new Set([
  "lookback_days",
  "include_bots",
  "jql",
  "include_comments",
  "include_links",
  "custom_fields",
  "get_child_pages",
  "allowed_title_patterns",
  "denied_title_patterns",
  "settings",
]);

const ALLOWED_TYPE_SPECIFIC_FIELDS: Record<
  IngestionSourceConfig["source_type"],
  Set<string>
> = {
  slack_channel: new Set(["lookback_days", "include_bots"]),
  confluence_space: new Set([
    "get_child_pages",
    "allowed_title_patterns",
    "denied_title_patterns",
  ]),
  jira_project: new Set([
    "jql",
    "include_comments",
    "include_links",
    "custom_fields",
  ]),
  web_url: new Set(["settings"]),
  webex_space: new Set(["include_bots"]),
};

function pickMutableFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of MUTABLE_FIELDS) {
    if (body[field] !== undefined) {
      result[field] = body[field];
    }
  }
  return result;
}

function validateMutableFields(
  source: IngestionSourceConfig,
  updateData: Record<string, unknown>,
): void {
  const allowedTypeSpecificFields =
    ALLOWED_TYPE_SPECIFIC_FIELDS[source.source_type];
  for (const field of TYPE_SPECIFIC_MUTABLE_FIELDS) {
    if (field in updateData && !allowedTypeSpecificFields.has(field)) {
      throw new ApiError(
        `${field} is not valid for source_type ${source.source_type}`,
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
  }
  if ("name" in updateData) {
    const name = normalizeString(updateData.name);
    if (!name || name.length > 120) {
      throw new ApiError(
        "name must be between 1 and 120 characters",
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
    updateData.name = name;
  }
  if ("description" in updateData) {
    if (typeof updateData.description !== "string") {
      throw new ApiError(
        "description must be a string",
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
    if (updateData.description.length > 2000) {
      throw new ApiError(
        "description must not exceed 2000 characters",
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
  }
  const integerRanges: Record<string, [number, number]> = {
    default_chunk_size: [100, 100000],
    default_chunk_overlap: [0, 10000],
    reload_interval: [60, Number.MAX_SAFE_INTEGER],
    lookback_days: [0, Number.MAX_SAFE_INTEGER],
  };
  for (const [field, [minimum, maximum]] of Object.entries(integerRanges)) {
    if (!(field in updateData)) continue;
    const value = updateData[field];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new ApiError(
        `${field} is outside its allowed range`,
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
  }
  const finalChunkSize =
    (updateData.default_chunk_size as number | undefined) ??
    source.default_chunk_size;
  const finalChunkOverlap =
    (updateData.default_chunk_overlap as number | undefined) ??
    source.default_chunk_overlap;
  if (finalChunkOverlap >= finalChunkSize) {
    throw new ApiError(
      "default_chunk_overlap must be smaller than default_chunk_size",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  for (const field of [
    "include_bots",
    "include_comments",
    "include_links",
    "get_child_pages",
  ]) {
    if (field in updateData && typeof updateData[field] !== "boolean") {
      throw new ApiError(
        `${field} must be a boolean`,
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
  }
  if ("jql" in updateData && !normalizeString(updateData.jql)) {
    throw new ApiError(
      "jql must be a non-empty string",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  for (const field of ["allowed_title_patterns", "denied_title_patterns"]) {
    if (field in updateData) {
      updateData[field] = optionalStringList(updateData[field], field) ?? [];
    }
  }
  if ("custom_fields" in updateData) {
    updateData.custom_fields =
      optionalStringMap(updateData.custom_fields, "custom_fields") ?? {};
  }
  if ("settings" in updateData) {
    updateData.settings = optionalWebSettings(updateData.settings);
  }
}

async function normalizeSearchTeamSlugs(
  raw: unknown[],
  maximumTeams: number,
  grandfatheredTeamSlugs: readonly string[] = [],
): Promise<string[]> {
  const slugs = Array.from(
    new Set(
      raw.map((value) => {
        const slug = normalizeString(value);
        if (!slug || !isValidTeamSlug(slug)) {
          throw new ApiError(
            "search_team_slugs must contain valid team slugs",
            400,
            "INVALID_SOURCE_PAYLOAD",
          );
        }
        return slug;
      }),
    ),
  );
  const grandfathered = new Set(grandfatheredTeamSlugs);
  if (
    slugs.length > maximumTeams &&
    slugs.some((slug) => !grandfathered.has(slug))
  ) {
    throw new ApiError(
      `A source cannot grant search access to more than ${maximumTeams} teams`,
      400,
      "RAG_INGESTOR_LIMIT_EXCEEDED",
    );
  }
  const teams = await Promise.all(slugs.map((slug) => loadOwnerTeam(slug)));
  if (teams.some((team) => !team)) {
    throw new ApiError(
      "One or more search teams do not exist",
      404,
      "SEARCH_TEAM_NOT_FOUND",
    );
  }
  return slugs;
}

async function normalizeSearchUserSubjects(
  raw: unknown[],
  grandfatheredSubjects: readonly string[] = [],
): Promise<string[]> {
  const subjects = Array.from(
    new Set(
      raw.map((value) => {
        const subject = normalizeString(value);
        if (!subject || !OPENFGA_ID_PATTERN.test(subject)) {
          throw new ApiError(
            "search_user_subjects must contain valid user subjects",
            400,
            "INVALID_SOURCE_PAYLOAD",
          );
        }
        return subject;
      }),
    ),
  );
  const grandfathered = new Set(grandfatheredSubjects);
  if (
    subjects.length > 50 &&
    subjects.some((subject) => !grandfathered.has(subject))
  ) {
    throw new ApiError(
      "A source cannot grant search access to more than 50 people",
      400,
      "RAG_INGESTOR_LIMIT_EXCEEDED",
    );
  }
  const identities = await resolveUserIdentitiesBySubject(subjects);
  if (subjects.some((subject) => !identities.has(subject))) {
    throw new ApiError(
      "One or more search users do not exist",
      404,
      "SEARCH_USER_NOT_FOUND",
    );
  }
  return subjects;
}

const RAG_SYNC_FIELDS = new Set([
  "name",
  "description",
  "default_chunk_size",
  "default_chunk_overlap",
  "reload_interval",
  "lookback_days",
  "include_bots",
  "jql",
  "include_comments",
  "include_links",
  "custom_fields",
  "get_child_pages",
  "allowed_title_patterns",
  "denied_title_patterns",
  "settings",
]);

async function syncRagDatasourceConfig(
  sourceId: string,
  updateData: Record<string, unknown>,
  accessToken: string | undefined,
): Promise<void> {
  const payload = Object.fromEntries(
    Object.entries(updateData).filter(([key]) => RAG_SYNC_FIELDS.has(key)),
  );
  if (Object.keys(payload).length === 0) return;
  if (!accessToken) {
    throw new ApiError(
      "A Keycloak access token is required to update this source",
      401,
    );
  }
  let response: Response;
  try {
    response = await fetch(
      `${getRagServerUrl()}/v1/datasource/${encodeURIComponent(sourceId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    throw new ApiError(
      "The source could not be synchronized with the RAG server",
      503,
      "RAG_SOURCE_SYNC_UNAVAILABLE",
    );
  }
  // A retained failed-create row may not have reached RAG metadata yet; its
  // next retry sends the current Mongo configuration in the ingest payload.
  if (response.status === 404) return;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ApiError(
      `The source could not be synchronized with the RAG server (${response.status})${detail ? `: ${detail}` : ""}`,
      502,
      "RAG_SOURCE_SYNC_FAILED",
    );
  }
}

/**
 * Keep the post-ingestion DataSourceInfo access metadata aligned with the
 * Mongo source config. Enforcement is reconciled separately in OpenFGA. A
 * failed initial ingestion legitimately has no RAG metadata row yet, so 404
 * is a successful no-op and the next ingest persists these fields from the
 * source payload.
 */
async function syncRagDatasourceAccessPolicy(
  sourceId: string,
  update: {
    ownerTeamSlug?: string | null;
    ownerSubject?: string | null;
    searchWithTeams?: string[];
    searchWithUsers?: string[];
  },
  accessToken: string | undefined,
): Promise<boolean> {
  if (!accessToken) {
    throw new ApiError(
      "A Keycloak access token is required to update this source's access",
      401,
    );
  }
  const payload = {
    ...(Object.prototype.hasOwnProperty.call(update, "ownerTeamSlug")
      ? { owner_team_slug: update.ownerTeamSlug }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(update, "ownerSubject")
      ? { owner_subject: update.ownerSubject }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(update, "searchWithTeams")
      ? { search_with_teams: update.searchWithTeams }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(update, "searchWithUsers")
      ? { search_with_users: update.searchWithUsers }
      : {}),
  };
  let response: Response;
  try {
    response = await fetch(
      `${getRagServerUrl()}/v1/datasource/${encodeURIComponent(sourceId)}/owner-team`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    throw new ApiError(
      "The source access policy could not be synchronized with the RAG server",
      503,
      "RAG_ACCESS_SYNC_UNAVAILABLE",
    );
  }
  if (response.status === 404) return false;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ApiError(
      `The source access policy could not be synchronized with the RAG server (${response.status})${detail ? `: ${detail}` : ""}`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
      "RAG_ACCESS_SYNC_FAILED",
    );
  }
  return true;
}

function previousRagDatasourceConfig(
  source: IngestionSourceConfig,
  updateData: Record<string, unknown>,
): Record<string, unknown> {
  const sourceRecord = source as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(updateData)
      .filter((key) => RAG_SYNC_FIELDS.has(key))
      .map((key) => [
        key,
        sourceRecord[key] === undefined
          ? key === "description"
            ? ""
            : null
          : sourceRecord[key],
      ]),
  );
}

async function loadSource(sourceId: string): Promise<IngestionSourceConfig> {
  const collection =
    await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
  const source = await collection.findOne({ source_id: sourceId } as never);
  if (!source) {
    throw new ApiError("Source not found", 404, "SOURCE_NOT_FOUND");
  }
  return source;
}

export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ sourceId: string }> },
  ) => {
    const { sourceId } = await context.params;
    const { session } = await getAuthFromBearerOrSession(request);

    const source = await loadSource(sourceId);

    await requireResourcePermission(
      session,
      { type: "ingestion_source", id: sourceId, action: "read" },
      { bypassForOrgAdmin: true },
    );

    const canManage = await requireResourcePermission(
      session,
      { type: "ingestion_source", id: sourceId, action: "manage" },
      { bypassForOrgAdmin: true },
    )
      .then(() => true)
      .catch(() => false);

    return successResponse({
      ...source,
      _permissions: { can_manage: canManage },
    });
  },
);

export const PATCH = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ sourceId: string }> },
  ) => {
    const { sourceId } = await context.params;
    const { session } = await getAuthFromBearerOrSession(request);

    const source = await loadSource(sourceId);

    // Config-driven check first — a config-driven record is immutable via
    // the API regardless of who's asking.
    if (source.config_driven) {
      throw new ApiError(
        "Config-driven sources cannot be modified. Update the Helm values instead.",
        403,
        "CONFIG_DRIVEN_IMMUTABLE",
      );
    }

    await requireResourcePermission(
      session,
      { type: "ingestion_source", id: sourceId, action: "manage" },
      { bypassForOrgAdmin: true },
    ).catch(() => {
      throw new ApiError(
        "You do not have permission to manage this source",
        403,
        "FORBIDDEN_MANAGE",
      );
    });
    const ingestorLimits = await getRagIngestorLimits();

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ApiError(
          "Request body must be an object",
          400,
          "INVALID_SOURCE_PAYLOAD",
        );
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("Invalid JSON body", 400, "INVALID_JSON");
    }
    const attemptedImmutableChange = IMMUTABLE_FIELDS.some(
      (field) => body[field] !== undefined,
    );
    if (attemptedImmutableChange) {
      throw new ApiError(
        "Immutable fields cannot be changed via PATCH",
        400,
        "IMMUTABLE_FIELD_CHANGE",
      );
    }
    if (Object.prototype.hasOwnProperty.call(body, "shared_with_teams")) {
      throw new ApiError(
        "A datasource has one Owner. Add other people or teams under Search.",
        400,
        "MANAGEMENT_SHARING_NOT_SUPPORTED",
      );
    }

    const updateData = pickMutableFields(body);
    validateMutableFields(source, updateData);
    const searchTeamsWereRequested = Object.prototype.hasOwnProperty.call(
      body,
      "search_team_slugs",
    );
    if (searchTeamsWereRequested && !Array.isArray(body.search_team_slugs)) {
      throw new ApiError(
        "search_team_slugs must be an array of team slugs",
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
    const previousSearchTeamSlugs = Array.isArray(source.search_with_teams)
      ? source.search_with_teams
      : source.search_owner_team_slug
        ? [source.search_owner_team_slug]
        : [];
    const nextSearchTeamSlugs = searchTeamsWereRequested
      ? await normalizeSearchTeamSlugs(
          body.search_team_slugs as unknown[],
          ingestorLimits.shared.max_search_teams,
          previousSearchTeamSlugs,
        )
      : previousSearchTeamSlugs;
    if (searchTeamsWereRequested) {
      updateData.search_with_teams = nextSearchTeamSlugs;
    }
    const searchUsersWereRequested = Object.prototype.hasOwnProperty.call(
      body,
      "search_user_subjects",
    );
    if (searchUsersWereRequested && !Array.isArray(body.search_user_subjects)) {
      throw new ApiError(
        "search_user_subjects must be an array of user subjects",
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
    const previousSearchUserSubjects = Array.isArray(source.search_with_users)
      ? source.search_with_users
      : [];
    const nextSearchUserSubjects = searchUsersWereRequested
      ? await normalizeSearchUserSubjects(
          body.search_user_subjects as unknown[],
          previousSearchUserSubjects,
        )
      : previousSearchUserSubjects;
    if (searchUsersWereRequested) {
      updateData.search_with_users = nextSearchUserSubjects;
    }
    const searchTeamsNeedLimitCheck =
      searchTeamsWereRequested &&
      nextSearchTeamSlugs.length <= ingestorLimits.shared.max_search_teams;
    enforceRagIngestorLimits(
      source.source_type,
      {
        ...updateData,
        ...(searchTeamsNeedLimitCheck
          ? { search_team_slugs: nextSearchTeamSlugs }
          : {}),
      },
      ingestorLimits,
    );

    const previousOwnerTeamSlug = normalizeString(source.owner_team_slug);
    const previousOwnerSubject = previousOwnerTeamSlug
      ? null
      : (normalizeString(source.owner_subject) ??
        normalizeString(source.creator_subject));
    const previousSharedTeamSlugs = Array.isArray(source.shared_with_teams)
      ? source.shared_with_teams
      : [];
    const ownerTeamWasRequested = Object.prototype.hasOwnProperty.call(
      body,
      "owner_team_slug",
    );
    const ownerSubjectWasRequested = Object.prototype.hasOwnProperty.call(
      body,
      "owner_subject",
    );
    const ownerWasRequested = ownerTeamWasRequested || ownerSubjectWasRequested;
    let nextOwnerTeamSlug = previousOwnerTeamSlug;
    let nextOwnerSubject = previousOwnerSubject;
    if (ownerWasRequested) {
      const requestedOwnerTeamSlug = normalizeString(body.owner_team_slug);
      const requestedOwnerSubject = normalizeString(body.owner_subject);
      if (requestedOwnerTeamSlug && requestedOwnerSubject) {
        throw new ApiError(
          "Select either a person or a team as owner, not both",
          400,
          "INVALID_SOURCE_PAYLOAD",
        );
      }
      if (!requestedOwnerTeamSlug && !requestedOwnerSubject) {
        throw new ApiError(
          "Select a person or team to own this source",
          400,
          "INVALID_SOURCE_PAYLOAD",
        );
      }
      if (requestedOwnerTeamSlug && !isValidTeamSlug(requestedOwnerTeamSlug)) {
        throw new ApiError(
          "owner_team_slug must be a valid team slug",
          400,
          "INVALID_SOURCE_PAYLOAD",
        );
      }
      if (
        requestedOwnerSubject &&
        !OPENFGA_ID_PATTERN.test(requestedOwnerSubject)
      ) {
        throw new ApiError(
          "owner_subject must be a valid user subject",
          400,
          "INVALID_SOURCE_PAYLOAD",
        );
      }
      if (requestedOwnerSubject) {
        const users = await resolveUserIdentitiesBySubject([
          requestedOwnerSubject,
        ]);
        if (!users.has(requestedOwnerSubject)) {
          throw new ApiError(
            "Owner user not found",
            404,
            "OWNER_USER_NOT_FOUND",
          );
        }
      }
      nextOwnerTeamSlug = requestedOwnerTeamSlug;
      nextOwnerSubject = requestedOwnerSubject;
    }
    if (
      Object.prototype.hasOwnProperty.call(body, "confirm_not_member") &&
      typeof body.confirm_not_member !== "boolean"
    ) {
      throw new ApiError(
        "confirm_not_member must be a boolean",
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
    const ownerChanged =
      nextOwnerTeamSlug !== previousOwnerTeamSlug ||
      nextOwnerSubject !== previousOwnerSubject;
    if (ownerChanged) {
      const canTransfer = await canTransferResourceOwnership(session, {
        type: "ingestion_source",
        id: sourceId,
      });
      if (!canTransfer) {
        throw new ApiError(
          "Only the current Owner or an organization admin can transfer this source.",
          403,
          "TRANSFER_FORBIDDEN",
        );
      }
    }
    if (ownerChanged && nextOwnerTeamSlug) {
      const destinationTeam = await loadOwnerTeam(nextOwnerTeamSlug);
      if (!destinationTeam) {
        throw new ApiError(
          "Destination team not found",
          404,
          "OWNER_TEAM_NOT_FOUND",
        );
      }
      const canUseDestination = await requireResourcePermission(session, {
        type: "team",
        id: nextOwnerTeamSlug,
        action: "use",
      }).then(
        () => true,
        () => false,
      );
      if (!canUseDestination && body.confirm_not_member !== true) {
        throw new ApiError(
          "You are not a member of the destination team. Confirm the transfer to proceed.",
          409,
          "TRANSFER_NOT_MEMBER_UNCONFIRMED",
        );
      }
    }
    if (
      ownerChanged &&
      nextOwnerSubject &&
      nextOwnerSubject !== session.sub &&
      body.confirm_not_member !== true
    ) {
      throw new ApiError(
        "Transferring this source to another person may remove your access. Confirm the transfer to proceed.",
        409,
        "TRANSFER_CONFIRMATION_REQUIRED",
      );
    }
    if (ownerChanged && nextOwnerTeamSlug) {
      updateData.owner_team_slug = nextOwnerTeamSlug;
    } else if (ownerChanged && nextOwnerSubject) {
      updateData.owner_subject = nextOwnerSubject;
    }

    const gatedSourceUpdate = changedApprovalGatedSourceUpdate(source, updateData);
    const materialChange = ownerChanged || Object.keys(gatedSourceUpdate).length > 0;
    const collectionAudience = materialChange
      ? await datasourceCollectionAudience(sourceId, {
          ownerTeamSlug: previousOwnerTeamSlug,
          ownerSubject: previousOwnerSubject,
        })
      : {
          collectionIds: [],
          readerTeamSlugs: [],
          hasExternalPrincipal: false,
          organizationWide: false,
        };
    const publicationSource = {
      ...source,
      ...gatedSourceUpdate,
    } as IngestionSourceConfig;
    const publication = await prepareRagPublication({
      session,
      source: publicationSource,
      currentSearchTeamSlugs: previousSearchTeamSlugs,
      currentSearchUserSubjects: previousSearchUserSubjects,
      requestedSearchTeamSlugs: nextSearchTeamSlugs,
      requestedSearchUserSubjects: nextSearchUserSubjects,
      sourceUpdate: Object.keys(gatedSourceUpdate).length > 0 ? gatedSourceUpdate : undefined,
      ownerUpdate: ownerChanged
        ? {
            owner_team_slug: nextOwnerTeamSlug,
            owner_subject: nextOwnerSubject,
          }
        : undefined,
      materialChange,
      externalAudienceTeamSlugs: collectionAudience.readerTeamSlugs,
      externalBroadAudience: collectionAudience.hasExternalPrincipal,
      externalOrganizationWide: collectionAudience.organizationWide,
    });
    await invalidatePublicationRequests(
      publication.resource,
      publication.actor,
      "A newer datasource change replaced this publication proposal.",
    );
    const effectiveSearch = publication.plan.effective_state as unknown as RagPublicationState;
    const effectiveSearchTeamSlugs = effectiveSearch.search_team_slugs;
    const effectiveSearchUserSubjects = effectiveSearch.search_user_subjects;
    if (publication.plan.requires_approval) {
      // Keep the currently published source configuration active until the
      // approver adapter applies the requested material change.
      for (const field of Object.keys(gatedSourceUpdate)) delete updateData[field];
    }
    const ownerChangeDeferred = publication.plan.requires_approval && ownerChanged;
    if (ownerChangeDeferred) {
      delete updateData.owner_team_slug;
      delete updateData.owner_subject;
    }
    const appliedOwnerTeamSlug = ownerChangeDeferred
      ? previousOwnerTeamSlug
      : nextOwnerTeamSlug;
    const appliedOwnerSubject = ownerChangeDeferred
      ? previousOwnerSubject
      : nextOwnerSubject;
    const ownerChangeApplied =
      appliedOwnerTeamSlug !== previousOwnerTeamSlug ||
      appliedOwnerSubject !== previousOwnerSubject;
    if (searchTeamsWereRequested) {
      updateData.search_with_teams = effectiveSearchTeamSlugs;
    }
    if (searchUsersWereRequested) {
      updateData.search_with_users = effectiveSearchUserSubjects;
    }

    const nextSharedTeamSlugs: string[] = [];
    if (previousSharedTeamSlugs.length > 0) {
      updateData.shared_with_teams = [];
    }

    updateData.updated_at = new Date().toISOString();

    const collection =
      await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
    const mongoUpdate: Record<string, unknown> = { $set: updateData };
    const unsetFields: Record<string, string> = {};
    if (ownerChangeApplied && appliedOwnerTeamSlug && source.owner_subject) {
      unsetFields.owner_subject = "";
    }
    if (ownerChangeApplied && appliedOwnerSubject && source.owner_team_slug) {
      unsetFields.owner_team_slug = "";
    }
    if (searchTeamsWereRequested && source.search_owner_team_slug) {
      unsetFields.search_owner_team_slug = "";
    }
    if (Object.keys(unsetFields).length > 0) {
      mongoUpdate.$unset = unsetFields;
    }
    const previousRagConfig = previousRagDatasourceConfig(source, updateData);
    const ragSyncRequired = Object.keys(updateData).some((key) =>
      RAG_SYNC_FIELDS.has(key),
    );
    const managementPolicyChanged =
      ownerChangeApplied || previousSharedTeamSlugs.length > 0;
    const previousPersonalSearchOwner = previousOwnerSubject;
    const nextPersonalSearchOwner = appliedOwnerSubject;
    const personalSearchOwnershipChanged =
      previousPersonalSearchOwner !== nextPersonalSearchOwner;
    const searchPolicyChanged =
      effectiveSearchTeamSlugs.join("\u0000") !== previousSearchTeamSlugs.join("\u0000") ||
      effectiveSearchUserSubjects.join("\u0000") !== previousSearchUserSubjects.join("\u0000") ||
      personalSearchOwnershipChanged;
    let ragAccessPolicySynced = false;
    let managementPolicyWriteStarted = false;
    let searchPolicyWriteStarted = false;
    let updated: IngestionSourceConfig | null;
    try {
      await syncRagDatasourceConfig(sourceId, updateData, session.accessToken);

      // Persist access metadata while the caller still has the old management
      // grant. The policy transfer below can deliberately remove that grant.
      if (
        ownerChangeApplied ||
        searchTeamsWereRequested ||
        searchUsersWereRequested
      ) {
        ragAccessPolicySynced = await syncRagDatasourceAccessPolicy(
          sourceId,
          {
            ...(ownerChangeApplied
              ? {
                  ownerTeamSlug: appliedOwnerTeamSlug,
                  ownerSubject: appliedOwnerSubject,
                }
              : {}),
            ...(searchTeamsWereRequested
              ? { searchWithTeams: effectiveSearchTeamSlugs }
              : {}),
            ...(searchUsersWereRequested
              ? { searchWithUsers: effectiveSearchUserSubjects }
              : {}),
          },
          session.accessToken,
        );
      }

      // Reconcile source management independently. A personal -> team transfer
      // also revokes the implicit personal query owner below.
      if (managementPolicyChanged) {
        managementPolicyWriteStarted = true;
        const previousOwnerForRevoke = ownerChangeApplied
          ? previousOwnerTeamSlug
          : undefined;
        await reconcileIngestionSourceRelationships({
          sourceId,
          creatorSubject: source.creator_subject,
          // A personal source is owned by its creator. An explicit transfer
          // ends that grant; creator provenance alone never carries authority.
          ownerSubject: appliedOwnerSubject,
          previousOwnerSubject: ownerChangeApplied ? previousOwnerSubject : undefined,
          ownerTeamSlug: appliedOwnerTeamSlug,
          previousOwnerTeamSlug: previousOwnerForRevoke,
          nextSharedTeamSlugs,
          previousSharedTeamSlugs,
          globalUserAccess: source.visibility === "global",
          previousGlobalUserAccess: source.visibility === "global",
        });
      }

      if (searchPolicyChanged) {
        searchPolicyWriteStarted = true;
        await reconcileKnowledgeBaseRelationships({
          knowledgeBaseId: sourceId,
          creatorSubject: source.creator_subject,
          ownerSubject: nextPersonalSearchOwner,
          previousOwnerSubject: personalSearchOwnershipChanged
            ? previousPersonalSearchOwner
            : undefined,
          ownerTeamSlug: null,
          previousOwnerTeamSlug: source.search_owner_team_slug,
          nextSharedTeamSlugs: effectiveSearchTeamSlugs,
          previousSharedTeamSlugs: previousSearchTeamSlugs,
          nextSharedUserSubjects: effectiveSearchUserSubjects.filter(
            (subject) => subject !== nextPersonalSearchOwner,
          ),
          previousSharedUserSubjects: previousSearchUserSubjects,
        });
        await reconcileDataSourceRelationships({
          dataSourceId: sourceId,
          parentKnowledgeBaseId: sourceId,
        });
      }

      updated = await collection.findOneAndUpdate(
        { source_id: sourceId } as never,
        mongoUpdate as never,
        { returnDocument: "after" },
      );
      if (!updated) {
        throw new ApiError(
          "Failed to update source",
          500,
          "SOURCE_UPDATE_FAILED",
        );
      }
    } catch (error) {
      // The policy write happens before Mongo so a transfer never persists a
      // new owner after revoking the only caller that can retry. If Mongo then
      // fails, restore the exact previous management and Search Access
      // projections.
      if (managementPolicyWriteStarted) {
        try {
          await reconcileIngestionSourceRelationships({
            sourceId,
            creatorSubject: source.creator_subject,
            ownerSubject: previousOwnerSubject,
            previousOwnerSubject: ownerChangeApplied
              ? appliedOwnerSubject
              : undefined,
            ownerTeamSlug: previousOwnerTeamSlug,
            previousOwnerTeamSlug: ownerChangeApplied ? appliedOwnerTeamSlug : undefined,
            nextSharedTeamSlugs: previousSharedTeamSlugs,
            previousSharedTeamSlugs: nextSharedTeamSlugs,
            globalUserAccess: source.visibility === "global",
            previousGlobalUserAccess: source.visibility === "global",
          });
        } catch (rollbackError) {
          console.error(
            `[rag/sources/${sourceId}] failed to restore source policy after Mongo update failure`,
            rollbackError,
          );
        }
      }
      if (searchPolicyWriteStarted) {
        try {
          await reconcileKnowledgeBaseRelationships({
            knowledgeBaseId: sourceId,
            creatorSubject: source.creator_subject,
            ownerSubject: previousPersonalSearchOwner,
            previousOwnerSubject: personalSearchOwnershipChanged
              ? nextPersonalSearchOwner
              : undefined,
            ownerTeamSlug: source.search_owner_team_slug,
            nextSharedTeamSlugs: previousSearchTeamSlugs,
            previousSharedTeamSlugs: effectiveSearchTeamSlugs,
            nextSharedUserSubjects: previousSearchUserSubjects,
            previousSharedUserSubjects: effectiveSearchUserSubjects,
          });
          await reconcileDataSourceRelationships({
            dataSourceId: sourceId,
            parentKnowledgeBaseId: sourceId,
          });
        } catch (rollbackError) {
          console.error(
            `[rag/sources/${sourceId}] failed to restore search policy after Mongo update failure`,
            rollbackError,
          );
        }
      }
      if (ragSyncRequired && session.accessToken) {
        try {
          await syncRagDatasourceConfig(
            sourceId,
            previousRagConfig,
            session.accessToken,
          );
        } catch (rollbackError) {
          console.error(
            `[rag/sources/${sourceId}] failed to restore RAG metadata after source update failure`,
            rollbackError,
          );
        }
      }
      if (ragAccessPolicySynced && session.accessToken) {
        try {
          await syncRagDatasourceAccessPolicy(
            sourceId,
            {
              ...(ownerChangeApplied
                ? {
                    ownerTeamSlug: previousOwnerTeamSlug,
                    ownerSubject: previousOwnerSubject,
                  }
                : {}),
              ...(searchTeamsWereRequested
                ? { searchWithTeams: previousSearchTeamSlugs }
                : {}),
              ...(searchUsersWereRequested
                ? { searchWithUsers: previousSearchUserSubjects }
                : {}),
            },
            session.accessToken,
          );
        } catch (rollbackError) {
          console.error(
            `[rag/sources/${sourceId}] failed to restore RAG access metadata after source update failure`,
            rollbackError,
          );
        }
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        "Failed to update source",
        500,
        "SOURCE_UPDATE_FAILED",
      );
    }

    let publicationRequest: Awaited<ReturnType<typeof createPublicationRequest>> | null = null;
    if (publication.plan.requires_approval) {
      publicationRequest = await createPublicationRequest({
        resource: publication.resource,
        resourceRevision: ragPublicationRevision(updated, effectiveSearch),
        requestedState: publication.requestedState as unknown as Record<string, unknown>,
        effectiveState: effectiveSearch as unknown as Record<string, unknown>,
        riskFacts: publication.plan.risk_facts,
        requester: publication.actor,
        requesterTeamSlugs: publication.requesterTeamSlugs,
        approverTeamSlugs: publication.plan.approver_team_slugs,
        approverUserSubjects: publication.plan.approver_user_subjects,
      });
    } else if (
      searchTeamsWereRequested ||
      searchUsersWereRequested ||
      publication.plan.risk_facts.added_team_slugs?.length ||
      publication.plan.risk_facts.added_user_subjects?.length ||
      publication.plan.risk_facts.material_change
    ) {
      await recordAutoApprovedPublication({
        resource: publication.resource,
        resourceRevision: ragPublicationRevision(updated, effectiveSearch),
        requestedState: publication.requestedState as unknown as Record<string, unknown>,
        effectiveState: effectiveSearch as unknown as Record<string, unknown>,
        riskFacts: publication.plan.risk_facts,
        requester: publication.actor,
        requesterTeamSlugs: publication.requesterTeamSlugs,
        approverTeamSlugs: publication.plan.approver_team_slugs,
        approverUserSubjects: publication.plan.approver_user_subjects,
      });
    }

    return successResponse({
      ...updated,
      ...(publicationRequest
        ? {
            _publication_request: {
              id: publicationRequest._id,
              status: publicationRequest.status,
              reason: publication.plan.reason,
            },
          }
        : {}),
    });
  },
);

export const DELETE = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ sourceId: string }> },
  ) => {
    const { sourceId } = await context.params;
    const { session } = await getAuthFromBearerOrSession(request);

    const source = await loadSource(sourceId);

    if (source.config_driven) {
      throw new ApiError(
        "Config-driven sources cannot be deleted. Remove the Helm values entry instead.",
        403,
        "CONFIG_DRIVEN_IMMUTABLE",
      );
    }

    await requireResourcePermission(
      session,
      { type: "ingestion_source", id: sourceId, action: "manage" },
      { bypassForOrgAdmin: true },
    ).catch(() => {
      throw new ApiError(
        "You do not have permission to manage this source",
        403,
        "FORBIDDEN_MANAGE",
      );
    });

    const publicationActor = publicationActorFromSession(session);
    await invalidatePublicationRequests(
      {
        kind: "rag_datasource",
        id: sourceId,
        label: source.name || sourceId,
      },
      publicationActor,
      "The datasource was deleted before this proposal was approved.",
    );
    await invalidatePublicationRequestsReferencingDatasource(
      sourceId,
      publicationActor,
      "A datasource referenced by this collection proposal was deleted.",
    );

    const searchParams = new URL(request.url).searchParams;
    const purgeData = searchParams.get("purge_data") === "true";
    const purgeQueryGrants =
      purgeData || searchParams.get("purge_query_grants") === "true";

    if (purgeData) {
      if (!session.accessToken) {
        throw new ApiError(
          "A Keycloak access token is required to delete this source",
          401,
        );
      }
      let response: Response;
      try {
        response = await fetch(
          `${getRagServerUrl()}/v1/datasource?datasource_id=${encodeURIComponent(sourceId)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${session.accessToken}` },
          },
        );
      } catch {
        throw new ApiError(
          "The datasource could not be deleted from the RAG server",
          503,
          "RAG_DELETE_UNAVAILABLE",
        );
      }
      // A retry after the upstream delete succeeded is intentionally
      // idempotent so policy/config cleanup can finish.
      if (!response.ok && response.status !== 404) {
        const detail = await response.text().catch(() => "");
        throw new ApiError(
          `The datasource could not be deleted from the RAG server (${response.status})${detail ? `: ${detail}` : ""}`,
          response.status === 400 ? 409 : 502,
          "RAG_DELETE_FAILED",
        );
      }
    }

    // Revoke query access before the independent management grant. If a
    // downstream cleanup fails, the caller retains source-management access
    // and can safely retry instead of leaving a live source with no manager.
    if (purgeQueryGrants) {
      await removeDatasourceFromRagCollections(sourceId);
      await removeDatasourceFromAgentPins(sourceId);
      await deleteAllDataSourceRelationshipTuples(sourceId);
      await deleteAllKnowledgeBaseRelationshipTuples(sourceId);
    }

    // Exact deletion is required: a normal reconciler always re-writes
    // creator/owner tuples and cannot represent object deletion. Remove the
    // management projection before the Mongo row; if either operation has an
    // ambiguous failure, restore the projection from the still-loaded config
    // so the same manager can retry.
    const collection =
      await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
    try {
      await deleteAllIngestionSourceRelationshipTuples(sourceId);
      const deleted = await collection.deleteOne({
        source_id: sourceId,
      } as never);
      if (deleted.deletedCount !== 1) {
        throw new ApiError(
          "Failed to delete source",
          500,
          "SOURCE_DELETE_FAILED",
        );
      }
    } catch (error) {
      // `deleteOne` may have committed even when the driver lost the response,
      // and another authorized request may have completed the same delete.
      // If the row is now absent, cleanup succeeded and restoring tuples would
      // create a dangling authorization object.
      try {
        const remaining = await collection.findOne({
          source_id: sourceId,
        } as never);
        if (!remaining) {
          return successResponse({ deleted: sourceId });
        }
      } catch (readbackError) {
        console.error(
          `[rag/sources/${sourceId}] could not verify Mongo state after delete failure`,
          readbackError,
        );
      }
      try {
        await reconcileIngestionSourceRelationships({
          sourceId,
          creatorSubject: source.creator_subject,
          ownerSubject: source.owner_subject,
          ownerTeamSlug: normalizeString(source.owner_team_slug),
          nextSharedTeamSlugs: Array.isArray(source.shared_with_teams)
            ? source.shared_with_teams
            : [],
          previousSharedTeamSlugs: [],
          globalUserAccess: source.visibility === "global",
          previousGlobalUserAccess: false,
        });
      } catch (rollbackError) {
        console.error(
          `[rag/sources/${sourceId}] failed to restore source policy after delete failure`,
          rollbackError,
        );
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        "Failed to delete source",
        500,
        "SOURCE_DELETE_FAILED",
      );
    }

    return successResponse({ deleted: sourceId });
  },
);
