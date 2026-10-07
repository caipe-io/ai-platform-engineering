/**
 * Platform-governed limits for self-service RAG ingestion.
 *
 * These values intentionally sit below the deployment's absolute safety
 * ceilings where that is useful (for example web page count and Slack
 * history). Operators can tighten them without rebuilding an ingestor. The
 * RAG server still keeps its own hard validation as a final safety layer.
 */

export interface RagIngestorLimits {
  shared: {
    max_chunk_size: number;
    max_chunk_overlap: number;
    min_reload_interval_seconds: number;
    max_reload_interval_seconds: number;
    max_search_teams: number;
  };
  file: {
    max_files_per_upload: number;
    max_file_size_mb: number;
    max_total_upload_size_mb: number;
  };
  slack: {
    max_lookback_days: number;
    allow_full_history: boolean;
    allow_bot_messages: boolean;
  };
  confluence: {
    allow_child_pages: boolean;
    max_title_patterns: number;
  };
  jira: {
    max_jql_length: number;
    max_custom_fields: number;
    allow_comments: boolean;
    allow_issue_links: boolean;
  };
  web: {
    max_depth: number;
    max_pages: number;
    max_page_load_timeout_seconds: number;
    min_download_delay_seconds: number;
    max_download_delay_seconds: number;
    max_concurrent_requests: number;
    max_url_patterns: number;
    allow_javascript: boolean;
    allow_external_links: boolean;
    allow_ignore_robots_txt: boolean;
    allow_custom_user_agent: boolean;
    allow_non_public_urls: boolean;
  };
  webex: {
    allow_bot_messages: boolean;
  };
}

/**
 * Defaults preserve the connector capabilities available before this policy
 * existed. Risky per-source values still retain their safe connector defaults
 * (for example robots.txt is respected and private URLs are off); admins can
 * now disable those overrides platform-wide.
 */
export const DEFAULT_RAG_INGESTOR_LIMITS: RagIngestorLimits = {
  shared: {
    max_chunk_size: 100_000,
    max_chunk_overlap: 10_000,
    min_reload_interval_seconds: 60,
    max_reload_interval_seconds: 2_678_400, // 31 days
    max_search_teams: 50,
  },
  file: {
    max_files_per_upload: 1_000,
    max_file_size_mb: 10,
    max_total_upload_size_mb: 25,
  },
  slack: {
    max_lookback_days: 365,
    allow_full_history: true,
    allow_bot_messages: true,
  },
  confluence: {
    allow_child_pages: true,
    max_title_patterns: 100,
  },
  jira: {
    max_jql_length: 10_000,
    max_custom_fields: 100,
    allow_comments: true,
    allow_issue_links: true,
  },
  web: {
    max_depth: 10,
    max_pages: 5_000,
    max_page_load_timeout_seconds: 120,
    min_download_delay_seconds: 0,
    max_download_delay_seconds: 60,
    max_concurrent_requests: 50,
    max_url_patterns: 100,
    allow_javascript: true,
    allow_external_links: true,
    allow_ignore_robots_txt: true,
    allow_custom_user_agent: true,
    allow_non_public_urls: true,
  },
  webex: {
    allow_bot_messages: true,
  },
};

export type RagIngestorNumberRule = {
  integer?: boolean;
  minimum: number;
  maximum: number;
};

