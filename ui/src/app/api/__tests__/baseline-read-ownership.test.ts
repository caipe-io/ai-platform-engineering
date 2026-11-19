/** @jest-environment node */

import { NextRequest } from "next/server";
import { GET as availableAgents } from "../dynamic-agents/available/route";
import { GET as adminTabGates } from "../rbac/admin-tab-gates/route";
import { baselineAdminTuples, baselineMemberTuples } from "@/lib/rbac/baseline-access";
import { writeOpenFgaTuples, type OpenFgaTupleKey } from "@/lib/rbac/openfga";

const mockSession = { sub: "test-user", role: "admin", user: { email: "test-user@example.test" } };
const mockTuples = new Map<string, OpenFgaTupleKey>();
const mockOwnership = new Map<string, Record<string, unknown>>();
const mockLocks = new Map<string, string>();

function mockTupleKey(tuple: OpenFgaTupleKey): string {
  return JSON.stringify([tuple.user, tuple.relation, tuple.object]);
}

jest.mock("next-auth", () => ({ getServerSession: async () => mockSession }));
jest.mock("@/lib/auth-config", () => ({ authOptions: {}, isBootstrapAdmin: () => false }));
jest.mock("@/lib/config", () => ({ getConfig: () => false }));
jest.mock("@/lib/rbac/keycloak-admin", () => ({ getRealmUserByIdOrNull: async () => null }));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: jest.requireActual("@/lib/api-error").ApiError,
  getAuthFromBearerOrSession: async () => ({ session: mockSession }),
  successResponse: (data: unknown) => Response.json({ success: true, data }),
  withErrorHandler: (handler: unknown) => handler,
}));
jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: async (_session: unknown, agents: unknown[]) => agents,
}));
jest.mock("@/lib/rbac/agent-ownership-scope", () => ({
  filterAgentsByOwnershipScopeForSession: async (_session: unknown, agents: unknown[]) => agents,
}));
// Exercise every route invocation, including stale-role reads after demotion.
jest.mock("@/lib/server-response-cache", () => ({
  createJsonResponseCacheStore: () => new Map(),
  envTtlMs: () => 0,
  withJsonResponseCache: async (_request: unknown, _store: unknown, load: () => Promise<Response>) => load(),
}));

// Keep the production tuple writer, ownership ledger and mutation-lock code.
// Only storage/transport are in memory; this is not a live SSO/OpenFGA test.
jest.mock("@/lib/mongodb", () => ({
  getCollection: async (name: string) => {
    if (name === "agent_mutation_locks") return {
      insertOne: async ({ _id, token }: { _id: string; token: string }) => {
        if (mockLocks.has(_id)) throw Object.assign(new Error("duplicate lock"), { code: 11000 });
        mockLocks.set(_id, token);
      },
      deleteOne: async ({ _id, token }: { _id: string; token: string }) => {
        if (mockLocks.get(_id) === token) mockLocks.delete(_id);
      },
    };
    if (name === "admin_grant_ownership") return {
      findOne: async ({ _id }: { _id: string }) => {
        const row = mockOwnership.get(_id);
        return row ? { _id, ...row } : null;
      },
      updateOne: async (
        { _id }: { _id: string },
        update: { $set: Record<string, unknown>; $unset?: Record<string, unknown> },
      ) => {
        const row = { ...mockOwnership.get(_id), ...update.$set };
        for (const key of Object.keys(update.$unset ?? {})) delete row[key];
        mockOwnership.set(_id, row);
      },
    };
    if (["openfga_baseline_profiles", "platform_config", "dynamic_agents"].includes(name)) return {
      findOne: async () => null,
      find: () => ({ sort: () => ({ toArray: async () => [] }) }),
    };
    throw new Error(`Unexpected collection: ${name}`);
  },
}));

