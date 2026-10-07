/** @jest-environment node */
import { NextRequest } from "next/server";

import { PATCH } from "../route";
import type { OpenFgaTupleKey } from "@/lib/rbac/openfga";

const mockGetCollection = jest.fn();
const mockUpdateOne = jest.fn();

// Keep the real HTTP error handler, CAS reconciliation and OpenFGA writer.
// Authentication is outside this save-error contract; external I/O is simulated.
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  withAuth: (request: NextRequest, handler: (...args: unknown[]) => unknown) =>
    handler(request, { email: "admin@example.test" }, { sub: "admin-sub", role: "admin" }),
  requireRbacPermission: jest.fn(),
}));
jest.mock("@/lib/auth-config", () => ({ authOptions: {}, isBootstrapAdmin: jest.fn() }));
jest.mock("@/lib/mongodb", () => ({ getCollection: (...args: unknown[]) => mockGetCollection(...args) }));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: jest.fn() }));
jest.mock("@/lib/authz/audit", () => ({ emitReconcileAudit: jest.fn() }));

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
const envKeys = ["OPENFGA_HTTP", "OPENFGA_STORE_ID", "OPENFGA_RECONCILE_ENABLED", "DEFAULT_AGENT_ID"];
const tuple = (id: string): OpenFgaTupleKey => ({ user: "user:*", relation: "user", object: `agent:${id}` });
const key = (value: OpenFgaTupleKey) => `${value.user}|${value.relation}|${value.object}`;
let graph: Map<string, OpenFgaTupleKey>;
let savedDefault: string | null;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OPENFGA_HTTP = "http://openfga.example.test";
  process.env.OPENFGA_STORE_ID = "example-store";
  process.env.OPENFGA_RECONCILE_ENABLED = "true";
  delete process.env.DEFAULT_AGENT_ID;
  savedDefault = "agent-old";
  graph = new Map([[key(tuple("agent-old")), tuple("agent-old")]]);
  mockUpdateOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 0 });
  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "platform_config") return {
      findOne: async () => ({ _id: "platform_settings", default_agent_id: savedDefault, authz_write_id: "old-version" }),
      updateOne: mockUpdateOne,
    };
    if (name === "dynamic_agents") return { findOne: async () => ({ visibility: "team" }) };
    throw new Error(`Unexpected collection: ${name}`);
  });
  global.fetch = jest.fn(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).endsWith("/read")) {
      const found = graph.get(key(body.tuple_key));
      return Response.json({ tuples: found ? [{ key: found }] : [] });
    }
    if (String(url).endsWith("/write")) {
      for (const t of body.writes?.tuple_keys ?? []) graph.set(key(t), t);
      for (const t of body.deletes?.tuple_keys ?? []) graph.delete(key(t));
      return Response.json({});
    }
    throw new Error(`Unexpected OpenFGA operation: ${url}`);
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const name of envKeys) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  jest.restoreAllMocks();
});

function save(defaultAgent: string | null) {
  return PATCH(new NextRequest("https://example.test/api/admin/platform-config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ default_agent_id: defaultAgent, acknowledge_public_access: true }),
  }));
}

it.each(["storage-only", "route-empty-diff"])("returns 409 for a direct %s snapshot conflict", async mode => {
  if (mode === "storage-only") delete process.env.OPENFGA_HTTP;
  else savedDefault = null;
  const response = await save(mode === "storage-only" ? "agent-next" : null);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ success: false, code: "PLATFORM_CONFIG_SAVE_CONFLICT" });
  expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
});

it("rejects a stale settings snapshot before any OpenFGA mutation", async () => {
  const response = await save("agent-next");
  const body = await response.json();
  expect(response.status).toBe(409);
  expect(body).toMatchObject({
    success: false, code: "PLATFORM_CONFIG_SAVE_CONFLICT",
  });
  expect(body).not.toHaveProperty("cause");
  expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  expect([...graph.values()]).toEqual([tuple("agent-old")]);
  expect(global.fetch).not.toHaveBeenCalled();
});

it("still checks the snapshot when all requested tuples already exist", async () => {
  const response = await save("agent-old");
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "PLATFORM_CONFIG_SAVE_CONFLICT" });
  expect([...graph.values()]).toEqual([tuple("agent-old")]);
  expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
});
