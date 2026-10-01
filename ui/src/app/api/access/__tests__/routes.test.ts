/** @jest-environment node */
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-error";
import { POST as check } from "../check/route";
import { POST as query } from "../query/route";
import { POST as grant, DELETE as revoke } from "../grants/route";

const mockAuth = jest.fn();
const mockAuthorize = jest.fn();
const mockMany = jest.fn();
const mockGrant = jest.fn();
const mockRevoke = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/api-middleware", () => ({ getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/authz", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
  authorizeMany: (...args: unknown[]) => mockMany(...args),
  grant: (...args: unknown[]) => mockGrant(...args),
  revoke: (...args: unknown[]) => mockRevoke(...args),
}));
jest.mock("@/lib/authz/audit", () => ({ emitGrantAudit: (...args: unknown[]) => mockAudit(...args) }));

const allow = { decision: "ALLOW", reason: "OK", retriable: false };
const deny = { decision: "DENY", reason: "NO_CAPABILITY", retriable: false };
const unavailable = { decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true };
const resource = { type: "agent", id: "example" };
const checkBody = { resource, action: "use" };
const queryBody = { resource_type: "agent", action: "use", ids: ["example", "secondary"] };
const grantBody = { resource, capability: "use", grantee: { type: "team", id: "example-team" } };
const originalNextAuthUrl = process.env.NEXTAUTH_URL;

