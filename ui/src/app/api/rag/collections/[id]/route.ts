import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { reconcileTupleDiff } from "@/lib/authz";
import { getCollection } from "@/lib/mongodb";
import {
  createPublicationRequest,
  invalidatePublicationRequests,
  publicationActorFromSession,
  recordAutoApprovedPublication,
} from "@/lib/publication-approval.server";
import {
  applyRagCollectionPublicationState,
  prepareRagCollectionPublication,
  ragCollectionPublicationState,
  ragCollectionSourceDependencyRevisions,
} from "@/lib/rag-collection-publication-approval.server";
import { batchCheckOpenFgaTuples } from "@/lib/rbac/openfga";
import {
  collectionMembershipTuple,
  collectionRelationshipTuples,
  manageableDatasourceIdsForCollectionPublishing,
  ragCollectionSetFields,
  RAG_COLLECTION_ID_PATTERN,
  RAG_COLLECTIONS_COLLECTION,
  removeRagCollectionFromAgentPins,
  reconcileCollectionRelationships,
  replaceCollectionSources,
} from "@/lib/rag-collections.server";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import {
  filterResourcesByPermission,
  requireResourcePermission,
  subjectFromSession,
} from "@/lib/rbac/resource-authz";
import type { RagCollection } from "@/types/rag-collection";
import type { Team } from "@/types/teams";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_COLLECTION_SOURCES = 2_000;
const MAX_COLLECTION_TEAMS = 100;
const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStringList(
  value: unknown,
  field: string,
  validateId = false,
): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(
      `${field} must be an array`,
      400,
      "INVALID_COLLECTION_UPDATE",
    );
  }
  const values = value.map((item) => normalizeString(item));
  if (
    values.some(
      (item) => !item || (validateId && !OPENFGA_ID_PATTERN.test(item)),
    )
  ) {
    throw new ApiError(
      `${field} must contain valid ids`,
      400,
      "INVALID_COLLECTION_UPDATE",
    );
  }
  return Array.from(new Set(values as string[]));
}

async function loadCollection(id: string): Promise<RagCollection> {
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const doc = await collection.findOne({ _id: id } as never);
  if (!doc)
    throw new ApiError("Knowledge base not found", 404, "COLLECTION_NOT_FOUND");
  return doc;
}

function requireCollectionId(id: string): void {
  if (!RAG_COLLECTION_ID_PATTERN.test(id)) {
    throw new ApiError(
      "Knowledge base id is invalid",
      400,
      "INVALID_COLLECTION_ID",
    );
  }
}

async function requireExistingTeams(
  teamSlugs: readonly string[],
): Promise<void> {
  const uniqueSlugs = Array.from(new Set(teamSlugs));
  if (uniqueSlugs.length === 0) return;
  const teams = await getCollection<Team>("teams");
  const existing = await teams
    .find({ slug: { $in: uniqueSlugs } } as never)
    .project({ slug: 1 })
    .toArray();
  const existingSlugs = new Set(existing.map((team) => team.slug));
  if (uniqueSlugs.some((slug) => !existingSlugs.has(slug))) {
    throw new ApiError(
      "One or more collection teams do not exist",
      404,
      "TEAM_NOT_FOUND",
    );
  }
}

