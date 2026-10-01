/**
 * @jest-environment node
 */
/**
 * T024 + T024a — GET list + detail routes.
 *
 * Core guarantee (FR-005): NEITHER the list NOR the detail response may contain
 * any credential/secret material. The secret appears ONLY in the 201-create
 * (T011) and rotate (T029) responses. These tests assert the no-secret
 * invariant plus the owning-team visibility boundary (FR-021/022).
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
}));

const mockListOpenFgaObjects = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
}));

const mockResolveAuthorizedAdminSimulationScope = jest.fn();
jest.mock("@/lib/rbac/admin-simulation-server", () => ({
  resolveAuthorizedAdminSimulationScope: (...args: unknown[]) =>
    mockResolveAuthorizedAdminSimulationScope(...args),
}));

const mockHasOrganizationAdmin = jest.fn();
jest.mock("@/lib/rbac/platform-admin", () => ({
  hasOrganizationAdmin: (...args: unknown[]) =>
    mockHasOrganizationAdmin(...args),
}));

const mockListByOwningTeams = jest.fn();
const mockCountByOwningTeams = jest.fn();
const mockGetBySub = jest.fn();
jest.mock("@/lib/service-accounts", () => ({
  listByOwningTeams: (...args: unknown[]) => mockListByOwningTeams(...args),
  countByOwningTeams: (...args: unknown[]) => mockCountByOwningTeams(...args),
  getBySub: (...args: unknown[]) => mockGetBySub(...args),
}));

import { GET as listGET } from "../route";
import { GET as detailGET } from "../[id]/route";

const SECRET_TOKENS = [
  "client_secret",
  "secret",
  "credential",
  "client_uuid",
  "token_url",
];

/** Recursively assert that no secret-bearing key appears anywhere in the body. */
function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const token of SECRET_TOKENS) {
    expect(serialized).not.toContain(token);
  }
}

function listRequest(
  path = "http://localhost:3000/api/admin/service-accounts",
): NextRequest {
  return new NextRequest(new URL(path));
}

const SESSION = { sub: "caller-sub", user: { email: "caller@example.com" } };

