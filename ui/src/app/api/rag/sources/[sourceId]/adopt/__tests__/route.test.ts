/**
 * @jest-environment node
 *
 * Tests for `POST /api/rag/sources/[sourceId]/adopt` (spec
 * 2026-07-21-rag-source-config-db, US5).
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockAdoptConfigImportedRagSources = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
    successResponse: (data: unknown) => Response.json({ success: true, data }),
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
        } catch (err) {
          const { ApiError } = actual;
          if (err instanceof ApiError) {
            return Response.json(
              { success: false, error: err.message, code: err.code },
              { status: err.statusCode },
            );
          }
          throw err;
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/seed-config", () => ({
  adoptConfigImportedRagSources: (...args: unknown[]) => mockAdoptConfigImportedRagSources(...args),
}));

const session = { sub: "admin-sub" };
const user = { email: "admin@example.com" };

function postRequest(body: unknown = {}): NextRequest {
  return new NextRequest("http://localhost/api/rag/sources/slack-channel-C1/adopt", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function params(sourceId = "slack-channel-C1") {
  return { params: Promise.resolve({ sourceId }) };
}

const eligibleSource = {
  source_id: "slack-channel-C1",
  config_driven: true,
  config_import_adopted: false,
  visibility: "global",
};

describe("POST /api/rag/sources/[sourceId]/adopt", () => {
  let sources: { findOne: jest.Mock };
  let teams: { findOne: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    mockRequireRbacPermission.mockResolvedValue(undefined);
    sources = { findOne: jest.fn().mockResolvedValue({ ...eligibleSource }) };
    teams = { findOne: jest.fn().mockResolvedValue({ slug: "platform" }) };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_ingestion_sources") return sources;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
    mockAdoptConfigImportedRagSources.mockResolvedValue({ adopted: ["slack-channel-C1"], skipped: [] });
  });

  // T055
  it("requires admin_ui admin permission — a non-org-admin (e.g. owning team's admin) is rejected", async () => {
    mockRequireRbacPermission.mockRejectedValue(new Error("forbidden"));
    const { POST } = await import("../route");

    await expect(POST(postRequest(), params())).rejects.toThrow("forbidden");
    expect(mockRequireRbacPermission).toHaveBeenCalledWith(session, "admin_ui", "admin");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });

  // T054
  it("adopts an eligible record and returns 200 with the updated record", async () => {
    sources.findOne
      .mockResolvedValueOnce({ ...eligibleSource })
      .mockResolvedValueOnce({
        ...eligibleSource,
        config_driven: false,
        config_import_adopted: true,
        owner_team_slug: "platform",
      });
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({ owner_team_slug: "platform" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({ config_driven: false, config_import_adopted: true });
    expect(mockAdoptConfigImportedRagSources).toHaveBeenCalledWith(
      ["slack-channel-C1"],
      { ownerTeamSlug: "platform" },
    );
  });

  it("rejects the removed management-sharing field", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({ owner_team_slug: "platform", shared_with_teams: ["secondary"] }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.code).toBe("MANAGEMENT_SHARING_NOT_SUPPORTED");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });

  it("requires one management owner team", async () => {
    const { POST } = await import("../route");

    const response = await POST(postRequest({}), params());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.code).toBe("OWNER_TEAM_REQUIRED");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });

  // T056
  it("returns 409 SOURCE_NOT_ADOPTABLE for an already-adopted record", async () => {
    sources.findOne.mockResolvedValue({
      ...eligibleSource,
      config_driven: false,
      config_import_adopted: true,
    });
    const { POST } = await import("../route");

    const response = await POST(postRequest(), params());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.code).toBe("SOURCE_NOT_ADOPTABLE");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });

  // T056
  it("returns 409 SOURCE_NOT_ADOPTABLE for a DB-native (never config-driven) record", async () => {
    sources.findOne.mockResolvedValue({
      ...eligibleSource,
      config_driven: false,
      config_import_adopted: false,
    });
    const { POST } = await import("../route");

    const response = await POST(postRequest(), params());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.code).toBe("SOURCE_NOT_ADOPTABLE");
  });

  it("returns 404 SOURCE_NOT_FOUND for a nonexistent id", async () => {
    sources.findOne.mockResolvedValue(null);
    const { POST } = await import("../route");

    const response = await POST(postRequest(), params("no-such-source"));
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.code).toBe("SOURCE_NOT_FOUND");
  });

  it("returns 404 OWNER_TEAM_NOT_FOUND for an unknown owner_team_slug", async () => {
    teams.findOne.mockResolvedValue(null);
    const { POST } = await import("../route");

    const response = await POST(postRequest({ owner_team_slug: "no-such-team" }), params());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.code).toBe("OWNER_TEAM_NOT_FOUND");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });
});