async function requireExistingDatasources(
  session: { accessToken?: string; org?: string },
  datasourceIds: readonly string[],
): Promise<void> {
  const ids = Array.from(new Set(datasourceIds));
  if (ids.length === 0) return;

  // A DB-backed source may exist before its first ingestion job completes, so
  // Mongo is one valid source of existence. Legacy/env sources are discovered
  // from the RAG registry using the caller's token. The registry list includes
  // management-only sources but remains RBAC-filtered for non-admin callers.
  const sourceConfigs = await getCollection<{ source_id: string }>(
    "rag_ingestion_sources",
  );
  const configured = await sourceConfigs
    .find({ source_id: { $in: ids } } as never)
    .project({ _id: 0, source_id: 1 })
    .toArray();
  const existing = new Set(configured.map((row) => row.source_id));
  const unresolved = ids.filter((id) => !existing.has(id));
  if (unresolved.length === 0) return;

  if (!session.accessToken) {
    throw new ApiError(
      "A Keycloak access token is required to verify legacy datasources",
      401,
      "DATASOURCE_VERIFICATION_TOKEN_REQUIRED",
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
  };
  if (session.org) headers["X-Tenant-Id"] = session.org;

  let response: Response;
  try {
    response = await fetch(`${getRagServerUrl()}/v1/datasources`, {
      method: "GET",
      headers,
    });
  } catch {
    throw new ApiError(
      "The RAG datasource registry is unavailable",
      503,
      "DATASOURCE_REGISTRY_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      `The RAG datasource registry could not be read (${response.status})`,
      response.status === 401 || response.status === 403
        ? response.status
        : 502,
      "DATASOURCE_REGISTRY_FAILED",
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    datasources?: Array<{ datasource_id?: unknown }>;
  } | null;
  if (!payload || !Array.isArray(payload.datasources)) {
    throw new ApiError(
      "The RAG datasource registry returned an invalid response",
      502,
      "DATASOURCE_REGISTRY_INVALID",
    );
  }
  for (const row of payload.datasources) {
    if (typeof row?.datasource_id === "string") existing.add(row.datasource_id);
  }
  const missing = ids.filter((id) => !existing.has(id));
  if (missing.length > 0) {
    throw new ApiError(
      `These datasources do not exist or are not visible to you: ${missing.join(", ")}`,
      404,
      "DATASOURCE_NOT_FOUND",
    );
  }
}

async function requireManage(
  session: Parameters<typeof requireResourcePermission>[0],
  id: string,
): Promise<void> {
  await requireResourcePermission(
    session,
    { type: "rag_collection", id, action: "manage" },
    { bypassForOrgAdmin: true },
  );
}

function requireHumanCollectionEditor(session: {
  isServiceAccount?: boolean;
}): void {
  if (session.isServiceAccount === true) {
    throw new ApiError(
      "Service accounts cannot modify knowledge-base collections",
      403,
      "SERVICE_ACCOUNT_COLLECTION_MUTATION_FORBIDDEN",
    );
  }
}

export const GET = withErrorHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { id } = await context.params;
    requireCollectionId(id);
    const { session } = await getAuthFromBearerOrSession(request);
    await requireResourcePermission(
      session,
      { type: "rag_collection", id, action: "discover" },
      { bypassForOrgAdmin: true },
    );
    return successResponse(await loadCollection(id));
  },
);

