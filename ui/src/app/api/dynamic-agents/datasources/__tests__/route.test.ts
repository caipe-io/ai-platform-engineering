/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockListTeamKbGrants = jest.fn();
const mockManageableDatasourceIdsForCollectionPublishing = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...args: unknown[]) =>
    mockGetAuthFromBearerOrSession(...args),
  successResponse: (data: unknown) => Response.json({ success: true, data }),
  withErrorHandler:
    <T>(handler: (request: NextRequest) => Promise<T>) =>
    async (request: NextRequest) =>
      handler(request),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/team-resource-listing", () => ({
  listTeamKbGrants: (...args: unknown[]) => mockListTeamKbGrants(...args),
}));

jest.mock("@/lib/rag-collections.server", () => ({
  manageableDatasourceIdsForCollectionPublishing: (...args: unknown[]) =>
    mockManageableDatasourceIdsForCollectionPublishing(...args),
}));

const session = { sub: "alice-sub", accessToken: "token-123" };
const user = { email: "alice@example.com" };

describe("GET /api/dynamic-agents/datasources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockManageableDatasourceIdsForCollectionPublishing.mockImplementation(
      async (_session, ids: string[]) => new Set(ids),
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        datasources: [
          {
            datasource_id: "kb-1",
            name: "Runbooks",
            _permissions: { can_read_content: true },
          },
          {
            datasource_id: "kb-2",
            name: "Support Docs",
            _permissions: { can_read_content: true },
          },
        ],
      }),
    });
  });

  it("returns caller-readable personal sources when no team_slug is provided", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest("http://localhost/api/dynamic-agents/datasources"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      datasources: [
        { datasource_id: "kb-1", name: "Runbooks", permission: "Your access" },
        {
          datasource_id: "kb-2",
          name: "Support Docs",
          permission: "Your access",
        },
      ],
    });
    expect(mockListTeamKbGrants).not.toHaveBeenCalled();
  });

  it("includes datasource type metadata for branded agent cards", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        datasources: [
          {
            datasource_id: "slack-primary",
            name: "Primary Slack",
            source_type: "slack",
            _permissions: { can_read_content: true },
          },
        ],
      }),
    });

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest("http://localhost/api/dynamic-agents/datasources"),
    );
    const body = await response.json();

    expect(body.data.datasources).toEqual([
      {
        datasource_id: "slack-primary",
        name: "Primary Slack",
        source_type: "slack",
        permission: "Your access",
      },
    ]);
  });

  it("includes the latest successful ingestion counts for card rarity", async () => {
    (global.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/datasources")) {
          return {
            ok: true,
            json: async () => ({
              datasources: [
                {
                  datasource_id: "kb-rare",
                  name: "Rare runbooks",
                  source_type: "web",
                  _permissions: { can_read_content: true },
                },
              ],
            }),
          };
        }
        if (url.endsWith("/v1/jobs/batch")) {
          expect(init).toMatchObject({
            method: "POST",
            body: JSON.stringify({
              datasource_ids: ["kb-rare"],
              status_filter: ["completed", "completed_with_errors"],
            }),
          });
          return {
            ok: true,
            json: async () => ({
              jobs: {
                "kb-rare": [
                  {
                    status: "completed_with_errors",
                    created_at: 200,
                    document_count: 7,
                    chunk_count: 11,
                  },
                  {
                    status: "completed",
                    created_at: 100,
                    document_count: 4,
                    chunk_count: 6,
                  },
                ],
              },
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    );

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest("http://localhost/api/dynamic-agents/datasources"),
    );
    const body = await response.json();

    expect(body.data.datasources).toEqual([
      {
        datasource_id: "kb-rare",
        name: "Rare runbooks",
        source_type: "web",
        document_count: 7,
        chunk_count: 11,
        permission: "Your access",
      },
    ]);
  });

  it("joins the team's KB grants with RAG server display names", async () => {
    mockListTeamKbGrants.mockResolvedValue({
      kbIds: ["kb-1", "kb-2"],
      permissions: { "kb-1": "reader", "kb-2": "manager" },
    });

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/dynamic-agents/datasources?team_slug=platform",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListTeamKbGrants).toHaveBeenCalledWith("platform");
    expect(body.data.datasources).toEqual([
      { datasource_id: "kb-1", name: "Runbooks", permission: "reader" },
      { datasource_id: "kb-2", name: "Support Docs", permission: "manager" },
    ]);
  });

  it("falls back to raw ids when the RAG server lookup fails", async () => {
    mockListTeamKbGrants.mockResolvedValue({
      kbIds: ["kb-9"],
      permissions: { "kb-9": "reader" },
    });
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/dynamic-agents/datasources?team_slug=platform",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.datasources).toEqual([
      { datasource_id: "kb-9", name: "kb-9", permission: "reader" },
    ]);
  });

  it("does not offer a source the caller can manage but cannot query", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        datasources: [
          {
            datasource_id: "managed-only",
            name: "Managed only",
            _permissions: { can_read_content: false, can_manage_source: true },
          },
        ],
      }),
    });

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest("http://localhost/api/dynamic-agents/datasources"),
    );
    const body = await response.json();

    expect(body.data.datasources).toEqual([]);
  });

  it("offers management-only sources for collection publishing", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        datasources: [
          {
            datasource_id: "managed-only",
            name: "Managed only",
            _permissions: { can_read_content: false, can_manage_source: true },
          },
        ],
      }),
    });

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/dynamic-agents/datasources?purpose=publish",
      ),
    );
    const body = await response.json();

    expect(body.data.datasources).toEqual([
      {
        datasource_id: "managed-only",
        name: "Managed only",
        permission: "Manage source",
        can_manage: true,
        can_read: false,
      },
    ]);
  });

  it("keeps human-readable metadata for readable collection sources the caller cannot manage", async () => {
    mockManageableDatasourceIdsForCollectionPublishing.mockResolvedValue(
      new Set(),
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        datasources: [
          {
            datasource_id: "slack-channel-C00000000",
            name: "Slack: #primary",
            source_type: "slack",
            _permissions: {
              can_read_content: true,
              can_manage_source: false,
            },
          },
        ],
      }),
    });

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/dynamic-agents/datasources?purpose=publish",
      ),
    );
    const body = await response.json();

    expect(body.data.datasources).toEqual([
      {
        datasource_id: "slack-channel-C00000000",
        name: "Slack: #primary",
        source_type: "slack",
        permission: "Read source",
        can_manage: false,
        can_read: true,
      },
    ]);
  });

  it("falls back to the manage permission check when use is denied", async () => {
    mockRequireResourcePermission
      .mockRejectedValueOnce(new Error("cannot use"))
      .mockResolvedValueOnce(undefined);
    mockListTeamKbGrants.mockResolvedValue({ kbIds: [], permissions: {} });

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/dynamic-agents/datasources?team_slug=platform",
      ),
    );

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenNthCalledWith(
      1,
      session,
      { type: "team", id: "platform", action: "use" },
      { bypassForOrgAdmin: true },
    );
    expect(mockRequireResourcePermission).toHaveBeenNthCalledWith(
      2,
      session,
      { type: "team", id: "platform", action: "manage" },
      { bypassForOrgAdmin: true },
    );
  });

  it("propagates the error when neither use nor manage is permitted", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("forbidden"));

    const { GET } = await import("../route");
    await expect(
      GET(
        new NextRequest(
          "http://localhost/api/dynamic-agents/datasources?team_slug=platform",
        ),
      ),
    ).rejects.toThrow("forbidden");
    expect(mockListTeamKbGrants).not.toHaveBeenCalled();
  });
});
