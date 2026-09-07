import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import {
  listPublicationActorTeamSlugs,
  planRagCollectionPublication,
  publicationActorFromSession,
  publicationResourceRevision,
  type PublicationSession,
  type RagCollectionPublicationState,
} from "@/lib/publication-approval.server";
import { getPublicationApprovalSettings } from "@/lib/publication-approval-settings";
import {
  ensureRagCollectionReaderTeamsCanSearch,
  ragCollectionSetFields,
  RAG_COLLECTIONS_COLLECTION,
  reconcileCollectionRelationships,
  replaceCollectionSources,
} from "@/lib/rag-collections.server";
import { ragDatasourcePublicationDependencyRevision } from "@/lib/rag-publication-approval.server";
import { readOpenFgaTuples } from "@/lib/rbac/openfga";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import type { RagCollection } from "@/types/rag-collection";
import type {
  PublicationActor,
  PublicationPolicyPlan,
  PublicationRequestDocument,
  PublicationResourceRef,
} from "@/types/publication-approval";

const MAX_COLLECTION_SOURCES = 2_000;
const MAX_COLLECTION_TEAMS = 100;

async function legacyDatasourceDependencyRevision(
  datasourceId: string,
): Promise<string | null> {
  const tuples: Array<{ user: string; relation: string; object: string }> = [];
  for (const object of [
    `ingestion_source:${datasourceId}`,
    `knowledge_base:${datasourceId}`,
    `data_source:${datasourceId}`,
  ]) {
    let continuationToken: string | undefined;
    do {
      const page = await readOpenFgaTuples({
        tuple: { object },
        continuationToken,
      });
      tuples.push(...page.tuples.map((tuple) => tuple.key));
      continuationToken = page.continuationToken;
    } while (continuationToken);
  }
  if (tuples.length === 0) return null;
  return publicationResourceRevision(
    tuples.sort((left, right) =>
      `${left.object}\n${left.relation}\n${left.user}`.localeCompare(
        `${right.object}\n${right.relation}\n${right.user}`,
      ),
    ),
  );
}

/** Snapshot material source state referenced by a collection proposal. */
export async function ragCollectionSourceDependencyRevisions(
  sourceIds: readonly string[],
): Promise<Record<string, string>> {
  const ids = strings(sourceIds);
  if (ids.length === 0) return {};
  const sources = await getCollection<IngestionSourceConfig>(
    "rag_ingestion_sources",
  );
  const rows = await sources
    .find({ source_id: { $in: ids } } as never)
    .toArray();
  const byId = new Map(rows.map((source) => [source.source_id, source]));
  const revisions: Record<string, string> = {};
  for (const id of ids) {
    const source = byId.get(id);
    const revision = source
      ? ragDatasourcePublicationDependencyRevision(source)
      : await legacyDatasourceDependencyRevision(id);
    if (!revision) {
      throw new ApiError(
        `Datasource ${id} no longer exists or has no authorization policy`,
        409,
        "PUBLICATION_REVISION_CONFLICT",
      );
    }
    revisions[id] = revision;
  }
  return revisions;
}

export interface PreparedRagCollectionPublication {
  actor: PublicationActor;
  requesterTeamSlugs: string[];
  requestedState: RagCollectionPublicationState;
  ownershipChange?: boolean;
  plan: PublicationPolicyPlan;
  resource: PublicationResourceRef;
  resourceRevision: string;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.flatMap((item) =>
        typeof item === "string" && item.trim() ? [item.trim()] : [],
      ),
    ),
  ).sort();
}

export function ragCollectionPublicationState(
  collection: Pick<
    RagCollection,
    "maintainer_team_slugs" | "reader_team_slugs" | "global_read" | "source_ids"
  >,
): RagCollectionPublicationState {
  return {
    maintainer_team_slugs: strings(collection.maintainer_team_slugs),
    reader_team_slugs: strings(collection.reader_team_slugs),
    global_read: collection.global_read === true,
    source_ids: strings(collection.source_ids),
  };
}

export function ragCollectionPublicationRevision(
  collection: Pick<RagCollection, "_id" | "owner_subject">,
  state: RagCollectionPublicationState,
): string {
  return publicationResourceRevision({
    collection_id: collection._id,
    owner_subject: collection.owner_subject ?? null,
    ...ragCollectionPublicationState(state),
  });
}