export const PATCH = withErrorHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { id } = await context.params;
    requireCollectionId(id);
    const { session } = await getAuthFromBearerOrSession(request);
    requireHumanCollectionEditor(session);
    const previous = await loadCollection(id);
    const raw = await request.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError("Request body must be an object", 400, "INVALID_BODY");
    }
    const body = raw as Record<string, unknown>;
    const hasSources = Object.prototype.hasOwnProperty.call(body, "source_ids");
    const hasOwnerChange = Object.prototype.hasOwnProperty.call(
      body,
      "maintainer_team_slugs",
    );
    const hasSearchChange = ["reader_team_slugs", "global_read"].some(
      (field) => Object.prototype.hasOwnProperty.call(body, field),
    );
    const hasDelegation = hasOwnerChange || hasSearchChange;
    const hasMetadata = ["name", "description"].some((field) =>
      Object.prototype.hasOwnProperty.call(body, field),
    );
    if (!hasSources && !hasDelegation && !hasMetadata)
      return successResponse(previous);

    if (hasMetadata || hasDelegation) await requireManage(session, id);
    if (hasOwnerChange && !(await hasOrganizationAdmin(session))) {
      throw new ApiError(
        "Only an organization administrator can change collection Owner teams",
        403,
        "COLLECTION_DELEGATION_FORBIDDEN",
      );
    }

    const nextMaintainerTeamSlugs = Object.prototype.hasOwnProperty.call(
      body,
      "maintainer_team_slugs",
    )
      ? normalizeStringList(
          body.maintainer_team_slugs,
          "maintainer_team_slugs",
          true,
        )
      : (previous.maintainer_team_slugs ?? []);
    const nextReaderTeamSlugs = Object.prototype.hasOwnProperty.call(
      body,
      "reader_team_slugs",
    )
      ? normalizeStringList(body.reader_team_slugs, "reader_team_slugs", true)
      : (previous.reader_team_slugs ?? []);
    if (
      nextMaintainerTeamSlugs.length > MAX_COLLECTION_TEAMS ||
      nextReaderTeamSlugs.length > MAX_COLLECTION_TEAMS
    ) {
      throw new ApiError(
        `A knowledge base may have at most ${MAX_COLLECTION_TEAMS} Owner teams and ${MAX_COLLECTION_TEAMS} Search teams`,
        400,
        "TOO_MANY_COLLECTION_TEAMS",
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(body, "global_read") &&
      typeof body.global_read !== "boolean"
    ) {
      throw new ApiError(
        "global_read must be a boolean",
        400,
        "INVALID_GLOBAL_READ",
      );
    }
    if (hasDelegation) {
      await requireExistingTeams([
        ...nextMaintainerTeamSlugs,
        ...nextReaderTeamSlugs,
      ]);
    }

    let sourceIds = previous.source_ids;
    if (hasSources) {
      const subject = subjectFromSession(session);
      if (!subject)
        throw new ApiError("A stable subject is required", 401, "NO_SUBJECT");
      const canPublish = await filterResourcesByPermission(
        session,
        [{ id }],
        { type: "rag_collection", action: "write", id: (row) => row.id },
        { bypassForOrgAdmin: true },
      );
      if (canPublish.length === 0) {
        throw new ApiError(
          "You cannot add datasources to this knowledge base",
          403,
          "COLLECTION_PUBLISH_FORBIDDEN",
        );
      }
      sourceIds = normalizeStringList(body.source_ids, "source_ids", true);
      if (sourceIds.length > MAX_COLLECTION_SOURCES) {
        throw new ApiError(
          `A knowledge base may contain at most ${MAX_COLLECTION_SOURCES} datasources`,
          400,
          "TOO_MANY_COLLECTION_SOURCES",
        );
      }
      const additions = sourceIds.filter(
        (sourceId) => !(previous.source_ids ?? []).includes(sourceId),
      );
      await requireExistingDatasources(session, additions);
      // Publishing a search-only source controlled by somebody else would let
      // an untrusted owner mutate already-approved content later. Require source
      // management authority for additions; removals need only collection publish.
      const manageableIds =
        await manageableDatasourceIdsForCollectionPublishing(
          session,
          additions,
        );
      const denied = additions.filter(
        (sourceId) => !manageableIds.has(sourceId),
      );
      if (denied.length > 0) {
        throw new ApiError(
          `You must be able to manage a datasource before adding it: ${denied.join(", ")}`,
          403,
          "DATASOURCE_PUBLISH_FORBIDDEN",
        );
      }

      // A personal owner is an explicit collection reader, even after teams
      // are delegated. Validate against that owner rather than the editor so
      // an administrator or Owner cannot turn source-management access
      // into content access for somebody else through collection membership.
      if (previous.owner_subject && additions.length > 0) {
        const ownerReadDecisions = await batchCheckOpenFgaTuples(
          additions.map((sourceId) => ({
            user: `user:${previous.owner_subject}`,
            relation: "can_read",
            object: `data_source:${sourceId}`,
          })),
        );
        const unreadable = additions.filter(
          (_sourceId, index) => ownerReadDecisions[index] !== true,
        );
        if (unreadable.length > 0) {
          throw new ApiError(
            `A personally owned knowledge base can only include datasources its owner can already search: ${unreadable.join(", ")}`,
            403,
            "DATASOURCE_READ_REQUIRED",
          );
        }
      }
    }

    const now = new Date().toISOString();
    const nextName = Object.prototype.hasOwnProperty.call(body, "name")
      ? normalizeString(body.name)
      : previous.name;
    if (!nextName || nextName.length > 80) {
      throw new ApiError(
        "name must be between 1 and 80 characters",
        400,
        "INVALID_NAME",
      );
    }
    const nextDescription = Object.prototype.hasOwnProperty.call(
      body,
      "description",
    )
      ? (normalizeString(body.description) ?? undefined)
      : previous.description;
    if (nextDescription && nextDescription.length > 500) {
      throw new ApiError(
        "description may not exceed 500 characters",
        400,
        "INVALID_DESCRIPTION",
      );
    }
    const requestedNext: RagCollection = {
      ...previous,
      name: nextName,
      description: nextDescription,
      maintainer_team_slugs: nextMaintainerTeamSlugs,
      reader_team_slugs: nextReaderTeamSlugs,
      ...(Object.prototype.hasOwnProperty.call(body, "global_read")
        ? { global_read: body.global_read === true }
        : {}),
      source_ids: sourceIds,
      updated_at: now,
    };
    const ownershipChanged =
      JSON.stringify([...(previous.maintainer_team_slugs ?? [])].sort()) !==
      JSON.stringify([...nextMaintainerTeamSlugs].sort());
    const hasPublicationChange = hasSources || hasSearchChange || ownershipChanged;
    const publication = hasPublicationChange
      ? await prepareRagCollectionPublication({
          session,
          collection: requestedNext,
          currentState: ragCollectionPublicationState(previous),
          requestedState: ragCollectionPublicationState(requestedNext),
        })
      : null;
    if (publication) {
      await invalidatePublicationRequests(
        publication.resource,
        publication.actor,
        "A newer knowledge-base change replaced this publication proposal.",
      );
    }
    const effectiveState = publication
      ? publication.plan.effective_state as unknown as ReturnType<
          typeof ragCollectionPublicationState
        >
      : ragCollectionPublicationState(previous);
    const baseNext: RagCollection = {
      ...requestedNext,
      maintainer_team_slugs: effectiveState.maintainer_team_slugs,
      reader_team_slugs: previous.reader_team_slugs ?? [],
      global_read: previous.global_read === true,
      source_ids: previous.source_ids ?? [],
    };
    const collection = await getCollection<RagCollection>(
      RAG_COLLECTIONS_COLLECTION,
    );
    let lastApplied = baseNext;
    await reconcileCollectionRelationships(previous, baseNext);
    try {
      const metadataUpdate = await collection.updateOne({ _id: id } as never, {
        $set: ragCollectionSetFields(baseNext),
      });
      if (metadataUpdate.matchedCount !== 1) {
        throw new Error("RAG collection disappeared while updating settings");
      }

      if (!publication) return successResponse(baseNext);
      const updated = await applyRagCollectionPublicationState({
        previous: baseNext,
        nextState: effectiveState,
        actorSubject: publication.actor.subject,
      });
      lastApplied = updated;

      let publicationRequest: Awaited<ReturnType<typeof createPublicationRequest>> | null = null;
      if (publication.plan.requires_approval) {
        const requestedSourceIds = publication.requestedState.source_ids;
        const sourceDependencyRevisions =
          await ragCollectionSourceDependencyRevisions(requestedSourceIds);
        publicationRequest = await createPublicationRequest({
          resource: publication.resource,
          resourceRevision: publication.resourceRevision,
          requestedState: {
            ...publication.requestedState,
            source_dependency_revisions: sourceDependencyRevisions,
          } as unknown as Record<string, unknown>,
          effectiveState: publication.plan.effective_state,
          riskFacts: publication.plan.risk_facts,
          requester: publication.actor,
          requesterTeamSlugs: publication.requesterTeamSlugs,
          approverTeamSlugs: publication.plan.approver_team_slugs,
          approverUserSubjects: publication.plan.approver_user_subjects,
        });
      } else {
        await recordAutoApprovedPublication({
          resource: publication.resource,
          resourceRevision: publication.resourceRevision,
          requestedState: publication.requestedState as unknown as Record<string, unknown>,
          effectiveState: publication.requestedState as unknown as Record<string, unknown>,
          riskFacts: publication.plan.risk_facts,
          requester: publication.actor,
          requesterTeamSlugs: publication.requesterTeamSlugs,
          approverTeamSlugs: publication.plan.approver_team_slugs,
          approverUserSubjects: publication.plan.approver_user_subjects,
        });
      }
      return successResponse(
        {
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
        },
        publicationRequest ? 202 : 200,
      );
    } catch (error) {
      // Keep Mongo and OpenFGA on the previous effective state if either the
      // metadata update or membership projection fails. Membership replacement
      // performs its own tuple rollback; this restores the surrounding document
      // and delegation relationships for combined edits.
      if (
        JSON.stringify([...(lastApplied.source_ids ?? [])].sort()) !==
        JSON.stringify([...(previous.source_ids ?? [])].sort())
      ) {
        await replaceCollectionSources(id, previous.source_ids ?? []).catch(() => {});
      }
      await collection
        .replaceOne({ _id: id } as never, previous)
        .catch(() => {});
      await reconcileCollectionRelationships(lastApplied, previous).catch(() => {});
      throw error;
    }
  },
);

