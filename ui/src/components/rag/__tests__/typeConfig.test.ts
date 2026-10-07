import {
  getAvailableIngestTypes,
  getIconForType,
  ingestTypeConfigs,
  isIngestTypeAvailable,
  isIngestorOnline,
  supportsScheduledReload,
} from "../typeConfig";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("RAG ingest source availability", () => {
  const now = 1_000;

  it("maps every managed UI source type to its worker type", () => {
    expect(ingestTypeConfigs).toMatchObject({
      web: { requiredIngestorType: "webloader", sourceType: "web_url" },
      slack: { requiredIngestorType: "slack", sourceType: "slack_channel" },
      confluence: {
        requiredIngestorType: "confluence",
        sourceType: "confluence_space",
      },
      jira: { requiredIngestorType: "jira", sourceType: "jira_project" },
      webex: { requiredIngestorType: "webex", sourceType: "webex_space" },
    });
  });

  it("enables only workers with a recent heartbeat", () => {
    const workers = [
      { ingestor_type: "confluence", last_seen: now - 10 },
      { ingestor_type: "slack", last_seen: now - 301 },
      { ingestor_type: "jira" },
    ];

    expect(isIngestTypeAvailable("file", workers, now)).toBe(true);
    expect(isIngestTypeAvailable("confluence", workers, now)).toBe(true);
    expect(isIngestTypeAvailable("slack", workers, now)).toBe(false);
    expect(isIngestTypeAvailable("jira", workers, now)).toBe(false);
  });

  it("classifies ingestors from the same heartbeat threshold as availability", () => {
    expect(isIngestorOnline({ last_seen: now - 300 }, now)).toBe(true);
    expect(isIngestorOnline({ last_seen: now - 301 }, now)).toBe(false);
    expect(isIngestorOnline({}, now)).toBe(false);
  });

  it("returns all registered live connector types", () => {
    jest.spyOn(Date, "now").mockReturnValue(now * 1_000);
    const workers = [
      { ingestor_type: "webloader", last_seen: now },
      { ingestor_type: "slack", last_seen: now },
      { ingestor_type: "confluence", last_seen: now },
      { ingestor_type: "jira", last_seen: now },
      { ingestor_type: "webex", last_seen: now },
    ];

    expect(getAvailableIngestTypes(workers)).toEqual([
      "file",
      "web",
      "slack",
      "confluence",
      "jira",
      "webex",
    ]);
  });

  it("reuses the File ingest icon for local file datasources", () => {
    expect(getIconForType("local_file")).toBe(ingestTypeConfigs.file.icon);
    expect(getIconForType("local-file")).toBe(ingestTypeConfigs.file.icon);
  });

  it("does not show a scheduled refresh for uploaded files", () => {
    expect(supportsScheduledReload("local_file")).toBe(false);
    expect(supportsScheduledReload("local-file")).toBe(false);
    expect(supportsScheduledReload("web")).toBe(true);
    expect(supportsScheduledReload("slack")).toBe(true);
  });
});
