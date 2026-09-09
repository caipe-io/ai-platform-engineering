/**
 * @jest-environment node
 */
/**
 * Tests for Agent Config Visibility / Sharing
 *
 * Covers:
 * - POST: creating configs with private/team/global visibility
 * - POST: validation (team requires shared_with_teams)
 * - GET: OpenFGA candidate loading (legacy visibility fields are metadata only)
 * - GET by ID: OpenFGA read gate
 * - PUT: visibility field updates and validation
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

const mockCollections: Record<string, ReturnType<typeof createMockCollection>> = {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) {
    mockCollections[name] = createMockCollection();
  }
  return Promise.resolve(mockCollections[name]);
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...(args as [string])),
  isMongoDBConfigured: true,
}));

// `requireResourcePermission` (added by 098-enterprise-rbac for skill
// visibility / share gates) calls `checkOpenFgaTuple`. Default-allow so
// these tests just exercise the route's own visibility validation.
// `writeOpenFgaTupleDiff` is invoked by `grantSkillsToTeams` for team
// visibility creates; stub it out so the tests don't touch the real PDP.
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: true }),
  writeOpenFgaTupleDiff: jest
    .fn()
    .mockResolvedValue({ writes: 0, deletes: 0, enabled: false }),
  writeOpenFgaTuples: jest.fn().mockResolvedValue(undefined),
  deleteOpenFgaTuples: jest.fn().mockResolvedValue(undefined),
  isOpenFgaReconciliationEnabled: jest.fn().mockReturnValue(false),
  readOpenFgaTuples: jest.fn().mockResolvedValue({ tuples: [], continuationToken: undefined }),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: jest.fn(async (_session, resources: unknown[]) => resources),
  requireResourcePermission: jest.fn().mockResolvedValue(undefined),
  requireSkillPermission: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/rbac/skill-team-grants", () => ({
  reconcileSkillTeamShares: jest.fn().mockResolvedValue({
    teamSlugs: [],
    writesPlanned: 0,
    writesApplied: 0,
    deletesPlanned: 0,
    deletesApplied: 0,
    enabled: false,
  }),
  readSkillSharedTeamSlugsFromOpenFga: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/agent-skill-visibility", () => ({
  getAgentSkillVisibleToUser: jest.fn(async () => {
    const { getCollection } = jest.requireMock("@/lib/mongodb");
    const collection = await getCollection("agent_skills");
    return collection.findOne();
  }),
  hydrateAgentSkillTeamShares: jest.fn(async (skill: unknown) => skill),
  hydrateAgentSkillTeamSharesList: jest.fn(async (skills: unknown[]) => skills),
}));

function createMockCollection() {
  const findReturnValue: Record<string, jest.Mock> = {};
  findReturnValue.project = jest.fn().mockReturnValue(findReturnValue);
  findReturnValue.sort = jest.fn().mockReturnValue(findReturnValue);
  findReturnValue.limit = jest.fn().mockReturnValue(findReturnValue);
  findReturnValue.toArray = jest.fn().mockResolvedValue([]);

  return {
    find: jest.fn().mockReturnValue(findReturnValue),
    findOne: jest.fn().mockResolvedValue(null),
    findOneAndUpdate: jest.fn().mockImplementation(
      async (_filter: unknown, update: { $set?: Record<string, unknown> }) => ({
        id: "config-1",
        ...(update.$set ?? {}),
      }),
    ),
    insertOne: jest.fn().mockResolvedValue({ insertedId: "test-id" }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1, acknowledged: true }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), options);
}

function userSession(email = "user@example.com") {
  return {
    user: { email, name: "Test User" },
    role: "user",
    sub: "user-sub",
  };
}

const VALID_TASK = {
  display_text: "Test task",
  llm_prompt: "Do something",
  subagent: "user_input",
};

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST - Create with visibility
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/skills/configs - visibility", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(userSession());
  });

  it("should default to 'private' visibility when not specified", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Skill",
        category: "Custom",
        tasks: [VALID_TASK],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.visibility).toBe("private");
    expect(insertedConfig.shared_with_teams).toEqual([]);
  });

  it("should create with 'global' visibility", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Global Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        visibility: "global",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.visibility).toBe("global");
    expect(insertedConfig.shared_with_teams).toEqual([]);
  });

  it("should create with 'team' visibility and shared_with_teams", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Team Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        visibility: "team",
        shared_with_teams: ["team-1", "team-2"],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.visibility).toBe("team");
    expect(insertedConfig.shared_with_teams).toEqual(["team-1", "team-2"]);
  });

  it("should reject 'team' visibility without shared_with_teams", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad Team Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        visibility: "team",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("team");
  });

  it("should reject 'team' visibility with empty shared_with_teams array", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad Team Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        visibility: "team",
        shared_with_teams: [],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should reject invalid visibility value", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad Visibility",
        category: "Custom",
        tasks: [VALID_TASK],
        visibility: "invalid",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid visibility");
  });

  it("should clear shared_with_teams when visibility is not 'team'", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Global Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        visibility: "global",
        shared_with_teams: ["team-1"],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.visibility).toBe("global");
    expect(insertedConfig.shared_with_teams).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET - OpenFGA candidate loading
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/skills/configs - OpenFGA candidate loading", () => {
  it("loads all skill configs as candidates instead of filtering by global visibility in MongoDB", async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const { GET } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs");
    await GET(request);

    const collection = await mockGetCollection("agent_skills");
    expect(collection.find).toHaveBeenCalledWith({});
  });

  it("does not use owner/system visibility clauses as MongoDB authorization prefilters", async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const { GET } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs");
    await GET(request);

    const collection = await mockGetCollection("agent_skills");
    const findCall = collection.find.mock.calls[0][0];
    expect(findCall).toEqual({});
  });

  it("does not resolve team membership for legacy team visibility filtering", async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const teamsCollection = createMockCollection();
    teamsCollection.find.mockReturnValue({
      project: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { _id: "team-abc" },
          { _id: "team-xyz" },
        ]),
      }),
    });
    mockCollections["teams"] = teamsCollection;

    const { GET } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs");
    await GET(request);

    const agentCollection = await mockGetCollection("agent_skills");
    expect(agentCollection.find).toHaveBeenCalledWith({});
    expect(teamsCollection.find).not.toHaveBeenCalled();
  });

  it("keeps team visibility out of the MongoDB query when no teams are present", async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const { GET } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs");
    await GET(request);

    const collection = await mockGetCollection("agent_skills");
    const findCall = collection.find.mock.calls[0][0];
    expect(findCall).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT - Visibility updates
// ─────────────────────────────────────────────────────────────────────────────
describe("PUT /api/skills/configs - visibility updates", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(userSession());
  });

  it("should reject invalid visibility in update", async () => {
    const configsCollection = createMockCollection();
    configsCollection.findOne.mockResolvedValue({
      id: "config-1",
      owner_id: "user@example.com",
      is_system: false,
    });
    mockCollections["agent_skills"] = configsCollection;

    const { PUT } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs?id=config-1", {
      method: "PUT",
      body: JSON.stringify({ visibility: "invalid" }),
    });

    const response = await PUT(request);
    expect(response.status).toBe(400);
  });

  it("should reject team visibility without teams in update", async () => {
    const configsCollection = createMockCollection();
    configsCollection.findOne.mockResolvedValue({
      id: "config-1",
      owner_id: "user@example.com",
      is_system: false,
    });
    mockCollections["agent_skills"] = configsCollection;

    const { PUT } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs?id=config-1", {
      method: "PUT",
      body: JSON.stringify({ visibility: "team" }),
    });

    const response = await PUT(request);
    expect(response.status).toBe(400);
  });

  it("should clear shared_with_teams when changing to non-team visibility", async () => {
    const configsCollection = createMockCollection();
    configsCollection.findOne
      .mockResolvedValueOnce({
        id: "config-1",
        owner_id: "user@example.com",
        is_system: false,
        visibility: "team",
        shared_with_teams: ["team-1"],
      })
      .mockResolvedValueOnce({
        id: "config-1",
        visibility: "private",
      });
    mockCollections["agent_skills"] = configsCollection;

    const { PUT } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs?id=config-1", {
      method: "PUT",
      body: JSON.stringify({ visibility: "private" }),
    });

    const response = await PUT(request);
    expect(response.status).toBe(200);

    const updateCall = configsCollection.findOneAndUpdate.mock.calls[0][1];
    expect(updateCall.$set.shared_with_teams).toEqual([]);
  });
});
