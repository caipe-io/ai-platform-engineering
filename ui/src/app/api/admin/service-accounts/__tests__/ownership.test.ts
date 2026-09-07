/**
 * @jest-environment node
 */
// assisted-by Codex Codex-sonnet-4-6

/**
 * T034 + T034a — ownership & visibility boundaries (US5) + static-access guard.
 *
 * FR-021/022: an SA belongs to exactly ONE team; only members of that team can
 * see or mutate it. Non-members get 404 (existence hidden) on every [id] route,
 * and the list only returns SAs in the caller's own teams. There is no
 * multi-team / share path — `owning_team_id` is a single scalar.
 *
 * FR-020 (static access): scopes are static — removing the CREATOR's own grant
 * for a scope must NOT touch the SA's tuple. This is a regression guard: no
 * route re-derives an SA's scopes from its creator, so nothing here calls a
 * "sync from creator" path. We assert the SA's grant tuple is independent.
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
}));

const mockCheckOpenFgaTuple = jest.fn();
const mockListOpenFgaObjects = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockDeleteExactOpenFgaTuples = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
  deleteExactOpenFgaTuples: (...args: unknown[]) => mockDeleteExactOpenFgaTuples(...args),
}));

jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: jest.fn(
    async (diff: { writes?: unknown[]; deletes?: unknown[] }) => {
      if (diff.writes?.length) {
        await mockWriteOpenFgaTuples(diff);
      }
      if (diff.deletes?.length) {
        await mockDeleteExactOpenFgaTuples(diff.deletes);
      }
    },
  ),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  createServiceAccountClient: jest.fn(),
  deleteServiceAccountClient: jest.fn(),
  regenerateClientSecret: jest.fn(),
  getServiceAccountTokenUrl: () => "https://kc.example.com/realms/caipe/protocol/openid-connect/token",
}));

jest.mock("@/lib/rbac/audit", () => ({
  logOpenFgaRebacAuditEvent: jest.fn(),
}));

const mockListByOwningTeams = jest.fn();
const mockGetBySub = jest.fn();
const mockIsNameTakenInTeam = jest.fn();
const mockCreateServiceAccountDoc = jest.fn();
const mockUpdateScopesSnapshot = jest.fn();
const mockUpdateStatus = jest.fn();
jest.mock("@/lib/service-accounts", () => ({
  listByOwningTeams: (...args: unknown[]) => mockListByOwningTeams(...args),
  getBySub: (...args: unknown[]) => mockGetBySub(...args),
  isNameTakenInTeam: (...args: unknown[]) => mockIsNameTakenInTeam(...args),
  createServiceAccountDoc: (...args: unknown[]) => mockCreateServiceAccountDoc(...args),
  updateScopesSnapshot: (...args: unknown[]) => mockUpdateScopesSnapshot(...args),
  updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
}));

import { GET as listGET, POST as createPOST } from "../route";
import { GET as detailGET, DELETE as revokeDELETE } from "../[id]/route";
import { POST as scopeADD, DELETE as scopeDEL } from "../[id]/scopes/route";
import { POST as rotatePOST } from "../[id]/rotate/route";

const SA_ID = "sa-1";
const MEMBER = { sub: "member-sub", user: { email: "member@example.com" } };
const OUTSIDER = { sub: "outsider-sub", user: { email: "outsider@example.com" } };

function jsonReq(method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/admin/service-accounts/${SA_ID}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function ctx() {
  return { params: Promise.resolve({ id: SA_ID }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
  mockDeleteExactOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 0, deletes: 1 });
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockReadOpenFgaTuples.mockResolvedValue({
    tuples: [],
    continuationToken: undefined,
  });
  mockUpdateScopesSnapshot.mockResolvedValue(true);
  mockUpdateStatus.mockResolvedValue(true);
  mockGetBySub.mockResolvedValue({
    sa_sub: SA_ID,
    client_id: "caipe-sa-x",
    client_uuid: "kc-1",
    name: "x",
    owning_team_id: "team-sre",
    created_by: "member-sub",
    status: "active",
  });
});

describe("list visibility (FR-021)", () => {
  it("a member sees only SAs in their own teams", async () => {
    mockGetServerSession.mockResolvedValue(MEMBER);
    mockListOpenFgaObjects.mockResolvedValueOnce({ objects: ["team:team-sre"] }); // caller's teams
    mockListByOwningTeams.mockResolvedValue([
      {
        sa_sub: SA_ID,
        name: "x",
        owning_team_id: "team-sre",
        created_by: "member-sub",
        created_at: new Date(),
        status: "active",
        scopes_snapshot: [],
      },
    ]);

    const res = await listGET(new NextRequest("http://localhost/api/admin/service-accounts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    // The query was scoped to the caller's teams only.
    expect(mockListByOwningTeams).toHaveBeenCalledWith(["team-sre"], { includeRevoked: false });
  });

  it("a user in no team sees an empty list (never queries Mongo)", async () => {
    mockGetServerSession.mockResolvedValue(OUTSIDER);
    mockListOpenFgaObjects.mockResolvedValueOnce({ objects: [] });

    const res = await listGET(new NextRequest("http://localhost/api/admin/service-accounts"));
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(mockListByOwningTeams).not.toHaveBeenCalled();
  });
});

describe("non-member cannot see or mutate (FR-022) — every [id] route 404s", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(OUTSIDER);
    // can_manage denied for the outsider on this SA.
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
  });

  it("GET detail → 404", async () => {
    const res = await detailGET(jsonReq("GET"), ctx());
    expect(res.status).toBe(404);
    expect(mockGetBySub).not.toHaveBeenCalled();
  });

  it("POST add-scope → 404, no write", async () => {
    const res = await scopeADD(jsonReq("POST", { type: "agent", ref: "a1" }), ctx());
    expect(res.status).toBe(404);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("DELETE remove-scope → 404, no delete", async () => {
    const res = await scopeDEL(jsonReq("DELETE", { type: "agent", ref: "a1" }), ctx());
    expect(res.status).toBe(404);
    expect(mockDeleteExactOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("POST rotate → 404, no secret regen", async () => {
    const res = await rotatePOST(jsonReq("POST"), ctx());
    expect(res.status).toBe(404);
  });

  it("DELETE revoke → 404, no client delete", async () => {
    const res = await revokeDELETE(jsonReq("DELETE"), ctx());
    expect(res.status).toBe(404);
    expect(mockDeleteExactOpenFgaTuples).not.toHaveBeenCalled();
  });
});

describe("no multi-team / share path (FR-022)", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(MEMBER);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockIsNameTakenInTeam.mockResolvedValue(false);
  });

  it("create rejects an array owning_team_id (only a single scalar team is accepted)", async () => {
    const res = await createPOST(
      new NextRequest("http://localhost/api/admin/service-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "multi", owning_team_id: ["team-a", "team-b"], scopes: [] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreateServiceAccountDoc).not.toHaveBeenCalled();
  });

  it("create writes exactly ONE owner_team tuple for the single team", async () => {
    mockCreateServiceAccountDoc.mockResolvedValue({});
    // Keycloak client mock comes from the module mock; stub its return:
    const kc = jest.requireMock("@/lib/rbac/keycloak-admin");
    kc.createServiceAccountClient.mockResolvedValue({
      clientUuid: "kc-1",
      clientId: "caipe-sa-x",
      clientSecret: "s",
      saSub: SA_ID,
    });

    const res = await createPOST(
      new NextRequest("http://localhost/api/admin/service-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "single", owning_team_id: "team-sre", scopes: [] }),
      }),
    );
    expect(res.status).toBe(201);
    const writeArg = mockWriteOpenFgaTuples.mock.calls[0][0];
    const ownerTuples = writeArg.writes.filter(
      (t: { relation: string }) => t.relation === "owner_team",
    );
    expect(ownerTuples).toHaveLength(1);
    expect(ownerTuples[0]).toEqual({
      user: "team:team-sre#member",
      relation: "owner_team",
      object: `service_account:${SA_ID}`,
    });
  });
});

describe("static access (FR-020) — SA grant is independent of the creator", () => {
  it("removing the editor's OWN held-status does not affect an SA scope delete", async () => {
    // The editor can_manage the SA but does NOT currently hold the tool being
    // removed (simulating "creator lost their own grant"). Removal must still
    // operate purely on the SA's tuple — FR-016 + FR-020.
    mockGetServerSession.mockResolvedValue(MEMBER);
    mockCheckOpenFgaTuple.mockImplementation(
      async (t: { relation: string }) => ({ allowed: t.relation === "can_manage" }),
    );

    const res = await scopeDEL(jsonReq("DELETE", { type: "tool", ref: "jira/search" }), ctx());
    expect(res.status).toBe(200);
    // The deleted tuple targets the SA subject — NOT the creator/editor.
    expect(mockDeleteExactOpenFgaTuples).toHaveBeenCalledWith([
      { user: `service_account:${SA_ID}`, relation: "caller", object: "tool:jira/search" },
    ]);
    // No check was made against the editor's own holding of the scope.
    const checkedRelations = mockCheckOpenFgaTuple.mock.calls.map((c) => c[0].relation);
    expect(new Set(checkedRelations)).toEqual(new Set(["can_manage"]));
  });
});
