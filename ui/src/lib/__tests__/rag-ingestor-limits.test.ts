/** @jest-environment node */

import {
  DEFAULT_RAG_INGESTOR_LIMITS,
  normalizeRagIngestorLimits,
} from "@/lib/rag-ingestor-limits";
import {
  enforceRagFileUploadLimits,
  enforceRagIngestorLimits,
} from "@/lib/rag-ingestor-limits.server";

describe("RAG ingestor limits", () => {
  it("merges a partial stored policy over safe defaults", () => {
    const limits = normalizeRagIngestorLimits({
      slack: { max_lookback_days: 90 },
      web: { max_pages: 750 },
    });

    expect(limits.slack.max_lookback_days).toBe(90);
    expect(limits.slack.allow_full_history).toBe(true);
    expect(limits.web.max_pages).toBe(750);
    expect(limits.shared.max_chunk_size).toBe(100_000);
  });

  it("strictly rejects malformed and internally inconsistent admin policies", () => {
    expect(() =>
      normalizeRagIngestorLimits(
        { web: { max_concurrent_requests: 51 } },
        { strict: true },
      ),
    ).toThrow(/outside its allowed range/);
    expect(() =>
      normalizeRagIngestorLimits(
        {
          shared: {
            max_chunk_size: 1_000,
            max_chunk_overlap: 1_000,
          },
        },
        { strict: true },
      ),
    ).toThrow(/smaller than max_chunk_size/);
  });

  it("repairs inconsistent stored ranges on the lenient read path", () => {
    const limits = normalizeRagIngestorLimits({
      shared: {
        max_chunk_size: 1_000,
        max_chunk_overlap: 2_000,
        min_reload_interval_seconds: 10_000,
        max_reload_interval_seconds: 1_000,
      },
      file: {
        max_file_size_mb: 10,
        max_total_upload_size_mb: 5,
      },
      web: {
        min_download_delay_seconds: 10,
        max_download_delay_seconds: 5,
      },
    });

    expect(limits.shared.max_chunk_overlap).toBe(999);
    expect(limits.shared.min_reload_interval_seconds).toBe(
      DEFAULT_RAG_INGESTOR_LIMITS.shared.min_reload_interval_seconds,
    );
    expect(limits.shared.max_reload_interval_seconds).toBe(
      DEFAULT_RAG_INGESTOR_LIMITS.shared.max_reload_interval_seconds,
    );
    expect(limits.file).toEqual(DEFAULT_RAG_INGESTOR_LIMITS.file);
    expect(limits.web.min_download_delay_seconds).toBe(
      DEFAULT_RAG_INGESTOR_LIMITS.web.min_download_delay_seconds,
    );
    expect(limits.web.max_download_delay_seconds).toBe(
      DEFAULT_RAG_INGESTOR_LIMITS.web.max_download_delay_seconds,
    );
  });

  it("rejects Slack full history and excessive lookback", () => {
    const limits = normalizeRagIngestorLimits({
      slack: { allow_full_history: false },
    });
    expect(() =>
      enforceRagIngestorLimits(
        "slack_channel",
        { lookback_days: 0 },
        limits,
      ),
    ).toThrow(/Full Slack history/);
    expect(() =>
      enforceRagIngestorLimits(
        "slack_channel",
        { lookback_days: 366 },
        DEFAULT_RAG_INGESTOR_LIMITS,
      ),
    ).toThrow(/cannot exceed 365/);
  });

  it("checks effective connector defaults when callers omit optional fields", () => {
    const slackLimits = normalizeRagIngestorLimits({
      slack: { max_lookback_days: 7 },
    });
    expect(() =>
      enforceRagIngestorLimits("slack_channel", {}, slackLimits, {
        applyDefaults: true,
      }),
    ).toThrow(/cannot exceed 7/);

    const jiraLimits = normalizeRagIngestorLimits({
      jira: { allow_comments: false, allow_issue_links: false },
    });
    expect(() =>
      enforceRagIngestorLimits("jira_project", {}, jiraLimits, {
        applyDefaults: true,
      }),
    ).toThrow(/comment ingestion/);
    // A partial PATCH evaluates only the fields being changed; the full
    // stored source is checked again when it is reloaded.
    expect(() =>
      enforceRagIngestorLimits("jira_project", {}, jiraLimits),
    ).not.toThrow();

    const webLimits = normalizeRagIngestorLimits({ web: { max_pages: 100 } });
    expect(() =>
      enforceRagIngestorLimits(
        "web_url",
        { settings: {} },
        webLimits,
        { applyDefaults: true },
      ),
    ).toThrow(/cannot exceed 100 pages/);
  });

  it("governs web crawl load and risky features", () => {
    expect(() =>
      enforceRagIngestorLimits(
        "web_url",
        { settings: { max_pages: 5_001 } },
        DEFAULT_RAG_INGESTOR_LIMITS,
      ),
    ).toThrow(/cannot exceed 5000 pages/);
    const limits = normalizeRagIngestorLimits({
      web: {
        allow_ignore_robots_txt: false,
        allow_non_public_urls: false,
      },
    });
    expect(() =>
      enforceRagIngestorLimits(
        "web_url",
        { settings: { respect_robots_txt: false } },
        limits,
      ),
    ).toThrow(/must respect robots.txt/);
    expect(() =>
      enforceRagIngestorLimits(
        "web_url",
        { settings: { allow_non_public_urls: true } },
        limits,
      ),
    ).toThrow(/internal or private URLs/);
  });

  it("enforces the configured Search Access team ceiling", () => {
    const limits = normalizeRagIngestorLimits({
      shared: { max_search_teams: 1 },
    });
    expect(() =>
      enforceRagIngestorLimits(
        "jira_project",
        { search_team_slugs: ["primary", "secondary"] },
        limits,
      ),
    ).toThrow(/more than 1 teams/);
  });

  it("enforces shared chunk and reload bounds", () => {
    const limits = normalizeRagIngestorLimits({
      shared: {
        max_chunk_size: 1_000,
        max_chunk_overlap: 100,
        min_reload_interval_seconds: 3_600,
        max_reload_interval_seconds: 86_400,
      },
    });

    expect(() =>
      enforceRagIngestorLimits(
        "jira_project",
        { default_chunk_size: 1_001 },
        limits,
      ),
    ).toThrow(/Chunk size/);
    expect(() =>
      enforceRagIngestorLimits(
        "jira_project",
        { default_chunk_overlap: 101 },
        limits,
      ),
    ).toThrow(/Chunk overlap/);
    expect(() =>
      enforceRagIngestorLimits(
        "jira_project",
        { reload_interval: 60 },
        limits,
      ),
    ).toThrow(/Reload interval/);
  });

  it("governs Confluence expansion and filter counts", () => {
    const limits = normalizeRagIngestorLimits({
      confluence: { allow_child_pages: false, max_title_patterns: 1 },
    });

    expect(() =>
      enforceRagIngestorLimits(
        "confluence_space",
        { get_child_pages: true },
        limits,
      ),
    ).toThrow(/child-page ingestion/);
    expect(() =>
      enforceRagIngestorLimits(
        "confluence_space",
        { allowed_title_patterns: ["first", "second"] },
        limits,
      ),
    ).toThrow(/more than 1 entries/);
  });

  it("governs Jira query expansion and custom fields", () => {
    const limits = normalizeRagIngestorLimits({
      jira: {
        max_jql_length: 100,
        max_custom_fields: 1,
        allow_comments: false,
        allow_issue_links: false,
      },
    });

    expect(() =>
      enforceRagIngestorLimits(
        "jira_project",
        { jql: "x".repeat(101) },
        limits,
      ),
    ).toThrow(/JQL/);
    expect(() =>
      enforceRagIngestorLimits(
        "jira_project",
        { custom_fields: { first: "customfield_1", second: "customfield_2" } },
        limits,
      ),
    ).toThrow(/custom fields/);
    expect(() =>
      enforceRagIngestorLimits(
        "jira_project",
        { include_comments: true },
        limits,
      ),
    ).toThrow(/comment ingestion/);
    expect(() =>
      enforceRagIngestorLimits(
        "jira_project",
        { include_links: true },
        limits,
      ),
    ).toThrow(/issue-link ingestion/);
  });

  it("governs Webex bot messages", () => {
    const limits = normalizeRagIngestorLimits({
      webex: { allow_bot_messages: false },
    });
    expect(() =>
      enforceRagIngestorLimits(
        "webex_space",
        { include_bots: true },
        limits,
      ),
    ).toThrow(/Webex bot messages/);
  });

  it("enforces multipart file count and size limits", () => {
    const limits = normalizeRagIngestorLimits({
      file: {
        max_files_per_upload: 1,
        max_file_size_mb: 1,
        max_total_upload_size_mb: 1,
      },
    });
    const form = new FormData();
    form.append("file", new File(["first"], "first.txt", { type: "text/plain" }));
    form.append("file", new File(["second"], "second.txt", { type: "text/plain" }));

    expect(() => enforceRagFileUploadLimits(form, limits)).toThrow(
      /more than 1 files/,
    );
  });

  it("enforces multipart per-file and total-byte limits", () => {
    const limits = normalizeRagIngestorLimits({
      file: {
        max_files_per_upload: 3,
        max_file_size_mb: 1,
        max_total_upload_size_mb: 1,
      },
    });
    const oversized = new FormData();
    oversized.append(
      "file",
      new File([new Uint8Array(1_048_577)], "large.txt", { type: "text/plain" }),
    );
    expect(() => enforceRagFileUploadLimits(oversized, limits)).toThrow(
      /exceeds the platform limit/,
    );

    const total = new FormData();
    total.append(
      "file",
      new File([new Uint8Array(600_000)], "first.txt", { type: "text/plain" }),
    );
    total.append(
      "file",
      new File([new Uint8Array(600_000)], "second.txt", { type: "text/plain" }),
    );
    expect(() => enforceRagFileUploadLimits(total, limits)).toThrow(
      /total-size limit/,
    );
  });

  it("applies shared defaults to multipart uploads", () => {
    const limits = normalizeRagIngestorLimits({
      shared: { max_chunk_size: 5_000 },
    });
    const form = new FormData();
    form.append("file", new File(["text"], "example.txt", { type: "text/plain" }));

    expect(() => enforceRagFileUploadLimits(form, limits)).toThrow(/Chunk size/);
  });
});
