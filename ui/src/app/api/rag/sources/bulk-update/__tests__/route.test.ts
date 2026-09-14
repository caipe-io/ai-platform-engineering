/**
 * @jest-environment node
 *
 * `POST /api/rag/sources/bulk-update` — a self-service tool, not an admin
 * bypass. Every source goes through the exact same `PATCH /api/rag/sources/
 * [sourceId]` handler this route imports and invokes in-process, so these
 * tests mock that import and assert on how it's called and how its response
 * is classified - the PATCH handler's own authorization/approval logic has
 * its own dedicated test coverage.
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockPatchSource = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown) => Response.json({ success: true, data }),
    withErrorHandler:
      <T>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          const { ApiError } = actual;
          if (error instanceof ApiError) {
            return Response.json(
              { success: false, error: error.message, code: error.code },
              { status: error.statusCode },
            );
          }
          throw error;
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("../../[sourceId]/route", () => ({
  PATCH: (...args: unknown[]) => mockPatchSource(...args),
}));

const session = { sub: "alice-sub", accessToken: "token-123" };

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/rag/sources/bulk-update", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function mockSources(docs: Array<Record<string, unknown>>): void {
  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "rag_ingestion_sources") {
      return {
        findOne: jest.fn(async ({ source_id }: { source_id: string }) =>
          docs.find((d) => d.source_id === source_id) ?? null,
        ),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  });
}

function patchResponse(status: number, data: Record<string, unknown>): Response {
  return Response.json({ success: status < 300, data, code: data.code }, { status });
}

describe("POST /api/rag/sources/bulk-update", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session });
    mockSources([
      { source_id: "source-a", search_with_teams: ["existing-team"], search_with_users: [] },
      { source_id: "source-b", search_with_teams: [], search_with_users: ["existing-user"] },
    ]);
  });

  it("rejects an empty source_ids array", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ source_ids: [] }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_SOURCE_IDS");
  });

  it("rejects a request that applies neither an Owner nor Search Access", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ source_ids: ["source-a"] }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("NOTHING_TO_APPLY");
  });

  it("rejects an owner with neither a team_slug nor a subject", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({ source_ids: ["source-a"], owner: {} }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("OWNER_REQUIRED");
  });

  it("invokes the single-source PATCH handler per source, forwarding the Authorization and Cookie headers", async () => {
    mockPatchSource.mockResolvedValue(patchResponse(200, { source_id: "source-a" }));
    const { POST } = await import("../route");
    await POST(
      request(
        { source_ids: ["source-a"], owner: { team_slug: "new-owner-team" } },
        { Authorization: "Bearer caller-token", Cookie: "next-auth.session-token=abc" },
      ),
    );

    expect(mockPatchSource).toHaveBeenCalledTimes(1);
    const [syntheticRequest, context] = mockPatchSource.mock.calls[0];
    expect(syntheticRequest.method).toBe("PATCH");
    expect(syntheticRequest.headers.get("Authorization")).toBe("Bearer caller-token");
    // Forwarded so each per-source call hits the same session-auth cache
    // the outer request already populated (getSessionAuthCacheKey hashes
    // this header), instead of re-running getServerSession() per source.
    expect(syntheticRequest.headers.get("Cookie")).toBe(
      "next-auth.session-token=abc",
    );
    expect(syntheticRequest.url).toContain("/api/rag/sources/source-a");
    await expect(context.params).resolves.toEqual({ sourceId: "source-a" });
    expect(await syntheticRequest.clone().json()).toEqual({
      owner_team_slug: "new-owner-team",
    });
  });

  it("classifies an updated source, a pending-approval source, and a forbidden source", async () => {
    mockPatchSource
      .mockResolvedValueOnce(patchResponse(200, { source_id: "source-a" }))
      .mockResolvedValueOnce(
        patchResponse(200, {
          source_id: "source-b",
          _publication_request: { id: "pr-1", status: "pending" },
        }),
      )
      .mockResolvedValueOnce(
        patchResponse(403, { code: "FORBIDDEN_MANAGE" } as never),
      );
    mockSources([
      { source_id: "source-a" },
      { source_id: "source-b" },
      { source_id: "source-c" },
    ]);
    const { POST } = await import("../route");
    const response = await POST(
      request({
        source_ids: ["source-a", "source-b", "source-c"],
        owner: { team_slug: "new-owner-team" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.results).toEqual(
      expect.arrayContaining([
        { source_id: "source-a", status: "updated" },
        { source_id: "source-b", status: "pending_approval" },
        { source_id: "source-c", status: "skipped", reason: "FORBIDDEN_MANAGE" },
      ]),
    );
    expect(body.data.updated_count).toBe(1);
    expect(body.data.pending_approval_count).toBe(1);
    expect(body.data.skipped_count).toBe(1);
  });

  it("skips a source_id that has no matching ingestion source document", async () => {
    mockSources([]);
    const { POST } = await import("../route");
    const response = await POST(
      request({ source_ids: ["missing-source"], owner: { team_slug: "new-owner-team" } }),
    );
    const body = await response.json();

    expect(body.data.results).toEqual([
      { source_id: "missing-source", status: "skipped", reason: "not_found" },
    ]);
    expect(mockPatchSource).not.toHaveBeenCalled();
  });

  it("replaces Search Access with exactly the requested list in replace mode", async () => {
    mockPatchSource.mockResolvedValue(patchResponse(200, { source_id: "source-a" }));
    const { POST } = await import("../route");
    await POST(
      request({
        source_ids: ["source-a"],
        search: { mode: "replace", team_slugs: ["new-team"], user_subjects: [] },
      }),
    );

    const [syntheticRequest] = mockPatchSource.mock.calls[0];
    expect(await syntheticRequest.clone().json()).toEqual({
      search_team_slugs: ["new-team"],
      search_user_subjects: [],
    });
  });

  it("unions with each source's own existing Search Access in additive mode", async () => {
    mockPatchSource.mockResolvedValue(patchResponse(200, { source_id: "source-a" }));
    const { POST } = await import("../route");
    await POST(
      request({
        source_ids: ["source-a", "source-b"],
        search: { mode: "additive", team_slugs: ["new-team"], user_subjects: ["new-user"] },
      }),
    );

    const bodies = mockPatchSource.mock.calls.map(([req]) =>
      req.clone().text(),
    );
    const [sourceABody, sourceBBody] = await Promise.all(bodies);
    // source-a already has team "existing-team"; source-b already has user "existing-user".
    expect(JSON.parse(sourceABody)).toEqual({
      search_team_slugs: ["existing-team", "new-team"],
      search_user_subjects: ["new-user"],
    });
    expect(JSON.parse(sourceBBody)).toEqual({
      search_team_slugs: ["new-team"],
      search_user_subjects: ["existing-user", "new-user"],
    });
  });

  it("isolates a per-source throw instead of failing the whole batch", async () => {
    mockPatchSource
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(patchResponse(200, { source_id: "source-b" }));
    const { POST } = await import("../route");
    const response = await POST(
      request({
        source_ids: ["source-a", "source-b"],
        owner: { team_slug: "new-owner-team" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.results).toEqual(
      expect.arrayContaining([
        { source_id: "source-a", status: "skipped", reason: "ERROR" },
        { source_id: "source-b", status: "updated" },
      ]),
    );
  });

  it("isolates a transient lookup failure for one source instead of failing the whole batch", async () => {
    mockPatchSource.mockResolvedValue(patchResponse(200, { source_id: "source-b" }));
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_ingestion_sources") {
        return {
          findOne: jest.fn(async ({ source_id }: { source_id: string }) => {
            if (source_id === "source-a") throw new Error("Mongo timeout");
            return { source_id };
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");
    const response = await POST(
      request({
        source_ids: ["source-a", "source-b"],
        owner: { team_slug: "new-owner-team" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.results).toEqual(
      expect.arrayContaining([
        { source_id: "source-a", status: "skipped", reason: "ERROR" },
        { source_id: "source-b", status: "updated" },
      ]),
    );
  });
});
