/**
 * @jest-environment node
 *
 * Tests for GET /api/admin/teams/[id]/members — the paginated, search-filtered
 * member list. Mocks `loadActiveTeamMembersPage` so we assert param parsing
 * (page / page_size / search), the owner_email passthrough, and the
 * `{ members, total, page, page_size, has_more }` response envelope without a
 * real MongoDB aggregation.
 */

import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";

const mockGetServerSession = jest.fn();
const mockCheckPermission = jest.fn();
const mockLoadActiveTeamMembersPage = jest.fn();
const mockSearchRealmUsers = jest.fn();

jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "ssoEnabled",
}));

jest.mock("@/lib/rbac/keycloak-authz", () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
}));

jest.mock("@/lib/rbac/audit", () => ({
  logAuthzDecision: jest.fn(),
}));

// `isValidTeamSlug` is only exercised by POST/DELETE; stub it so importing
// the module doesn't drag in a real implementation. `searchRealmUsers` IS
// exercised by GET now — it resolves a name search into candidate emails.
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  searchRealmUsers: (...args: unknown[]) => mockSearchRealmUsers(...args),
  isValidTeamSlug: jest.fn(() => true),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: jest.fn(),
  isOpenFgaConfigured: jest.fn(() => true),
}));

jest.mock("@/lib/rbac/team-openfga-sync-status", () => {
  const actual = jest.requireActual("@/lib/rbac/team-openfga-sync-status");
  return {
    readTeamOpenFgaTuples: jest.fn(),
    // Page-scoped per-member tuple read used by GET /members for the sync
    // badge. Default to "no tuples found" so members read as drifted unless a
    // test overrides it; the pure classifier stays real.
    readTeamMemberOpenFgaTuples: jest.fn(async () => new Map<string, Set<string>>()),
    classifyMemberSyncStatus: actual.classifyMemberSyncStatus,
  };
});

jest.mock("@/lib/rbac/team-membership-source-store", () => ({
  upsertTeamMembershipSource: jest.fn(),
  markTeamMembershipSourceRemoved: jest.fn(),
  listActiveTeamMembershipSourcesForTeamUser: jest.fn(),
}));

jest.mock("@/lib/rbac/team-membership-store", () => ({
  findUserRoleInTeam: jest.fn(),
  loadActiveTeamMembersPage: (...args: unknown[]) => mockLoadActiveTeamMembersPage(...args),
}));

const mockCollections: Record<string, unknown> = {};
let mockIsMongoDBConfigured = true;

jest.mock("@/lib/mongodb", () => ({
  get isMongoDBConfigured() {
    return mockIsMongoDBConfigured;
  },
  getCollection: jest.fn(async (name: string) => mockCollections[name] ?? createMockCollection()),
}));

const TEAM_ID = "507f1f77bcf86cd799439011";

function createMockCollection() {
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      toArray: jest.fn().mockResolvedValue([]),
    }),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

function accessTokenWithRoles(roles: string[]): string {
  const payload = Buffer.from(JSON.stringify({ realm_access: { roles } }), "utf8").toString(
    "base64url",
  );
  return `h.${payload}.s`;
}

function adminSession() {
  return {
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin",
    sub: "admin-sub",
    accessToken: accessTokenWithRoles(["admin"]),
  };
}

