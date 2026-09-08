/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();
const mockGetUserTeamIds = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGrantSkillsToTeams = jest.fn();
const mockReconcileSkillTeamShares = jest.fn();
const mockReadSkillSharedTeamSlugsFromOpenFga = jest.fn(
  async () => [] as string[],
);

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
  const session = {
    sub: "alice-sub",
    role: "user",
    realm_access: { roles: [] },
  };

  return {
    ApiError,
    getUserTeamIds: (...args: unknown[]) => mockGetUserTeamIds(...args),
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
  requireSkillPermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/skill-team-grants", () => ({
  grantSkillsToTeams: (...args: unknown[]) => mockGrantSkillsToTeams(...args),
  reconcileSkillTeamShares: (...args: unknown[]) =>
    mockReconcileSkillTeamShares(...args),
  readSkillSharedTeamSlugsFromOpenFga: (...args: unknown[]) =>
    mockReadSkillSharedTeamSlugsFromOpenFga(...args),
}));

jest.mock("@/lib/agent-skill-visibility", () => ({
  getAgentSkillVisibleToUser: jest.fn(async (id: string) => {
    const { getCollection } = jest.requireMock("@/lib/mongodb");
    const collection = await getCollection();
    return collection.findOne({ id });
  }),
  hydrateAgentSkillTeamShares: jest.fn(async (skill: { id: string }) => skill),
  hydrateAgentSkillTeamSharesList: jest.fn(async (skills: unknown[]) => skills),
}));

jest.mock("@/lib/rbac/keycloak-resource-sync", () => ({
  syncSkillResource: jest.fn(),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  deleteAllSkillRelationshipTuples: jest.fn(),
}));

jest.mock("@/lib/rbac/task-skill-realm-access", () => ({
  extractRealmRolesFromSession: jest.fn(() => []),
  extractSkillAccessFromJwtRoles: jest.fn(() => ({ allGrantedSkillIds: [] })),
}));

jest.mock("@/lib/skill-scan", () => ({
  scanSkillContent: jest.fn(async () => ({ scan_status: "unscanned" })),
}));

jest.mock("@/lib/skill-scan-history", () => ({
  recordScanEvent: jest.fn(),
}));

jest.mock("@/lib/skill-revisions", () => ({
  deleteRevisionsForSkill: jest.fn(),
  recordRevision: jest.fn(),
  snapshotsDiffer: jest.fn(() => true),
}));

