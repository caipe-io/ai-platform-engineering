/**
 * @jest-environment node
 */
/**
 * T013 — POST /api/admin/service-accounts (create flow).
 *
 * Covers the contract's 7-step flow and the spec acceptance scenarios:
 *  - happy path → 201 with the secret returned exactly once (FR-005)
 *  - name conflict, incl. case-insensitive collision → 409 (FR-002a)
 *  - unauthorized scope → 403, request rejected wholesale (FR-006/008, S3)
 *  - non-member of owning team → 403 (FR-002)
 *  - default-deny: empty scopes is allowed and creates a zero-scope SA (FR-004, S2)
 *  - malformed body → 400 (constitution VII)
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/auth-config", () => ({ authOptions: {} }));

const mockCheckOpenFgaTuple = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockDeleteExactOpenFgaTuples = jest.fn();
const mockListOpenFgaObjects = jest.fn();
jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (diff: { writes: unknown[]; deletes: unknown[] }) =>
    diff.writes.length > 0
      ? mockWriteOpenFgaTuples(diff)
      : mockDeleteExactOpenFgaTuples(diff.deletes),
}));
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
}));

const mockHasOrganizationAdmin = jest.fn();
jest.mock("@/lib/rbac/platform-admin", () => ({
  hasOrganizationAdmin: (...args: unknown[]) =>
    mockHasOrganizationAdmin(...args),
}));

const mockCreateServiceAccountClient = jest.fn();
const mockDeleteServiceAccountClient = jest.fn();
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  createServiceAccountClient: (...args: unknown[]) =>
    mockCreateServiceAccountClient(...args),
  deleteServiceAccountClient: (...args: unknown[]) =>
    mockDeleteServiceAccountClient(...args),
  getServiceAccountTokenUrl: () =>
    "https://keycloak.example.com/realms/caipe/protocol/openid-connect/token",
}));

const mockLogAudit = jest.fn();
jest.mock("@/lib/rbac/audit", () => ({
  logOpenFgaRebacAuditEvent: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockIsNameTakenInTeam = jest.fn();
const mockCreateServiceAccountDoc = jest.fn();
const mockListByOwningTeams = jest.fn();
jest.mock("@/lib/service-accounts", () => ({
  isNameTakenInTeam: (...args: unknown[]) => mockIsNameTakenInTeam(...args),
  createServiceAccountDoc: (...args: unknown[]) =>
    mockCreateServiceAccountDoc(...args),
  listByOwningTeams: (...args: unknown[]) => mockListByOwningTeams(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:example-org",
}));

import { POST } from "../route";

const SESSION = { sub: "caller-sub", user: { email: "caller@example.com" } };

const KC_CLIENT = {
  clientUuid: "kc-uuid-1",
  clientId: "caipe-sa-incident-bot-a1b2c3",
  clientSecret: "super-secret-value",
  saSub: "sa-sub-1",
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/admin/service-accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A tuple-check stub: caller is a member + holds the named scopes; denies the rest. */
function allowMembershipAndScopes(held: Set<string>) {
  mockCheckOpenFgaTuple.mockImplementation(
    async (t: { relation: string; object: string }) => {
      if (t.relation === "member") return { allowed: true };
      return { allowed: held.has(`${t.relation} ${t.object}`) };
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServerSession.mockResolvedValue(SESSION);
  mockIsNameTakenInTeam.mockResolvedValue(false);
  mockWriteOpenFgaTuples.mockResolvedValue({
    enabled: true,
    writes: 1,
    deletes: 0,
  });
  mockDeleteExactOpenFgaTuples.mockResolvedValue({
    enabled: true,
    writes: 0,
    deletes: 0,
  });
  mockCreateServiceAccountClient.mockResolvedValue(KC_CLIENT);
  mockDeleteServiceAccountClient.mockResolvedValue(undefined);
  mockCreateServiceAccountDoc.mockResolvedValue({
    ...KC_CLIENT,
    _id: "mongo-id",
  });
  mockHasOrganizationAdmin.mockResolvedValue(false);
});

describe("POST /api/admin/service-accounts", () => {
  it("happy path → 201 returns the secret exactly once + writes tuples + audits", async () => {
    allowMembershipAndScopes(
      new Set(["can_use agent:incident-resolver", "can_call tool:jira/search"]),
    );

    const res = await POST(
      postRequest({
        name: "incident-bot",
        description: "PagerDuty",
        owning_team_id: "team-sre",
        scopes: [
          { type: "agent", ref: "incident-resolver" },
          { type: "tool", ref: "jira/search" },
        ],
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe("sa-sub-1");
    expect(body.data.credential.client_secret).toBe("super-secret-value");
    expect(body.data.credential.client_id).toBe(KC_CLIENT.clientId);
    expect(body.data.credential.token_url).toContain(
      "/protocol/openid-connect/token",
    );
    expect(body.data.granted_scopes).toHaveLength(2);

    // Ownership tuple written with owner_team (base relation, not can_*), plus
    // the coarse-gateway baseline (mcp_gateway:list) so the SA passes the
    // bridge's coarse gate (research.md R-9).
    const writeArg = mockWriteOpenFgaTuples.mock.calls[0][0];
    expect(writeArg.writes).toEqual(
      expect.arrayContaining([
        {
          user: "team:team-sre#member",
          relation: "owner_team",
          object: "service_account:sa-sub-1",
        },
        {
          user: "service_account:sa-sub-1",
          relation: "caller",
          object: "mcp_gateway:list",
        },
        {
          user: "service_account:sa-sub-1",
          relation: "user",
          object: "agent:incident-resolver",
        },
        {
          user: "service_account:sa-sub-1",
          relation: "caller",
          object: "tool:jira/search",
        },
      ]),
    );

    expect(mockCreateServiceAccountDoc).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "service_account.create" }),
    );
  });

  it("default-deny: empty scopes → 201 zero-scope SA (FR-004)", async () => {
    allowMembershipAndScopes(new Set());

    const res = await POST(
      postRequest({
        name: "no-scope-bot",
        owning_team_id: "team-sre",
        scopes: [],
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.granted_scopes).toEqual([]);
    // No scope tuples — only ownership + the coarse-gateway baseline are written.
    const writeArg = mockWriteOpenFgaTuples.mock.calls[0][0];
    expect(writeArg.writes).toHaveLength(2);
    expect(
      writeArg.writes.map((t: { relation: string }) => t.relation).sort(),
    ).toEqual(["caller", "owner_team"]);
    expect(writeArg.writes).toEqual(
      expect.arrayContaining([
        {
          user: "service_account:sa-sub-1",
          relation: "caller",
          object: "mcp_gateway:list",
        },
      ]),
    );
  });

  it("grants a held datasource plus the hidden RAG search baseline", async () => {
    allowMembershipAndScopes(new Set(["can_read data_source:source-a"]));

    const res = await POST(
      postRequest({
        name: "automation-reader",
        owning_team_id: "team-example",
        scopes: [{ type: "datasource", ref: "source-a" }],
      }),
    );

    expect(res.status).toBe(201);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        {
          user: "service_account:sa-sub-1",
          relation: "reader",
          object: "data_source:source-a",
        },
        {
          user: "service_account:sa-sub-1",
          relation: "searcher",
          object: "organization:example-org",
        },
      ]),
      deletes: [],
    });
    expect(mockCreateServiceAccountDoc).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes_snapshot: [
          expect.objectContaining({ type: "datasource", ref: "source-a" }),
        ],
      }),
    );
  });

  it("grants a held collection without expanding its datasources", async () => {
    allowMembershipAndScopes(new Set(["can_read rag_collection:platform-rag"]));

    const res = await POST(
      postRequest({
        name: "collection-reader",
        owning_team_id: "team-example",
        scopes: [{ type: "collection", ref: "platform-rag" }],
      }),
    );

    expect(res.status).toBe(201);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        {
          user: "service_account:sa-sub-1",
          relation: "reader",
          object: "rag_collection:platform-rag",
        },
        {
          user: "service_account:sa-sub-1",
          relation: "searcher",
          object: "organization:example-org",
        },
      ]),
      deletes: [],
    });
    expect(mockCreateServiceAccountDoc).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes_snapshot: [
          expect.objectContaining({
            type: "collection",
            ref: "platform-rag",
          }),
        ],
      }),
    );
  });

  it("lets an organization admin create with a datasource from the full catalog", async () => {
    allowMembershipAndScopes(new Set());
    mockHasOrganizationAdmin.mockResolvedValue(true);

    const res = await POST(
      postRequest({
        name: "platform-reader",
        owning_team_id: "team-example",
        scopes: [{ type: "datasource", ref: "source-admin" }],
      }),
    );

    expect(res.status).toBe(201);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledTimes(1);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        {
          user: "service_account:sa-sub-1",
          relation: "reader",
          object: "data_source:source-admin",
        },
      ]),
      deletes: [],
    });
  });

  it("name conflict → 409 (FR-002a)", async () => {
    allowMembershipAndScopes(new Set());
    mockIsNameTakenInTeam.mockResolvedValue(true);

    const res = await POST(
      postRequest({
        name: "incident-bot",
        owning_team_id: "team-sre",
        scopes: [],
      }),
    );

    expect(res.status).toBe(409);
    // No Keycloak client created on conflict.
    expect(mockCreateServiceAccountClient).not.toHaveBeenCalled();
  });

  it("case-insensitive name collision is detected via the lib (FR-002a)", async () => {
    allowMembershipAndScopes(new Set());
    // Simulate the lib's case-insensitive comparison: existing "Incident-Bot".
    mockIsNameTakenInTeam.mockImplementation(
      async (_team: string, name: string) =>
        name.trim().toLowerCase() === "incident-bot",
    );

    const res = await POST(
      postRequest({
        name: "INCIDENT-BOT",
        owning_team_id: "team-sre",
        scopes: [],
      }),
    );

    expect(res.status).toBe(409);
    expect(mockIsNameTakenInTeam).toHaveBeenCalledWith(
      "team-sre",
      "INCIDENT-BOT",
    );
  });

  it("unauthorized scope → 403, whole request rejected, nothing created (S3/FR-008)", async () => {
    // Caller holds the agent but NOT the tool.
    allowMembershipAndScopes(new Set(["can_use agent:incident-resolver"]));

    const res = await POST(
      postRequest({
        name: "incident-bot",
        owning_team_id: "team-sre",
        scopes: [
          { type: "agent", ref: "incident-resolver" },
          { type: "tool", ref: "jira/search" },
        ],
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.data.rejected_scopes).toEqual([
      { type: "tool", ref: "jira/search" },
    ]);
    expect(mockCreateServiceAccountClient).not.toHaveBeenCalled();
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("non-member of owning team → 403 (FR-002)", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    const res = await POST(
      postRequest({
        name: "incident-bot",
        owning_team_id: "team-other",
        scopes: [],
      }),
    );

    expect(res.status).toBe(403);
    expect(mockIsNameTakenInTeam).not.toHaveBeenCalled();
    expect(mockCreateServiceAccountClient).not.toHaveBeenCalled();
  });

  it("malformed body → 400 (constitution VII)", async () => {
    allowMembershipAndScopes(new Set());

    // Bad name char.
    const r1 = await POST(
      postRequest({ name: "bad/name", owning_team_id: "team-sre", scopes: [] }),
    );
    expect(r1.status).toBe(400);

    // Malformed tool ref (no server).
    const r2 = await POST(
      postRequest({
        name: "ok-name",
        owning_team_id: "team-sre",
        scopes: [{ type: "tool", ref: "/search" }],
      }),
    );
    expect(r2.status).toBe(400);

    // Missing owning_team_id.
    const r3 = await POST(postRequest({ name: "ok-name", scopes: [] }));
    expect(r3.status).toBe(400);

    expect(mockCreateServiceAccountClient).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(
      postRequest({ name: "x", owning_team_id: "team-sre", scopes: [] }),
    );
    expect(res.status).toBe(401);
  });

  it("compensates (deletes Keycloak client) when tuple write fails", async () => {
    allowMembershipAndScopes(new Set(["can_use agent:incident-resolver"]));
    mockWriteOpenFgaTuples.mockRejectedValue(new Error("openfga down"));

    const res = await POST(
      postRequest({
        name: "incident-bot",
        owning_team_id: "team-sre",
        scopes: [{ type: "agent", ref: "incident-resolver" }],
      }),
    );

    expect(res.status).toBe(503);
    expect(mockDeleteServiceAccountClient).toHaveBeenCalledWith("kc-uuid-1");
    expect(mockCreateServiceAccountDoc).not.toHaveBeenCalled();
  });

  it("compensates (deletes tuples + client) when Mongo insert fails", async () => {
    allowMembershipAndScopes(new Set(["can_use agent:incident-resolver"]));
    mockCreateServiceAccountDoc.mockRejectedValue(new Error("mongo down"));

    const res = await POST(
      postRequest({
        name: "incident-bot",
        owning_team_id: "team-sre",
        scopes: [{ type: "agent", ref: "incident-resolver" }],
      }),
    );

    expect(res.status).toBe(503);
    expect(mockDeleteExactOpenFgaTuples).toHaveBeenCalledTimes(1);
    expect(mockDeleteServiceAccountClient).toHaveBeenCalledWith("kc-uuid-1");
  });
});