/** Absolute application bounds shared by strict API validation and Admin UI inputs. */
export const RAG_INGESTOR_LIMIT_BOUNDS: {
  [Section in keyof RagIngestorLimits]: Partial<
    Record<keyof RagIngestorLimits[Section], RagIngestorNumberRule>
  >;
} = {
  shared: {
    max_chunk_size: { integer: true, minimum: 100, maximum: 100_000 },
    max_chunk_overlap: { integer: true, minimum: 0, maximum: 10_000 },
    min_reload_interval_seconds: { integer: true, minimum: 60, maximum: 31_536_000 },
    max_reload_interval_seconds: { integer: true, minimum: 60, maximum: 31_536_000 },
    max_search_teams: { integer: true, minimum: 0, maximum: 50 },
  },
  file: {
    max_files_per_upload: { integer: true, minimum: 1, maximum: 1_000 },
    max_file_size_mb: { integer: true, minimum: 1, maximum: 10 },
    max_total_upload_size_mb: { integer: true, minimum: 1, maximum: 25 },
  },
  slack: {
    max_lookback_days: { integer: true, minimum: 1, maximum: 3_650 },
  },
  confluence: {
    max_title_patterns: { integer: true, minimum: 0, maximum: 100 },
  },
  jira: {
    max_jql_length: { integer: true, minimum: 100, maximum: 100_000 },
    max_custom_fields: { integer: true, minimum: 0, maximum: 100 },
  },
  web: {
    max_depth: { integer: true, minimum: 1, maximum: 10 },
    max_pages: { integer: true, minimum: 1, maximum: 100_000 },
    max_page_load_timeout_seconds: { integer: true, minimum: 5, maximum: 120 },
    min_download_delay_seconds: { minimum: 0, maximum: 60 },
    max_download_delay_seconds: { minimum: 0, maximum: 300 },
    max_concurrent_requests: { integer: true, minimum: 1, maximum: 50 },
    max_url_patterns: { integer: true, minimum: 0, maximum: 100 },
  },
  webex: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaults(): RagIngestorLimits {
  return {
    shared: { ...DEFAULT_RAG_INGESTOR_LIMITS.shared },
    file: { ...DEFAULT_RAG_INGESTOR_LIMITS.file },
    slack: { ...DEFAULT_RAG_INGESTOR_LIMITS.slack },
    confluence: { ...DEFAULT_RAG_INGESTOR_LIMITS.confluence },
    jira: { ...DEFAULT_RAG_INGESTOR_LIMITS.jira },
    web: { ...DEFAULT_RAG_INGESTOR_LIMITS.web },
    webex: { ...DEFAULT_RAG_INGESTOR_LIMITS.webex },
  };
}

/**
 * Parse a complete or partial stored policy. In strict mode malformed values
 * throw; the lenient read path falls back field-by-field to safe defaults so
 * a damaged config document cannot disable ingestion entirely.
 */
export function normalizeRagIngestorLimits(
  value: unknown,
  options: { strict?: boolean } = {},
): RagIngestorLimits {
  const result = cloneDefaults();
  if (value == null) return result;
  if (!isRecord(value)) {
    if (options.strict) throw new Error("rag_ingestor_limits must be an object");
    return result;
  }

  for (const sectionName of Object.keys(result) as Array<keyof RagIngestorLimits>) {
    const rawSection = value[sectionName];
    if (rawSection === undefined) continue;
    if (!isRecord(rawSection)) {
      if (options.strict) {
        throw new Error(`rag_ingestor_limits.${sectionName} must be an object`);
      }
      continue;
    }
    const target = result[sectionName] as unknown as Record<string, number | boolean>;
    const rules = RAG_INGESTOR_LIMIT_BOUNDS[sectionName] as Record<
      string,
      RagIngestorNumberRule | undefined
    >;
    for (const field of Object.keys(target)) {
      if (!Object.prototype.hasOwnProperty.call(rawSection, field)) continue;
      const raw = rawSection[field];
      const defaultValue = target[field];
      if (typeof defaultValue === "boolean") {
        if (typeof raw !== "boolean") {
          if (options.strict) {
            throw new Error(`rag_ingestor_limits.${sectionName}.${field} must be a boolean`);
          }
          continue;
        }
        target[field] = raw;
        continue;
      }

      const rule = rules[field];
      const valid =
        typeof raw === "number" &&
        Number.isFinite(raw) &&
        (!rule?.integer || Number.isInteger(raw)) &&
        raw >= (rule?.minimum ?? Number.NEGATIVE_INFINITY) &&
        raw <= (rule?.maximum ?? Number.POSITIVE_INFINITY);
      if (!valid) {
        if (options.strict) {
          throw new Error(
            `rag_ingestor_limits.${sectionName}.${field} is outside its allowed range`,
          );
        }
        continue;
      }
      target[field] = raw;
    }

    if (options.strict) {
      const unknown = Object.keys(rawSection).find(
        (field) => !Object.prototype.hasOwnProperty.call(target, field),
      );
      if (unknown) {
        throw new Error(`rag_ingestor_limits.${sectionName}.${unknown} is not supported`);
      }
    }
  }

  if (options.strict) {
    const unknownSection = Object.keys(value).find(
      (section) => !Object.prototype.hasOwnProperty.call(result, section),
    );
    if (unknownSection) {
      throw new Error(`rag_ingestor_limits.${unknownSection} is not supported`);
    }
  }
  if (result.shared.max_chunk_overlap >= result.shared.max_chunk_size) {
    if (options.strict) {
      throw new Error(
        "rag_ingestor_limits.shared.max_chunk_overlap must be smaller than max_chunk_size",
      );
    }
    result.shared.max_chunk_overlap = Math.min(
      DEFAULT_RAG_INGESTOR_LIMITS.shared.max_chunk_overlap,
      result.shared.max_chunk_size - 1,
    );
  }
  if (
    result.shared.min_reload_interval_seconds >
    result.shared.max_reload_interval_seconds
  ) {
    if (options.strict) {
      throw new Error(
        "rag_ingestor_limits.shared.min_reload_interval_seconds must not exceed max_reload_interval_seconds",
      );
    }
    result.shared.min_reload_interval_seconds =
      DEFAULT_RAG_INGESTOR_LIMITS.shared.min_reload_interval_seconds;
    result.shared.max_reload_interval_seconds =
      DEFAULT_RAG_INGESTOR_LIMITS.shared.max_reload_interval_seconds;
  }
  if (result.file.max_file_size_mb > result.file.max_total_upload_size_mb) {
    if (options.strict) {
      throw new Error(
        "rag_ingestor_limits.file.max_file_size_mb must not exceed max_total_upload_size_mb",
      );
    }
    result.file.max_file_size_mb =
      DEFAULT_RAG_INGESTOR_LIMITS.file.max_file_size_mb;
    result.file.max_total_upload_size_mb =
      DEFAULT_RAG_INGESTOR_LIMITS.file.max_total_upload_size_mb;
  }
  if (
    result.web.min_download_delay_seconds >
    result.web.max_download_delay_seconds
  ) {
    if (options.strict) {
      throw new Error(
        "rag_ingestor_limits.web.min_download_delay_seconds must not exceed max_download_delay_seconds",
      );
    }
    result.web.min_download_delay_seconds =
      DEFAULT_RAG_INGESTOR_LIMITS.web.min_download_delay_seconds;
    result.web.max_download_delay_seconds =
      DEFAULT_RAG_INGESTOR_LIMITS.web.max_download_delay_seconds;
  }
  return result;
}
