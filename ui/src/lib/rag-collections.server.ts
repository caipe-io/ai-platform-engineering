import { getCollection } from "@/lib/mongodb";
import { reconcileTupleDiff } from "@/lib/authz";
import {
  checkOpenFgaTuple,
  readOpenFgaTuples,
  type OpenFgaTupleKey,
} from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import {
  EVERYONE_TEAM_SLUG,
  SUPER_ADMINS_TEAM_SLUG,
} from "@/lib/rbac/reserved-teams";
import type {
  RagCollection,
  RagCollectionMembershipLabel,
} from "@/types/rag-collection";
import {
  PLATFORM_RAG_COLLECTION_ID,
  RAG_COLLECTIONS_COLLECTION,
  RAG_COLLECTION_ID_PATTERN,
} from "@/types/rag-collection";
import {
  filterResourcesByPermission,
  type ResourceAuthzSession,
} from "@/lib/rbac/resource-authz";
import {
  isEveryoneKnowledgeAudience,
  reconcileExistingUnlinkedKnowledgeAccess,
  withUnlinkedEveryoneKnowledgeAccess,
} from "@/lib/rbac/unlinked-knowledge-access";

export { RAG_COLLECTIONS_COLLECTION, RAG_COLLECTION_ID_PATTERN };
const PLATFORM_RAG_BOOTSTRAP_SUBJECT = "platform";

/** Build a Mongo `$set` document without the immutable `_id` field. */
export function ragCollectionSetFields(
  value: RagCollection,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, fieldValue]) => key !== "_id" && fieldValue !== undefined,
    ),
  );
}

