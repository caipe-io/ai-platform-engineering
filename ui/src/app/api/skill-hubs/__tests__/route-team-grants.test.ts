/**
 * @jest-environment node
 */

const mockGetCollection = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    validateCredentialsRef: jest.fn((value) => value ?? null),
    getAuthFromBearerOrSession: jest.fn(async () => ({
      user: { email: "admin@example.com", role: "admin" },
      session: { sub: "admin-sub", role: "admin", user: { email: "admin@example.com" } },
    })),
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
    withErrorHandler:
      <T,>(handler: (request: Request, context?: unknown) => Promise<T>) =>
      async (request: Request, context?: unknown) => {
        try {
          return await handler(request, context);
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "error" },
            { status: (error as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

describe("skill hubs team grants config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  });

  it("lists skill hubs for authenticated read-only dashboard viewers", async () => {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "skill_hubs") {
        return {
          find: jest.fn().mockReturnValue({
            sort: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([
                {
                  id: "hub-1",
                  type: "github",
                  location: "caipe-io/ai-platform-engineering",
                  enabled: true,
                  credentials_ref: null,
                  labels: [],
                  last_success_at: null,
                  last_failure_at: null,
                  last_failure_message: null,
                  created_at: "2026-05-20T00:00:00.000Z",
                  updated_at: "2026-05-20T00:00:00.000Z",
                },
              ]),
            }),
          }),
        };
      }
      return {
        aggregate: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      };
    });
    const { GET } = await import("../route");

    const response = await GET(new Request("http://localhost/api/skill-hubs") as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:admin-sub",
      relation: "can_read",
      object: "admin_surface:skills",
    });
    expect(body.hubs).toEqual([
      expect.objectContaining({
        id: "hub-1",
        location: "caipe-io/ai-platform-engineering",
      }),
    ]);
  });

  it("persists selected teams when registering a hub", async () => {
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "hub" });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    });
    const { POST } = await import("../route");

    const response = await POST(
      new Request("http://localhost/api/skill-hubs", {
        method: "POST",
        body: JSON.stringify({
          type: "github",
          location: "owner/repo",
          shared_with_teams: ["platform", "platform", "sre"],
        }),
      }) as never,
    );

    expect(response.status).toBe(201);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:admin-sub",
      relation: "can_manage",
      object: "admin_surface:skills",
    });
    expect(insertOne.mock.calls[0][0].shared_with_teams).toEqual(["platform", "sre"]);
  });

  it("denies registering a hub when OpenFGA does not grant skills management", async () => {
    const insertOne = jest.fn();
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    });
    const { POST } = await import("../route");

    const response = await POST(
      new Request("http://localhost/api/skill-hubs", {
        method: "POST",
        body: JSON.stringify({
          type: "github",
          location: "owner/repo",
        }),
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(insertOne).not.toHaveBeenCalled();
  });
});
