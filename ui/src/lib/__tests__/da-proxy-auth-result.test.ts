/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest, buildBackendHeaders, proxySSEStream, type AuthResult } from "../da-proxy";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();

jest.mock("../api-middleware", () => ({
  ApiError: class ApiError extends Error {
    statusCode: number;
    code?: string;
    reason?: string;
    action?: string;

    constructor(message: string, statusCode: number, code?: string, reason?: string, action?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
      this.reason = reason;
      this.action = action;
    }
  },
  getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
  requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
}));

jest.mock("../config", () => ({
  getServerConfig: () => ({ dynamicAgentsUrl: "http://dynamic-agents:8000" }),
}));

function request(path = "/api/v1/chat/invoke"): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

describe("authenticateRequest auth result", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("includes stable subject and bearer token for downstream OpenFGA checks", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "alice@example.com", name: "Alice", role: "user" },
      session: {
        sub: "alice-sub",
        accessToken: "access-token",
        canViewAdmin: false,
        canAccessDynamicAgents: true,
      },
    });

    const result = await authenticateRequest(request());

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({
      subject: "alice-sub",
      bearerToken: "access-token",
      role: "user",
    });
  });

  it("falls back to email as subject only when the session sub is missing", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "alice@example.com", name: "Alice", role: "user" },
      session: {
        accessToken: "access-token",
        canViewAdmin: false,
        canAccessDynamicAgents: true,
      },
    });

    const result = await authenticateRequest(request());

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({
      subject: "alice@example.com",
      bearerToken: "access-token",
      role: "user",
    });
  });

  it("forwards a service-account's original JWT to DA as Authorization: Bearer (T023 / FR-010, R-4)", async () => {
    // A Keycloak client-credentials (service-account) token authenticates the
    // same way as a user bearer; da-proxy carries `accessToken` verbatim into
    // the AuthResult, and buildBackendHeaders forwards it unchanged so DA's
    // JwtAuthMiddleware can validate the SA identity. No SA-specific code path
    // is required — this test guards that the SA JWT is not dropped/rewritten.
    const saJwt = "sa-client-credentials-jwt";
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "service-account-caipe-sa-incident-bot-a1b2c3", name: null, role: "user" },
      session: {
        sub: "sa-user-sub",
        accessToken: saJwt,
        isServiceAccount: true,
        canViewAdmin: false,
        canAccessDynamicAgents: true,
      },
    });

    const result = await authenticateRequest(request("/api/v1/chat/invoke"));

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({ subject: "sa-user-sub", bearerToken: saJwt });

    // The SA JWT is forwarded downstream unchanged.
    const headers = buildBackendHeaders("application/json", result as AuthResult);
    expect(headers["Authorization"]).toBe(`Bearer ${saJwt}`);
  });

  it("allows browser session fallback without a bearer token for DA backend calls", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "alice@example.com", name: "Alice", role: "admin" },
      session: {
        sub: "alice-sub",
        canViewAdmin: true,
        canAccessDynamicAgents: true,
      },
    });

    const result = await authenticateRequest(request("/api/dynamic-agents/middleware"));

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({
      subject: "alice-sub",
      email: "alice@example.com",
      role: "admin",
      bearerToken: undefined,
    });
  });
});

describe("durable run streaming proxy", () => {
  it("preserves only admitted run metadata and uses GET for replay", async () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn().mockResolvedValue(new Response("event: done\ndata: {}\n\n", {
      headers: {
        "X-CAIPE-Run-Id": "run-1",
        "X-CAIPE-Turn-Id": "turn-1",
        "X-CAIPE-Protocol": "agui",
        "Set-Cookie": "upstream=private",
      },
    }));
    global.fetch = mockFetch;
    try {
      const response = await proxySSEStream("http://example.test/runs/run-1/stream", undefined, {}, "[test]", "GET");
      expect(mockFetch).toHaveBeenCalledWith("http://example.test/runs/run-1/stream", expect.objectContaining({ method: "GET" }));
      expect(mockFetch.mock.calls[0][1]).not.toHaveProperty("body");
      expect(response.headers.get("X-CAIPE-Run-Id")).toBe("run-1");
      expect(response.headers.get("X-CAIPE-Turn-Id")).toBe("turn-1");
      expect(response.headers.get("X-CAIPE-Protocol")).toBe("agui");
      expect(response.headers.get("Set-Cookie")).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