function unique(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function tupleKey(tuple: OpenFgaTupleKey): string {
  return `${tuple.user}\n${tuple.relation}\n${tuple.object}`;
}

export function collectionRelationshipTuples(
  collection: Pick<
    RagCollection,
    | "_id"
    | "owner_subject"
    | "maintainer_team_slugs"
    | "reader_team_slugs"
    | "global_read"
    | "created_by"
  >,
): OpenFgaTupleKey[] {
  const object = `rag_collection:${collection._id}`;
  const tuples: OpenFgaTupleKey[] = [
    { user: `user:${collection.created_by}`, relation: "creator", object },
  ];
  if (collection.owner_subject) {
    tuples.push(
      { user: `user:${collection.owner_subject}`, relation: "owner", object },
      // A personal collection is immediately usable by its owner. This is an
      // explicit query grant, separate from the owner relation used to manage
      // collection settings.
      { user: `user:${collection.owner_subject}`, relation: "reader", object },
    );
  }
  for (const slug of unique(collection.maintainer_team_slugs)) {
    tuples.push(
      { user: `team:${slug}#member`, relation: "publisher", object },
      { user: `team:${slug}#admin`, relation: "manager", object },
    );
  }
  for (const slug of unique(collection.reader_team_slugs)) {
    tuples.push({ user: `team:${slug}#member`, relation: "reader", object });
  }
  if (collection.global_read) {
    tuples.push({ user: "user:*", relation: "reader", object });
  }
  return tuples;
}

export function collectionMembershipTuple(
  collectionId: string,
  datasourceId: string,
): OpenFgaTupleKey {
  return {
    user: `rag_collection:${collectionId}`,
    relation: "parent_collection",
    object: `knowledge_base:${datasourceId}`,
  };
}

export async function reconcileCollectionRelationships(
  previous: RagCollection | null,
  next: RagCollection | null,
): Promise<void> {
  const previousByKey = new Map(
    (previous ? collectionRelationshipTuples(previous) : []).map((tuple) => [
      tupleKey(tuple),
      tuple,
    ]),
  );
  const nextByKey = new Map(
    (next ? collectionRelationshipTuples(next) : []).map((tuple) => [
      tupleKey(tuple),
      tuple,
    ]),
  );
  const previousEveryoneAccess =
    Boolean(previous?.global_read) ||
    isEveryoneKnowledgeAudience(previous?.reader_team_slugs);
  const nextEveryoneAccess =
    Boolean(next?.global_read) ||
    isEveryoneKnowledgeAudience(next?.reader_team_slugs);
  const diff = await withUnlinkedEveryoneKnowledgeAccess(
    {
      type: "collection",
      id: next?._id ?? previous?._id ?? "",
      previousEveryoneAccess,
      nextEveryoneAccess,
    },
    {
      writes: [...nextByKey]
        .filter(([key]) => !previousByKey.has(key))
        .map(([, tuple]) => tuple),
      deletes: [...previousByKey]
        .filter(([key]) => !nextByKey.has(key))
        .map(([, tuple]) => tuple),
    },
  );
  await reconcileTupleDiff(
    diff,
    {
      source: "rag_collection_relationships",
    },
  );
  if (previousEveryoneAccess && !nextEveryoneAccess) {
    await reconcileExistingUnlinkedKnowledgeAccess();
  }
}

/** Ensure a collection Search team also has the coarse RAG feature gate. */
export async function ensureRagCollectionReaderTeamsCanSearch(
  readerTeamSlugs: readonly string[],
  actorSubject: string,
): Promise<void> {
  if (readerTeamSlugs.length === 0) return;
  // Additive by design: another collection or an explicit team capability may
  // still require this coarse gate after a reader is removed here.
  await reconcileTupleDiff(
    {
      writes: unique(readerTeamSlugs).map((slug) => ({
        user: `team:${slug}#member`,
        relation: "searcher",
        object: organizationObjectId(),
      })),
      deletes: [],
    },
    {
      caller: { type: "user", id: actorSubject },
      source: "rag_collection_reader_search_capability",
    },
  );
}

/** Create the built-in collection once and repair its current access projection. */
export async function bootstrapPlatformRagCollection(): Promise<RagCollection> {
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const now = new Date().toISOString();
  const initial: RagCollection = {
    _id: PLATFORM_RAG_COLLECTION_ID,
    name: "Platform RAG",
    description: "Shared organization knowledge available to agents by default.",
    is_platform: true,
    source_ids: [],
    owner_subject: undefined,
    maintainer_team_slugs: [SUPER_ADMINS_TEAM_SLUG],
    reader_team_slugs: [EVERYONE_TEAM_SLUG],
    global_read: false,
    created_by: PLATFORM_RAG_BOOTSTRAP_SUBJECT,
    created_at: now,
    updated_at: now,
  };

  await collection.updateOne(
    { _id: PLATFORM_RAG_COLLECTION_ID } as never,
    { $setOnInsert: ragCollectionSetFields(initial) },
    { upsert: true },
  );
  const stored = await collection.findOne({
    _id: PLATFORM_RAG_COLLECTION_ID,
  } as never);
  if (!stored) {
    throw new Error("Platform RAG was not available after bootstrap");
  }

  await reconcileCollectionRelationships(null, stored);
  await ensureRagCollectionReaderTeamsCanSearch(
    stored.reader_team_slugs,
    PLATFORM_RAG_BOOTSTRAP_SUBJECT,
  );
  return stored;
}

export async function replaceCollectionSources(
  collectionId: string,
  nextSourceIds: readonly string[],
): Promise<RagCollection> {
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const previous = await collection.findOne({ _id: collectionId } as never);
  if (!previous) throw new Error("RAG collection not found");

  const nextIds = unique(nextSourceIds);
  const previousIds = new Set(previous.source_ids ?? []);
  const nextSet = new Set(nextIds);
  const writes = nextIds
    .filter((id) => !previousIds.has(id))
    .map((id) => collectionMembershipTuple(collectionId, id));
  const deletes = [...previousIds]
    .filter((id) => !nextSet.has(id))
    .map((id) => collectionMembershipTuple(collectionId, id));

  await reconcileTupleDiff(
    { writes, deletes },
    { source: "rag_collection_membership" },
  );
  const updatedAt = new Date().toISOString();
  try {
    const result = await collection.updateOne({ _id: collectionId } as never, {
      $set: { source_ids: nextIds, updated_at: updatedAt },
    });
    if (result.matchedCount !== 1) {
      throw new Error("RAG collection disappeared while updating membership");
    }
  } catch (error) {
    // Membership is control-plane state. Roll back the tuple projection if
    // Mongo fails so agents and the collection UI cannot disagree.
    await reconcileTupleDiff(
      { writes: deletes, deletes: writes },
      { source: "rag_collection_membership_rollback" },
    ).catch(() => {});
    throw error;
  }
  return { ...previous, source_ids: nextIds, updated_at: updatedAt };
}

export async function ensurePlatformRagCollection(input: {
  actorSubject: string;
  maintainerTeamSlugs: string[];
  readerTeamSlugs: string[];
  sourceIds?: string[];
  /** Preserve manually-added Platform RAG members while adopting legacy data. */
  mergeSourceIds?: boolean;
}): Promise<RagCollection> {
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const previous = await collection.findOne({
    _id: PLATFORM_RAG_COLLECTION_ID,
  } as never);
  const now = new Date().toISOString();
  const next: RagCollection = {
    _id: PLATFORM_RAG_COLLECTION_ID,
    name: "Platform RAG",
    description:
      "Trusted organization-wide knowledge, automatically available to agents by default.",
    is_platform: true,
    source_ids: unique(
      input.sourceIds
        ? [
            ...(input.mergeSourceIds ? (previous?.source_ids ?? []) : []),
            ...input.sourceIds,
          ]
        : (previous?.source_ids ?? []),
    ),
    owner_subject: undefined,
    maintainer_team_slugs: unique(input.maintainerTeamSlugs),
    reader_team_slugs: unique(input.readerTeamSlugs),
    global_read: false,
    created_by: previous?.created_by ?? input.actorSubject,
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };

  await reconcileCollectionRelationships(previous, next);
  const persisted = input.sourceIds
    ? { ...next, source_ids: previous?.source_ids ?? [] }
    : next;
  try {
    await collection.updateOne(
      { _id: PLATFORM_RAG_COLLECTION_ID } as never,
      {
        $set: ragCollectionSetFields(persisted),
        $unset: { owner_subject: "" },
      },
      { upsert: true },
    );
  } catch (error) {
    if (previous) {
      await reconcileCollectionRelationships(next, previous).catch(() => {});
    } else {
      await reconcileCollectionRelationships(next, null).catch(() => {});
    }
    throw error;
  }
  if (input.sourceIds) {
    try {
      return await replaceCollectionSources(
        PLATFORM_RAG_COLLECTION_ID,
        next.source_ids,
      );
    } catch (error) {
      if (previous) {
        await collection
          .replaceOne({ _id: PLATFORM_RAG_COLLECTION_ID } as never, previous)
          .catch(() => {});
        await reconcileCollectionRelationships(next, previous).catch(() => {});
      } else {
        await collection
          .deleteOne({ _id: PLATFORM_RAG_COLLECTION_ID } as never)
          .catch(() => {});
        await reconcileCollectionRelationships(next, null).catch(() => {});
      }
      throw error;
    }
  }
  return next;
}

export async function canPublishCollection(
  subject: string,
  collectionId: string,
): Promise<boolean> {
  return (
    await checkOpenFgaTuple({
      user: subject,
      relation: "can_publish",
      object: `rag_collection:${collectionId}`,
    })
  ).allowed;
}

export interface DatasourceCollectionAudience {
  collectionIds: string[];
  readerTeamSlugs: string[];
  hasExternalPrincipal: boolean;
  organizationWide: boolean;
}

/**
 * Resolve direct collection readers that currently inherit Search for a source.
 *
 * This reads the live OpenFGA projection rather than trusting Mongo labels, so
 * direct people, service accounts, chat surfaces, and typed wildcards are not
 * missed when a material source change is evaluated for publication review.
 */
export async function datasourceCollectionAudience(
  datasourceId: string,
  owner: { ownerTeamSlug?: string | null; ownerSubject?: string | null },
): Promise<DatasourceCollectionAudience> {
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const rows = await collection
    .find({ source_ids: datasourceId } as never)
    .project({ _id: 1 })
    .toArray();
  const collectionIds = rows.map((row) => String(row._id));
  const readerTeamSlugs = new Set<string>();
  let hasExternalPrincipal = false;
  let organizationWide = false;

  for (const collectionId of collectionIds) {
    let continuationToken: string | undefined;
    do {
      const page = await readOpenFgaTuples({
        tuple: {
          relation: "reader",
          object: `rag_collection:${collectionId}`,
        },
        continuationToken,
      });
      for (const tuple of page.tuples) {
        const principal = tuple.key.user;
        if (principal === "user:*") {
          organizationWide = true;
          hasExternalPrincipal = true;
          continue;
        }
        const team = /^team:([^#]+)#(?:member|admin)$/.exec(principal)?.[1];
        if (team) {
          readerTeamSlugs.add(team);
          continue;
        }
        if (
          owner.ownerSubject &&
          principal === `user:${owner.ownerSubject}`
        ) {
          continue;
        }
        hasExternalPrincipal = true;
      }
      continuationToken = page.continuationToken;
    } while (continuationToken);
  }

  return {
    collectionIds,
    readerTeamSlugs: [...readerTeamSlugs].sort(),
    hasExternalPrincipal,
    organizationWide,
  };
}

/**
 * Resolve which datasource ids the caller may publish into a collection.
 *
 * DB-backed sources use the independent ingestion_source management graph.
 * Legacy sources that have no source-config row fall back to the historical
 * data_source management relation. This prevents a query-policy manager from
 * publishing a mutable connector that is managed by somebody else.
 */
export async function manageableDatasourceIdsForCollectionPublishing(
  session: ResourceAuthzSession,
  datasourceIds: readonly string[],
): Promise<Set<string>> {
  const ids = unique(datasourceIds);
  if (ids.length === 0) return new Set();

  const sourceConfigs = await getCollection<{ source_id: string }>(
    "rag_ingestion_sources",
  );
  const configuredRows = await sourceConfigs
    .find({ source_id: { $in: ids } } as never)
    .project({ _id: 0, source_id: 1 })
    .toArray();
  const configuredIds = new Set(configuredRows.map((row) => row.source_id));
  const legacyRows = ids
    .filter((id) => !configuredIds.has(id))
    .map((source_id) => ({ source_id }));

  const [managedConfigured, managedLegacy] = await Promise.all([
    filterResourcesByPermission(
      session,
      configuredRows,
      {
        type: "ingestion_source",
        action: "manage",
        id: (row) => row.source_id,
      },
      { bypassForOrgAdmin: true },
    ),
    filterResourcesByPermission(
      session,
      legacyRows,
      { type: "data_source", action: "manage", id: (row) => row.source_id },
      { bypassForOrgAdmin: true },
    ),
  ]);

  return new Set(
    [...managedConfigured, ...managedLegacy].map((row) => row.source_id),
  );
}

export async function deleteCollectionMemberships(
  collection: RagCollection,
): Promise<void> {
  await reconcileTupleDiff(
    {
      writes: [],
      deletes: (collection.source_ids ?? []).map((id) =>
        collectionMembershipTuple(collection._id, id),
      ),
    },
    { source: "rag_collection_membership_delete" },
  );
}

/** Remove a deleted datasource from every collection and its tuple projection. */
export async function removeDatasourceFromRagCollections(
  datasourceId: string,
): Promise<string[]> {
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const affected = await collection
    .find({ source_ids: datasourceId } as never)
    .project({ _id: 1 })
    .toArray();
  if (affected.length === 0) return [];

  const tuples = affected.map((item) =>
    collectionMembershipTuple(String(item._id), datasourceId),
  );
  await reconcileTupleDiff(
    { writes: [], deletes: tuples },
    { source: "rag_collection_datasource_delete" },
  );
  try {
    await collection.updateMany(
      { _id: { $in: affected.map((item) => item._id) } } as never,
      {
        $pull: { source_ids: datasourceId },
        $set: { updated_at: new Date().toISOString() },
      } as never,
    );
  } catch (error) {
    await reconcileTupleDiff(
      { writes: tuples, deletes: [] },
      { source: "rag_collection_datasource_delete_rollback" },
    ).catch(() => {});
    throw error;
  }
  return affected.map((item) => String(item._id));
}

/**
 * Remove a retired datasource from explicit agent pins.
 *
 * A missing datasource is already fail-closed at query time, but retaining its
 * deterministic id on an agent could silently re-enable that source if another
 * connector is later created with the same id. Run this while deleting the
 * datasource policy so a failed cleanup is retryable before access is retired.
 */
export async function removeDatasourceFromAgentPins(
  datasourceId: string,
): Promise<number> {
  const agents = await getCollection<Record<string, unknown>>("dynamic_agents");
  const result = await agents.updateMany(
    { datasource_ids: datasourceId } as never,
    {
      $pull: { datasource_ids: datasourceId },
      $set: { updated_at: new Date().toISOString() },
    } as never,
  );
  return result.modifiedCount;
}

/**
 * Remove a retired collection id from every agent hand.
 *
 * Collection ids are reusable user-facing slugs. Cleaning before a slug is
 * created as well as after deletion prevents an interrupted delete from
 * making a later collection with the same id silently appear on old agents.
 */
export async function removeRagCollectionFromAgentPins(
  collectionId: string,
): Promise<number> {
  const agents = await getCollection<Record<string, unknown>>("dynamic_agents");
  const result = await agents.updateMany(
    { rag_collection_ids: collectionId } as never,
    {
      $pull: { rag_collection_ids: collectionId },
      $set: { updated_at: new Date().toISOString() },
    } as never,
  );
  return result.modifiedCount;
}

/** Visible collection labels grouped by datasource for datasource-list badges. */
export async function visibleRagCollectionsByDatasource(
  session: ResourceAuthzSession,
  datasourceIds: readonly string[],
): Promise<Map<string, RagCollectionMembershipLabel[]>> {
  const result = new Map<string, RagCollectionMembershipLabel[]>();
  const ids = unique(datasourceIds);
  if (ids.length === 0) return result;
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const candidates = await collection
    .find({ source_ids: { $in: ids } } as never)
    .toArray();
  const visible = await filterResourcesByPermission(
    session,
    candidates,
    { type: "rag_collection", action: "discover", id: (row) => row._id },
    { bypassForOrgAdmin: true },
  );
  const idSet = new Set(ids);
  for (const ragCollection of visible) {
    const label: RagCollectionMembershipLabel = {
      id: ragCollection._id,
      name: ragCollection.name,
      is_platform: ragCollection.is_platform,
      reader_team_slugs: ragCollection.reader_team_slugs ?? [],
    };
    for (const datasourceId of ragCollection.source_ids ?? []) {
      if (!idSet.has(datasourceId)) continue;
      result.set(datasourceId, [...(result.get(datasourceId) ?? []), label]);
    }
  }
  return result;
}
