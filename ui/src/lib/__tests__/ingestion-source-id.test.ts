import { createHash } from "crypto";

import {
  computeIngestionSourceId,
  confluenceSpaceSourceId,
  jiraProjectSourceId,
  slackChannelSourceId,
  webexSpaceSourceId,
  webUrlSourceId,
} from "../ingestion-source-id";

describe("ingestion source id formulas", () => {
  it("slack_channel matches `slack-channel-{channel_id}` (ingestors/slack/ingestor.py:346)", () => {
    expect(slackChannelSourceId("C1234567890")).toBe("slack-channel-C1234567890");
  });

  it("confluence_space matches generate_datasource_id (ingestors/confluence/loader.py:30-43)", () => {
    expect(confluenceSpaceSourceId("https://confluence.example.com", "ENG")).toBe(
      "src_confluence___confluence_example_com__ENG",
    );
  });

  it("confluence_space normalizes dots and hyphens in the hostname", () => {
    expect(confluenceSpaceSourceId("https://my-wiki.example.com", "TEAM")).toBe(
      "src_confluence___my_wiki_example_com__TEAM",
    );
  });

  it("uses the root page id to distinguish sources in the same Confluence space", () => {
    expect(
      confluenceSpaceSourceId(
        "https://confluence.example.com/wiki",
        "ENG",
        "123",
      ),
    ).toBe("src_confluence___confluence_example_com__ENG__123");
    expect(
      confluenceSpaceSourceId(
        "https://confluence.example.com/wiki",
        "ENG",
        "456",
      ),
    ).not.toBe(
      confluenceSpaceSourceId(
        "https://confluence.example.com/wiki",
        "ENG",
        "123",
      ),
    );
  });

  it("makes page-scoped Confluence ids safe for managed access", () => {
    expect(
      confluenceSpaceSourceId(
        "https://confluence.example.com:8090/wiki",
        "Control Plane",
        "123",
      ),
    ).toBe(
      "src_confluence___confluence_example_com_8090__Control_Plane__123",
    );
  });

  it("webex_space matches `webex-space-{space_id}` (ingestors/webex/ingestor.py:425)", () => {
    expect(webexSpaceSourceId("abc123")).toBe("webex-space-abc123");
  });

  it("jira_project uses the immutable source_slug, not name (deliberate deviation)", () => {
    expect(jiraProjectSourceId("SDPL", "onboarding-docs")).toBe("jira-sdpl-onboarding-docs");
  });

  it("jira_project lowercases the project key", () => {
    expect(jiraProjectSourceId("SDPL", "slug")).toBe("jira-sdpl-slug");
  });

  it("web_url matches generate_datasource_id_from_url (common/utils.py:165-170)", () => {
    const url = "https://example.com/docs/page";
    const expectedHash = createHash("md5").update(url).digest("hex").slice(0, 12);
    expect(webUrlSourceId(url)).toBe(`src_https___example_com_docs_page_${expectedHash}`);
  });

  it("web_url is deterministic for the same url", () => {
    const url = "https://example.org/a/b?c=d";
    expect(webUrlSourceId(url)).toBe(webUrlSourceId(url));
  });

  it("web_url matches Python's Unicode-aware isalnum() cleaning for non-ASCII characters", () => {
    const url = "https://example.test/例え/ページ";
    const expectedHash = createHash("md5").update(url).digest("hex").slice(0, 12);
    expect(webUrlSourceId(url)).toBe(`src_https___example_test_例え_ページ_${expectedHash}`);
  });

  it("confluence_space preserves host case and port, matching Python's urlparse().netloc (not WHATWG URL.hostname)", () => {
    expect(confluenceSpaceSourceId("https://Confluence.Example.com:8090", "ENG")).toBe(
      "src_confluence___Confluence_Example_com:8090__ENG",
    );
  });

  describe("computeIngestionSourceId dispatches on source_type", () => {
    it("slack_channel", () => {
      expect(
        computeIngestionSourceId({ source_type: "slack_channel", channel_id: "C1" }),
      ).toBe("slack-channel-C1");
    });

    it("confluence_space", () => {
      expect(
        computeIngestionSourceId({
          source_type: "confluence_space",
          confluence_url: "https://confluence.example.com",
          space_key: "ENG",
          page_id: "123",
        }),
      ).toBe("src_confluence___confluence_example_com__ENG__123");
    });

    it("jira_project", () => {
      expect(
        computeIngestionSourceId({
          source_type: "jira_project",
          project_key: "SDPL",
          source_slug: "slug",
        }),
      ).toBe("jira-sdpl-slug");
    });

    it("web_url", () => {
      const url = "https://example.test/a";
      expect(computeIngestionSourceId({ source_type: "web_url", url })).toBe(webUrlSourceId(url));
    });

    it("webex_space", () => {
      expect(
        computeIngestionSourceId({ source_type: "webex_space", space_id: "abc" }),
      ).toBe("webex-space-abc");
    });
  });
});
