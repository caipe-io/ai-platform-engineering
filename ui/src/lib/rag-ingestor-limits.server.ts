import { ApiError } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";
import {
  normalizeRagIngestorLimits,
  type RagIngestorLimits,
} from "@/lib/rag-ingestor-limits";
import type { IngestionSourceType } from "@/types/ingestion-source";

interface RagLimitsPlatformConfigDocument {
  _id: string;
  rag_ingestor_limits?: unknown;
}

const LIMIT_ERROR_CODE = "RAG_INGESTOR_LIMIT_EXCEEDED";
const BYTES_PER_MIB = 1024 * 1024;

function limitError(message: string): never {
  throw new ApiError(message, 400, LIMIT_ERROR_CODE);
}

function numericValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read the effective platform limits, falling back safely when unset. */
export async function getRagIngestorLimits(): Promise<RagIngestorLimits> {
  const collection = await getCollection<RagLimitsPlatformConfigDocument>("platform_config");
  const config = await collection.findOne({ _id: PLATFORM_CONFIG_ID } as never);
  return normalizeRagIngestorLimits(config?.rag_ingestor_limits);
}

function enforceSharedLimits(
  payload: Record<string, unknown>,
  limits: RagIngestorLimits,
  defaults: { chunk?: boolean; reload?: boolean } = {},
): void {
  const chunkSize =
    numericValue(payload, "default_chunk_size") ??
    numericValue(payload, "chunk_size") ??
    (defaults.chunk ? 10_000 : undefined);
  if (chunkSize !== undefined && chunkSize > limits.shared.max_chunk_size) {
    limitError(
      `Chunk size cannot exceed the platform limit of ${limits.shared.max_chunk_size}.`,
    );
  }

  const chunkOverlap =
    numericValue(payload, "default_chunk_overlap") ??
    numericValue(payload, "chunk_overlap") ??
    (defaults.chunk ? 2_000 : undefined);
  if (chunkOverlap !== undefined && chunkOverlap > limits.shared.max_chunk_overlap) {
    limitError(
      `Chunk overlap cannot exceed the platform limit of ${limits.shared.max_chunk_overlap}.`,
    );
  }

  const reloadInterval =
    numericValue(payload, "reload_interval") ??
    (defaults.reload ? 86_400 : undefined);
  if (
    reloadInterval !== undefined &&
    (reloadInterval < limits.shared.min_reload_interval_seconds ||
      reloadInterval > limits.shared.max_reload_interval_seconds)
  ) {
    limitError(
      `Reload interval must be between ${limits.shared.min_reload_interval_seconds} and ${limits.shared.max_reload_interval_seconds} seconds.`,
    );
  }

  const searchTeams = Array.isArray(payload.search_team_slugs)
    ? payload.search_team_slugs
    : Array.isArray(payload.search_with_teams)
      ? payload.search_with_teams
      : null;
  if (searchTeams && searchTeams.length > limits.shared.max_search_teams) {
    limitError(
      `Search cannot include more than ${limits.shared.max_search_teams} teams.`,
    );
  }
}

/**
 * Enforce one structured connector payload. This is called for creates,
 * edits, previews, and failed-first-ingestion retries so UI controls cannot
 * be bypassed by posting directly to an application API route.
 */
