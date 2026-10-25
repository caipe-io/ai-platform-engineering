/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

const mockAuthorize = jest.fn();
const mockGetAuth = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...a: unknown[]) => mockGetAuth(...a),
}));
jest.mock("@/lib/authz", () => ({
  authorize: (...a: unknown[]) => mockAuthorize(...a),
}));
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn(), isMongoDBConfigured: false }));

import { POST } from "../authz/v1/decisions/route";

function post(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(new URL("/api/authz/v1/decisions", "http://localhost:3000"), {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
}

const selfSubject = { type: "user", id: "alice" };
const resource = { type: "agent", id: "pe" };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "test-agent-context-secret";
  mockGetAuth.mockResolvedValue({ session: { sub: "alice", org: "acme" } });
});

afterAll(() => {
  delete process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
});

it("returns 200 ALLOW for a self-subject grant", async () => {
  mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK", retriable: false, ttl_seconds: 15 });
  const res = await POST(post({ subject: selfSubject, resource, action: "use" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ decision: "ALLOW", reason: "OK" });
});

it("forwards a valid internal interaction proof as trusted context", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = Buffer.from(JSON.stringify({
    source: "web",
    conversationKind: "personal",
    iat: now,
    exp: now + 60,
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET!)
    .update(token)
    .digest("hex");
  mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK", retriable: false });

  await POST(post(
    { subject: selfSubject, resource, action: "use" },
    {
      "X-CAIPE-Trusted-Interaction": token,
      "X-CAIPE-Trusted-Interaction-Signature": signature,
    },
  ));

  expect(mockAuthorize).toHaveBeenCalledWith(
    expect.objectContaining({
      trustedContext: {
        interaction: { source: "web", conversationKind: "personal", verified: true },
      },
    }),
    expect.anything(),
  );
});

it("fails closed when the internal interaction proof is forged", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "PRIVATE_RESOURCE_CONTEXT_DENIED", retriable: false });

  await POST(post(
    { subject: selfSubject, resource, action: "use" },
    {
      "X-CAIPE-Trusted-Interaction": "forged-payload",
      "X-CAIPE-Trusted-Interaction-Signature": "0".repeat(64),
    },
  ));

  expect(mockAuthorize).toHaveBeenCalledWith(
    expect.objectContaining({
      trustedContext: {
        interaction: { source: "api", conversationKind: "unknown", verified: false },
      },
    }),
    expect.anything(),
  );
});

it("returns 200 DENY (not 403) when the decision is no", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY", retriable: false });
  const res = await POST(post({ subject: selfSubject, resource, action: "use" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ decision: "DENY", reason: "NO_CAPABILITY" });
});

it("returns 503 on AUTHZ_UNAVAILABLE", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true });
  const res = await POST(post({ subject: selfSubject, resource, action: "use" }));
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ code: "AUTHZ_UNAVAILABLE", retriable: true });
});

it("returns 401 when the caller token is missing/invalid", async () => {
  mockGetAuth.mockRejectedValue(new Error("no auth"));
  const res = await POST(post({ subject: selfSubject, resource, action: "use" }));
  expect(res.status).toBe(401);
});

it("returns 401 (fail closed) when the caller has no stable sub", async () => {
  mockGetAuth.mockResolvedValue({ session: { role: "user", catalogKey: "k" } });
  const res = await POST(post({ subject: selfSubject, resource, action: "use" }));
  expect(res.status).toBe(401);
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it("returns 403 for cross-subject evaluation without can_audit", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY" }); // the audit gate
  const res = await POST(post({ subject: { type: "user", id: "bob" }, resource, action: "use" }));
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: "FORBIDDEN" });
});

it("returns 400 for an unrecognized action", async () => {
  const res = await POST(post({ subject: selfSubject, resource, action: "frobnicate" }));
  expect(res.status).toBe(400);
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it("returns 400 for malformed JSON", async () => {
  const res = await POST(post("{not json"));
  expect(res.status).toBe(400);
});

it("returns 400 when the body is valid JSON but not an object", async () => {
  const res = await POST(post("42"));
  expect(res.status).toBe(400);
});

it("re-throws non-authz errors instead of swallowing them", async () => {
  mockAuthorize.mockRejectedValue(new Error("boom"));
  await expect(POST(post({ subject: selfSubject, resource, action: "use" }))).rejects.toThrow("boom");
});

it("forwards advisory context but strips reserved workflow delegation keys", async () => {
  mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK", retriable: false });
  await POST(post({
    subject: selfSubject,
    resource,
    action: "use",
    context: { channel_id: "C123", workflow_run_id: "wr-1" },
  }));
  expect(mockAuthorize).toHaveBeenCalledWith(
    expect.objectContaining({ context: { channel_id: "C123" } }),
    expect.anything(),
  );
});

it("never leaks OpenFGA strings in a public response body", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY", retriable: false });
  const res = await POST(post({ subject: selfSubject, resource, action: "use" }));
  const text = JSON.stringify(await res.json());
  expect(text).not.toMatch(/can_use|pdp_denied|agent#use/);
});
