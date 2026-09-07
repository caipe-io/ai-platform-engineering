/**
 * @jest-environment node
 *
 * Tests for `GET /api/rag/sources/[sourceId]` (spec
 * 2026-07-21-rag-source-config-db, US2 List/Read).
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireResourcePermission = jest.fn();

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

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

function request(): NextRequest {
  return new NextRequest(new URL("/api/rag/sources/slack-channel-C1", "http://localhost:3000"));
}

const session = { sub: "alice-sub", role: "user" };
const user = { email: "alice@example.com" };

describe("GET /api/rag/sources/[sourceId]", () => {
  let sources: { findOne: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    sources = { findOne: jest.fn() };
    mockGetCollection.mockResolvedValue(sources);
  });

  // T035 — unreadable-but-existing record: 403, matching
  // rag/kbs/[id]/sharing/route.ts's GET convention.
  it("returns 403 for a record the caller cannot read", async () => {
    sources.findOne.mockResolvedValue({ source_id: "slack-channel-C1" });
    mockRequireResourcePermission.mockRejectedValue(
      Object.assign(new Error("denied"), { statusCode: 403, code: "ingestion_source#read" }),
    );
    const { GET } = await import("../route");

    const response = await GET(request(), { params: Promise.resolve({ sourceId: "slack-channel-C1" }) });

    expect(response.status).toBe(403);
  });

  // T036
  it("returns 404 SOURCE_NOT_FOUND for a nonexistent id", async () => {
    sources.findOne.mockResolvedValue(null);
    const { GET } = await import("../route");

    const response = await GET(request(), { params: Promise.resolve({ sourceId: "no-such-source" }) });
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.code).toBe("SOURCE_NOT_FOUND");
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
  });

  it("returns the record when the caller can read it", async () => {
    const record = { source_id: "slack-channel-C1", name: "eng-general" };
    sources.findOne.mockResolvedValue(record);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    const { GET } = await import("../route");

    const response = await GET(request(), { params: Promise.resolve({ sourceId: "slack-channel-C1" }) });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({ ...record, _permissions: { can_manage: true } });
  });

  it("includes _permissions.can_manage: false when the caller can read but not manage", async () => {
    const record = { source_id: "slack-channel-C1", name: "eng-general" };
    sources.findOne.mockResolvedValue(record);
    mockRequireResourcePermission
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error("denied"), { statusCode: 403, code: "ingestion_source#manage" }),
      );
    const { GET } = await import("../route");

    const response = await GET(request(), { params: Promise.resolve({ sourceId: "slack-channel-C1" }) });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({ ...record, _permissions: { can_manage: false } });
  });
});
