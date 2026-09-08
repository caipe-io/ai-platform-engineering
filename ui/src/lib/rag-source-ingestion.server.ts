import { ApiError } from "@/lib/api-middleware";
import type {
  IngestionSourceConfig,
  IngestionSourceType,
} from "@/types/ingestion-source";

export function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

const INGEST_TRIGGER_PATH: Record<IngestionSourceType, string> = {
  slack_channel: "/v1/ingest/slack/channel",
  confluence_space: "/v1/ingest/confluence/page",
  jira_project: "/v1/ingest/jira/project",
  web_url: "/v1/ingest/webloader/url",
  webex_space: "/v1/ingest/webex/space",
};

function buildIngestTriggerPayload(
  doc: IngestionSourceConfig,
  ownerTeamSlug: string | null,
): Record<string, unknown> {
  const common = {
    description: doc.description,
    owner_team_slug: ownerTeamSlug || undefined,
    search_team_slugs: doc.search_with_teams ?? [],
    search_user_subjects: doc.search_with_users ?? [],
    ownership_preprovisioned: true,
    config_managed: true,
    default_chunk_size: doc.default_chunk_size,
    default_chunk_overlap: doc.default_chunk_overlap,
    reload_interval: doc.reload_interval,
  };
  switch (doc.source_type) {
    case "slack_channel":
      return {
        ...common,
        channel_id: doc.channel_id,
        channel_name: doc.name,
        lookback_days: doc.lookback_days,
        include_bots: doc.include_bots,
      };
    case "confluence_space":
      if (!doc.start_page_url) {
        throw new ApiError(
          "This imported whole-space Confluence source can only be reloaded after its datasource exists",
          409,
          "CONFLUENCE_ROOT_PAGE_UNAVAILABLE",
        );
      }
      return {
        ...common,
        name: doc.name,
        url: doc.start_page_url,
        preprovisioned_datasource_id: doc.source_id,
        get_child_pages: doc.get_child_pages ?? false,
        allowed_title_patterns: doc.allowed_title_patterns,
        denied_title_patterns: doc.denied_title_patterns,
      };
    case "jira_project":
      return {
        ...common,
        project_key: doc.project_key,
        source_slug: doc.source_slug,
        name: doc.name,
        jql: doc.jql,
        include_comments: doc.include_comments,
        include_links: doc.include_links,
        custom_fields: doc.custom_fields,
      };
    case "web_url":
      return {
        url: doc.url,
        description: doc.description,
        owner_team_slug: ownerTeamSlug || undefined,
        search_team_slugs: doc.search_with_teams ?? [],
        search_user_subjects: doc.search_with_users ?? [],
        ownership_preprovisioned: true,
        config_managed: true,
        reload_interval: doc.reload_interval,
        settings: {
          ...(doc.settings ?? { crawl_mode: "single" }),
          chunk_size: doc.default_chunk_size,
          chunk_overlap: doc.default_chunk_overlap,
        },
      };
    case "webex_space":
      return {
        ...common,
        space_id: doc.space_id,
        space_name: doc.name,
        include_bots: doc.include_bots,
      };
  }
}

export interface IngestionTriggerResult {
  datasource_id: string;
  job_id: string;
}

export async function triggerIngestion(
  doc: IngestionSourceConfig,
  accessToken: string | undefined,
  ownerTeamSlug: string | null,
): Promise<IngestionTriggerResult> {
  const path = INGEST_TRIGGER_PATH[doc.source_type];
  if (!accessToken) {
    throw new ApiError(
      "A Keycloak access token is required to start ingestion",
      401,
    );
  }
  const response = await fetch(`${getRagServerUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(buildIngestTriggerPayload(doc, ownerTeamSlug)),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(
      `Source was saved, but ingestion could not be started (${response.status})${body ? `: ${body}` : ""}`,
      502,
      "INGEST_TRIGGER_FAILED",
    );
  }
  const result = (await response.json().catch(() => ({}))) as Partial<
    IngestionTriggerResult
  >;
  if (result.datasource_id !== doc.source_id) {
    throw new ApiError(
      `Ingestor returned datasource id "${result.datasource_id ?? ""}" for source "${doc.source_id}"`,
      502,
      "INGEST_DATASOURCE_ID_MISMATCH",
    );
  }
  if (typeof result.job_id !== "string" || !result.job_id.trim()) {
    throw new ApiError(
      "Ingestor accepted the request without returning an ingestion job id",
      502,
      "INGEST_JOB_ID_MISSING",
    );
  }
  return { datasource_id: result.datasource_id, job_id: result.job_id };
}