export const DELETE = withErrorHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { id } = await context.params;
    requireCollectionId(id);
    const { session } = await getAuthFromBearerOrSession(request);
    requireHumanCollectionEditor(session);
    const doc = await loadCollection(id);
    if (doc.is_platform) {
      throw new ApiError(
        "Platform RAG cannot be deleted",
        409,
        "PLATFORM_RAG_PROTECTED",
      );
    }
    await requireManage(session, id);
    await invalidatePublicationRequests(
      { kind: "rag_collection", id, label: doc.name },
      publicationActorFromSession(session),
      "The knowledge base was deleted before this proposal was approved.",
    );
    const deletedTuples = [
      ...(doc.source_ids ?? []).map((sourceId) =>
        collectionMembershipTuple(doc._id, sourceId),
      ),
      ...collectionRelationshipTuples(doc),
    ];
    await reconcileTupleDiff(
      { writes: [], deletes: deletedTuples },
      { source: "rag_collection_delete" },
    );
    const collection = await getCollection<RagCollection>(
      RAG_COLLECTIONS_COLLECTION,
    );
    try {
      await collection.deleteOne({ _id: id } as never);
    } catch (error) {
      await reconcileTupleDiff(
        { writes: deletedTuples, deletes: [] },
        { source: "rag_collection_delete_rollback" },
      ).catch(() => {});
      throw error;
    }

    // Deleted collection ids are fail-closed at runtime, but removing stale
    // references keeps every agent editor's visible hand accurate as well.
    let agentsUpdated = 0;
    try {
      agentsUpdated = await removeRagCollectionFromAgentPins(id);
    } catch (error) {
      // Runtime membership lookup is fail-closed when the collection document is
      // absent, so a cleanup outage cannot retain data access. Surface it in logs
      // without reporting that the already-completed collection deletion failed.
      console.error(
        "[rag-collections] failed to remove deleted collection from agents",
        error,
      );
    }
    return successResponse({ deleted: id, agents_updated: agentsUpdated });
  },
);