// A Mongo doc that DELIBERATELY carries credential-ish fields, to prove the
// route projects them out rather than leaking them.
const SA_DOC = {
  sa_sub: "sa-123",
  client_id: "caipe-sa-incident-bot-a1b2c3",
  client_uuid: "kc-uuid-xyz",
  name: "incident-bot",
  description: "PagerDuty",
  owning_team_id: "team-sre",
  created_by: "creator-sub",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  status: "active" as const,
  revoked_at: null,
  scopes_snapshot: [
    {
      type: "agent" as const,
      ref: "incident-resolver",
      added_by: "x",
      added_at: new Date(),
    },
    {
      type: "tool" as const,
      ref: "jira/search",
      added_by: "x",
      added_at: new Date(),
    },
    {
      type: "tool" as const,
      ref: "jira/*",
      added_by: "x",
      added_at: new Date(),
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServerSession.mockResolvedValue(SESSION);
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
  mockResolveAuthorizedAdminSimulationScope.mockResolvedValue(null);
  mockHasOrganizationAdmin.mockResolvedValue(false);
  mockReadOpenFgaTuples.mockResolvedValue({
    tuples: [],
    continuationToken: undefined,
  });
});

describe("GET /api/admin/service-accounts (list)", () => {
  it("returns owning-team SAs without any credential material", async () => {
    mockListOpenFgaObjects.mockResolvedValue({ objects: ["team:team-sre"] });
    mockListByOwningTeams.mockResolvedValue([SA_DOC]);

    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    const item = body.data.items[0];
    expect(item.id).toBe("sa-123");
    expect(item.name).toBe("incident-bot");
    expect(item.scope_counts).toEqual({
      agents: 1,
      tools: 2,
      datasources: 0,
      collections: 0,
    });

    assertNoSecrets(body);
  });

  it("returns an empty list when the caller belongs to no team", async () => {
    mockListOpenFgaObjects.mockResolvedValue({ objects: [] });

    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    // Must not even query Mongo if there are no owning teams.
    expect(mockListByOwningTeams).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await listGET(listRequest());
    expect(res.status).toBe(401);
  });

  it("?team= narrows to that owning team when the caller is a member", async () => {
    mockListOpenFgaObjects.mockResolvedValue({
      objects: ["team:team-sre", "team:team-platform"],
    });
    mockListByOwningTeams.mockResolvedValue([SA_DOC]);

    const res = await listGET(
      listRequest(
        "http://localhost:3000/api/admin/service-accounts?team=team-sre",
      ),
    );
    expect(res.status).toBe(200);
    expect(mockListByOwningTeams).toHaveBeenCalledWith(["team-sre"], {
      includeRevoked: false,
    });
  });

  it("?team= returns empty (no Mongo query) when the caller is NOT in that team", async () => {
    // Regression guard: non-admin callers are still bounded by their own team
    // memberships even when a ?team= filter is present — the admin bypass
    // below must not weaken this default (non-admin) path.
    mockListOpenFgaObjects.mockResolvedValue({ objects: ["team:team-sre"] });

    const res = await listGET(
      listRequest(
        "http://localhost:3000/api/admin/service-accounts?team=team-other",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(mockListByOwningTeams).not.toHaveBeenCalled();
  });

  it("admin + ?team= bypasses the membership intersection entirely", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockListByOwningTeams.mockResolvedValue([SA_DOC]);

    const res = await listGET(
      listRequest(
        "http://localhost:3000/api/admin/service-accounts?team=team-sre",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe("sa-123");

    // The bypass must skip the OpenFGA membership lookup altogether.
    expect(mockListOpenFgaObjects).not.toHaveBeenCalled();
    expect(mockListByOwningTeams).toHaveBeenCalledWith(["team-sre"], {
      includeRevoked: false,
    });
  });

  it("admin WITHOUT ?team= sees SAs across every team (org-wide, unbounded)", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockListByOwningTeams.mockResolvedValue([SA_DOC]);

    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);

    // No team filter, no preview subject: the admin sees every team's SAs, so
    // the caller's own membership lookup is never consulted, and the Mongo
    // query is unbounded (owningTeamIds === null, not the caller's teams).
    expect(mockListOpenFgaObjects).not.toHaveBeenCalled();
    expect(mockListByOwningTeams).toHaveBeenCalledWith(null, {
      includeRevoked: false,
    });
  });

  it("uses the preview subject's team memberships for a read-only simulation", async () => {
    mockResolveAuthorizedAdminSimulationScope.mockResolvedValue({
      openfgaUser: "user:target-sub",
      ownerEmail: "target@example.com",
      subjectType: "user",
      subjectId: "target-sub",
    });
    mockListOpenFgaObjects.mockResolvedValue({ objects: ["team:target-team"] });
    mockListByOwningTeams.mockResolvedValue([]);

    const res = await listGET(
      listRequest(
        "http://localhost:3000/api/admin/service-accounts?simulate_type=user&simulate_id=target-sub",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockListOpenFgaObjects).toHaveBeenCalledWith({
      user: "user:target-sub",
      relation: "member",
      type: "team",
    });
    expect(mockListByOwningTeams).toHaveBeenCalledWith(["target-team"], {
      includeRevoked: false,
    });
  });

  it("limits a team userset preview to the selected team's service accounts", async () => {
    mockResolveAuthorizedAdminSimulationScope.mockResolvedValue({
      openfgaUser: "team:platform#member",
      ownerEmail: "",
      subjectType: "team",
      subjectId: "platform",
      teamRelation: "member",
    });
    mockListByOwningTeams.mockResolvedValue([]);

    const res = await listGET(
      listRequest(
        "http://localhost:3000/api/admin/service-accounts?simulate_type=team&simulate_id=platform",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockListOpenFgaObjects).not.toHaveBeenCalled();
    expect(mockListByOwningTeams).toHaveBeenCalledWith(["platform"], {
      includeRevoked: false,
    });
  });
});

describe("GET /api/admin/service-accounts/[id] (detail)", () => {
  function detailCtx(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("returns detail + authoritative OpenFGA scopes, no credential material", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockGetBySub.mockResolvedValue(SA_DOC);
    mockListOpenFgaObjects
      .mockResolvedValueOnce({ objects: ["agent:incident-resolver"] }) // can_use agent
      .mockResolvedValueOnce({ objects: ["tool:jira/search", "tool:jira/*"] }); // can_call tool
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        {
          key: {
            user: "service_account:sa-123",
            relation: "reader",
            object: "rag_collection:platform-rag",
          },
        },
      ],
      continuationToken: undefined,
    });

    const res = await detailGET(
      new Request("http://localhost"),
      detailCtx("sa-123"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.id).toBe("sa-123");
    expect(body.data.scopes).toEqual([
      { type: "agent", ref: "incident-resolver" },
      { type: "tool", ref: "jira/search" },
      { type: "tool", ref: "jira/*" },
      { type: "collection", ref: "platform-rag" },
    ]);

    assertNoSecrets(body);
  });

  it("404s for a non-member (does not reveal existence)", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    const res = await detailGET(
      new Request("http://localhost"),
      detailCtx("sa-123"),
    );
    expect(res.status).toBe(404);
    // Must not read the doc or scopes once authorization fails.
    expect(mockGetBySub).not.toHaveBeenCalled();
    expect(mockListOpenFgaObjects).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await detailGET(
      new Request("http://localhost"),
      detailCtx("sa-123"),
    );
    expect(res.status).toBe(401);
  });

  it("org admin can view a SA owned by a team they don't belong to", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockGetBySub.mockResolvedValue(SA_DOC);
    mockListOpenFgaObjects
      .mockResolvedValueOnce({ objects: ["agent:incident-resolver"] })
      .mockResolvedValueOnce({ objects: ["tool:jira/search", "tool:jira/*"] });

    const res = await detailGET(
      new Request("http://localhost"),
      detailCtx("sa-123"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe("sa-123");
  });
});
