/**
 * @jest-environment node
 *
 * Regression coverage for the multi-server agent-context minting endpoint.
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    status: number;
    code?: string;

    constructor(message: string, status = 500, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (err) {
          const e = err as { status?: number; message: string; code?: string };
          return Response.json(
            { success: false, error: e.message, code: e.code },
            { status: e.status ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: (...args: unknown[]) => mockFilterResourcesByPermission(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

function request(body?: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL("/api/mcp-servers/agent-context", "http://localhost:3000"), {
    method: "POST",
    headers: body === undefined ? { "content-length": "0" } : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const session = {
  sub: "user-sub",
  role: "admin",
  accessToken: "user-keycloak-token",
};

function mcpServer(id: string) {
  return {
    _id: id,
    name: id,
    transport: "http" as const,
    endpoint: `http://agentgateway:4000/mcp/${id}`,
    source: "agentgateway" as const,
    enabled: true,
  };
}

function decodeAgentContextPayload(headers: Record<string, string>): {
  agent_id: string;
  kind: string;
  iat: number;
  exp: number;
} {
  return JSON.parse(Buffer.from(headers["X-CAIPE-Agent-Context"], "base64url").toString("utf8"));
}

describe("POST /api/mcp-servers/agent-context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "test-agent-context-secret";
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session });
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 3, deletes: 0 });
  });

  afterEach(() => {
    delete process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
  });

  it("mints one context scoped to every server the caller can invoke when serverIds is omitted", async () => {
    const toArray = jest.fn().mockResolvedValue([mcpServer("argocd"), mcpServer("jira")]);
    mockGetCollection.mockResolvedValue({ find: jest.fn().mockReturnValue({ toArray }) });
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);

    const { POST } = await import("../route");
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.server_ids.sort()).toEqual(["argocd", "jira"]);
    expect(body.data.headers["X-CAIPE-Agent-Context"]).toEqual(expect.any(String));
    expect(body.data.headers["X-CAIPE-Agent-Context-Signature"]).toEqual(expect.any(String));
    expect(body.data.headers["X-CAIPE-Trusted-Interaction"]).toEqual(expect.any(String));
    expect(body.data.headers["X-CAIPE-Trusted-Interaction-Signature"]).toEqual(expect.any(String));
    const payload = decodeAgentContextPayload(body.data.headers);
    expect(payload.kind).toBe("local");
    // Local contexts get an 8h TTL (see AGENT_CONTEXT_TTL_SECONDS.local in
    // mcp-http-server-client.ts) — guards against a regression back to 12h or
    // an unbounded lifetime, since the exp is the only lifetime bound on a
    // local context.
    expect(payload.exp - payload.iat).toBe(60 * 60 * 8);

    // No OpenFGA tuples are granted or revoked — a "local" context carries no
    // delegated authority to bound, so there's nothing to write.
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("scopes the context to only the requested serverIds", async () => {
    const toArray = jest.fn().mockResolvedValue([mcpServer("argocd")]);
    const find = jest.fn().mockReturnValue({ toArray });
    mockGetCollection.mockResolvedValue({ find });
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);

    const { POST } = await import("../route");
    const response = await POST(request({ serverIds: ["argocd"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.server_ids).toEqual(["argocd"]);
    expect(find).toHaveBeenCalledWith({ _id: { $in: ["argocd"] }, enabled: true });
  });

  it("rejects with 403 when a requested serverId is not invokable by the caller", async () => {
    const toArray = jest.fn().mockResolvedValue([mcpServer("argocd")]);
    mockGetCollection.mockResolvedValue({ find: jest.fn().mockReturnValue({ toArray }) });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const { POST } = await import("../route");
    const response = await POST(request({ serverIds: ["argocd"] }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain("argocd");
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("returns 404 when no serverIds are given and the caller can invoke nothing", async () => {
    const toArray = jest.fn().mockResolvedValue([mcpServer("argocd")]);
    mockGetCollection.mockResolvedValue({ find: jest.fn().mockReturnValue({ toArray }) });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const { POST } = await import("../route");
    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("returns 503 when agent context signing is not configured", async () => {
    delete process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
    const toArray = jest.fn().mockResolvedValue([mcpServer("argocd")]);
    mockGetCollection.mockResolvedValue({ find: jest.fn().mockReturnValue({ toArray }) });
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);

    const { POST } = await import("../route");
    const response = await POST(request({ serverIds: ["argocd"] }));

    expect(response.status).toBe(503);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("rejects a non-array serverIds body with 400", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ serverIds: "argocd" }));

    expect(response.status).toBe(400);
    expect(mockGetCollection).not.toHaveBeenCalled();
  });
});
