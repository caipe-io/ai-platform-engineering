/**
 * @jest-environment node
 */
/**
 * T031 — rotate + revoke.
 *
 * Rotate (FR-017/019): can_manage → regenerate Keycloak secret → return the NEW
 * secret ONCE; scopes untouched.
 * Revoke (FR-018/018a): can_manage → delete Keycloak client → delete ALL tuples
 * (ownership + scopes) → mark Mongo revoked (doc retained, name freed for reuse).
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/auth-config", () => ({ authOptions: {} }));

const mockCheckOpenFgaTuple = jest.fn();
const mockListOpenFgaObjects = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockDeleteExactOpenFgaTuples = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  deleteExactOpenFgaTuples: (...args: unknown[]) =>
    mockDeleteExactOpenFgaTuples(...args),
}));

const mockRegenerateClientSecret = jest.fn();
const mockDeleteServiceAccountClient = jest.fn();
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  regenerateClientSecret: (...args: unknown[]) =>
    mockRegenerateClientSecret(...args),
  deleteServiceAccountClient: (...args: unknown[]) =>
    mockDeleteServiceAccountClient(...args),
  getServiceAccountTokenUrl: () =>
    "https://keycloak.example.com/realms/caipe/protocol/openid-connect/token",
}));

const mockLogAudit = jest.fn();
jest.mock("@/lib/rbac/audit", () => ({
  logOpenFgaRebacAuditEvent: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockGetBySub = jest.fn();
const mockUpdateStatus = jest.fn();
jest.mock("@/lib/service-accounts", () => ({
  getBySub: (...args: unknown[]) => mockGetBySub(...args),
  updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
}));

const mockHasOrganizationAdmin = jest.fn();
jest.mock("@/lib/rbac/platform-admin", () => ({
  hasOrganizationAdmin: (...args: unknown[]) =>
    mockHasOrganizationAdmin(...args),
}));

import { POST as ROTATE } from "../[id]/rotate/route";
import { DELETE as REVOKE } from "../[id]/route";

const SESSION = { sub: "mgr-sub", user: { email: "mgr@example.com" } };
const SA_ID = "sa-123";
const DOC = {
  sa_sub: SA_ID,
  client_id: "caipe-sa-incident-bot-a1b2c3",
  client_uuid: "kc-uuid-1",
  name: "incident-bot",
  owning_team_id: "team-sre",
  created_by: "creator-sub",
  status: "active" as const,
};

function req(method: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/admin/service-accounts/${SA_ID}`,
    { method },
  );
}
function ctx() {
  return { params: Promise.resolve({ id: SA_ID }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServerSession.mockResolvedValue(SESSION);
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  mockGetBySub.mockResolvedValue(DOC);
  mockRegenerateClientSecret.mockResolvedValue("new-secret-xyz");
  mockDeleteServiceAccountClient.mockResolvedValue(undefined);
  mockDeleteExactOpenFgaTuples.mockResolvedValue({
    enabled: true,
    writes: 0,
    deletes: 3,
  });
  mockUpdateStatus.mockResolvedValue(true);
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockReadOpenFgaTuples.mockResolvedValue({
    tuples: [],
    continuationToken: undefined,
  });
  mockHasOrganizationAdmin.mockResolvedValue(false);
});

describe("POST .../[id]/rotate", () => {
  it("returns the NEW secret once, leaves scopes untouched, audits", async () => {
    const res = await ROTATE(req("POST"), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.credential.client_secret).toBe("new-secret-xyz");
    expect(body.data.credential.client_id).toBe(DOC.client_id);
    expect(mockRegenerateClientSecret).toHaveBeenCalledWith("kc-uuid-1");
    // No tuple/scope mutation on rotate (FR-019).
    expect(mockDeleteExactOpenFgaTuples).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "service_account.rotate" }),
    );
  });

  it("404 for a non-manager", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    const res = await ROTATE(req("POST"), ctx());
    expect(res.status).toBe(404);
    expect(mockRegenerateClientSecret).not.toHaveBeenCalled();
  });

  it("404 when already revoked (cannot rotate a dead SA)", async () => {
    mockGetBySub.mockResolvedValue({ ...DOC, status: "revoked" });
    const res = await ROTATE(req("POST"), ctx());
    expect(res.status).toBe(404);
    expect(mockRegenerateClientSecret).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await ROTATE(req("POST"), ctx());
    expect(res.status).toBe(401);
  });

  it("org admin can rotate a SA owned by a team they don't belong to", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockHasOrganizationAdmin.mockResolvedValue(true);
    const res = await ROTATE(req("POST"), ctx());
    expect(res.status).toBe(200);
    expect(mockRegenerateClientSecret).toHaveBeenCalledWith("kc-uuid-1");
  });
});

describe("DELETE .../[id] (revoke)", () => {
  it("deletes client + ALL tuples, marks revoked, audits", async () => {
    mockListOpenFgaObjects
      .mockResolvedValueOnce({ objects: ["agent:incident-resolver"] }) // can_use agent
      .mockResolvedValueOnce({ objects: ["tool:jira/search", "tool:jira/*"] }); // can_call tool
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        {
          key: {
            user: `service_account:${SA_ID}`,
            relation: "reader",
            object: "rag_collection:platform-rag",
          },
        },
      ],
      continuationToken: undefined,
    });

    const res = await REVOKE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: SA_ID, status: "revoked" });

    expect(mockDeleteServiceAccountClient).toHaveBeenCalledWith("kc-uuid-1");

    // Ownership + coarse-gateway baseline + every scope tuple deleted (base relations).
    const deleted = mockDeleteExactOpenFgaTuples.mock.calls[0][0];
    expect(deleted).toEqual(
      expect.arrayContaining([
        {
          user: "team:team-sre#member",
          relation: "owner_team",
          object: `service_account:${SA_ID}`,
        },
        {
          user: `service_account:${SA_ID}`,
          relation: "caller",
          object: "mcp_gateway:list",
        },
        {
          user: `service_account:${SA_ID}`,
          relation: "searcher",
          object: "organization:caipe",
        },
        {
          user: `service_account:${SA_ID}`,
          relation: "user",
          object: "agent:incident-resolver",
        },
        {
          user: `service_account:${SA_ID}`,
          relation: "caller",
          object: "tool:jira/search",
        },
        {
          user: `service_account:${SA_ID}`,
          relation: "caller",
          object: "tool:jira/*",
        },
        {
          user: `service_account:${SA_ID}`,
          relation: "reader",
          object: "rag_collection:platform-rag",
        },
      ]),
    );
    expect(deleted).toHaveLength(7);

    // Doc marked revoked (retained — frees name for reuse, FR-018a).
    expect(mockUpdateStatus).toHaveBeenCalledWith(SA_ID, "revoked");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "service_account.revoke" }),
    );
  });

  it("404 for a non-manager", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    const res = await REVOKE(req("DELETE"), ctx());
    expect(res.status).toBe(404);
    expect(mockDeleteServiceAccountClient).not.toHaveBeenCalled();
  });

  it("idempotent: already-revoked → 200 without re-deleting", async () => {
    mockGetBySub.mockResolvedValue({ ...DOC, status: "revoked" });
    const res = await REVOKE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(mockDeleteServiceAccountClient).not.toHaveBeenCalled();
    expect(mockDeleteExactOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await REVOKE(req("DELETE"), ctx());
    expect(res.status).toBe(401);
  });

  it("403 for a protected SA — cannot revoke, nothing deleted", async () => {
    mockGetBySub.mockResolvedValue({ ...DOC, is_platform_unlinked: true });
    const res = await REVOKE(req("DELETE"), ctx());
    expect(res.status).toBe(403);
    expect(mockDeleteServiceAccountClient).not.toHaveBeenCalled();
    expect(mockDeleteExactOpenFgaTuples).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("org admin can revoke a SA owned by a team they don't belong to", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockHasOrganizationAdmin.mockResolvedValue(true);
    const res = await REVOKE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(mockDeleteServiceAccountClient).toHaveBeenCalledWith("kc-uuid-1");
  });
});
