/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";

import { authenticateRequest, buildBackendHeaders, type AuthResult } from "../da-proxy";

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
    process.env.DA_USER_CONTEXT_HMAC_SECRET = "context-secret";
  });

  it("includes stable subject and bearer token for downstream OpenFGA checks", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "user@example.com", name: "Example User", role: "user" },
      session: {
        sub: "user-primary",
        accessToken: "access-token",
        canViewAdmin: false,
        canAccessDynamicAgents: true,
      },
    });

    const result = await authenticateRequest(request());

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({
      subject: "user-primary",
      bearerToken: "access-token",
      role: "user",
    });
  });

  it("falls back to email as subject only when the session sub is missing", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "user@example.com", name: "Example User", role: "user" },
      session: {
        accessToken: "access-token",
        canViewAdmin: false,
        canAccessDynamicAgents: true,
      },
    });

    const result = await authenticateRequest(request());

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({
      subject: "user@example.com",
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
    const saJwt = "service-account-client-credentials-jwt";
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "service-account-example-bot", name: null, role: "user" },
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
    const expectedSignature = createHmac("sha256", "context-secret")
      .update(headers["X-User-Context"])
      .digest("hex");
    expect(headers["X-User-Context-Signature"]).toBe(`v1=${expectedSignature}`);
  });

  it("rejects a browser session whose bearer token is unavailable", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "user@example.com", name: "Example User", role: "admin" },
      session: {
        sub: "user-primary",
        canViewAdmin: true,
        canAccessDynamicAgents: true,
      },
    });

    const result = await authenticateRequest(request("/api/dynamic-agents/middleware"));

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
    await expect((result as NextResponse).json()).resolves.toMatchObject({
      code: "BEARER_REQUIRED",
      action: "sign_in",
    });
  });

  it("fails closed when the user-context signing secret is unavailable", () => {
    delete process.env.DA_USER_CONTEXT_HMAC_SECRET;

    expect(() =>
      buildBackendHeaders("application/json", {
        bearerToken: "access-token",
        userContextHeader: "encoded-context",
      }),
    ).toThrow("DA_USER_CONTEXT_HMAC_SECRET is not configured");
  });
});
