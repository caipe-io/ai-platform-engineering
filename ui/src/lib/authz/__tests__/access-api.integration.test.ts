/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST as check } from "@/app/api/access/check/route";
import { POST as query } from "@/app/api/access/query/route";
import { POST as grant, DELETE as revoke } from "@/app/api/access/grants/route";
import { __resetAdapterStateForTests } from "../engines/openfga";
import { emitGrantAudit } from "../audit";

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: jest.fn(async () => ({ session: { sub: "test-user", authMethod: "bearer" } })),
}));
jest.mock("../audit", () => ({
  emitDecisionAudit: jest.fn(), emitBatchDecisionAudit: jest.fn(),
  emitGrantAudit: jest.fn(), emitReconcileAudit: jest.fn(), emitListObjectsDecisionAudit: jest.fn(),
}));

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
const resource = { type: "agent", id: "example" };
const checkBody = { resource, action: "use" };
const grantBody = { resource, capability: "use", grantee: { type: "user", id: "test-user" } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function request(path: string, body: unknown, method = "POST") {
  return new NextRequest(`https://example.test/api/access/${path}`, {
    method, headers: { authorization: "Bearer example-token", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.OPENFGA_HTTP = "http://openfga.example.test:8080";
  process.env.OPENFGA_STORE_ID = "store-example";
  __resetAdapterStateForTests();
  jest.clearAllMocks();
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const key of ["OPENFGA_HTTP", "OPENFGA_STORE_ID"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  __resetAdapterStateForTests();
});

it("uses real CAS policy, tuple mapping, auditing and cache invalidation through all four handlers", async () => {
  let granted = false;
  global.fetch = jest.fn(async (url: string, options: RequestInit) => {
    expect(url).toMatch(/^http:\/\/openfga\.example\.test:8080\/stores\/store-example\/(check|write)$/);
    const body = JSON.parse(options.body as string);
    if (url.endsWith("/write")) {
      const tuples = (body.writes ?? body.deletes).tuple_keys;
      expect(tuples).toEqual([{ user: "user:test-user", relation: "user", object: "agent:example" }]);
      granted = Boolean(body.writes);
      return response({});
    }
    expect(body.tuple_key.user).toBe("user:test-user");
    return response({ allowed: body.tuple_key.relation === "can_manage" || (granted && body.tuple_key.object === "agent:example") });
  }) as typeof fetch;

  expect(await (await check(request("check", checkBody))).json()).toMatchObject({ decision: "DENY" });
  expect((await grant(request("grants", grantBody))).status).toBe(200);
  expect(await (await check(request("check", checkBody))).json()).toMatchObject({ decision: "ALLOW" });
  expect(await (await query(request("query", { resource_type: "agent", action: "use", ids: ["example", "secondary"] }))).json()).toEqual({ ids: ["example"] });
  expect((await revoke(request("grants", grantBody, "DELETE"))).status).toBe(200);
  expect(await (await check(request("check", checkBody))).json()).toMatchObject({ decision: "DENY" });
  expect(emitGrantAudit).toHaveBeenCalledWith("grant", grantBody, expect.anything(), { outcome: "success" });
  expect(emitGrantAudit).toHaveBeenCalledWith("revoke", grantBody, expect.anything(), { outcome: "success" });
});

it("maps an OpenFGA outage to an unavailable HTTP result", async () => {
  global.fetch = jest.fn(async () => response({}, 503));
  const result = await check(request("check", checkBody));
  expect(result.status).toBe(503);
  expect(await result.json()).toMatchObject({ code: "AUTHZ_UNAVAILABLE" });
});
