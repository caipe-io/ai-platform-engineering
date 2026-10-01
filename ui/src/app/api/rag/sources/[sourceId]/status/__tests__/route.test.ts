/**
 * @jest-environment node
 *
 * Tests for `PATCH /api/rag/sources/[sourceId]/status` (spec
 * 2026-07-21-rag-source-config-db) — the ingestor-service-account-scoped
 * status-only PATCH route.
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockIsRecognizedIngestorServiceAccount = jest.fn();

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
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(
        handler: (
          request: NextRequest,
          context: { params: Promise<{ sourceId: string }> },
        ) => Promise<T>,
      ) =>
      async (request: NextRequest, context: { params: Promise<{ sourceId: string }> }) => {
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
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/rbac/ingestor-service-accounts", () => ({
  isRecognizedIngestorServiceAccount: (...args: unknown[]) =>
    mockIsRecognizedIngestorServiceAccount(...args),
}));

function request(body?: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL("/api/rag/sources/slack-channel-C1/status", "http://localhost:3000"), {
    method: "PATCH",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

function params(sourceId = "slack-channel-C1") {
  return { params: Promise.resolve({ sourceId }) };
}

const ingestorSession = { isServiceAccount: true, sub: "service-account-slack-ingestor" };
const ingestorUser = { email: "service-account-slack-ingestor@local" };

const baseSource = {
  source_id: "slack-channel-C1",
  source_type: "slack_channel",
  channel_id: "C1",
  name: "eng-general",
  description: "",
  status: "pending",
  default_chunk_size: 10000,
  default_chunk_overlap: 2000,
  reload_interval: 86400,
  config_driven: false,
  config_import_adopted: false,
  visibility: "team",
  owner_team_slug: "platform",
  shared_with_teams: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("PATCH /api/rag/sources/[sourceId]/status", () => {
  let sources: { findOne: jest.Mock; findOneAndUpdate: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user: ingestorUser, session: ingestorSession });
    mockIsRecognizedIngestorServiceAccount.mockReturnValue(true);
    sources = {
      findOne: jest.fn().mockResolvedValue({ ...baseSource }),
      findOneAndUpdate: jest.fn().mockImplementation(async (_filter, update) => ({
        ...baseSource,
        ...update.$set,
      })),
    };
    mockGetCollection.mockResolvedValue(sources);
  });

  it("updates status for a recognized ingestor service account scoped to the source's type", async () => {
    const { PATCH } = await import("../route");

    const response = await PATCH(request({ status: "active" }), params());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.status).toBe("active");
    expect(mockIsRecognizedIngestorServiceAccount).toHaveBeenCalledWith(ingestorSession, "slack_channel");
  });

  it("rejects an unrecognized service account with 403", async () => {
    mockIsRecognizedIngestorServiceAccount.mockReturnValue(false);
    const { PATCH } = await import("../route");

    const response = await PATCH(request({ status: "active" }), params());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.code).toBe("FORBIDDEN_INGESTOR_STATUS_UPDATE");
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a service account scoped to a different source_type (scope-crossing)", async () => {
    // The helper itself enforces the type match; simulate its false return
    // for a caller whose allow-list doesn't include this source's type.
    mockIsRecognizedIngestorServiceAccount.mockReturnValue(false);
    const { PATCH } = await import("../route");

    const response = await PATCH(request({ status: "active" }), params());

    expect(response.status).toBe(403);
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a non-service-account caller (helper returns false)", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "alice@example.com" },
      session: { sub: "alice-sub", role: "user" },
    });
    mockIsRecognizedIngestorServiceAccount.mockReturnValue(false);
    const { PATCH } = await import("../route");

    const response = await PATCH(request({ status: "active" }), params());

    expect(response.status).toBe(403);
  });

  it("returns 400 for an invalid status value", async () => {
    const { PATCH } = await import("../route");

    const response = await PATCH(request({ status: "not-a-real-status" }), params());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.code).toBe("INVALID_STATUS");
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the source does not exist", async () => {
    sources.findOne.mockResolvedValue(null);
    const { PATCH } = await import("../route");

    const response = await PATCH(request({ status: "active" }), params("does-not-exist"));
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.code).toBe("SOURCE_NOT_FOUND");
  });

  it("succeeds on a config_driven: true source (status-only exemption)", async () => {
    sources.findOne.mockResolvedValue({ ...baseSource, config_driven: true });
    const { PATCH } = await import("../route");

    const response = await PATCH(request({ status: "ingesting" }), params());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.status).toBe("ingesting");
  });
});