function seedTeam(extra: Record<string, unknown> = {}) {
  const teamsCol = createMockCollection();
  teamsCol.findOne.mockResolvedValue({
    _id: new ObjectId(TEAM_ID),
    slug: "platform",
    name: "Platform",
    owner_id: "owner@example.com",
    ...extra,
  });
  mockCollections.teams = teamsCol;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMongoDBConfigured = true;
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
  mockCheckPermission.mockResolvedValue({ allowed: true, reason: "OK" });
  mockGetServerSession.mockResolvedValue(adminSession());
  mockSearchRealmUsers.mockResolvedValue([]);
  mockLoadActiveTeamMembersPage.mockResolvedValue({
    members: [
      {
        identity_key: "owner@example.com",
        user_email: "owner@example.com",
        role: "owner",
        source_types: ["manual"],
        idp_managed: false,
        added_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    total: 60,
  });
});

async function callGet(url: string) {
  const { GET } = await import("../route");
  const response = await GET(makeRequest(url), {
    params: Promise.resolve({ id: TEAM_ID }),
  });
  return { response, body: await response.json() };
}

describe("GET /api/admin/teams/[id]/members", () => {
  it("returns a paginated envelope and passes page/size/search/owner to the store", async () => {
    seedTeam();
    const { response, body } = await callGet(
      `/api/admin/teams/${TEAM_ID}/members?page=2&page_size=25&search=ali`,
    );

    expect(response.status).toBe(200);
    expect(body.data.members).toHaveLength(1);
    expect(body.data.total).toBe(60);
    expect(body.data.page).toBe(2);
    expect(body.data.page_size).toBe(25);
    // 2 * 25 = 50 < 60, so there is another page.
    expect(body.data.has_more).toBe(true);

    expect(mockSearchRealmUsers).toHaveBeenCalledWith({ search: "ali", max: 50 });
    expect(mockLoadActiveTeamMembersPage).toHaveBeenCalledWith("platform", {
      page: 2,
      pageSize: 25,
      search: "ali",
      searchMatchedEmails: [],
      ownerEmail: "owner@example.com",
    });
  });

  it("defaults to page 1, size 25, empty search when params are absent", async () => {
    seedTeam();
    await callGet(`/api/admin/teams/${TEAM_ID}/members`);

    // No search term — the Keycloak name/email lookup is skipped entirely.
    expect(mockSearchRealmUsers).not.toHaveBeenCalled();
    expect(mockLoadActiveTeamMembersPage).toHaveBeenCalledWith("platform", {
      page: 1,
      pageSize: 25,
      search: "",
      searchMatchedEmails: [],
      ownerEmail: "owner@example.com",
    });
  });

  it("skips the Keycloak lookup for a single-character search", async () => {
    seedTeam();
    await callGet(`/api/admin/teams/${TEAM_ID}/members?search=a`);

    expect(mockSearchRealmUsers).not.toHaveBeenCalled();
    expect(mockLoadActiveTeamMembersPage).toHaveBeenCalledWith(
      "platform",
      expect.objectContaining({ search: "a", searchMatchedEmails: [] }),
    );
  });

  it("resolves a search term to matching emails via Keycloak name/email lookup", async () => {
    seedTeam();
    mockSearchRealmUsers.mockResolvedValueOnce([
      { email: "alice@example.com", firstName: "Alice" },
      { email: "bob@example.com", firstName: "Alice" },
      // No email on this row (e.g. a service account) — must be dropped,
      // not passed through as `undefined`.
      { username: "no-email-user" },
    ]);

    await callGet(`/api/admin/teams/${TEAM_ID}/members?search=alice`);

    expect(mockSearchRealmUsers).toHaveBeenCalledWith({ search: "alice", max: 50 });
    expect(mockLoadActiveTeamMembersPage).toHaveBeenCalledWith(
      "platform",
      expect.objectContaining({
        search: "alice",
        searchMatchedEmails: ["alice@example.com", "bob@example.com"],
      }),
    );
  });

  it("falls back to the plain email match when the Keycloak lookup fails", async () => {
    seedTeam();
    mockSearchRealmUsers.mockRejectedValueOnce(new Error("Keycloak unreachable"));

    const { response } = await callGet(`/api/admin/teams/${TEAM_ID}/members?search=alice`);

    expect(response.status).toBe(200);
    expect(mockLoadActiveTeamMembersPage).toHaveBeenCalledWith(
      "platform",
      expect.objectContaining({ search: "alice", searchMatchedEmails: [] }),
    );
  });

  it("clamps page_size to the 1..100 range", async () => {
    seedTeam();
    await callGet(`/api/admin/teams/${TEAM_ID}/members?page_size=9999`);

    expect(mockLoadActiveTeamMembersPage).toHaveBeenCalledWith(
      "platform",
      expect.objectContaining({ pageSize: 100 }),
    );
  });

  it("404s when the team does not exist", async () => {
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(null);
    mockCollections.teams = teamsCol;

    const { response } = await callGet(`/api/admin/teams/${TEAM_ID}/members`);
    expect(response.status).toBe(404);
    expect(mockLoadActiveTeamMembersPage).not.toHaveBeenCalled();
  });

  it("returns an empty page (no store call) when the team has no slug", async () => {
    seedTeam({ slug: "" });
    const { response, body } = await callGet(`/api/admin/teams/${TEAM_ID}/members`);

    expect(response.status).toBe(200);
    expect(body.data.members).toEqual([]);
    expect(body.data.total).toBe(0);
    expect(mockLoadActiveTeamMembersPage).not.toHaveBeenCalled();
  });

  describe("per-member OpenFGA sync badge (page-scoped)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const syncModule = require("@/lib/rbac/team-openfga-sync-status");
    const mockReadMemberTuples = syncModule.readTeamMemberOpenFgaTuples as jest.Mock;

    it("marks a member synced when OpenFGA holds the required relation", async () => {
      seedTeam();
      mockLoadActiveTeamMembersPage.mockResolvedValueOnce({
        members: [
          {
            identity_key: "alice@example.com",
            user_email: "alice@example.com",
            user_subject: "sub-alice",
            role: "member",
            source_types: ["okta"],
            idp_managed: true,
            added_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        total: 1,
      });
      mockReadMemberTuples.mockResolvedValueOnce(
        new Map([["sub-alice", new Set(["member"])]]),
      );

      const { response, body } = await callGet(`/api/admin/teams/${TEAM_ID}/members`);

      expect(response.status).toBe(200);
      expect(mockReadMemberTuples).toHaveBeenCalledWith("platform", ["sub-alice"]);
      expect(body.data.members[0].sync_status).toBe("synced");
    });

    it("marks a member drifted when the required relation is missing in OpenFGA", async () => {
      seedTeam();
      mockLoadActiveTeamMembersPage.mockResolvedValueOnce({
        members: [
          {
            identity_key: "bob@example.com",
            user_email: "bob@example.com",
            user_subject: "sub-bob",
            role: "member",
            source_types: ["okta"],
            idp_managed: true,
            added_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        total: 1,
      });
      // OpenFGA reachable but holds no tuple for this subject.
      mockReadMemberTuples.mockResolvedValueOnce(new Map([["sub-bob", new Set()]]));

      const { body } = await callGet(`/api/admin/teams/${TEAM_ID}/members`);

      expect(body.data.members[0].sync_status).toBe("drifted");
    });

    it("marks a member pending when no Keycloak subject is resolved", async () => {
      seedTeam();
      // Default fixture member (owner@example.com) has no user_subject.
      const { body } = await callGet(`/api/admin/teams/${TEAM_ID}/members`);

      expect(body.data.members[0].sync_status).toBe("pending");
    });

    it("reports unknown when the per-member OpenFGA read fails", async () => {
      seedTeam();
      mockLoadActiveTeamMembersPage.mockResolvedValueOnce({
        members: [
          {
            identity_key: "carol@example.com",
            user_email: "carol@example.com",
            user_subject: "sub-carol",
            role: "admin",
            source_types: ["manual"],
            idp_managed: false,
            added_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        total: 1,
      });
      // null signals OpenFGA unreachable — must not be inferred as drift.
      mockReadMemberTuples.mockResolvedValueOnce(null);

      const { body } = await callGet(`/api/admin/teams/${TEAM_ID}/members`);

      expect(body.data.members[0].sync_status).toBe("unknown");
    });
  });
});
