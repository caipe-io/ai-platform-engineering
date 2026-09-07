import { reconcileTupleDiff } from "@/lib/authz";
import { organizationObjectId } from "@/lib/rbac/organization";
import {
  readOpenFgaTuples,
  type OpenFgaTupleKey,
  type TeamResourceTupleDiff,
} from "@/lib/rbac/openfga";
import { isEveryoneTeamSlug } from "@/lib/rbac/reserved-teams";
import { getUnlinkedServiceAccount } from "@/lib/rbac/unlinked-service-account";
import type { ServiceAccountScope } from "@/types/mongodb";

export type UnlinkedKnowledgeScopeType = "datasource" | "collection";

export interface EveryoneKnowledgeScopes {
  datasourceIds: Set<string>;
  collectionIds: Set<string>;
}

export interface UnlinkedKnowledgeReconcileResult {
  datasourceCount: number;
  collectionCount: number;
  writes: number;
  deletes: number;
}

function tupleKey(tuple: OpenFgaTupleKey): string {
  return `${tuple.user}\n${tuple.relation}\n${tuple.object}`;
}

function uniqueTuples(tuples: readonly OpenFgaTupleKey[]): OpenFgaTupleKey[] {
  return [...new Map(tuples.map((tuple) => [tupleKey(tuple), tuple])).values()];
}

function mergeTupleDiff(
  base: TeamResourceTupleDiff,
  extra: TeamResourceTupleDiff,
): TeamResourceTupleDiff {
  const writes = uniqueTuples([...base.writes, ...extra.writes]);
  const writeKeys = new Set(writes.map(tupleKey));
  return {
    writes,
    deletes: uniqueTuples([...base.deletes, ...extra.deletes]).filter(
      (tuple) => !writeKeys.has(tupleKey(tuple)),
    ),
  };
}

function scopeKey(type: UnlinkedKnowledgeScopeType, id: string): string {
  return `${type}:${id}`;
}

function explicitKnowledgeScopeKeys(
  scopes: readonly ServiceAccountScope[],
): Set<string> {
  return new Set(
    scopes
      .filter(
        (scope): scope is ServiceAccountScope & {
          type: UnlinkedKnowledgeScopeType;
        } => scope.type === "datasource" || scope.type === "collection",
      )
      .map((scope) => scopeKey(scope.type, scope.ref)),
  );
}

function automaticReaderTuple(input: {
  serviceAccountSub: string;
  type: UnlinkedKnowledgeScopeType;
  id: string;
}): OpenFgaTupleKey {
  // Explicit datasource scopes use data_source:<id>. The automatic Everyone
  // projection deliberately uses knowledge_base:<id>, which is inherited by
  // the datasource and keeps the two grants independently revocable.
  const object =
    input.type === "datasource"
      ? `knowledge_base:${input.id}`
      : `rag_collection:${input.id}`;
  return {
    user: `service_account:${input.serviceAccountSub}`,
    relation: "reader",
    object,
  };
}

export function isEveryoneKnowledgeAudience(
  teamSlugs: readonly string[] | null | undefined,
): boolean {
  return (teamSlugs ?? []).some((slug) => isEveryoneTeamSlug(slug));
}

/**
 * Add the unlinked identity projection to one effective Search-policy diff.
 * Publication requests call their normal reconciler only when approved, so a
 * pending request never reaches this helper.
 */
export async function withUnlinkedEveryoneKnowledgeAccess(
  input: {
    type: UnlinkedKnowledgeScopeType;
    id: string;
    previousEveryoneAccess: boolean;
    nextEveryoneAccess: boolean;
  },
  base: TeamResourceTupleDiff,
): Promise<TeamResourceTupleDiff> {
  if (!input.previousEveryoneAccess && !input.nextEveryoneAccess) return base;

  let serviceAccount: Awaited<ReturnType<typeof getUnlinkedServiceAccount>>;
  try {
    serviceAccount = await getUnlinkedServiceAccount();
  } catch (error) {
    console.warn(
      "[unlinked-knowledge-access] could not resolve the unlinked service account:",
      error,
    );
    return base;
  }
  if (!serviceAccount?.sa_sub) return base;

  const reader = automaticReaderTuple({
    serviceAccountSub: serviceAccount.sa_sub,
    type: input.type,
    id: input.id,
  });
  const explicitScopes = explicitKnowledgeScopeKeys(
    serviceAccount.scopes_snapshot ?? [],
  );
  // Collection auto/explicit grants share the same tuple and therefore need
  // origin-aware preservation. Datasource grants use distinct KB/data-source
  // objects, so the automatic KB tuple is always safe to remove.
  const explicitlyGranted =
    input.type === "collection" &&
    explicitScopes.has(scopeKey(input.type, input.id));
  const writes: OpenFgaTupleKey[] = [];
  const deletes: OpenFgaTupleKey[] = [];

  if (input.nextEveryoneAccess) {
    writes.push(
      reader,
      {
        user: `service_account:${serviceAccount.sa_sub}`,
        relation: "searcher",
        object: organizationObjectId(),
      },
    );
  } else if (input.previousEveryoneAccess && !explicitlyGranted) {
    deletes.push(reader);
  }

  return mergeTupleDiff(base, { writes, deletes });
}

