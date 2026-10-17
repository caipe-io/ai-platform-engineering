/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockCheckPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockConnectToDatabase = jest.fn();
const mockResolveSimulation = jest.fn();
const mockSimulationCanManage = jest.fn();

jest.mock("@/lib/rbac/admin-simulation-server", () => ({
  resolveAuthorizedAdminSimulationScope: (...args: unknown[]) => mockResolveSimulation(...args),
  simulationSubjectCanManageAdminSurface: (...args: unknown[]) => mockSimulationCanManage(...args),
}));

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(async () => null),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "ssoEnabled",
}));

jest.mock("@/lib/jwt-validation", () => ({
  validateLocalSkillsJWT: jest.fn(async () => null),
  validateBearerJWT: jest.fn(async () => ({
    sub: "bob-sub",
    email: "bob@example.com",
    name: "Bob Chat User",
  })),
}));

jest.mock("@/lib/rbac/keycloak-authz", () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
}));

jest.mock("@/lib/rbac/audit", () => ({
  logAuthzDecision: jest.fn(),
}));

const mockLoadTeamMembersForSlugs = jest.fn();
jest.mock("@/lib/rbac/team-membership-store", () => ({
  loadTeamMembersForSlugs: (...args: unknown[]) => mockLoadTeamMembersForSlugs(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  connectToDatabase: (...args: unknown[]) => mockConnectToDatabase(...args),
  isMongoDBConfigured: true,
}));

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: "GET",
    headers: { Authorization: "Bearer test-token" },
  });
}

async function expectStatsDenied(response: Response): Promise<void> {
  const body = await response.json();
  expect(response.status).toBe(403);
  expect(body.reason).toBe("pdp_denied");
  expect(body.code).toBe("admin_ui#view");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckPermission.mockResolvedValue({ allowed: false, reason: "DENY_NO_CAPABILITY" });
  mockLoadTeamMembersForSlugs.mockResolvedValue(new Map());
  mockResolveSimulation.mockResolvedValue(null);
  mockSimulationCanManage.mockResolvedValue(false);
});

describe("admin stats RBAC routes", () => {
  it("denies skill metrics for a simulated subject without platform-wide access before cache or queries", async () => {
    mockCheckPermission.mockResolvedValue({ allowed: true, reason: "ALLOW" });
    mockResolveSimulation.mockResolvedValue({ openfgaUser: "user:test-user" });
    const { GET } = await import("../skills/route");
    const response = await GET(request("/api/admin/stats/skills?simulate_user=test-user"));
    expect(response.status).toBe(403);
    expect(mockSimulationCanManage).toHaveBeenCalledWith({ openfgaUser: "user:test-user" }, "stats");
    expect(mockGetCollection).not.toHaveBeenCalled();
  });
  it("denies bearer users without admin_ui#view before loading skill stats", async () => {
    const { GET } = await import("../skills/route");

    const response = await GET(request("/api/admin/stats/skills"));

    await expectStatsDenied(response);
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("applies date, user, and web-only source filters to skill metrics", async () => {
    mockCheckPermission.mockResolvedValue({ allowed: true, reason: "ALLOW" });
    const configs = {
      find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    };
    const runs = {
      aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    };
    mockGetCollection.mockImplementation((name: string) => (
      name === "agent_skills" ? Promise.resolve(configs) : Promise.resolve(runs)
    ));
    const { GET } = await import("../skills/route");
    const from = "2026-06-01T00:00:00.000Z";
    const to = "2026-06-30T23:59:59.999Z";

    const response = await GET(request(
      `/api/admin/stats/skills?from=${from}&to=${to}&source=slack&user=person@example.com`,
    ));

    expect(response.status).toBe(200);
    expect(configs.find).toHaveBeenCalledWith({
      created_at: { $gte: new Date(from), $lte: new Date(to) },
      owner_id: "person@example.com",
    }, { maxTimeMS: 15000 });
    expect(configs.aggregate.mock.calls[0][0][0].$match).toEqual(expect.objectContaining({
      created_at: { $gte: new Date(from), $lte: new Date(to) },
      owner_id: "person@example.com",
    }));
    for (const [pipeline] of runs.aggregate.mock.calls) {
      expect(pipeline[0].$match).toEqual({
        started_at: { $gte: new Date(from), $lte: new Date(to) },
        owner_id: "person@example.com",
        _id: null,
      });
    }
  });

  it("resolves a selected team from the canonical roster for skill metrics", async () => {
    mockCheckPermission.mockResolvedValue({ allowed: true, reason: "ALLOW" });
    mockLoadTeamMembersForSlugs.mockResolvedValue(new Map([
      ["platform-team", [
        { user_email: "alice@example.com" },
        { user_email: "bob@example.com" },
      ]],
    ]));
    const configs = {
      find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    };
    const runs = {
      aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    };
    mockGetCollection.mockImplementation((name: string) => (
      name === "agent_skills" ? Promise.resolve(configs) : Promise.resolve(runs)
    ));
    const { GET } = await import("../skills/route");

    const response = await GET(request("/api/admin/stats/skills?team=platform-team"));

    expect(response.status).toBe(200);
    expect(mockLoadTeamMembersForSlugs).toHaveBeenCalledWith(["platform-team"]);
    expect(configs.find).toHaveBeenCalledWith(expect.objectContaining({
      owner_id: { $in: ["alice@example.com", "bob@example.com"] },
    }), { maxTimeMS: 15000 });
    for (const [pipeline] of runs.aggregate.mock.calls) {
      expect(pipeline[0].$match.owner_id).toEqual({
        $in: ["alice@example.com", "bob@example.com"],
      });
    }
  });
});
