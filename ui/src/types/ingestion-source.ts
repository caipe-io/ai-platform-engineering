/**
 * RAG ingestion source configuration (spec 2026-07-21-rag-source-config-db).
 *
 * `IngestionSourceConfig` is the pre-ingestion source of truth for
 * self-service RAG ingestion — distinct from the RAG server's
 * `DataSourceInfo`, which remains the post-ingestion record. See
 * docs/docs/specs/2026-07-21-rag-source-config-db/data-model.md for the
 * full field-mapping rationale.
 */

import type { RagCollectionMembershipLabel } from "@/types/rag-collection";
import type { PendingPublicationRequestView } from "@/types/publication-approval";

export type IngestionSourceType =
  | "slack_channel"
  | "confluence_space"
  | "jira_project"
  | "web_url"
  | "webex_space";

export type IngestionSourceStatus =
  | "pending"
  | "active"
  | "disabled"
  | "ingesting"
  | "failed";

export type IngestionSourceVisibility = "team" | "global";

export interface IngestionSourceConfigBase {
  source_id: string;
  source_type: IngestionSourceType;
  name: string;
  description?: string;
  status: IngestionSourceStatus;
  default_chunk_size: number;
  default_chunk_overlap: number;
  reload_interval: number;

  config_driven: boolean;
  config_import_adopted: boolean;
  visibility: IngestionSourceVisibility;

  creator_subject?: string;
  owner_subject?: string;
  owner_id?: string;
  owner_team_slug?: string;
  /** Recovery hint for the independent Search policy owner. */
  search_owner_team_slug?: string;
  /** Teams whose members may search this source's indexed data. */
  search_with_teams?: string[];
  /** Individual Keycloak subjects granted Search access. */
  search_with_users?: string[];
  /** Response-only identity labels resolved by the BFF. */
  owner_display_name?: string | null;
  owner_email?: string | null;
  creator_display_name?: string | null;
  creator_email?: string | null;
  search_user_display_names?: string[];
  /** Search access inherited through RAG collections. */
  rag_collections?: RagCollectionMembershipLabel[];
  /** Active publication request created by the current user, when present. */
  _publication_request?: PendingPublicationRequestView;
  /**
   * Legacy management-sharing projection. New sources keep this empty: a
   * source has one optional Owner team, while Search access is
   * represented independently by `search_with_teams`.
   */
  shared_with_teams: string[];

  /** Most recent on-demand ingestion job started for this config row. */
  ingestion_job_id?: string;
  /** Human-readable trigger failure retained so the UI can offer a retry. */
  last_error?: string;

  created_at: string;
  updated_at: string;
}

export interface SlackChannelSource extends IngestionSourceConfigBase {
  source_type: "slack_channel";
  channel_id: string;
  lookback_days?: number;
  include_bots?: boolean;
}

export interface ConfluenceSpaceSource extends IngestionSourceConfigBase {
  source_type: "confluence_space";
  confluence_url: string;
  space_key: string;
  /** Concrete page used to start the initial crawl for this space. */
  start_page_url?: string;
  /** Adopted legacy configuration selected the entire space (no root page). */
  whole_space?: boolean;
  get_child_pages?: boolean;
  allowed_title_patterns?: string[];
  denied_title_patterns?: string[];
  /**
   * Full legacy page selection retained during config migration. New sources
   * normally contain one entry, while an adopted env-configured space may
   * contain several roots or an empty array meaning "the whole space".
   */
  page_configs?: Array<{
    page_id: string;
    source?: string | null;
    get_child_pages: boolean;
  }>;
}

export interface JiraProjectSource extends IngestionSourceConfigBase {
  source_type: "jira_project";
  project_key: string;
  /**
   * Caller-supplied and immutable at creation — deliberately NOT derived
   * from the mutable `name` field. The current Jira ingestor slugifies
   * `name` into its own `datasource_id`, which silently orphans RBAC tuples
   * on rename; this store's `source_id` formula uses `source_slug` instead
   * so renaming `name` never changes identity. See data-model.md's
   * "Jira id decision".
   */
  source_slug: string;
  jql: string;
  include_comments?: boolean;
  include_links?: boolean;
  custom_fields?: Record<string, string>;
}

export type WebCrawlMode = "single" | "sitemap" | "recursive";

export interface WebSourceSettings {
  crawl_mode: WebCrawlMode;
  max_depth?: number;
  max_pages?: number;
  render_javascript?: boolean;
  wait_for_selector?: string | null;
  page_load_timeout?: number;
  follow_external_links?: boolean;
  allowed_url_patterns?: string[] | null;
  denied_url_patterns?: string[] | null;
  download_delay?: number;
  concurrent_requests?: number;
  respect_robots_txt?: boolean;
  chunk_size?: number;
  chunk_overlap?: number;
  user_agent?: string | null;
  allow_non_public_urls?: boolean;
}

export interface WebUrlSource extends IngestionSourceConfigBase {
  source_type: "web_url";
  url: string;
  settings?: WebSourceSettings;
}

export interface WebexSpaceSource extends IngestionSourceConfigBase {
  source_type: "webex_space";
  space_id: string;
  include_bots?: boolean;
}

export type IngestionSourceConfig =
  | SlackChannelSource
  | ConfluenceSpaceSource
  | JiraProjectSource
  | WebUrlSource
  | WebexSpaceSource;

/** Per-row OpenFGA decision returned by GET /api/rag/sources (+ [sourceId]). */
export type IngestionSourceConfigWithPermissions = IngestionSourceConfig & {
  _permissions: { can_manage: boolean };
};
