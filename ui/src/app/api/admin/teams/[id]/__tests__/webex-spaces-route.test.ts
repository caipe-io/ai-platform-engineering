/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { RBAC_COLLECTION_NAMES } from "@/lib/rbac/mongo-collections";

const teamId = new ObjectId().toHexString();
const mockCollections: Record<string, ReturnType<typeof createMockCollection>> = {};

jest.mock("@/lib/rbac/keycloak-authz", () => ({
  checkPermission: jest.fn(async () => ({ allowed: true })),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn(async () => ({ allowed: true })),
  writeOpenFgaTupleDiff: jest.fn(async () => ({ enabled: true, writes: 2, deletes: 0 })),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: jest.fn(async () => undefined),
}));

jest.mock("@/lib/jwt-validation", () => ({
  validateLocalSkillsJWT: jest.fn(async () => null),
  validateBearerJWT: jest.fn(async () => ({
    sub: "alice-sub",
    email: "alice@example.com",
    name: "Alice",
  })),
}));

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async (name: string) => mockCollections[name] ?? createMockCollection([])),
}));

jest.mock("@/lib/rbac/mongo-collections", () => {
  const actual = jest.requireActual("@/lib/rbac/mongo-collections");
  return {
    ...actual,
    getRbacCollection: jest.fn(async (key: keyof typeof actual.RBAC_COLLECTION_NAMES) => {
      const name = actual.RBAC_COLLECTION_NAMES[key];
      return mockCollections[name] ?? createMockCollection([]);
    }),
  };
});

jest.mock("@/lib/config", () => ({ getConfig: () => true }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

function createMockCollection(rows: Record<string, unknown>[]) {
  return {
    rows,
    find: jest.fn((filter: Record<string, unknown> = {}) => ({
      sort: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue(
        rows.filter((row) => {
          if (filter.active && typeof filter.active === "object" && "$ne" in filter.active) {
            if (row.active === (filter.active as { $ne: unknown }).$ne) return false;
          }
          if (filter.webex_space_id && typeof filter.webex_space_id === "object" && "$in" in filter.webex_space_id) {
            if (!(filter.webex_space_id.$in as string[]).includes(String(row.webex_space_id))) return false;
          } else if (filter.webex_space_id !== undefined && row.webex_space_id !== filter.webex_space_id) {
            return false;
          }
          if (filter.team_id && typeof filter.team_id === "object" && "$ne" in filter.team_id) {
            if (row.team_id === (filter.team_id as { $ne: unknown }).$ne) return false;
          } else if (filter.team_id !== undefined && row.team_id !== filter.team_id) {
            return false;
          }
          return true;
        })
      ),
    })),
    findOne: jest.fn(async (filter: Record<string, unknown>) => {
      if (filter._id) {
        return rows.find((row) => String(row._id) === String(filter._id)) ?? null;
      }
      return null;
    }),
    updateOne: jest.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }) => {
      let row = rows.find((candidate) => {
        if (filter.webex_space_id !== undefined && candidate.webex_space_id !== filter.webex_space_id) {
          return false;
        }
        if (filter.team_id !== undefined && candidate.team_id !== filter.team_id) {
          return false;
        }
        return true;
      });
      if (!row && options?.upsert) {
        row = { ...filter, ...(update.$set as object), ...(update.$setOnInsert as object) };
        rows.push(row);
      } else if (row && update.$set) {
        Object.assign(row, update.$set);
      }
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0, upsertedCount: row && options?.upsert ? 1 : 0 };
    }),
    updateMany: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
  mockCollections.teams = createMockCollection([{ _id: teamId, slug: "team-a", name: "Team A" }]);
  mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings] = createMockCollection([]);
  process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
});

afterEach(() => {
  delete process.env.WEBEX_WORKSPACE_ALIAS;
});

async function putWebexSpaces(spaces: unknown[]) {
  const { PUT } = await import("../webex-spaces/route");
  return PUT(
    new NextRequest(`http://localhost:3000/api/admin/teams/${teamId}/webex-spaces`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ spaces }),
    }),
    { params: Promise.resolve({ id: teamId }) }
  );
}

