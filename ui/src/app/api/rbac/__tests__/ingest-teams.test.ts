/**
 * @jest-environment node
 */
/**
 * Tests for GET /api/rbac/ingest-teams (spec 2026-06-03).
 *
 * Returns the owning-team options for the Ingest form:
 *  - 401 with no session.
 *  - Org admins get ALL teams.
 *  - Non-admins get only teams that hold the org author capability AND that
 *    they are a member of (intersection).
 *  - Fail-closed (empty) on backend errors.
 */

jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
}));

const mockIsDevAnonymousAuthEnabled = jest.fn().mockReturnValue(false);
jest.mock("@/lib/auth/dev-auth-provider", () => ({
  isDevAnonymousAuthEnabled: () => mockIsDevAnonymousAuthEnabled(),
  getDevAnonymousSession: () => ({
    sub: "anonymous-local-dev",
    role: "admin",
    user: { email: "anonymous@local", name: "Anonymous Local Admin", role: "admin" },
  }),
}));

const mockCheckOpenFgaTuple = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:caipe",
}));

const mockIsUserInTeam = jest.fn();
jest.mock("@/lib/rbac/team-membership-store", () => ({
  isUserInTeam: (...args: unknown[]) => mockIsUserInTeam(...args),
}));

const mockCollections: Record<string, unknown> = {};
jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async (name: string) => mockCollections[name]),
  isMongoDBConfigured: true,
}));

import { getServerSession } from "next-auth";
import { isBootstrapAdmin } from "@/lib/auth-config";
import { ObjectId } from "mongodb";
import { GET } from "@/app/api/rbac/ingest-teams/route";

function teamsCollection(rows: Array<{ slug: string; name: string }>) {
  return {
    find: (filter: { slug?: { $in?: string[] } } = {}) => ({
      toArray: async () => {
        const wanted = filter?.slug?.$in;
        const selected = wanted ? rows.filter((r) => wanted.includes(r.slug)) : rows;
        return selected.map((r) => ({ _id: new ObjectId(), slug: r.slug, name: r.name }));
      },
    }),
  };
}

describe("GET /api/rbac/ingest-teams", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isBootstrapAdmin as jest.Mock).mockReturnValue(false);
    mockIsDevAnonymousAuthEnabled.mockReturnValue(false);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
    mockIsUserInTeam.mockResolvedValue(false);
    mockCollections.teams = teamsCollection([]);
  });

  it("returns 401 when unauthenticated", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("treats the explicit no-SSO development session as an org admin", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    mockIsDevAnonymousAuthEnabled.mockReturnValue(true);
    mockCollections.teams = teamsCollection([
      { slug: "super-admins", name: "Super Admins" },
    ]);

    const res = await GET();
    const body = await res.json();
    expect(body.org_admin).toBe(true);
    expect(body.teams.map((t: { slug: string }) => t.slug)).toEqual(["super-admins"]);
    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
  });

  it("org admin receives all teams", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true }); // can_manage org
    mockCollections.teams = teamsCollection([
      { slug: "team-a", name: "Team A" },
      { slug: "team-b", name: "Team B" },
    ]);

    const res = await GET();
    const body = await res.json();
    expect(body.org_admin).toBe(true);
    expect(body.teams.map((t: { slug: string }) => t.slug).sort()).toEqual(["team-a", "team-b"]);
  });

  it("non-admin gets the intersection of capability-holding and member teams", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      sub: "user-sub",
      user: { email: "user@example.com" },
    });
    // can_manage (org admin) is false for this user.
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    // team-a and team-b hold the capability...
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        { key: { user: "team:team-a#member", relation: "ingestor", object: "organization:caipe" } },
        { key: { user: "team:team-b#member", relation: "ingestor", object: "organization:caipe" } },
      ],
    });
    // ...but the user only belongs to team-a.
    mockIsUserInTeam.mockImplementation(async (slug: string) => slug === "team-a");
    mockCollections.teams = teamsCollection([
      { slug: "team-a", name: "Team A" },
      { slug: "team-b", name: "Team B" },
    ]);

    const res = await GET();
    const body = await res.json();
    expect(body.org_admin).toBe(false);
    expect(body.teams.map((t: { slug: string }) => t.slug)).toEqual(["team-a"]);
  });

  it("non-admin with no capability teams gets an empty list", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      sub: "user-sub",
      user: { email: "user@example.com" },
    });
    mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });

    const res = await GET();
    const body = await res.json();
    expect(body.org_admin).toBe(false);
    expect(body.teams).toEqual([]);
    expect(mockIsUserInTeam).not.toHaveBeenCalled();
  });
});
