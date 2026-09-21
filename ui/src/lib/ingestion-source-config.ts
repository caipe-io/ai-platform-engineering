import { ApiError } from "@/lib/api-middleware";
import { parseConfluencePageUrl } from "@/lib/confluence-url";
import type { IngestionSourceIdentity } from "@/lib/ingestion-source-id";
import type {
  IngestionSourceType,
  WebSourceSettings,
} from "@/types/ingestion-source";

export const INGESTION_SOURCE_TYPES: readonly IngestionSourceType[] = [
  "slack_channel",
  "confluence_space",
  "jira_project",
  "web_url",
  "webex_space",
];

const SOURCE_SPECIFIC_INPUT_FIELDS = new Set([
  "channel_id",
  "lookback_days",
  "include_bots",
  "confluence_url",
  "space_key",
  "start_page_url",
  "get_child_pages",
  "allowed_title_patterns",
  "denied_title_patterns",
  "project_key",
  "source_slug",
  "jql",
  "include_comments",
  "include_links",
  "custom_fields",
  "url",
  "settings",
  "space_id",
]);

const ALLOWED_SOURCE_SPECIFIC_INPUT_FIELDS: Record<
  IngestionSourceType,
  Set<string>
> = {
  slack_channel: new Set(["channel_id", "lookback_days", "include_bots"]),
  confluence_space: new Set([
    "url",
    "confluence_url",
    "space_key",
    "start_page_url",
    "get_child_pages",
    "allowed_title_patterns",
    "denied_title_patterns",
  ]),
  jira_project: new Set([
    "project_key",
    "source_slug",
    "jql",
    "include_comments",
    "include_links",
    "custom_fields",
  ]),
  web_url: new Set(["url", "settings"]),
  webex_space: new Set(["space_id", "include_bots"]),
};

const DEFAULT_CHUNK_SIZE = 10000;
const DEFAULT_CHUNK_OVERLAP = 2000;

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined || value === null) return undefined;
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
  return value;
}

export function optionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError(
      `${field} must be a boolean`,
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  return value;
}

export function optionalStringList(
  value: unknown,
  field: string,
  maximumItems = 100,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ApiError(
      `${field} must be an array of at most ${maximumItems} strings`,
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 1000) {
      throw new ApiError(
        `${field} must contain non-empty strings of at most 1000 characters`,
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
    return item.trim();
  });
}

