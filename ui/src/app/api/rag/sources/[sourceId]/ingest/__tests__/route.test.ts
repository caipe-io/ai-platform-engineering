/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockTriggerIngestion = jest.fn();
const mockGetRagIngestorLimits = jest.fn();
const mockEnforceRagIngestorLimits = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
      public code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown) => Response.json({ success: true, data }),
    withErrorHandler:
      <T,>(
        handler: (
          request: NextRequest,
          context: { params: Promise<{ sourceId: string }> },
        ) => Promise<T>,
      ) =>
      async (
        request: NextRequest,
        context: { params: Promise<{ sourceId: string }> },
      ) => {
        try {
          return await handler(request, context);
        } catch (error) {
          return Response.json(
            {
              success: false,
              error: error instanceof Error ? error.message : "error",
              code: (error as { code?: string }).code,
            },
            { status: (error as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("../../../route", () => ({
  triggerIngestion: (...args: unknown[]) => mockTriggerIngestion(...args),
}));

jest.mock("@/lib/rag-ingestor-limits.server", () => ({
  getRagIngestorLimits: (...args: unknown[]) =>
    mockGetRagIngestorLimits(...args),
  enforceRagIngestorLimits: (...args: unknown[]) =>
    mockEnforceRagIngestorLimits(...args),
}));

function params(sourceId: string) {
  return { params: Promise.resolve({ sourceId }) };
}

const session = { sub: "test-user", accessToken: "access-token" };

describe("POST /api/rag/sources/[sourceId]/ingest", () => {
  const originalFetch = global.fetch;
  const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockGetRagIngestorLimits.mockResolvedValue({
      shared: { max_search_teams: 50 },
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        source_id: "jira-example-primary",
        source_type: "jira_project",
        project_key: "EXAMPLE",
        source_slug: "primary",
        jql: "project = EXAMPLE",
        name: "Primary issues",
        status: "failed",
        default_chunk_size: 10000,
        default_chunk_overlap: 2000,
        reload_interval: 86400,
        config_driven: false,
        config_import_adopted: true,
        visibility: "team",
        owner_team_slug: "management-team",
        search_owner_team_slug: "search-team",
        shared_with_teams: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
      updateOne,
    });
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("reloads an existing datasource without replaying its create config", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ exists: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          datasource_id: "jira-example-primary",
          job_id: "reload-job",
        }),
      });

    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("http://localhost/api/rag/sources/jira-example-primary/ingest", {
        method: "POST",
      }),
      params("jira-example-primary"),
    );

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:9446/v1/ingest/jira/reload",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ datasource_id: "jira-example-primary" }),
      }),
    );
    expect(mockTriggerIngestion).not.toHaveBeenCalled();
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      session,
      {
        type: "ingestion_source",
        id: "jira-example-primary",
        action: "manage",
      },
      { bypassForOrgAdmin: true },
    );
    expect(updateOne).toHaveBeenCalledWith(
      { source_id: "jira-example-primary" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "ingesting",
          ingestion_job_id: "reload-job",
        }),
      }),
    );
  });

  it("allows an Owner to reload without Search access", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ exists: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          datasource_id: "jira-example-primary",
          job_id: "manager-reload-job",
        }),
      });

    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("http://localhost/api/rag/sources/jira-example-primary/ingest", {
        method: "POST",
      }),
      params("jira-example-primary"),
    );

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      session,
      {
        type: "ingestion_source",
        id: "jira-example-primary",
        action: "manage",
      },
      { bypassForOrgAdmin: true },
    );
  });

  it("does not let a Search-only user reload", async () => {
    mockRequireResourcePermission.mockRejectedValueOnce(
      Object.assign(new Error("owner access denied"), { statusCode: 403 }),
    );

    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("http://localhost/api/rag/sources/jira-example-primary/ingest", {
        method: "POST",
      }),
      params("jira-example-primary"),
    );

    expect(response.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTriggerIngestion).not.toHaveBeenCalled();
  });

  it("replays initial creation only when no RAG datasource exists", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ exists: false }),
    });
    mockTriggerIngestion.mockResolvedValue({
      datasource_id: "jira-example-primary",
      job_id: "initial-job",
    });

    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("http://localhost/api/rag/sources/jira-example-primary/ingest", {
        method: "POST",
      }),
      params("jira-example-primary"),
    );

    expect(response.status).toBe(200);
    expect(mockTriggerIngestion).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: "jira-example-primary" }),
      "access-token",
      "management-team",
    );
  });

  it("fails closed when existing datasource state cannot be verified", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 503,
    });

    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("http://localhost/api/rag/sources/jira-example-primary/ingest", {
        method: "POST",
      }),
      params("jira-example-primary"),
    );

    expect(response.status).toBe(502);
    expect(mockTriggerIngestion).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledWith(
      { source_id: "jira-example-primary" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
        }),
      }),
    );
  });
});