function request(body: unknown, headers: Record<string, string> = {}, method = "POST"): NextRequest {
  return new NextRequest("https://example.test/api/access/check", {
    method, headers: { "content-type": "application/json", origin: "https://example.test", ...headers },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  process.env.NEXTAUTH_URL = "https://example.test";
  mockAuth.mockResolvedValue({ session: { sub: "test-user", authMethod: "session" } });
  mockAuthorize.mockResolvedValue(allow);
  mockMany.mockResolvedValue(new Map([["example", allow], ["secondary", deny]]));
});
afterAll(() => {
  if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = originalNextAuthUrl;
});

describe.each([
  ["check", check, checkBody], ["query", query, queryBody],
  ["grant", grant, grantBody], ["revoke", revoke, grantBody],
] as const)("%s boundary", (_name, handler, body) => {
  it("requires authentication", async () => {
    mockAuth.mockRejectedValue(new ApiError("invalid token", 401));
    const response = await handler(request(body));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
  it.each([{}, { sub: "owner", principalType: "catalog_api_key" }, { sub: "owner", principalType: "skills_api_key" }])(
    "rejects missing or scoped identities", async (session) => {
      mockAuth.mockResolvedValue({ session });
      expect((await handler(request(body))).status).toBe(401);
      expect(mockAuthorize).not.toHaveBeenCalled();
    },
  );
  it.each(["subject", "trustedContext", "context"])("rejects caller-supplied %s", async (key) => {
    expect((await handler(request({ ...body, [key]: { id: "other-user" } }))).status).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockMany).not.toHaveBeenCalled();
  });
  it("rejects cross-origin cookie requests", async () => {
    expect((await handler(request(body, { origin: "https://other.example.test" }))).status).toBe(403);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
  it("rejects cookie requests without Origin", async () => {
    const req = request(body);
    req.headers.delete("origin");
    expect((await handler(req)).status).toBe(403);
  });
  it("requires JSON rather than accepting cross-site form bodies", async () => {
    expect((await handler(request(body, { "content-type": "text/plain" }))).status).toBe(400);
  });
  it.each([null, [], "example"].map((body) => [body]))("rejects a non-object body", async (invalidBody) => {
    expect((await handler(request(invalidBody))).status).toBe(400);
  });
  it("rejects malformed JSON", async () => {
    const req = new NextRequest("https://example.test/api/access/check", {
      method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: "{bad",
    });
    expect((await handler(req)).status).toBe(400);
  });
});

it("returns allow/deny as decisions and threads the verified caller and correlation ID", async () => {
  const response = await check(request(checkBody, { "x-correlation-id": "example-request" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(allow);
  expect(mockAuthorize).toHaveBeenCalledWith({ ...checkBody, subject: { type: "user", id: "test-user" } },
    expect.objectContaining({ caller: { type: "user", id: "test-user" }, correlationId: "example-request" }));
  mockAuthorize.mockResolvedValue(deny);
  expect(await (await check(request(checkBody))).json()).toEqual(deny);
});

it("accepts authenticated service callers without a browser Origin", async () => {
  mockAuth.mockResolvedValue({ session: { sub: "example-bot", isServiceAccount: true, authMethod: "bearer" } });
  const req = request(checkBody, { authorization: "Bearer example-token" });
  req.headers.delete("origin");
  expect((await check(req)).status).toBe(200);
  expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ subject: { type: "service_account", id: "example-bot" } }), expect.anything());
});

it.each(["Basic example", "Bearer", "Bearer one two"])("does not fall back to cookies for malformed Authorization", async (authorization) => {
  expect((await check(request(checkBody, { authorization }))).status).toBe(401);
  expect(mockAuth).not.toHaveBeenCalled();
});

it("preserves authentication's scoped-credential rejection", async () => {
  mockAuth.mockRejectedValue(new ApiError("scoped credential", 403));
  expect((await check(request(checkBody))).status).toBe(403);
});

it("distinguishes an authentication dependency outage from an invalid token", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    mockAuth.mockRejectedValue(new Error("private upstream detail"));
    const response = await check(request(checkBody));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private upstream detail");
  } finally { log.mockRestore(); }
});

it.each([{ ...checkBody, action: "ingest" }, { resource: { type: "unknown", id: "example" }, action: "use" },
  { ...checkBody, resource: { type: "agent", id: "example#manager" } }])("rejects unsupported resource/action combinations and tuple syntax", async (body) => {
  expect((await check(request(body))).status).toBe(400);
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it("reports a decision outage as 503, not a definitive deny", async () => {
  mockAuthorize.mockResolvedValue(unavailable);
  const response = await check(request(checkBody));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "AUTHZ_UNAVAILABLE", retriable: true });
});

it("filters candidates, preserves order, deduplicates and never returns other resources", async () => {
  mockMany.mockResolvedValue(new Map([["example", allow], ["secondary", allow], ["unrequested", allow]]));
  const response = await query(request({ ...queryBody, ids: ["secondary", "example", "secondary"] }));
  expect(await response.json()).toEqual({ ids: ["secondary", "example"] });
  expect(mockMany).toHaveBeenCalledWith({ type: "user", id: "test-user" }, "use", "agent", ["secondary", "example"], expect.anything());
});

it("returns only allowed candidates", async () => {
  expect(await (await query(request(queryBody))).json()).toEqual({ ids: ["example"] });
});

it("accepts an empty candidate page without calling the engine", async () => {
  expect(await (await query(request({ ...queryBody, ids: [] }))).json()).toEqual({ ids: [] });
  expect(mockMany).not.toHaveBeenCalled();
});

it.each([new Map([["example", allow], ["secondary", unavailable]]), new Map([["example", allow]])])(
  "rejects incomplete/degraded queries instead of returning a partial success", async (results) => {
    mockMany.mockResolvedValue(results);
    const response = await query(request(queryBody));
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("ids");
  },
);

it.each([Array(201).fill("example"), ["example#member"], [null], "example"].map((ids) => [ids]))("bounds and validates query candidates", async (ids) => {
  expect((await query(request({ ...queryBody, ids }))).status).toBe(400);
  expect(mockMany).not.toHaveBeenCalled();
});

it.each([[grant, "grant", mockGrant], [revoke, "revoke", mockRevoke]] as const)("authorizes and audits mutations through CAS", async (handler, operation, mutation) => {
  const response = await handler(request(grantBody, {}, operation === "revoke" ? "DELETE" : "POST"));
  expect(response.status).toBe(200);
  expect(mockAuthorize).toHaveBeenCalledWith({ subject: { type: "user", id: "test-user" }, resource, action: "manage" }, expect.anything());
  expect(mutation).toHaveBeenCalledWith(grantBody, expect.objectContaining({ caller: { type: "user", id: "test-user" } }));
});

it.each([grant, revoke])("never writes after a management denial or outage", async (handler) => {
  mockAuthorize.mockResolvedValue(deny);
  expect((await handler(request(grantBody))).status).toBe(403);
  mockAuthorize.mockResolvedValue(unavailable);
  expect((await handler(request(grantBody))).status).toBe(503);
  expect(mockGrant).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalled();
});

it("retains the existing organization-manager grant rule", async () => {
  mockAuthorize.mockResolvedValueOnce(deny).mockResolvedValueOnce(allow);
  expect((await grant(request(grantBody))).status).toBe(200);
  expect(mockGrant).toHaveBeenCalled();
});

it("retains restrictions on high-risk everyone grants", async () => {
  expect((await grant(request({ ...grantBody, capability: "manage", grantee: { type: "everyone" } }))).status).toBe(400);
  expect(mockGrant).not.toHaveBeenCalled();
});

it.each([[grant, mockGrant], [revoke, mockRevoke]] as const)("does not acknowledge or automatically retry a failed write", async (handler, mutation) => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    mutation.mockRejectedValue(new Error("private OpenFGA detail"));
    const response = await handler(request(grantBody));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Access operation failed", code: "INTERNAL_ERROR", retriable: false });
    expect(mutation).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});