async function readDirectReaderIds(
  user: string,
  objectType: "data_source" | "knowledge_base" | "rag_collection",
): Promise<Set<string>> {
  const ids = new Set<string>();
  let continuationToken: string | undefined;
  do {
    // OpenFGA Read accepts the object type followed by ':' as a type filter.
    // Keep the explicit startsWith check because mocked and older servers may
    // return a broader page.
    const prefix = `${objectType}:`;
    const page = await readOpenFgaTuples({
      tuple: { user, relation: "reader", object: prefix },
      continuationToken,
      pageSize: 100,
    });
    for (const { key } of page.tuples) {
      if (
        key.user === user &&
        key.relation === "reader" &&
        key.object.startsWith(prefix)
      ) {
        const id = key.object.slice(prefix.length);
        if (id) ids.add(id);
      }
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return ids;
}

/** Direct effective Search audiences that also apply to unlinked callers. */
export async function listEveryoneKnowledgeScopes(): Promise<EveryoneKnowledgeScopes> {
  const everyone = "team:everyone#member";
  const [teamDatasources, globalDatasources, teamCollections, globalCollections] =
    await Promise.all([
      readDirectReaderIds(everyone, "knowledge_base"),
      readDirectReaderIds("user:*", "knowledge_base"),
      readDirectReaderIds(everyone, "rag_collection"),
      readDirectReaderIds("user:*", "rag_collection"),
    ]);
  return {
    datasourceIds: new Set([...teamDatasources, ...globalDatasources]),
    collectionIds: new Set([...teamCollections, ...globalCollections]),
  };
}

/**
 * Startup/backfill sweep. It repairs automatic Everyone grants, removes stale
 * automatic grants, and preserves scopes explicitly assigned by an admin.
 */
export async function reconcileExistingUnlinkedKnowledgeAccess(): Promise<UnlinkedKnowledgeReconcileResult> {
  const serviceAccount = await getUnlinkedServiceAccount();
  if (!serviceAccount?.sa_sub) {
    return {
      datasourceCount: 0,
      collectionCount: 0,
      writes: 0,
      deletes: 0,
    };
  }

  const subject = `service_account:${serviceAccount.sa_sub}`;
  const [
    everyone,
    currentAutomaticDatasources,
    currentExplicitDatasources,
    currentCollections,
  ] = await Promise.all([
    listEveryoneKnowledgeScopes(),
    readDirectReaderIds(subject, "knowledge_base"),
    readDirectReaderIds(subject, "data_source"),
    readDirectReaderIds(subject, "rag_collection"),
  ]);
  const explicit = explicitKnowledgeScopeKeys(
    serviceAccount.scopes_snapshot ?? [],
  );
  const explicitDatasourceIds = new Set([
    ...currentExplicitDatasources,
    ...[...explicit]
      .filter((key) => key.startsWith("datasource:"))
      .map((key) => key.slice("datasource:".length)),
  ]);
  const explicitCollectionIds = new Set(
    [...explicit]
      .filter((key) => key.startsWith("collection:"))
      .map((key) => key.slice("collection:".length)),
  );
  const desiredCollectionIds = new Set([
    ...everyone.collectionIds,
    ...explicitCollectionIds,
  ]);
  const writes: OpenFgaTupleKey[] = [
    ...[...everyone.datasourceIds].map((id) =>
      automaticReaderTuple({
        serviceAccountSub: serviceAccount.sa_sub,
        type: "datasource",
        id,
      }),
    ),
    ...[...desiredCollectionIds].map((id) =>
      automaticReaderTuple({
        serviceAccountSub: serviceAccount.sa_sub,
        type: "collection",
        id,
      }),
    ),
    ...[...explicitDatasourceIds].map((id) => ({
      user: subject,
      relation: "reader",
      object: `data_source:${id}`,
    })),
  ];
  const hasKnowledgeAccess =
    everyone.datasourceIds.size > 0 ||
    desiredCollectionIds.size > 0 ||
    explicitDatasourceIds.size > 0;
  const searchCapability: OpenFgaTupleKey = {
    user: subject,
    relation: "searcher",
    object: organizationObjectId(),
  };
  if (hasKnowledgeAccess) writes.push(searchCapability);

  const deletes: OpenFgaTupleKey[] = [
    ...[...currentAutomaticDatasources]
      .filter((id) => !everyone.datasourceIds.has(id))
      .map((id) =>
        automaticReaderTuple({
          serviceAccountSub: serviceAccount.sa_sub,
          type: "datasource",
          id,
        }),
      ),
    ...[...currentCollections]
      .filter((id) => !desiredCollectionIds.has(id))
      .map((id) =>
        automaticReaderTuple({
          serviceAccountSub: serviceAccount.sa_sub,
          type: "collection",
          id,
        }),
      ),
    ...(!hasKnowledgeAccess ? [searchCapability] : []),
  ];

  const result = await reconcileTupleDiff(
    { writes: uniqueTuples(writes), deletes: uniqueTuples(deletes) },
    { source: "unlinked_everyone_knowledge_reconcile" },
  );
  return {
    datasourceCount: everyone.datasourceIds.size,
    collectionCount: everyone.collectionIds.size,
    writes: result.writes,
    deletes: result.deletes,
  };
}
