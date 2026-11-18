/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockGetAuth = jest.fn();
const mockAuthorize = jest.fn();
const mockGrant = jest.fn();
const mockRevoke = jest.fn();
const mockEmitGrantAudit = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...a: unknown[]) => mockGetAuth(...a),
}));
jest.mock("@/lib/authz", () => ({
  PolicyWritePendingError: jest.requireActual("@/lib/authz/engine").PolicyWritePendingError,
  authorize: (...a: unknown[]) => mockAuthorize(...a),
  grant: (...a: unknown[]) => mockGrant(...a),
  revoke: (...a: unknown[]) => mockRevoke(...a),
}));
jest.mock("@/lib/authz/audit", () => ({
  emitGrantAudit: (...a: unknown[]) => mockEmitGrantAudit(...a),
}));
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn(), isMongoDBConfigured: false }));

import { POST, DELETE } from "../authz/v1/grants/route";

function req(b: unknown, method = "POST"): NextRequest {
  return new NextRequest(new URL("/api/authz/v1/grants", "http://localhost:3000"), {
    method,
    body: JSON.stringify(b),
  });
}

const validGrant = { resource: { type: "agent", id: "pe" }, grantee: { type: "team", id: "eng" }, capability: "use" };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuth.mockResolvedValue({ session: { sub: "alice", org: "acme" } });
  mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK" });
});

it("grants when the caller can manage the resource", async () => {
  const res = await POST(req(validGrant));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ granted: true });
  expect(mockGrant).toHaveBeenCalledWith(
    { resource: { type: "agent", id: "pe" }, grantee: { type: "team", id: "eng" }, capability: "use" },
    expect.objectContaining({
      tenantId: "acme",
      caller: { type: "user", id: "alice" },
      correlationId: expect.any(String),
    }),
  );
  expect(mockEmitGrantAudit).not.toHaveBeenCalled();
});

it("revokes on DELETE", async () => {
  const res = await DELETE(req(validGrant, "DELETE"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ revoked: true });
  expect(mockRevoke).toHaveBeenCalled();
});

it("returns 403 when caller cannot manage the resource", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY" });
  const res = await POST(req(validGrant));
  expect(res.status).toBe(403);
  expect(mockGrant).not.toHaveBeenCalled();
  expect(mockEmitGrantAudit).toHaveBeenCalledWith(
    "grant",
    { resource: { type: "agent", id: "pe" }, grantee: { type: "team", id: "eng" }, capability: "use" },
    expect.objectContaining({ caller: { type: "user", id: "alice" }, tenantId: "acme" }),
    { outcome: "error", reasonCode: "NO_CAPABILITY" },
  );
});

it("audits failed revoke attempts on meta-authz deny", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE" });
  const res = await DELETE(req(validGrant, "DELETE"));
  expect(res.status).toBe(503);
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockEmitGrantAudit).toHaveBeenCalledWith(
    "revoke",
    expect.any(Object),
    expect.objectContaining({ caller: { type: "user", id: "alice" } }),
    { outcome: "error", reasonCode: "AUTHZ_UNAVAILABLE" },
  );
});

it("threads x-correlation-id into grant context", async () => {
  const r = new NextRequest(new URL("/api/authz/v1/grants", "http://localhost:3000"), {
    method: "POST",
    headers: { "x-correlation-id": "corr-v1-grant" },
    body: JSON.stringify(validGrant),
  });
  const res = await POST(r);
  expect(res.status).toBe(200);
  expect(mockGrant).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ correlationId: "corr-v1-grant" }),
  );
});

it("returns 401 with no auth", async () => {
  mockGetAuth.mockRejectedValue(new Error("no auth"));
  const res = await POST(req(validGrant));
  expect(res.status).toBe(401);
});

it("returns 401 when session has no stable sub", async () => {
  mockGetAuth.mockResolvedValue({ session: { catalogKey: "k" } });
  const res = await POST(req(validGrant));
  expect(res.status).toBe(401);
});

it("returns 400 for an unrecognized capability", async () => {
  const res = await POST(req({ ...validGrant, capability: "frobnicate" }));
  expect(res.status).toBe(400);
  expect(mockGrant).not.toHaveBeenCalled();
});

it("returns 400 when the capability is unsupported by the resource type", async () => {
  const res = await POST(req({ ...validGrant, capability: "ingest" }));
  expect(res.status).toBe(400);
  expect(mockGrant).not.toHaveBeenCalled();
});

it("returns 400 for high-risk everyone grants", async () => {
  const res = await POST(req({ ...validGrant, grantee: { type: "everyone" }, capability: "manage" }));
  expect(res.status).toBe(400);
  expect(mockGrant).not.toHaveBeenCalled();
});

it("allows everyone grants for agent use so global workflows can run their agents", async () => {
  const res = await POST(req({ ...validGrant, grantee: { type: "everyone" }, capability: "use" }));
  expect(res.status).toBe(200);
  expect(mockGrant).toHaveBeenCalledWith(
    { resource: { type: "agent", id: "pe" }, grantee: { type: "everyone" }, capability: "use" },
    expect.objectContaining({ caller: { type: "user", id: "alice" } }),
  );
});

it("returns 400 for malformed JSON", async () => {
  const r = new NextRequest(new URL("/api/authz/v1/grants", "http://localhost:3000"), { method: "POST", body: "{bad" });
  expect((await POST(r)).status).toBe(400);
});

it("does not require admin_ui/audit.view — any resource manager may grant", async () => {
  // Regular user (no admin role) with can_manage on the resource
  mockGetAuth.mockResolvedValue({ session: { sub: "regular-user" } });
  mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK" });
  const res = await POST(req(validGrant));
  expect(res.status).toBe(200);
});