export function enforceRagIngestorLimits(
  sourceType: IngestionSourceType,
  payload: Record<string, unknown>,
  limits: RagIngestorLimits,
  options: { applyDefaults?: boolean } = {},
): void {
  const applyDefaults = options.applyDefaults === true;
  enforceSharedLimits(payload, limits, {
    chunk: applyDefaults && sourceType !== "web_url",
    reload: applyDefaults,
  });

  switch (sourceType) {
    case "slack_channel": {
      const lookbackDays =
        numericValue(payload, "lookback_days") ??
        (applyDefaults ? 30 : undefined);
      if (lookbackDays === 0 && !limits.slack.allow_full_history) {
        limitError("Full Slack history ingestion is disabled by the platform administrator.");
      }
      if (lookbackDays !== undefined && lookbackDays > limits.slack.max_lookback_days) {
        limitError(
          `Slack lookback cannot exceed ${limits.slack.max_lookback_days} days.`,
        );
      }
      if (payload.include_bots === true && !limits.slack.allow_bot_messages) {
        limitError("Including Slack bot messages is disabled by the platform administrator.");
      }
      break;
    }
    case "confluence_space": {
      if (payload.get_child_pages === true && !limits.confluence.allow_child_pages) {
        limitError("Confluence child-page ingestion is disabled by the platform administrator.");
      }
      for (const field of ["allowed_title_patterns", "denied_title_patterns"]) {
        if (listLength(payload[field]) > limits.confluence.max_title_patterns) {
          limitError(
            `Confluence ${field.replaceAll("_", " ")} cannot contain more than ${limits.confluence.max_title_patterns} entries.`,
          );
        }
      }
      break;
    }
    case "jira_project": {
      const jql = nonEmptyString(payload.jql);
      if (jql && jql.length > limits.jira.max_jql_length) {
        limitError(`Jira JQL cannot exceed ${limits.jira.max_jql_length} characters.`);
      }
      const customFields = recordValue(payload.custom_fields);
      if (
        customFields &&
        Object.keys(customFields).length > limits.jira.max_custom_fields
      ) {
        limitError(
          `Jira custom fields cannot contain more than ${limits.jira.max_custom_fields} entries.`,
        );
      }
      const includeComments =
        typeof payload.include_comments === "boolean"
          ? payload.include_comments
          : applyDefaults;
      const includeLinks =
        typeof payload.include_links === "boolean"
          ? payload.include_links
          : applyDefaults;
      if (includeComments && !limits.jira.allow_comments) {
        limitError("Jira comment ingestion is disabled by the platform administrator.");
      }
      if (includeLinks && !limits.jira.allow_issue_links) {
        limitError("Jira issue-link ingestion is disabled by the platform administrator.");
      }
      break;
    }
    case "web_url": {
      const settings = recordValue(payload.settings) ?? {};
      enforceSharedLimits(settings, limits, { chunk: applyDefaults });
      const maxDepth =
        numericValue(settings, "max_depth") ??
        (applyDefaults ? 2 : undefined);
      if (maxDepth !== undefined && maxDepth > limits.web.max_depth) {
        limitError(`Web crawl depth cannot exceed ${limits.web.max_depth}.`);
      }
      const maxPages =
        numericValue(settings, "max_pages") ??
        (applyDefaults ? 2_000 : undefined);
      if (maxPages !== undefined && maxPages > limits.web.max_pages) {
        limitError(`Web crawls cannot exceed ${limits.web.max_pages} pages.`);
      }
      const timeout =
        numericValue(settings, "page_load_timeout") ??
        (applyDefaults ? 15 : undefined);
      if (
        timeout !== undefined &&
        timeout > limits.web.max_page_load_timeout_seconds
      ) {
        limitError(
          `Web page timeout cannot exceed ${limits.web.max_page_load_timeout_seconds} seconds.`,
        );
      }
      const delay =
        numericValue(settings, "download_delay") ??
        (applyDefaults ? 0.05 : undefined);
      if (
        delay !== undefined &&
        (delay < limits.web.min_download_delay_seconds ||
          delay > limits.web.max_download_delay_seconds)
      ) {
        limitError(
          `Web download delay must be between ${limits.web.min_download_delay_seconds} and ${limits.web.max_download_delay_seconds} seconds.`,
        );
      }
      const concurrency =
        numericValue(settings, "concurrent_requests") ??
        (applyDefaults ? 30 : undefined);
      if (
        concurrency !== undefined &&
        concurrency > limits.web.max_concurrent_requests
      ) {
        limitError(
          `Web crawl concurrency cannot exceed ${limits.web.max_concurrent_requests}.`,
        );
      }
      for (const field of ["allowed_url_patterns", "denied_url_patterns"]) {
        if (listLength(settings[field]) > limits.web.max_url_patterns) {
          limitError(
            `Web ${field.replaceAll("_", " ")} cannot contain more than ${limits.web.max_url_patterns} entries.`,
          );
        }
      }
      if (settings.render_javascript === true && !limits.web.allow_javascript) {
        limitError("JavaScript rendering is disabled by the platform administrator.");
      }
      if (settings.follow_external_links === true && !limits.web.allow_external_links) {
        limitError("Following external links is disabled by the platform administrator.");
      }
      if (settings.respect_robots_txt === false && !limits.web.allow_ignore_robots_txt) {
        limitError("Web crawls must respect robots.txt under the platform policy.");
      }
      if (nonEmptyString(settings.user_agent) && !limits.web.allow_custom_user_agent) {
        limitError("Custom web crawler user agents are disabled by the platform administrator.");
      }
      if (settings.allow_non_public_urls === true && !limits.web.allow_non_public_urls) {
        limitError("Crawling internal or private URLs is disabled by the platform administrator.");
      }
      break;
    }
    case "webex_space":
      if (payload.include_bots === true && !limits.webex.allow_bot_messages) {
        limitError("Including Webex bot messages is disabled by the platform administrator.");
      }
      break;
  }
}

/** Apply file-count/size and shared chunk/search limits to a multipart upload. */
export function enforceRagFileUploadLimits(
  formData: FormData,
  limits: RagIngestorLimits,
): void {
  const files = formData
    .getAll("file")
    .filter(
      (entry): entry is File =>
        typeof entry !== "string" && typeof (entry as { size?: unknown }).size === "number",
    );
  if (files.length > limits.file.max_files_per_upload) {
    limitError(
      `A file ingestion cannot contain more than ${limits.file.max_files_per_upload} files.`,
    );
  }
  const maxFileBytes = limits.file.max_file_size_mb * BYTES_PER_MIB;
  const oversized = files.find((file) => file.size > maxFileBytes);
  if (oversized) {
    limitError(
      `File "${oversized.name}" exceeds the platform limit of ${limits.file.max_file_size_mb} MiB.`,
    );
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > limits.file.max_total_upload_size_mb * BYTES_PER_MIB) {
    limitError(
      `The upload exceeds the platform total-size limit of ${limits.file.max_total_upload_size_mb} MiB.`,
    );
  }

  const numberFromForm = (key: string): number | undefined => {
    const raw = formData.get(key);
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  enforceSharedLimits(
    {
      chunk_size: numberFromForm("chunk_size"),
      chunk_overlap: numberFromForm("chunk_overlap"),
      search_team_slugs: formData.getAll("search_team_slugs"),
    },
    limits,
    { chunk: true },
  );
}
