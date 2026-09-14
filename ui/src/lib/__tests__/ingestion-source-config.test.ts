/** @jest-environment node */

import { extractIngestionSourceTypeFields } from "../ingestion-source-config";

describe("extractIngestionSourceTypeFields", () => {
  it("normalizes the full Confluence configuration", () => {
    expect(
      extractIngestionSourceTypeFields({
        source_type: "confluence_space",
        confluence_url: "https://confluence.example.com/wiki/",
        space_key: "DOC",
        start_page_url:
          "https://confluence.example.com/wiki/spaces/DOC/pages/123/Overview",
        get_child_pages: true,
        allowed_title_patterns: [" Guide.* "],
        denied_title_patterns: ["Archive.*"],
      }),
    ).toEqual({
      identity: {
        source_type: "confluence_space",
        confluence_url: "https://confluence.example.com/wiki",
        space_key: "DOC",
        page_id: "123",
      },
      fields: {
        source_type: "confluence_space",
        confluence_url: "https://confluence.example.com/wiki",
        space_key: "DOC",
        start_page_url:
          "https://confluence.example.com/wiki/spaces/DOC/pages/123/Overview",
        get_child_pages: true,
        allowed_title_patterns: ["Guide.*"],
        denied_title_patterns: ["Archive.*"],
      },
    });
  });

  it("preserves Jira connector settings", () => {
    expect(
      extractIngestionSourceTypeFields({
        source_type: "jira_project",
        project_key: " EXAMPLE ",
        source_slug: " primary ",
        jql: " project = EXAMPLE ",
        include_comments: true,
        include_links: false,
        custom_fields: { severity: " customfield_10001 " },
      }),
    ).toEqual({
      identity: {
        source_type: "jira_project",
        project_key: "EXAMPLE",
        source_slug: "primary",
      },
      fields: {
        source_type: "jira_project",
        project_key: "EXAMPLE",
        source_slug: "primary",
        jql: "project = EXAMPLE",
        include_comments: true,
        include_links: false,
        custom_fields: { severity: "customfield_10001" },
      },
    });
  });

  it("preserves web crawl settings and Webex bot filtering", () => {
    expect(
      extractIngestionSourceTypeFields({
        source_type: "web_url",
        url: "https://docs.example.com",
        settings: {
          crawl_mode: "recursive",
          max_depth: 3,
          respect_robots_txt: true,
        },
      })?.fields,
    ).toEqual({
      source_type: "web_url",
      url: "https://docs.example.com",
      settings: {
        crawl_mode: "recursive",
        max_depth: 3,
        respect_robots_txt: true,
      },
    });
    expect(
      extractIngestionSourceTypeFields({
        source_type: "webex_space",
        space_id: "space-primary",
        include_bots: true,
      })?.fields,
    ).toEqual({
      source_type: "webex_space",
      space_id: "space-primary",
      include_bots: true,
    });
  });

  it("rejects malformed typed settings", () => {
    expect(() =>
      extractIngestionSourceTypeFields({
        source_type: "web_url",
        url: "https://docs.example.com",
        settings: { crawl_mode: "recursive", max_depth: 99 },
      }),
    ).toThrow("settings.max_depth is outside its allowed range");
  });
});
