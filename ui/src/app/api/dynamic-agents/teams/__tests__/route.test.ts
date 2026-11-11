/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockGetRbacCollection = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
  successResponse: (data: unknown) => Response.json({ success: true, data }),
  withErrorHandler:
    <T,>(handler: (request: NextRequest) => Promise<T>) =>
    async (request: NextRequest) => handler(request),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/mongo-collections", () => ({
  getRbacCollection: (...args: unknown[]) => mockGetRbacCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
  filterResourcesByPermission: (...args: unknown[]) => mockFilterResourcesByPermission(...args),
}));

const session = { sub: "alice-sub" };
const user = { email: "alice@example.com" };

describe("GET /api/dynamic-agents/teams", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    mockRequireResourcePermission.mockRejectedValue(new Error("not org admin"));
    mockFilterResourcesByPermission.mockImplementation(async (_session, resources) => resources);
  });

  it("marks can_own_agents for team members, not just admins", async () => {
    mockGetRbacCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { team_slug: "platform", relationship: "member", status: "active", user_email: "alice@example.com" },
          { team_slug: "sre", relationship: "admin", status: "active", user_email: "alice@example.com" },
        ]),
      }),
    });
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { _id: "team-1", name: "Platform", slug: "platform" },
          { _id: "team-2", name: "SRE", slug: "sre" },
        ]),
      }),
    });

    const { GET } = await import("../route");
    const response = await GET(new NextRequest("http://localhost/api/dynamic-agents/teams"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "platform", user_role: "member", can_own_agents: true }),
        expect.objectContaining({ slug: "sre", user_role: "admin", can_own_agents: true }),
      ]),
    );
  });

  it("does not offer foreign teams as owners just because the caller manages the organization", async () => {
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { _id: "team-1", name: "Primary", slug: "primary" },
          { _id: "team-2", name: "Secondary", slug: "secondary" },
          { _id: "team-3", name: "Other", slug: "other" },
          { _id: "team-4", name: "Legacy without slug" },
        ]),
      }),
    });
    mockFilterResourcesByPermission.mockImplementation(async (_session, _resources, target) =>
      target.action === "use" ? ["primary"] : ["secondary"],
    );

    const { GET } = await import("../route");
    const response = await GET(new NextRequest("http://localhost/api/dynamic-agents/teams"));
    const body = await response.json();

    expect(body.data).toEqual([
      expect.objectContaining({ slug: "primary", user_role: "member", can_own_agents: true }),
      expect.objectContaining({ slug: "secondary", user_role: "admin", can_own_agents: true }),
      expect.objectContaining({ slug: "other", user_role: null, can_own_agents: false }),
      expect.objectContaining({ name: "Legacy without slug", can_own_agents: false }),
    ]);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledTimes(2);
    expect(mockGetRbacCollection).not.toHaveBeenCalled();
  });

  it("keeps a membership record visible but disables ownership when its authorization grants are missing", async () => {
    mockGetRbacCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { team_slug: "primary", relationship: "member", status: "active", user_email: user.email },
        ]),
      }),
    });
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ _id: "team-1", name: "Primary", slug: "primary" }]),
      }),
    });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const { GET } = await import("../route");
    const response = await GET(new NextRequest("http://localhost/api/dynamic-agents/teams"));

    expect((await response.json()).data).toEqual([
      expect.objectContaining({ slug: "primary", user_role: "member", can_own_agents: false }),
    ]);
  });
});
