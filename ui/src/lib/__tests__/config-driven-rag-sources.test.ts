/** @jest-environment node */

const mockCollection = {
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
};
const mockGetAdminToken = jest.fn();
const mockTriggerIngestion = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async () => mockCollection),
}));
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getAdminToken: (...args: unknown[]) => mockGetAdminToken(...args),
}));
jest.mock("@/lib/rag-source-ingestion.server", () => ({
  triggerIngestion: (...args: unknown[]) => mockTriggerIngestion(...args),
}));

import { reconcileConfigDrivenRagSources } from "../config-driven-rag-sources.server";

const source = {
  source_id: "slack-channel-C1",
  source_type: "slack_channel",
  channel_id: "C1",
  name: "team-updates",
  status: "pending",
  config_driven: true,
  config_import_adopted: false,
  owner_team_slug: "primary",
};

describe("reconcileConfigDrivenRagSources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollection.find.mockReturnValue({
      limit: jest.fn(() => ({ toArray: jest.fn(async () => [source]) })),
    });
    mockCollection.findOneAndUpdate.mockResolvedValue({
      ...source,
      status: "ingesting",
      config_seed_claimed_at: "2026-09-08T00:00:00.000Z",
    });
    mockGetAdminToken.mockResolvedValue("platform-token");
    mockTriggerIngestion.mockResolvedValue({
      datasource_id: source.source_id,
      job_id: "job-primary",
    });
  });

  it("claims and starts pending config-driven sources", async () => {
    await reconcileConfigDrivenRagSources();

    expect(mockTriggerIngestion).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: source.source_id }),
      "platform-token",
      "primary",
    );
    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: source.source_id }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "ingesting",
          ingestion_job_id: "job-primary",
        }),
        $unset: { config_seed_claimed_at: "", last_error: "" },
      }),
    );
  });

  it("records a failed trigger so it remains visible and retryable", async () => {
    mockTriggerIngestion.mockRejectedValue(new Error("RAG unavailable"));

    await reconcileConfigDrivenRagSources();

    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: source.source_id }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          last_error: "RAG unavailable",
        }),
        $unset: { config_seed_claimed_at: "" },
      }),
    );
  });
});
