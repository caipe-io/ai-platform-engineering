/**
 * @jest-environment node
 */
/**
 * BFF tests for custom MCP tool ownership + org-wide sharing wiring
 * (spec 2026-06-03-unified-shareable-resource-rbac, US6).
 *
 * These pin the RAG proxy route's create/update behavior (the generic
 * `handleShareableResourceWrite` transfer guard is covered separately in
 * shareable-resource-write.test.ts):
 *   - Assigning an `owner_team_slug` requires `team#use` on that team; a
 *     caller who is rejected by `requireResourcePermission` cannot create the
 *     tool and no OpenFGA reconcile runs (fail-closed).
 *   - On a successful create/update the proxy reconciles the OpenFGA
 *     projection with the requested `shared_with_org` / shared-teams and the
 *     PREVIOUS state read from config (so org-share toggles revoke correctly).
 *   - The owner/creator/shared/org fields are injected into the body forwarded
 *     to the RAG server (the source of truth), and `creator_subject` is
 *     preserved set-once across updates.
 * assisted-by Cursor claude-opus-4-8
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
  // Use the REAL ApiError so the route's `error instanceof ApiError` check
  // matches errors thrown by shared modules (shareable-resource.ts imports
  // ApiError from @/lib/api-error). In production api-middleware re-exports the
  // same class; a local stand-in here would make instanceof fail and surface
  // clean 4xx errors as 502.
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
  // The shared `resolveShareableOwnershipWrite` decision (in shareable-resource.ts)
  // calls this for transfers. These cases are first-set/share-only (no owner
  // CHANGE), so it's never the deciding gate here; default-allow keeps the
  // import resolvable. Actual transfer authorization is covered in
  // mcp-tool-ownership.test.ts and shareable-resource-write.test.ts.
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

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RAG_ADMIN_BYPASS_DISABLED;
  mockRequireRbacPermission.mockResolvedValue(undefined);
  mockRequireResourcePermission.mockResolvedValue(undefined);
  // Default: not org admin.
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
  mockCanTransferResourceOwnership.mockResolvedValue(true);
  mockReconcileMcpToolRelationships.mockResolvedValue({
    enabled: true,
    writes: 0,
    deletes: 0,
  });
});

function ragRequest(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
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

/**
 * Wire global.fetch for the proxy. GET /v1/mcp/custom-tools returns the
 * `previousTools` (used by loadMcpToolConfig to compute the reconcile diff);
 * the create/update POST/PUT returns `upstreamStatus`. Returns the recorded
 * calls so tests can assert the forwarded body.
 */
function setupFetch(opts: {
  previousTools?: Array<Record<string, unknown>>;
  upstreamStatus?: number;
}) {
  const calls: Array<{
    url: string;
    method: string;
    body?: Record<string, unknown>;
  }> = [];
  global.fetch = jest.fn((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: Record<string, unknown> | undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = undefined;
      }
    }
    calls.push({ url: u, method, body: parsedBody });
    if (u.includes("/v1/mcp/custom-tools") && method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => opts.previousTools ?? [],
      } as Response);
    }
    const status = opts.upstreamStatus ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ tool_id: "custom-search" }),
    } as Response);
  }) as jest.Mock;
  return calls;
}

function jsonInit(method: string, body: unknown): RequestInit {
  const text = JSON.stringify(body);
  return {
    method,
    body: text,
    headers: {
      "content-type": "application/json",
      // PUT in the route only parses the body when content-length > 0.
      "content-length": String(Buffer.byteLength(text)),
    },
  };
}

const CREATE_CTX = {
  params: Promise.resolve({ path: ["v1", "mcp", "custom-tools"] }),
};
const UPSERT_CTX = {
  params: Promise.resolve({
    path: ["v1", "mcp", "custom-tools", "custom-search"],
  }),
};

