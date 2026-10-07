/**
 * @jest-environment node
 */
// assisted-by cursor (composer-2-fast)
//
// Pins the access-control + happy path for the revisions endpoints.
// We deliberately mock the lib helpers (`listRevisions`, `getRevision`,
// `recordRevision`) so the route test stays focused on the HTTP
// surface — validation, auth, and shape of the response — without
// re-exercising the Mongo plumbing already covered by the helper
// unit tests.

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
}));

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(),
}));

const mockGetVisible = jest.fn();
jest.mock("@/lib/agent-skill-visibility", () => ({
  getAgentSkillVisibleToUser: (...args: unknown[]) =>
    mockGetVisible(...args),
}));

const mockListRevisions = jest.fn();
const mockGetRevision = jest.fn();
const mockRecordRevision = jest.fn();
jest.mock("@/lib/skill-revisions", () => ({
  listRevisions: (...args: unknown[]) => mockListRevisions(...args),
  getRevision: (...args: unknown[]) => mockGetRevision(...args),
  recordRevision: (...args: unknown[]) => mockRecordRevision(...args),
}));

const mockRunSkillScan = jest.fn();
jest.mock("@/lib/skill-scan", () => ({
  scanSkillContent: (...args: unknown[]) => mockRunSkillScan(...args),
}));

jest.mock("@/lib/skill-scan-history", () => ({
  recordScanEvent: jest.fn().mockResolvedValue(undefined),
}));

// 098-enterprise-rbac added a `requireResourcePermission` gate that needs
// `session.sub` and calls `checkOpenFgaTuple`. Allow it by default so
// these tests focus on the visibility / revisions surface they were
// originally written to pin.
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireSkillPermission: jest.fn().mockResolvedValue(undefined),
}));

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

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServerSession.mockResolvedValue(userSession());
});

// ---------------------------------------------------------------------------
// GET /api/skills/configs/[id]/revisions
// ---------------------------------------------------------------------------