export function optionalStringMap(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      `${field} must be an object mapping names to field ids`,
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) {
    throw new ApiError(
      `${field} cannot contain more than 100 entries`,
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  return Object.fromEntries(
    entries.map(([key, item]) => {
      const normalizedKey = key.trim();
      if (
        !normalizedKey ||
        normalizedKey.length > 120 ||
        typeof item !== "string"
      ) {
        throw new ApiError(
          `${field} must map non-empty names to string field ids`,
          400,
          "INVALID_SOURCE_PAYLOAD",
        );
      }
      const normalizedValue = item.trim();
      if (!normalizedValue || normalizedValue.length > 120) {
        throw new ApiError(
          `${field} field ids must be between 1 and 120 characters`,
          400,
          "INVALID_SOURCE_PAYLOAD",
        );
      }
      return [normalizedKey, normalizedValue];
    }),
  );
}

export function optionalWebSettings(
  value: unknown,
): WebSourceSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      "settings must be an object",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set<keyof WebSourceSettings>([
    "crawl_mode",
    "max_depth",
    "max_pages",
    "render_javascript",
    "wait_for_selector",
    "page_load_timeout",
    "follow_external_links",
    "allowed_url_patterns",
    "denied_url_patterns",
    "download_delay",
    "concurrent_requests",
    "respect_robots_txt",
    "chunk_size",
    "chunk_overlap",
    "user_agent",
    "allow_non_public_urls",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key as keyof WebSourceSettings)) {
      throw new ApiError(
        `settings.${key} is not supported`,
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
  }

  const crawlMode = input.crawl_mode ?? "single";
  if (!["single", "sitemap", "recursive"].includes(String(crawlMode))) {
    throw new ApiError(
      "settings.crawl_mode is invalid",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  const result: Record<string, unknown> = { crawl_mode: crawlMode };
  const integerRanges: Record<string, [number, number]> = {
    max_depth: [1, 10],
    max_pages: [1, Number.MAX_SAFE_INTEGER],
    page_load_timeout: [5, 120],
    concurrent_requests: [1, 50],
    chunk_size: [100, 100000],
    chunk_overlap: [0, 10000],
  };
  for (const [field, [minimum, maximum]] of Object.entries(integerRanges)) {
    const parsed = optionalInteger(
      input[field],
      `settings.${field}`,
      minimum,
      maximum,
    );
    if (parsed !== undefined) result[field] = parsed;
  }
  for (const field of [
    "render_javascript",
    "follow_external_links",
    "respect_robots_txt",
    "allow_non_public_urls",
  ]) {
    const parsed = optionalBoolean(input[field], `settings.${field}`);
    if (parsed !== undefined) result[field] = parsed;
  }
  for (const field of ["allowed_url_patterns", "denied_url_patterns"]) {
    const parsed = optionalStringList(input[field], `settings.${field}`);
    if (parsed !== undefined) result[field] = parsed;
  }
  for (const field of ["wait_for_selector", "user_agent"]) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === "") {
      if (raw === null) result[field] = null;
      continue;
    }
    if (typeof raw !== "string" || raw.length > 1000) {
      throw new ApiError(
        `settings.${field} must be a string of at most 1000 characters`,
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
    result[field] = raw;
  }
  if (input.download_delay !== undefined && input.download_delay !== null) {
    if (
      typeof input.download_delay !== "number" ||
      !Number.isFinite(input.download_delay) ||
      input.download_delay < 0
    ) {
      throw new ApiError(
        "settings.download_delay must be a non-negative number",
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
    result.download_delay = input.download_delay;
  }

  const chunkSize =
    (result.chunk_size as number | undefined) ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap =
    (result.chunk_overlap as number | undefined) ?? DEFAULT_CHUNK_OVERLAP;
  if (chunkOverlap >= chunkSize) {
    throw new ApiError(
      "settings.chunk_overlap must be smaller than settings.chunk_size",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  return result as unknown as WebSourceSettings;
}

export function validateSourceSpecificInputFields(
  body: Record<string, unknown>,
): void {
  const sourceType = body.source_type as IngestionSourceType | undefined;
  if (!sourceType || !INGESTION_SOURCE_TYPES.includes(sourceType)) return;
  const allowed = ALLOWED_SOURCE_SPECIFIC_INPUT_FIELDS[sourceType];
  for (const field of SOURCE_SPECIFIC_INPUT_FIELDS) {
    if (field in body && !allowed.has(field)) {
      throw new ApiError(
        `${field} is not valid for source_type ${sourceType}`,
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
  }
}

/**
 * Normalize and validate fields whose shape depends on `source_type`.
 * Both API-created and configuration-driven sources use this representation.
 */
export function extractIngestionSourceTypeFields(
  body: Record<string, unknown>,
): { identity: IngestionSourceIdentity; fields: Record<string, unknown> } | null {
  const sourceType = body.source_type as IngestionSourceType | undefined;
  if (!sourceType || !INGESTION_SOURCE_TYPES.includes(sourceType)) return null;

  switch (sourceType) {
    case "slack_channel": {
      const channelId = normalizeString(body.channel_id);
      if (!channelId) return null;
      return {
        identity: { source_type: "slack_channel", channel_id: channelId },
        fields: {
          source_type: sourceType,
          channel_id: channelId,
          lookback_days: optionalInteger(body.lookback_days, "lookback_days", 0),
          include_bots: optionalBoolean(body.include_bots, "include_bots"),
        },
      };
    }
    case "confluence_space": {
      const spaceKey = normalizeString(body.space_key);
      const startPageUrl =
        normalizeString(body.url) ?? normalizeString(body.start_page_url);
      const parsed = startPageUrl ? parseConfluencePageUrl(startPageUrl) : null;
      if (!spaceKey || !parsed || parsed.spaceKey !== spaceKey) return null;
      const suppliedBaseUrl = normalizeString(body.confluence_url);
      if (suppliedBaseUrl) {
        try {
          const normalizedSuppliedBase = new URL(suppliedBaseUrl)
            .toString()
            .replace(/\/$/, "");
          if (normalizedSuppliedBase !== parsed.baseUrl) return null;
        } catch {
          return null;
        }
      }
      return {
        identity: {
          source_type: "confluence_space",
          confluence_url: parsed.baseUrl,
          space_key: spaceKey,
          page_id: parsed.pageId,
        },
        fields: {
          source_type: sourceType,
          confluence_url: parsed.baseUrl,
          space_key: spaceKey,
          start_page_url: startPageUrl,
          get_child_pages: optionalBoolean(
            body.get_child_pages,
            "get_child_pages",
          ),
          allowed_title_patterns: optionalStringList(
            body.allowed_title_patterns,
            "allowed_title_patterns",
          ),
          denied_title_patterns: optionalStringList(
            body.denied_title_patterns,
            "denied_title_patterns",
          ),
        },
      };
    }
    case "jira_project": {
      const projectKey = normalizeString(body.project_key);
      const sourceSlug = normalizeString(body.source_slug);
      if (!projectKey || !sourceSlug) return null;
      return {
        identity: {
          source_type: "jira_project",
          project_key: projectKey,
          source_slug: sourceSlug,
        },
        fields: {
          source_type: sourceType,
          project_key: projectKey,
          source_slug: sourceSlug,
          jql: normalizeString(body.jql) ?? "",
          include_comments: optionalBoolean(
            body.include_comments,
            "include_comments",
          ),
          include_links: optionalBoolean(body.include_links, "include_links"),
          custom_fields: optionalStringMap(body.custom_fields, "custom_fields"),
        },
      };
    }
    case "web_url": {
      const url = normalizeString(body.url);
      if (!url) return null;
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return null;
      } catch {
        return null;
      }
      return {
        identity: { source_type: "web_url", url },
        fields: {
          source_type: sourceType,
          url,
          settings: optionalWebSettings(body.settings),
        },
      };
    }
    case "webex_space": {
      const spaceId = normalizeString(body.space_id);
      if (!spaceId) return null;
      return {
        identity: { source_type: "webex_space", space_id: spaceId },
        fields: {
          source_type: sourceType,
          space_id: spaceId,
          include_bots: optionalBoolean(body.include_bots, "include_bots"),
        },
      };
    }
  }
}