describe("POST /v1/mcp/custom-tools — owner-team assignment guard", () => {
  it("rejects (403) when the caller cannot use the requested owner team", async () => {
    await asUser("mallory-sub");
    const calls = setupFetch({});
    const { ApiError } = await import("@/lib/api-middleware");
    // requireResourcePermission is called for { type:'team', action:'use' }.
    mockRequireResourcePermission.mockRejectedValue(
      new ApiError(
        "You must belong to the owner team to assign it.",
        403,
        "team#use",
      ),
    );

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest(
        "/api/rag/v1/mcp/custom-tools",
        jsonInit("POST", {
          tool_id: "custom-search",
          owner_team_slug: "platform",
        }),
      ),
      CREATE_CTX,
    );

    expect(res.status).toBe(403);
    // Fail-closed: no upstream write, no OpenFGA reconcile.
    expect(mockReconcileMcpToolRelationships).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("requires team#use against the requested owner team", async () => {
    await asUser("alice-sub");
    setupFetch({});
    const { POST } = await import("@/app/api/rag/[...path]/route");
    await POST(
      ragRequest(
        "/api/rag/v1/mcp/custom-tools",
        jsonInit("POST", {
          tool_id: "custom-search",
          owner_team_slug: "platform",
        }),
      ),
      CREATE_CTX,
    );
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "team", id: "platform", action: "use" }),
    );
  });
});

describe("POST /v1/mcp/custom-tools — org-wide + shared-team reconcile wiring", () => {
  it("reconciles with sharedWithOrg=true and the previous state from config (fresh create)", async () => {
    await asUser("alice-sub");
    const calls = setupFetch({ previousTools: [] }); // no prior tool

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest(
        "/api/rag/v1/mcp/custom-tools",
        jsonInit("POST", {
          tool_id: "custom-search",
          owner_team_slug: "platform",
          shared_with_teams: ["data-eng"],
          shared_with_org: true,
        }),
      ),
      CREATE_CTX,
    );

    expect(res.status).toBe(200);
    expect(mockReconcileMcpToolRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "custom-search",
        ownerTeamSlug: "platform",
        ownerSubject: "alice-sub",
        creatorSubject: "alice-sub", // stamped on first write
        nextSharedTeamSlugs: ["data-eng"],
        previousSharedTeamSlugs: [],
        sharedWithOrg: true,
        previousSharedWithOrg: false,
      }),
    );

    // Body forwarded to the RAG server (source of truth) carries the fields.
    const upstream = calls.find((c) => c.method === "POST");
    expect(upstream?.body).toMatchObject({
      owner_team_slug: "platform",
      creator_subject: "alice-sub",
      owner_subject: "alice-sub",
      shared_with_teams: ["data-eng"],
      shared_with_org: true,
    });
  });

  it("does not reconcile when the upstream create fails", async () => {
    await asUser("alice-sub");
    setupFetch({ previousTools: [], upstreamStatus: 500 });

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest(
        "/api/rag/v1/mcp/custom-tools",
        jsonInit("POST", {
          tool_id: "custom-search",
          owner_team_slug: "platform",
          shared_with_org: true,
        }),
      ),
      CREATE_CTX,
    );

    expect(res.status).toBe(500);
    expect(mockReconcileMcpToolRelationships).not.toHaveBeenCalled();
  });
});

describe("PUT /v1/mcp/custom-tools/<id> — toggling org sharing off", () => {
  it("passes previousSharedWithOrg=true and preserves the set-once creator", async () => {
    await asUser("alice-sub");
    // Previously persisted: org-shared, shared with data-eng, created by 'orig'.
    setupFetch({
      previousTools: [
        {
          tool_id: "custom-search",
          owner_team_slug: "platform",
          shared_with_teams: ["data-eng"],
          shared_with_org: true,
          creator_subject: "orig-creator",
        },
      ],
    });

    const { PUT } = await import("@/app/api/rag/[...path]/route");
    const res = await PUT(
      ragRequest(
        "/api/rag/v1/mcp/custom-tools/custom-search",
        // shared_with_org omitted → false (turn off).
        jsonInit("PUT", {
          tool_id: "custom-search",
          owner_team_slug: "platform",
          shared_with_teams: ["data-eng"],
        }),
      ),
      UPSERT_CTX,
    );

    expect(res.status).toBe(200);
    expect(mockReconcileMcpToolRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "custom-search",
        sharedWithOrg: false,
        previousSharedWithOrg: true,
        previousSharedTeamSlugs: ["data-eng"],
        creatorSubject: "orig-creator", // set-once preserved across the update
      }),
    );
  });
});