jest.mock("@/lib/authz/engines/openfga-client", () => ({
  OPENFGA_READ_TIMEOUT_MS: 5_000,
  isOpenFgaConfigured: () => true,
  getOpenFgaStoreId: async () => "example",
  requestOpenFga: async (path: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (path.endsWith("/read")) {
      const tuple = mockTuples.get(mockTupleKey(body.tuple_key));
      return Response.json({ tuples: tuple ? [{ key: tuple }] : [] });
    }
    if (path.endsWith("/write")) {
      for (const tuple of body.writes?.tuple_keys ?? []) mockTuples.set(mockTupleKey(tuple), tuple);
      for (const tuple of body.deletes?.tuple_keys ?? []) mockTuples.delete(mockTupleKey(tuple));
      return Response.json({});
    }
    // Only a minimal org-admin decision is needed to exercise the repair paths;
    // the authorization model's inheritance is covered by its own contract tests.
    const allowed = (tuple: OpenFgaTupleKey) => mockTuples.has(mockTupleKey(tuple)) || (
      tuple.object === "organization:example" && tuple.relation === "can_manage" &&
      mockTuples.has(mockTupleKey({ ...tuple, relation: "admin" }))
    );
    if (path.endsWith("/check")) return Response.json({ allowed: allowed(body.tuple_key) });
    if (path.endsWith("/batch-check")) return Response.json({
      result: Object.fromEntries(body.checks.map((check: { correlation_id: string; tuple_key: OpenFgaTupleKey }) => [
        check.correlation_id, { allowed: allowed(check.tuple_key) },
      ])),
    });
    if (path.endsWith("/list-objects")) return Response.json({ objects: [] });
    throw new Error(`Unexpected OpenFGA request: ${path}`);
  },
}));

const previousOrg = process.env.CAIPE_ORG_KEY;
beforeEach(() => {
  process.env.CAIPE_ORG_KEY = "example";
  mockTuples.clear();
  mockOwnership.clear();
  mockLocks.clear();
});
afterEach(() => {
  if (previousOrg === undefined) delete process.env.CAIPE_ORG_KEY;
  else process.env.CAIPE_ORG_KEY = previousOrg;
  expect(mockLocks.size).toBe(0);
});

const routes = {
  available: () => availableAgents(new NextRequest("https://example.test/api/dynamic-agents/available")),
  gates: () => adminTabGates(new NextRequest("https://example.test/api/rbac/admin-tab-gates")),
};

describe.each(["available", "gates", "both"] as const)("%s baseline reads and admin ownership", (route) => {
  it.each(["none", "before", "after"] as const)("keeps ownership correct with manual assignment timing: %s", async (manual) => {
    const admin = baselineAdminTuples(mockSession.sub);
    const read = async () => {
      for (const name of route === "both" ? ["available", "gates"] as const : [route]) {
        expect((await routes[name]()).status).toBe(200);
      }
    };
    const assertOwnership = (login: boolean, independent: boolean) => {
      for (const tuple of admin) expect(mockOwnership.get(mockTupleKey(tuple))).toMatchObject({ login, independent });
    };
    if (manual === "before") await writeOpenFgaTuples({ writes: admin, deletes: [] });
    await writeOpenFgaTuples({ writes: admin, deletes: [] }, "login");
    await read();
    await read();
    assertOwnership(true, manual === "before");
    if (manual === "after") await writeOpenFgaTuples({ writes: admin, deletes: [] });

    // Repeated demotion must remove login-only grants without losing manual ones.
    for (let attempt = 0; attempt < 2; attempt++) {
      await writeOpenFgaTuples({ writes: [], deletes: admin }, "login");
      await read();
      assertOwnership(false, manual !== "none");
      for (const tuple of admin) expect(mockTuples.has(mockTupleKey(tuple))).toBe(manual !== "none");
    }
    if (manual !== "none") {
      await writeOpenFgaTuples({ writes: [], deletes: admin });
      await read();
      assertOwnership(false, false);
      for (const tuple of admin) expect(mockTuples.has(mockTupleKey(tuple))).toBe(false);
    }
    for (const tuple of baselineMemberTuples(mockSession.sub)) expect(mockTuples.has(mockTupleKey(tuple))).toBe(true);
  });
});