export async function prepareRagCollectionPublication(input: {
  session: PublicationSession;
  collection: RagCollection;
  currentState: RagCollectionPublicationState;
  requestedState: RagCollectionPublicationState;
  ownershipChange?: boolean;
}): Promise<PreparedRagCollectionPublication> {
  const actor = publicationActorFromSession(input.session);
  const [settings, requesterTeamSlugs] = await Promise.all([
    getPublicationApprovalSettings(),
    listPublicationActorTeamSlugs(actor),
  ]);
  const requestedState = ragCollectionPublicationState(input.requestedState);
  const plan = planRagCollectionPublication({
    settings,
    requester: actor,
    requesterTeamSlugs,
    currentState: ragCollectionPublicationState(input.currentState),
    requestedState,
  });
  return {
    actor,
    requesterTeamSlugs,
    requestedState,
    plan,
    resource: {
      kind: "rag_collection",
      id: input.collection._id,
      label: input.collection.name,
    },
    resourceRevision: ragCollectionPublicationRevision(
      input.collection,
      plan.effective_state as unknown as RagCollectionPublicationState,
    ),
  };
}

function requestState(
  request: PublicationRequestDocument,
): RagCollectionPublicationState {
  const state = {
    maintainer_team_slugs: strings(
      request.requested_state.maintainer_team_slugs,
    ),
    reader_team_slugs: strings(request.requested_state.reader_team_slugs),
    global_read: request.requested_state.global_read === true,
    source_ids: strings(request.requested_state.source_ids),
  };
  if (state.reader_team_slugs.length > MAX_COLLECTION_TEAMS) {
    throw new ApiError("The approved collection has too many Search teams", 409);
  }
  if (state.maintainer_team_slugs.length > MAX_COLLECTION_TEAMS) {
    throw new ApiError("The approved collection has too many Owner teams", 409);
  }
  if (state.source_ids.length > MAX_COLLECTION_SOURCES) {
    throw new ApiError("The approved collection has too many datasources", 409);
  }
  return state;
}

function requestDependencyRevisions(
  request: PublicationRequestDocument,
): Record<string, string> {
  const value = request.requested_state.source_dependency_revisions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      "This collection approval does not contain a source revision snapshot.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
  const revisions = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        Boolean(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1]),
    ),
  );
  const requestedIds = requestState(request).source_ids;
  if (requestedIds.some((id) => !revisions[id])) {
    throw new ApiError(
      "This collection approval has an incomplete source revision snapshot.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
  return revisions;
}

export async function applyRagCollectionPublicationState(input: {
  previous: RagCollection;
  nextState: RagCollectionPublicationState;
  actorSubject: string;
}): Promise<RagCollection> {
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const now = new Date().toISOString();
  const nextMetadata: RagCollection = {
    ...input.previous,
    maintainer_team_slugs: strings(input.nextState.maintainer_team_slugs),
    reader_team_slugs: strings(input.nextState.reader_team_slugs),
    global_read: input.nextState.global_read === true,
    // Membership projection is replaced separately so it can roll back its
    // own OpenFGA tuples before this surrounding document is restored.
    source_ids: input.previous.source_ids ?? [],
    updated_at: now,
  };

  await reconcileCollectionRelationships(input.previous, nextMetadata);
  try {
    const updated = await collection.updateOne(
      { _id: input.previous._id } as never,
      { $set: ragCollectionSetFields(nextMetadata) },
    );
    if (updated.matchedCount !== 1) {
      throw new Error("Knowledge base disappeared while applying publication");
    }
    await ensureRagCollectionReaderTeamsCanSearch(
      nextMetadata.reader_team_slugs,
      input.actorSubject,
    );
    return await replaceCollectionSources(
      input.previous._id,
      input.nextState.source_ids,
    );
  } catch (error) {
    await collection
      .replaceOne({ _id: input.previous._id } as never, input.previous)
      .catch(() => {});
    await reconcileCollectionRelationships(nextMetadata, input.previous).catch(
      () => {},
    );
    throw error;
  }
}

export async function applyRagCollectionPublicationRequest(
  request: PublicationRequestDocument,
  session: PublicationSession,
): Promise<void> {
  if (request.resource.kind !== "rag_collection") {
    throw new ApiError("The request is not a RAG collection publication", 400);
  }
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const current = await collection.findOne({ _id: request.resource.id } as never);
  if (!current) {
    throw new ApiError("Knowledge base no longer exists", 409, "PUBLICATION_REVISION_CONFLICT");
  }
  const currentState = ragCollectionPublicationState(current);
  const expectedDependencies = requestDependencyRevisions(request);
  const currentDependencies = await ragCollectionSourceDependencyRevisions(
    Object.keys(expectedDependencies),
  );
  if (
    publicationResourceRevision(currentDependencies) !==
    publicationResourceRevision(expectedDependencies)
  ) {
    throw new ApiError(
      "A datasource in this knowledge base changed after approval was requested.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
  if (ragCollectionPublicationRevision(current, currentState) !== request.resource_revision) {
    if (
      publicationResourceRevision(currentState) ===
      publicationResourceRevision(requestState(request))
    ) {
      return;
    }
    throw new ApiError(
      "This knowledge base changed after approval was requested. Review the newer request instead.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
  const actor = publicationActorFromSession(session);
  await applyRagCollectionPublicationState({
    previous: current,
    nextState: requestState(request),
    actorSubject: actor.subject,
  });
}
