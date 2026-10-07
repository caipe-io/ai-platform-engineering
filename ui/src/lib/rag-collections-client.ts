/**
 * Client-side helper shared by every "add datasources from a collection"
 * bulk-add control (Service Accounts admin panel, Unlinked Access modal).
 *
 * A collection grant is a search-time filter only (#2724 removed
 * `parent_collection`→`can_read` propagation) — it never grants content
 * access to member datasources. This resolves the collection's member
 * datasource ids so a caller can bulk-add the ones they can actually grant
 * as direct datasource scopes.
 */
export async function fetchCollectionMemberDatasourceIds(
  collectionId: string,
): Promise<string[]> {
  const res = await fetch(
    `/api/rag/collections/${encodeURIComponent(collectionId)}`,
  );
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.error ?? "Could not load collection");
  }
  return Array.isArray(data.data?.source_ids) ? data.data.source_ids : [];
}
