/**
 * @jest-environment node
 */
/**
 * BFF tests for custom MCP tool ownership + transfer (spec 2026-06-03, US3/US6).
 *
 *   - PUT /v1/mcp/custom-tools/<id> changing owner_team_slug is a TRANSFER:
 *     allowed only for an owner-team admin or org admin (canTransferResourceOwnership),
 *     with a not-a-member confirmation gate.
 *   - Omitting owner_team_slug keeps the existing owner (no accidental revoke).
 *   - The previous owner team's grants are revoked on a successful transfer
 *     (previousOwnerTeamSlug threaded to the reconciler).
 */

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

import { NextRequest } from "next/server";

const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockCanTransferResourceOwnership = jest.fn();
const mockReconcileMcpToolRelationships = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  // Real ApiError so the route's `instanceof ApiError` matches errors thrown
  // by shared modules (shareable-resource.ts → @/lib/api-error). Production
  // api-middleware re-exports this same class.
  const { ApiError } = jest.requireActual("@/lib/api-error");
  return {
    ApiError,
    getAuthFromBearerOrSession: async () => {
      const { getServerSession } = jest.requireMock("next-auth") as {
        getServerSession: jest.Mock;
      };
      const session = await getServerSession();
      return { session, user: session?.user };
    },
    requireRbacPermission: (...args: unknown[]) =>
      mockRequireRbacPermission(...args),
    handleApiError: (error: unknown) =>
      Response.json(
        {
          error: error instanceof Error ? error.message : "error",
          code: (error as { code?: string }).code,
        },
        { status: (error as { statusCode?: number }).statusCode ?? 500 },
      ),
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
  canTransferResourceOwnership: (...args: unknown[]) =>
    mockCanTransferResourceOwnership(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:caipe",
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileKnowledgeBaseRelationships: jest.fn(),
  reconcileDataSourceRelationships: jest.fn(),
  reconcileMcpToolRelationships: (...args: unknown[]) =>
    mockReconcileMcpToolRelationships(...args),
  deleteAllMcpToolRelationshipTuples: jest.fn(),
}));

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

const EXISTING_TOOL = {
  tool_id: "infra-search",
  owner_team_slug: "team-old",
  creator_subject: "creator-x",
  shared_with_teams: ["share-a"],
};

/**
 * Mock fetch: the GET custom-tools listing (used by loadMcpToolConfig) returns
 * the existing tool; the PUT forward to the RAG server returns 204.
 */
function mockFetch() {
  global.fetch = jest.fn((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.includes("/v1/mcp/custom-tools") && method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [EXISTING_TOOL],
      } as Response);
    }
    // Upstream forward (PUT) — succeeds with no content.
    return Promise.resolve({
      ok: true,
      status: 204,
      json: async () => ({}),
    } as Response);
  }) as jest.Mock;
}

async function asUser(sub = "alice-sub") {
  const nextAuth = await import("next-auth");
  jest.mocked(nextAuth.getServerSession).mockResolvedValue({
    sub,
    role: "user",
    org: "team-alpha",
    accessToken: "browser-token",
    user: { email: `${sub}@example.com` },
  } as never);
}

function putToolRequest(body: unknown): NextRequest {
  const payload = JSON.stringify(body);
  return new NextRequest(
    new URL("http://localhost:3000/api/rag/v1/mcp/custom-tools/infra-search"),
    {
      method: "PUT",
      body: payload,
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
      },
    },
  );
}

const PUT_PARAMS = {
  params: Promise.resolve({
    path: ["v1", "mcp", "custom-tools", "infra-search"],
  }),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireRbacPermission.mockResolvedValue(undefined);
  mockRequireResourcePermission.mockResolvedValue(undefined);
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
  mockReconcileMcpToolRelationships.mockResolvedValue({
    enabled: true,
    writes: 2,
    deletes: 1,
  });
  mockFetch();
});

describe("PUT /v1/mcp/custom-tools/<id> — ownership transfer (US3)", () => {
  it("denies a transfer when the caller is not an owner-team/org admin (403)", async () => {
    await asUser("mallory-sub");
    mockCanTransferResourceOwnership.mockResolvedValue(false);

    const { PUT } = await import("@/app/api/rag/[...path]/route");
    const res = await PUT(
      putToolRequest({ owner_team_slug: "team-new" }),
      PUT_PARAMS,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("TRANSFER_FORBIDDEN");
    expect(mockReconcileMcpToolRelationships).not.toHaveBeenCalled();
  });

  it("allows a transfer by an authorized admin who is a member of the destination, revoking the old owner", async () => {
    await asUser("alice-sub");
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    mockRequireResourcePermission.mockResolvedValue(undefined); // member of destination

    const { PUT } = await import("@/app/api/rag/[...path]/route");
    const res = await PUT(
      putToolRequest({ owner_team_slug: "team-new" }),
      PUT_PARAMS,
    );

    expect(res.status).toBe(204);
    expect(mockReconcileMcpToolRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "infra-search",
        ownerTeamSlug: "team-new",
        previousOwnerTeamSlug: "team-old", // old owner revoked
        creatorSubject: "creator-x", // set-once preserved
      }),
    );
  });

  it("rejects a transfer to a team the caller is not a member of without confirmation (409)", async () => {
    await asUser("alice-sub");
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    const ApiErrorClass = jest.requireMock("@/lib/api-middleware").ApiError;
    mockRequireResourcePermission.mockRejectedValue(
      new ApiErrorClass("forbidden", 403),
    );

    const { PUT } = await import("@/app/api/rag/[...path]/route");
    const res = await PUT(
      putToolRequest({ owner_team_slug: "team-new" }),
      PUT_PARAMS,
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TRANSFER_NOT_MEMBER_UNCONFIRMED");
    expect(mockReconcileMcpToolRelationships).not.toHaveBeenCalled();
  });

  it("allows a transfer to a non-member team when explicitly confirmed", async () => {
    await asUser("alice-sub");
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    const ApiErrorClass = jest.requireMock("@/lib/api-middleware").ApiError;
    mockRequireResourcePermission.mockRejectedValue(
      new ApiErrorClass("forbidden", 403),
    );

    const { PUT } = await import("@/app/api/rag/[...path]/route");
    const res = await PUT(
      putToolRequest({ owner_team_slug: "team-new", confirm_not_member: true }),
      PUT_PARAMS,
    );

    expect(res.status).toBe(204);
    expect(mockReconcileMcpToolRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerTeamSlug: "team-new",
        previousOwnerTeamSlug: "team-old",
      }),
    );
  });

  it("keeps the existing owner (no transfer, no revoke) when owner_team_slug is omitted", async () => {
    await asUser("alice-sub");

    const { PUT } = await import("@/app/api/rag/[...path]/route");
    const res = await PUT(
      putToolRequest({ shared_with_teams: ["share-a", "share-b"] }),
      PUT_PARAMS,
    );

    expect(res.status).toBe(204);
    expect(mockCanTransferResourceOwnership).not.toHaveBeenCalled();
    expect(mockReconcileMcpToolRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerTeamSlug: "team-old",
        // prev === next ⇒ reconcile helper passes undefined (no owner revoke).
        previousOwnerTeamSlug: undefined,
        nextSharedTeamSlugs: ["share-a", "share-b"],
      }),
    );
  });
});
