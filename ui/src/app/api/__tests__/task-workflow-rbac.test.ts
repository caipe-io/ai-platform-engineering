/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();
const mockGetUserTeamIds = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();

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
  const user = { email: "alice@example.com", role: "user" };
  const session = { sub: "alice-sub", role: "user" };
  return {
    ApiError,
    getUserTeamIds: (...args: unknown[]) => mockGetUserTeamIds(...args),
    requireRbacPermission: (...args: unknown[]) =>
      mockRequireRbacPermission(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withAuth: async (
      _request: NextRequest,
      handler: (...args: unknown[]) => Promise<Response>,
    ) => handler(_request, user, session),
    withErrorHandler:
      <T>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          return Response.json(
            {
              success: false,
              error: error instanceof Error ? error.message : "error",
            },
            { status: (error as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  subjectFromSession: () => "alice-sub",
}));

jest.mock("@/lib/rbac/openfga-team-membership", () => ({
  listUserTeamSlugs: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/server/workflow-cas-authz", () => ({
  filterAccessibleWorkflowConfigs: jest.fn(),
  workflowAccessAllowed: jest.fn().mockResolvedValue(false),
  requireWorkflowAccess: jest.fn(),
  requireWorkflowRunAccess: jest.fn(),
  workflowSubjectFromSession: jest.fn(() => ({
    type: "user",
    id: "alice-sub",
  })),
}));

const mockFilterAccessibleWorkflowConfigs = jest.requireMock(
  "@/lib/server/workflow-cas-authz",
).filterAccessibleWorkflowConfigs as jest.Mock;

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("workflow config RBAC cutover", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserTeamIds.mockResolvedValue(["legacy-team"]);
    mockRequireRbacPermission.mockRejectedValue(new Error("not admin"));
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, items) => items,
    );
    mockFilterAccessibleWorkflowConfigs.mockImplementation(
      async (_session, items) => items,
    );
  });

  it("hides another user's private workflow before OpenFGA discovery", async () => {
    const configs = [
      {
        _id: "wf-openfga",
        name: "OpenFGA Workflow",
        visibility: "private",
        owner_id: "bob@example.com",
      },
      {
        _id: "wf-global",
        name: "Global Workflow",
        visibility: "global",
        owner_id: "system",
      },
    ];
    mockFilterAccessibleWorkflowConfigs.mockResolvedValue([configs[1]]);
    const sort = jest
      .fn()
      .mockReturnValue({ toArray: jest.fn().mockResolvedValue(configs) });
    const find = jest.fn().mockReturnValue({ sort });
    const teamsCollection = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "teams" ? teamsCollection : { find },
    );
    const { GET } = await import("../workflow-configs/route");

    const response = await GET(request("/api/workflow-configs"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetUserTeamIds).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalledWith({});
    expect(mockFilterAccessibleWorkflowConfigs).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      [configs[1]],
      expect.any(Function),
      "read",
    );
    expect(body).toEqual(
      expect.arrayContaining([expect.objectContaining({ _id: "wf-global" })]),
    );
    expect(body).toHaveLength(1);
  });
});
