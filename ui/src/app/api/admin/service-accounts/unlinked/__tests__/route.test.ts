/**
 * @jest-environment node
 *
 * B2 — GET /api/admin/service-accounts/unlinked
 *
 * Core contracts:
 *  1. 401 for unauthenticated callers.
 *  2. 403 for authenticated non-admins (org-admin gate).
 *  3. 200 + SA payload for platform admins.
 *  4. 404 when the unlinked SA has not been bootstrapped.
 *  5. 503 when getUnlinkedServiceAccount throws.
 *  6. Bootstrap-admin email bypasses the OpenFGA check (break-glass).
 */

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: (email: string) => email === "bootstrap@example.com",
}));

const mockCheckOpenFgaTuple = jest.fn();
const mockListOpenFgaObjects = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
}));

const mockFindAgentVisibilities = jest.fn();
jest.mock("@/lib/dynamic-agent-visibility", () => ({
  findAgentVisibilities: (...args: unknown[]) => mockFindAgentVisibilities(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:caipe",
}));

const mockGetUnlinkedServiceAccount = jest.fn();
jest.mock("@/lib/rbac/unlinked-service-account", () => ({
  getUnlinkedServiceAccount: () => mockGetUnlinkedServiceAccount(),
}));

const mockListEveryoneKnowledgeScopes = jest.fn();
jest.mock("@/lib/rbac/unlinked-knowledge-access", () => ({
  listEveryoneKnowledgeScopes: () => mockListEveryoneKnowledgeScopes(),
}));

// QUAL-7: isPlatformAdmin is now imported from @/lib/rbac/platform-admin in the route.
const mockIsPlatformAdmin = jest.fn();
jest.mock("@/lib/rbac/platform-admin", () => ({
  isPlatformAdmin: (...args: unknown[]) => mockIsPlatformAdmin(...args),
  hasOrganizationAdmin: (...args: unknown[]) => mockIsPlatformAdmin(...args),
}));

import { GET } from "../route";

const ADMIN_SESSION = { sub: "admin-sub", user: { email: "admin@example.com" } };
const NON_ADMIN_SESSION = { sub: "user-sub", user: { email: "user@example.com" } };
const BOOTSTRAP_SESSION = { sub: "bootstrap-sub", user: { email: "bootstrap@example.com" } };

const ANON_SA_DOC = {
  sa_sub: "anon-sub-abc",
  client_id: "caipe-sa-unlinked-12345",
  client_uuid: "kc-uuid-anon",
  name: "unlinked",
  description: "Platform-managed unlinked identity.",
  owning_team_id: "super-admins",
  created_by: "unlinked-bootstrap",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  status: "active" as const,
  is_platform_unlinked: true,
  scopes_snapshot: [
    { type: "agent" as const, ref: "hello-world", added_by: "admin-sub", added_at: new Date() },
    { type: "tool" as const, ref: "jira/search", added_by: "admin-sub", added_at: new Date() },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: non-admin. Individual tests override as needed.
  mockIsPlatformAdmin.mockResolvedValue(false);
  // Default authoritative reads: no agent grants, empty visibility map.
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockFindAgentVisibilities.mockResolvedValue(new Map());
  mockListEveryoneKnowledgeScopes.mockResolvedValue({
    datasourceIds: new Set<string>(),
    collectionIds: new Set<string>(),
  });
});

describe("GET /api/admin/service-accounts/unlinked", () => {
  it("401s when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("401s when session has no email or sub", async () => {
    mockGetServerSession.mockResolvedValue({ sub: "sub", user: {} });

    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("403s when caller is not a platform admin", async () => {
    mockGetServerSession.mockResolvedValue(NON_ADMIN_SESSION);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/platform admin/i);
    // Should not have called the SA resolver
    expect(mockGetUnlinkedServiceAccount).not.toHaveBeenCalled();
  });

  it("200s for org-admin with authoritative scopes tagged by source", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockGetUnlinkedServiceAccount.mockResolvedValue(ANON_SA_DOC);
    // Authoritative agent grants come from OpenFGA, not the Mongo snapshot.
    // `hello-world` is explicitly granted (team-scoped); `default` is global
    // (auto-granted because it is shared with Everyone).
    mockListOpenFgaObjects.mockResolvedValue({
      objects: ["agent:hello-world", "agent:default"],
    });
    mockFindAgentVisibilities.mockResolvedValue(
      new Map([
        ["hello-world", "team"],
        ["default", "global"],
      ]),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.id).toBe("anon-sub-abc");
    // QUAL-10: sa_sub is no longer in the response — only id/name/scopes
    expect(body.data.sa_sub).toBeUndefined();
    expect(body.data.name).toBe("unlinked");
    // Agents are tagged: global → "everyone" (locked), otherwise "explicit".
    // Tools remain explicit. `jira/search` still comes from the snapshot.
    expect(body.data.scopes).toEqual(
      expect.arrayContaining([
        { type: "agent", ref: "hello-world", source: "explicit" },
        { type: "agent", ref: "default", source: "everyone" },
        { type: "tool", ref: "jira/search", source: "explicit" },
      ]),
    );
    expect(body.data.scopes).toHaveLength(3);
    // The OpenFGA read is keyed on the SA's can_use agent objects.
    expect(mockListOpenFgaObjects).toHaveBeenCalledWith({
      user: "service_account:anon-sub-abc",
      relation: "can_use",
      type: "agent",
    });
  });

  it("does not surface a global agent as a removable explicit scope even if it lingers in the snapshot", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    // Snapshot still carries a stale manual entry for `default` (a global agent).
    mockGetUnlinkedServiceAccount.mockResolvedValue({
      ...ANON_SA_DOC,
      scopes_snapshot: [
        { type: "agent", ref: "default", added_by: "admin-sub", added_at: new Date() },
      ],
    });
    mockListOpenFgaObjects.mockResolvedValue({ objects: ["agent:default"] });
    mockFindAgentVisibilities.mockResolvedValue(new Map([["default", "global"]]));

    const res = await GET();
    const body = await res.json();
    // `default` appears exactly once, tagged everyone (locked) — never as a
    // second explicit chip from the stale snapshot.
    expect(body.data.scopes).toEqual([
      { type: "agent", ref: "default", source: "everyone" },
    ]);
  });

  it("surfaces Everyone-shared knowledge as automatic access", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockGetUnlinkedServiceAccount.mockResolvedValue(ANON_SA_DOC);
    mockListEveryoneKnowledgeScopes.mockResolvedValue({
      datasourceIds: new Set(["published-source"]),
      collectionIds: new Set(["platform-rag"]),
    });

    const res = await GET();
    const body = await res.json();

    expect(body.data.scopes).toEqual(
      expect.arrayContaining([
        { type: "datasource", ref: "published-source", source: "everyone" },
        { type: "collection", ref: "platform-rag", source: "everyone" },
      ]),
    );
  });

  it("does not return credential material in the response", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockGetUnlinkedServiceAccount.mockResolvedValue(ANON_SA_DOC);

    const res = await GET();
    const body = await res.json();
    const serialized = JSON.stringify(body);

    // NEVER expose these in any response
    expect(serialized).not.toContain("client_secret");
    expect(serialized).not.toContain("client_uuid");
    expect(serialized).not.toContain("kc-uuid-anon");
  });

  it("200s for bootstrap-admin without an OpenFGA check", async () => {
    mockGetServerSession.mockResolvedValue(BOOTSTRAP_SESSION);
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockGetUnlinkedServiceAccount.mockResolvedValue(ANON_SA_DOC);

    const res = await GET();
    expect(res.status).toBe(200);
    // Break-glass path should not call OpenFGA
    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
  });

  it("404s when the unlinked SA has not been bootstrapped", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockGetUnlinkedServiceAccount.mockResolvedValue(null);

    const res = await GET();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not found/i);
  });

  it("503s when getUnlinkedServiceAccount throws", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockGetUnlinkedServiceAccount.mockRejectedValue(new Error("DB connection lost"));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("403s when isPlatformAdmin returns false (non-admin)", async () => {
    // isPlatformAdmin is now the shared lib helper; this test verifies the route
    // enforces its result rather than checking the inner OpenFGA call (which is
    // covered by the unlinked-service-account lib tests).
    mockGetServerSession.mockResolvedValue(NON_ADMIN_SESSION);
    mockIsPlatformAdmin.mockResolvedValue(false);

    const res = await GET();
    expect(res.status).toBe(403);
    expect(mockGetUnlinkedServiceAccount).not.toHaveBeenCalled();
  });
});
