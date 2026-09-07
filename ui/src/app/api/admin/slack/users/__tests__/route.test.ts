/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockListRealmUsersPage = jest.fn();
const mockGetCollection = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    requireRbacPermission: (...args: unknown[]) =>
      mockRequireRbacPermission(...args),
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  listRealmUsersPage: (...args: unknown[]) => mockListRealmUsersPage(...args),
}));

interface RealmUser {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
}

interface SlackMetricsDoc {
  slack_user_id: string;
  last_interaction_at?: Date;
  obo_success_count?: number;
  obo_fail_count?: number;
  active_channel_ids?: string[];
}

function makeMetricsCollection(
  orphans: SlackMetricsDoc[],
  metricsBySlackId: Record<string, SlackMetricsDoc>,
) {
  return {
    find: () => ({
      limit: () => ({
        toArray: async () => orphans,
      }),
    }),
    findOne: async ({ slack_user_id }: { slack_user_id: string }) =>
      metricsBySlackId[slack_user_id] ?? null,
  };
}

function makeTeamsCollection(teamsByEmail: Record<string, string[]>) {
  return {
    find: (query: { "members.user_id": string }) => ({
      project: () => ({
        limit: () => ({
          toArray: async () =>
            (teamsByEmail[query["members.user_id"]] ?? []).map((name) => ({ name })),
        }),
      }),
    }),
  };
}

function mockCollections(options: {
  orphans?: SlackMetricsDoc[];
  metricsBySlackId?: Record<string, SlackMetricsDoc>;
  teamsByEmail?: Record<string, string[]>;
}) {
  const metricsColl = makeMetricsCollection(
    options.orphans ?? [],
    options.metricsBySlackId ?? {},
  );
  const teamsColl = makeTeamsCollection(options.teamsByEmail ?? {});
  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "slack_user_metrics") return metricsColl;
    if (name === "teams") return teamsColl;
    return null;
  });
}

function makeRequest(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/admin/slack/users${query ? `?${query}` : ""}`,
    { headers: { Authorization: "Bearer test-token" } },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    user: { email: "admin@example.com" },
    session: { sub: "admin-sub" },
  });
  mockRequireRbacPermission.mockResolvedValue(undefined);
  mockListRealmUsersPage.mockResolvedValue([]);
  mockCollections({});
});

describe("GET /api/admin/slack/users", () => {
  it("returns linked users with teams and metrics populated", async () => {
    const user: RealmUser = {
      id: "kc-1",
      username: "alice",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Example",
      enabled: true,
      attributes: { slack_user_id: ["U1"] },
    };
    mockListRealmUsersPage.mockResolvedValueOnce([user]);
    mockCollections({
      metricsBySlackId: {
        U1: {
          slack_user_id: "U1",
          last_interaction_at: new Date("2026-01-01T00:00:00.000Z"),
          obo_success_count: 2,
          obo_fail_count: 1,
          active_channel_ids: ["C1"],
        },
      },
      teamsByEmail: { "alice@example.com": ["Team A"] },
    });

    const { GET } = await import("../route");
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.data.total).toBe(1);
    expect(body.data.items).toEqual([
      expect.objectContaining({
        keycloak_user_id: "kc-1",
        username: "alice",
        email: "alice@example.com",
        display_name: "Alice Example",
        slack_user_id: "U1",
        link_status: "linked",
        enabled: true,
        teams: ["Team A"],
        last_interaction: "2026-01-01T00:00:00.000Z",
        obo_success_count: 2,
        obo_fail_count: 1,
        active_channels: ["C1"],
      }),
    ]);
  });

  it("includes an unlinked orphan row from metrics only when status is all or unlinked", async () => {
    mockCollections({
      orphans: [{ slack_user_id: "U-orphan" }],
    });

    const { GET } = await import("../route");

    const all = await (await GET(makeRequest())).json();
    expect(all.data.items).toEqual([
      expect.objectContaining({ slack_user_id: "U-orphan", link_status: "unlinked" }),
    ]);

    const unlinked = await (await GET(makeRequest("status=unlinked"))).json();
    expect(unlinked.data.items).toEqual([
      expect.objectContaining({ slack_user_id: "U-orphan", link_status: "unlinked" }),
    ]);

    const linked = await (await GET(makeRequest("status=linked"))).json();
    expect(linked.data.items).toEqual([]);
    expect(linked.data.total).toBe(0);
  });

  it("filters linked and unlinked rows by the status query param", async () => {
    const user: RealmUser = {
      id: "kc-2",
      username: "bob",
      email: "bob@example.com",
      enabled: true,
      attributes: { slack_user_id: ["U2"] },
    };
    mockListRealmUsersPage.mockResolvedValueOnce([user]);
    mockCollections({ orphans: [{ slack_user_id: "U-orphan" }] });

    const { GET } = await import("../route");

    const linked = await (await GET(makeRequest("status=linked"))).json();
    expect(linked.data.items).toEqual([
      expect.objectContaining({ slack_user_id: "U2", link_status: "linked" }),
    ]);

    const unlinked = await (await GET(makeRequest("status=unlinked"))).json();
    expect(unlinked.data.items).toEqual([
      expect.objectContaining({ slack_user_id: "U-orphan", link_status: "unlinked" }),
    ]);
  });

  it("paginates results using page and page_size", async () => {
    const users: RealmUser[] = ["U1", "U2", "U3"].map((sid, idx) => ({
      id: `kc-${idx}`,
      username: `user${idx}`,
      email: `user${idx}@example.com`,
      enabled: true,
      attributes: { slack_user_id: [sid] },
    }));
    mockListRealmUsersPage.mockResolvedValueOnce(users);

    const { GET } = await import("../route");
    const response = await GET(makeRequest("page=2&page_size=1"));
    const body = await response.json();

    expect(body.data.total).toBe(3);
    expect(body.data.page).toBe(2);
    expect(body.data.page_size).toBe(1);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ slack_user_id: "U2" });
    expect(body.data.has_more).toBe(true);
  });

  it("requires admin_ui admin permission", async () => {
    await (await import("../route")).GET(makeRequest());

    expect(mockRequireRbacPermission).toHaveBeenCalledWith({ sub: "admin-sub" }, "admin_ui", "admin");
  });
});