function request(path = "/api/skills/configs"): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("GET /api/skills/configs RBAC cutover", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserTeamIds.mockResolvedValue(["legacy-team"]);
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, items) => items,
    );
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockGrantSkillsToTeams.mockResolvedValue({
      enabled: true,
      writesApplied: 1,
    });
    mockReconcileSkillTeamShares.mockResolvedValue({
      enabled: true,
      writes: 1,
      deletes: 0,
    });
  });

  it("hides another user's private skill before OpenFGA discovery", async () => {
    const skills = [
      {
        id: "skill-a",
        name: "Allowed",
        visibility: "private",
        owner_id: "bob@example.com",
      },
      { id: "skill-b", name: "Denied", visibility: "global" },
    ];
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, items) => items,
    );
    const sort = jest
      .fn()
      .mockReturnValue({ toArray: jest.fn().mockResolvedValue(skills) });
    const find = jest.fn().mockReturnValue({ sort });
    mockGetCollection.mockResolvedValue({ find });
    const { GET } = await import("../route");

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetUserTeamIds).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalledWith({});
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      [skills[1]],
      { type: "skill", action: "discover", id: expect.any(Function) },
    );
    expect(body).toEqual([expect.objectContaining({ id: "skill-b" })]);
  });

  it("does not reveal another user's private skill by id", async () => {
    const skill = {
      id: "skill-openfga-only",
      name: "OpenFGA Only",
      visibility: "private",
      owner_id: "bob@example.com",
    };
    const findOne = jest.fn(async (query: Record<string, unknown>) =>
      Object.keys(query).length === 1 && query.id === skill.id ? skill : null,
    );
    mockGetCollection.mockResolvedValue({ findOne });
    const { GET } = await import("../route");

    const response = await GET(
      request("/api/skills/configs?id=skill-openfga-only"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(findOne).toHaveBeenCalledWith({ id: "skill-openfga-only" });
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(body).toMatchObject({ success: false });
  });

  it("updates a shared skill when OpenFGA grants write", async () => {
    const skill = {
      id: "skill-openfga-write",
      name: "OpenFGA Write",
      description: "before",
      visibility: "team",
      shared_with_teams: ["platform"],
      owner_id: "bob@example.com",
      is_system: false,
      tasks: [
        { display_text: "Task", llm_prompt: "Do it", subagent: "skills" },
      ],
    };
    const ready = {
      ...skill,
      description: "after",
      authz_revision: 1,
      authz_sync_state: "ready",
      authz_last_synced_revision: 1,
    };
    const findOne = jest.fn().mockResolvedValue(skill);
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValueOnce({ ...ready, authz_sync_state: "pending" })
      .mockResolvedValueOnce(ready);
    mockGetCollection.mockResolvedValue({ findOne, findOneAndUpdate });
    const { PUT } = await import("../route");

    const response = await PUT(
      new NextRequest(
        new URL(
          "/api/skills/configs?id=skill-openfga-write",
          "http://localhost:3000",
        ),
        {
          method: "PUT",
          body: JSON.stringify({ description: "after" }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "skill-openfga-write",
      "write",
    );
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "skill-openfga-write" }),
      expect.objectContaining({
        $set: expect.objectContaining({ description: "after" }),
      }),
      { returnDocument: "after" },
    );
  });

  it("grants selected teams OpenFGA skill use when creating a team-visible skill", async () => {
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "inserted" });
    mockGetCollection.mockResolvedValue({ insertOne });
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest(new URL("/api/skills/configs", "http://localhost:3000"), {
        method: "POST",
        body: JSON.stringify({
          name: "Team Owned Skill",
          category: "Custom",
          tasks: [
            { display_text: "Do it", llm_prompt: "Do it", subagent: "skills" },
          ],
          visibility: "team",
          shared_with_teams: ["platform"],
        }),
      }),
    );

    expect(response.status).toBe(201);
    const savedSkill = insertOne.mock.calls[0][0];
    // Convergence (2026-06-04): create now reconciles team shares through the
    // shared shareable-resource reconciler (diff-based) instead of the
    // write-only grant helper. Fresh create has no previous shares to revoke.
    expect(mockReconcileSkillTeamShares).toHaveBeenCalledWith(
      {
        skillId: savedSkill.id,
        ownerSubject: "alice-sub",
        previousTeamRefs: [],
        nextTeamRefs: ["platform"],
        nextVisibility: "team",
      },
      expect.objectContaining({ verifyHigherConsistency: true }),
    );
  });

  it("revokes un-shared teams on update (shared reconciler diff)", async () => {
    mockReadSkillSharedTeamSlugsFromOpenFga.mockResolvedValue([
      "platform",
      "sre",
    ]);
    const skill = {
      id: "skill-reshared",
      name: "Reshared",
      description: "before",
      visibility: "team",
      owner_id: "alice@example.com",
      is_system: false,
      shared_with_teams: ["platform", "sre"],
      tasks: [
        { display_text: "Task", llm_prompt: "Do it", subagent: "skills" },
      ],
    };
    const findOne = jest.fn().mockResolvedValue(skill);
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValueOnce({
        ...skill,
        shared_with_teams: ["platform"],
        authz_sync_state: "pending",
      })
      .mockResolvedValueOnce({
        ...skill,
        shared_with_teams: ["platform"],
        owner_subject: "alice-sub",
        authz_revision: 1,
        authz_sync_state: "ready",
        authz_last_synced_revision: 1,
      });
    mockGetCollection.mockResolvedValue({ findOne, findOneAndUpdate });
    const { PUT } = await import("../route");

    const response = await PUT(
      new NextRequest(
        new URL(
          "/api/skills/configs?id=skill-reshared",
          "http://localhost:3000",
        ),
        {
          method: "PUT",
          body: JSON.stringify({
            visibility: "team",
            shared_with_teams: ["platform"],
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    // Dropping "sre" from the shared set must reach the reconciler with the
    // previous and next team sets so the stale grant is revoked, not orphaned.
    expect(mockReconcileSkillTeamShares).toHaveBeenLastCalledWith(
      {
        skillId: "skill-reshared",
        ownerSubject: "alice-sub",
        previousTeamRefs: ["platform", "sre"],
        nextTeamRefs: ["platform"],
        nextVisibility: "team",
        previousVisibility: "team",
      },
      expect.objectContaining({ verifyHigherConsistency: true }),
    );
  });

  it("revokes all team shares when demoting to private visibility", async () => {
    mockReadSkillSharedTeamSlugsFromOpenFga.mockResolvedValue(["platform"]);
    const skill = {
      id: "skill-private",
      name: "Hello",
      description: "before",
      visibility: "team",
      owner_id: "alice@example.com",
      is_system: false,
      shared_with_teams: ["platform"],
      tasks: [
        { display_text: "Task", llm_prompt: "Do it", subagent: "skills" },
      ],
    };
    const findOne = jest.fn().mockResolvedValue(skill);
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValueOnce({
        ...skill,
        visibility: "private",
        authz_sync_state: "pending",
      })
      .mockResolvedValueOnce({
        ...skill,
        visibility: "private",
        shared_with_teams: [],
        owner_subject: "alice-sub",
        authz_revision: 1,
        authz_sync_state: "ready",
        authz_last_synced_revision: 1,
      });
    mockGetCollection.mockResolvedValue({ findOne, findOneAndUpdate });
    const { PUT } = await import("../route");

    const response = await PUT(
      new NextRequest(
        new URL(
          "/api/skills/configs?id=skill-private",
          "http://localhost:3000",
        ),
        {
          method: "PUT",
          body: JSON.stringify({ visibility: "private" }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileSkillTeamShares).toHaveBeenLastCalledWith(
      {
        skillId: "skill-private",
        ownerSubject: "alice-sub",
        previousTeamRefs: ["platform"],
        nextTeamRefs: [],
        nextVisibility: "private",
        previousVisibility: "team",
      },
      expect.objectContaining({ verifyHigherConsistency: true }),
    );
  });
});