describe("GET /api/skills/configs/[id]/revisions", () => {
  it("returns 404 when the user can't see the skill (no leak via 403)", async () => {
    mockGetVisible.mockResolvedValue(null);
    const { GET } = await import("../route");
    const res = await GET(
      makeRequest("/api/skills/configs/skill-x/revisions"),
      { params: Promise.resolve({ id: "skill-x" }) },
    );
    expect(res.status).toBe(404);
    // The visibility helper masks both "doesn't exist" and "not
    // visible" as the same response — we never want to leak which.
    expect(mockListRevisions).not.toHaveBeenCalled();
  });

  it("returns the revision summaries for a visible skill", async () => {
    mockGetVisible.mockResolvedValue({
      id: "skill-x",
      name: "Skill X",
      is_system: false,
      owner_id: "user@example.com",
    });
    mockListRevisions.mockResolvedValue([
      {
        id: "rev-1",
        skill_id: "skill-x",
        revision_number: 2,
        trigger: "update",
        created_at: new Date(),
        name: "Skill X",
        category: "Custom",
        tasks: [],
        skill_content_size: 100,
        ancillary_file_count: 0,
        ancillary_total_size: 0,
      },
      {
        id: "rev-2",
        skill_id: "skill-x",
        revision_number: 1,
        trigger: "create",
        created_at: new Date(),
        name: "Skill X",
        category: "Custom",
        tasks: [],
        skill_content_size: 80,
        ancillary_file_count: 0,
        ancillary_total_size: 0,
      },
    ]);
    const { GET } = await import("../route");
    const res = await GET(
      makeRequest("/api/skills/configs/skill-x/revisions"),
      { params: Promise.resolve({ id: "skill-x" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const data = body.data ?? body;
    expect(data.skill_id).toBe("skill-x");
    expect(data.revisions).toHaveLength(2);
    expect(data.revisions[0].revision_number).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/skills/configs/[id]/revisions/[revisionId]
// ---------------------------------------------------------------------------

describe("GET /api/skills/configs/[id]/revisions/[revisionId]", () => {
  it("returns 404 if the revision id does not match the skill", async () => {
    mockGetVisible.mockResolvedValue({
      id: "skill-x",
      name: "x",
      is_system: false,
      owner_id: "user@example.com",
    });
    mockGetRevision.mockResolvedValue(null);
    const { GET } = await import("../[revisionId]/route");
    const res = await GET(
      makeRequest("/api/skills/configs/skill-x/revisions/rev-other"),
      { params: Promise.resolve({ id: "skill-x", revisionId: "rev-other" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns the full revision when found", async () => {
    mockGetVisible.mockResolvedValue({
      id: "skill-x",
      name: "x",
      is_system: false,
      owner_id: "user@example.com",
    });
    mockGetRevision.mockResolvedValue({
      id: "rev-1",
      skill_id: "skill-x",
      revision_number: 1,
      trigger: "create",
      created_at: new Date(),
      name: "x",
      category: "Custom",
      tasks: [],
      skill_content: "# v1",
      ancillary_files: { "x.sh": "echo" },
    });
    const { GET } = await import("../[revisionId]/route");
    const res = await GET(
      makeRequest("/api/skills/configs/skill-x/revisions/rev-1"),
      { params: Promise.resolve({ id: "skill-x", revisionId: "rev-1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const data = body.data ?? body;
    expect(data.revision.skill_content).toBe("# v1");
    expect(data.revision.ancillary_files).toEqual({ "x.sh": "echo" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/skills/configs/[id]/revisions/[revisionId]/restore
// ---------------------------------------------------------------------------

describe("POST .../revisions/[revisionId]/restore", () => {
  const updateOne = jest.fn();
  beforeEach(() => {
    updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    // Override the Mongo mock for this describe block — restore
    // writes the live agent_skills row directly so we need a real
    // collection-shaped mock. Distinguish the `users` collection
    // (touched by `persistKeycloakSubMapping` whenever a session
    // carries `sub`) so its writes don't pollute the `updateOne`
    // counter we're asserting on for `agent_skills`.
    const usersUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const mongo = jest.requireMock("@/lib/mongodb") as {
      getCollection: jest.Mock;
    };
    mongo.getCollection.mockImplementation(async (name: string) =>
      name === "users" ? { updateOne: usersUpdateOne } : { updateOne },
    );
    mockRunSkillScan.mockResolvedValue({
      scan_status: "passed",
      scan_summary: "ok",
    });
  });

  it("404s when the revision is not found before any write happens", async () => {
    mockGetVisible.mockResolvedValue({
      id: "skill-x",
      name: "x",
      is_system: false,
      owner_id: "user@example.com",
    });
    mockGetRevision.mockResolvedValue(null);
    const { POST } = await import("../[revisionId]/restore/route");
    const res = await POST(
      makeRequest(
        "/api/skills/configs/skill-x/revisions/rev-missing/restore",
        { method: "POST" },
      ),
      {
        params: Promise.resolve({
          id: "skill-x",
          revisionId: "rev-missing",
        }),
      },
    );
    expect(res.status).toBe(404);
    expect(updateOne).not.toHaveBeenCalled();
    expect(mockRecordRevision).not.toHaveBeenCalled();
  });

  it("overwrites the live skill, re-scans, and records a `restore` revision", async () => {
    mockGetVisible.mockResolvedValue({
      id: "skill-x",
      name: "current name",
      is_system: false,
      owner_id: "user@example.com",
      skill_content: "# current",
    });
    mockGetRevision.mockResolvedValue({
      id: "rev-7",
      skill_id: "skill-x",
      revision_number: 7,
      trigger: "update",
      created_at: new Date(),
      name: "old name",
      category: "Custom",
      tasks: [{ display_text: "t", llm_prompt: "p", subagent: "github" }],
      skill_content: "# old",
      ancillary_files: { "x.sh": "echo" },
    });
    mockRecordRevision.mockResolvedValue({
      id: "rev-new",
      revision_number: 8,
    });
    const { POST } = await import("../[revisionId]/restore/route");
    const res = await POST(
      makeRequest(
        "/api/skills/configs/skill-x/revisions/rev-7/restore",
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: "skill-x", revisionId: "rev-7" }) },
    );
    expect(res.status).toBe(200);
    // Live row updated with the snapshotted content + fresh scan.
    expect(updateOne).toHaveBeenCalledWith(
      { id: "skill-x", config_driven: { $ne: true } },
      expect.objectContaining({
        $set: expect.objectContaining({
          skill_content: "# old",
          name: "old name",
          scan_status: "passed",
        }),
      }),
    );
    // Re-scan must be invoked — old `scan_status` may not match
    // current policy.
    expect(mockRunSkillScan).toHaveBeenCalledWith(
      "old name",
      "# old",
      "skill-x",
    );
    // Restore is itself a revision so the timeline records the
    // event (and the user can undo the undo).
    expect(mockRecordRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "skill-x",
        trigger: "restore",
        restoredFrom: "rev-7",
      }),
    );
  });

  it("rejects a restore when app-config adopts the skill during scanning", async () => {
    mockGetVisible.mockResolvedValue({ id: "example-skill", name: "Example Skill", config_driven: false });
    mockGetRevision.mockResolvedValue({ name: "Example Skill", skill_content: "Previous content" });
    updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const { POST } = await import("../[revisionId]/restore/route");
    const response = await POST(makeRequest("/api/skills/configs/example-skill/revisions/example-revision/restore", {
      method: "POST",
    }), { params: Promise.resolve({ id: "example-skill", revisionId: "example-revision" }) });
    expect(response.status).toBe(409);
    expect(updateOne).toHaveBeenCalledWith({ id: "example-skill", config_driven: { $ne: true } }, expect.anything());
    expect(mockRecordRevision).not.toHaveBeenCalled();
  });
});
