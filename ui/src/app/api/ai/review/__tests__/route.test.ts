/**
 * @jest-environment node
 *
 * Regression tests for `/api/ai/review` header forwarding.
 *
 * The route runs each rubric criterion through dynamic-agents'
 * `/api/v1/assistant/suggest` endpoint, which is JWT-gated. If the route
 * only forwards `X-User-Context` and not the bearer token, every criterion
 * comes back with `error: "Backend error: Unauthorized"`, surfacing as
 * "AI Review — 0/N criteria passed" with red banners in the UI even for
 * platform admins.
 *
 * These tests pin both required headers (Authorization + X-User-Context)
 * so a future refactor can't silently regress.
 */

import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const mockAuthenticateRequest = jest.fn();
const mockFetchAssistantSuggest = jest.fn();
const mockEnsureConfig = jest.fn();
const mockGetCollection = jest.fn();
const mockConsume = jest.fn();

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));

jest.mock("@/lib/server/assistant-suggest-da", () => ({
  fetchAssistantSuggest: (...args: unknown[]) =>
    mockFetchAssistantSuggest(...args),
}));

jest.mock("@/lib/server/ai-review/defaults", () => ({
  ensureConfig: (...args: unknown[]) => mockEnsureConfig(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/server/ai-assist-rate-limit", () => ({
  consume: (...args: unknown[]) => mockConsume(...args),
}));

import { POST } from "../route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.com/api/ai/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

beforeEach(() => {
  jest.resetAllMocks();
  mockConsume.mockReturnValue({
    allowed: true,
    remaining: 9,
    limit: 10,
    windowMs: 60_000,
    retryAfterSec: 0,
  });
  // Minimal review config: a single criterion so we can inspect a single
  // backend call without bloating the test with parallel call assertions.
  mockEnsureConfig.mockResolvedValue({
    target: "agent-system-prompt",
    enabled: true,
    enforcement: "informational",
    criteria: [
      {
        id: "clear-role-definition",
        name: "Clear role definition",
        severity: "error",
        weight: 2,
        micro_prompt: "Pass if the role is clear.",
        expects_fix: true,
      },
    ],
    min_score: 0.85,
  });
  // No Platform LLM and no registered models, so resolution reaches the
  // built-in default unless a test says otherwise.
  mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue(null) });
});

describe("/api/ai/review POST — header forwarding to dynamic-agents", () => {
  it("falls back to Claude Haiku 4.5 when no platform LLM, review config, or Mongo model is available", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      subject: "admin@example.com",
      email: "admin@example.com",
      role: "admin",
      tenantId: "default",
      userContextHeader: "BASE64_USER_CTX",
      bearerToken: "ADMIN_JWT_TOKEN",
    });
    mockGetCollection.mockRejectedValue(new Error("mongo unavailable"));
    mockFetchAssistantSuggest.mockResolvedValueOnce({
      ok: true,
      content: JSON.stringify({ pass: true, comment: "ok" }),
    });

    const content = "You review infra changes.";
    const req = makeRequest({
      target: "agent-system-prompt",
      content,
      content_hash: hashContent(content),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const [, body] = mockFetchAssistantSuggest.mock.calls[0] as [
      Record<string, string>,
      { model: { id: string; provider: string } },
    ];
    expect(body.model).toEqual({
      id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      provider: "aws-bedrock",
    });
  });

  it("forwards the caller's bearer token AND X-User-Context so dynamic-agents JwtAuthMiddleware accepts the call", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      subject: "admin@example.com",
      email: "admin@example.com",
      role: "admin",
      tenantId: "default",
      userContextHeader: "BASE64_USER_CTX",
      bearerToken: "ADMIN_JWT_TOKEN",
    });
    mockFetchAssistantSuggest.mockResolvedValueOnce({
      ok: true,
      content: JSON.stringify({ pass: true, comment: "ok" }),
    });

    const content = "You review infra changes.";
    const req = makeRequest({
      target: "agent-system-prompt",
      content,
      content_hash: hashContent(content),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(mockFetchAssistantSuggest).toHaveBeenCalledTimes(1);
    const [headers] = mockFetchAssistantSuggest.mock.calls[0] as [
      Record<string, string>,
      unknown,
    ];
    // Both headers must be present — this is what dynamic-agents needs to
    // validate the JWT and resolve the caller identity for the LLM call.
    expect(headers["Authorization"]).toBe("Bearer ADMIN_JWT_TOKEN");
    expect(headers["X-User-Context"]).toBe("BASE64_USER_CTX");
  });

  it("forwards traceparent when the auth layer surfaces one", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      subject: "admin@example.com",
      email: "admin@example.com",
      role: "admin",
      userContextHeader: "BASE64_USER_CTX",
      bearerToken: "ADMIN_JWT_TOKEN",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    mockFetchAssistantSuggest.mockResolvedValueOnce({
      ok: true,
      content: JSON.stringify({ pass: true, comment: "ok" }),
    });

    const content = "Reviews infra changes.";
    const req = makeRequest({
      target: "agent-system-prompt",
      content,
      content_hash: hashContent(content),
    });

    await POST(req);
    const [headers] = mockFetchAssistantSuggest.mock.calls[0] as [
      Record<string, string>,
      unknown,
    ];
    expect(headers.traceparent).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
  });

  it("omits Authorization when the caller has no bearer token (anonymous local dev)", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      subject: "anon",
      email: "anon@example.com",
      role: "viewer",
      userContextHeader: "BASE64_USER_CTX",
      // bearerToken intentionally omitted
    });
    mockFetchAssistantSuggest.mockResolvedValueOnce({
      ok: true,
      content: JSON.stringify({ pass: true, comment: "ok" }),
    });

    const content = "Reviews infra changes.";
    const req = makeRequest({
      target: "agent-system-prompt",
      content,
      content_hash: hashContent(content),
    });

    await POST(req);
    const [headers] = mockFetchAssistantSuggest.mock.calls[0] as [
      Record<string, string>,
      unknown,
    ];
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-User-Context"]).toBe("BASE64_USER_CTX");
  });
});
