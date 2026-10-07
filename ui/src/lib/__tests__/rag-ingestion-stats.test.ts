import { loadLatestSuccessfulIngestionStats } from "@/lib/rag-ingestion-stats.server";

describe("loadLatestSuccessfulIngestionStats", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns document and chunk totals from the latest successful job", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: {
          "source-primary": [
            {
              status: "completed",
              created_at: 100,
              document_count: 8,
              chunk_count: 24,
            },
            {
              status: "in_progress",
              created_at: 300,
              document_count: 99,
              chunk_count: 99,
            },
            {
              status: "completed_with_errors",
              created_at: 200,
              document_count: 11,
              chunk_count: 31,
            },
          ],
        },
      }),
    } as Response);

    const stats = await loadLatestSuccessfulIngestionStats(
      { accessToken: "access-token", org: "example" },
      ["source-primary"],
    );

    expect(stats.get("source-primary")).toEqual({
      documentCount: 11,
      chunkCount: 31,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/v1/jobs/batch"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "X-Tenant-Id": "example",
        }),
      }),
    );
  });

  it("does not invent a zero when a job has no recorded totals", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: {
          "source-primary": [{ status: "completed", created_at: 100 }],
        },
      }),
    } as Response);

    const stats = await loadLatestSuccessfulIngestionStats(
      { accessToken: "access-token" },
      ["source-primary"],
    );

    expect(stats.has("source-primary")).toBe(false);
  });
});
