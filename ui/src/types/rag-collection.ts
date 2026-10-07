/**
 * Control-plane grouping for RAG datasources.
 *
 * Chunks remain stored once under datasource_id in Milvus. A collection only
 * groups those ids for reusable authorization and agent configuration.
 */

export const RAG_COLLECTIONS_COLLECTION = "rag_collections";
export const RAG_COLLECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RagCollectionPermissions {
  can_read: boolean;
  can_publish: boolean;
  can_manage: boolean;
  can_delegate: boolean;
}

export interface RagCollection {
  _id: string;
  name: string;
  description?: string;
  /** Stable datasource references; membership is mutable and content is never copied. */
  source_ids: string[];
  /** Personal owner for user-created collections. */
  owner_subject?: string;
  /** Members publish sources; team admins also manage collection settings. */
  maintainer_team_slugs: string[];
  /** Teams that may use this collection as a search-time filter. Grants no
   * read access to member datasources - each one remains independently
   * governed. */
  reader_team_slugs: string[];
  /** Reserved for the explicit platform-wide wildcard option. */
  global_read: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type RagCollectionWithPermissions = RagCollection & {
  _permissions: RagCollectionPermissions;
};

export interface RagCollectionMembershipLabel {
  id: string;
  name: string;
}