describe("PUT /api/admin/teams/[id]/webex-spaces", () => {
  it("upserts by webex_space_id and team_id and rejects cross-team conflicts", async () => {
    mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].rows.push({
      webex_space_id: "space-taken",
      team_id: "other-team",
      active: true,
    });

    const conflict = await putWebexSpaces([
      { webex_space_id: "space-taken", space_name: "Taken Space", bot_id: "primary" },
    ]);
    expect(conflict.status).toBe(409);

    const ok = await putWebexSpaces([
      { webex_space_id: "space-new", space_name: "New Space", bot_id: "primary" },
    ]);
    expect(ok.status).toBe(200);
    expect(
      mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].updateOne
    ).toHaveBeenCalledWith(
      { webex_space_id: "space-new", team_id: teamId },
      expect.objectContaining({ $set: expect.objectContaining({ bot_id: "primary" }) }),
      { upsert: true }
    );
  });

  // The single-space team route falls back to resolving the old team by
  // team_id when team_slug is missing on the mapping doc, so every upsert
  // here must also persist team_slug — otherwise a space last assigned via
  // this bulk route can never have its stale OpenFGA grant revoked.
  it("writes team_slug alongside team_id on every upsert", async () => {
    const res = await putWebexSpaces([
      { webex_space_id: "space-new", space_name: "New Space", bot_id: "primary" },
    ]);
    expect(res.status).toBe(200);
    expect(
      mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].updateOne
    ).toHaveBeenCalledWith(
      { webex_space_id: "space-new", team_id: teamId },
      expect.objectContaining({ $set: expect.objectContaining({ team_id: teamId, team_slug: "team-a" }) }),
      { upsert: true }
    );
  });

  // space_team_resolver.py filters `webex_space_team_mappings` on `bot_id`
  // (added for multi-bot support). A mapping written without it can never be
  // resolved at runtime, so a brand-new space must supply bot_id explicitly —
  // there's nothing on record yet to fall back to.
  it("rejects a brand-new space assignment with no bot_id", async () => {
    const res = await putWebexSpaces([{ webex_space_id: "space-new", space_name: "New Space" }]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bot_id is required/i);
    expect(
      mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].updateOne
    ).not.toHaveBeenCalled();
  });

  it("preserves the existing mapping's bot_id when re-saving without supplying it", async () => {
    mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].rows.push({
      webex_space_id: "space-existing",
      team_id: teamId,
      bot_id: "primary",
      active: true,
    });

    const res = await putWebexSpaces([
      { webex_space_id: "space-existing", space_name: "Existing Space" },
    ]);
    expect(res.status).toBe(200);
    expect(
      mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].updateOne
    ).toHaveBeenCalledWith(
      { webex_space_id: "space-existing", team_id: teamId },
      expect.objectContaining({ $set: expect.objectContaining({ bot_id: "primary" }) }),
      { upsert: true }
    );
  });

  it("lets an explicit bot_id override the previously stored one", async () => {
    mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].rows.push({
      webex_space_id: "space-existing",
      team_id: teamId,
      bot_id: "primary",
      active: true,
    });

    const res = await putWebexSpaces([
      { webex_space_id: "space-existing", space_name: "Existing Space", bot_id: "secondary" },
    ]);
    expect(res.status).toBe(200);
    expect(
      mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].updateOne
    ).toHaveBeenCalledWith(
      { webex_space_id: "space-existing", team_id: teamId },
      expect.objectContaining({ $set: expect.objectContaining({ bot_id: "secondary" }) }),
      { upsert: true }
    );
  });
});

describe("GET /api/admin/teams/[id]/webex-spaces", () => {
  it("round-trips the stored bot_id", async () => {
    mockCollections[RBAC_COLLECTION_NAMES.webexSpaceTeamMappings].rows.push({
      webex_space_id: "space-existing",
      team_id: teamId,
      bot_id: "primary",
      space_name: "Existing Space",
      active: true,
    });

    const { GET } = await import("../webex-spaces/route");
    const res = await GET(
      new NextRequest(`http://localhost:3000/api/admin/teams/${teamId}/webex-spaces`, {
        headers: { Authorization: "Bearer test-token" },
      }),
      { params: Promise.resolve({ id: teamId }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.spaces).toEqual([
      expect.objectContaining({ webex_space_id: "space-existing", bot_id: "primary" }),
    ]);
  });
});
