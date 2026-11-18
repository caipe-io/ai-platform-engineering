/** @jest-environment node */
import { withAdminGrantLock, withAdminGrantOwnership } from "../admin-grant-ownership";
import type { OpenFgaTupleKey, TeamResourceTupleDiff } from "../openfga";

const mockRequest = jest.fn();
jest.mock("@/lib/authz/engines/openfga-client", () => ({
  OPENFGA_READ_TIMEOUT_MS: 5_000,
  isOpenFgaConfigured: () => true,
  getOpenFgaStoreId: async () => "example",
  requestOpenFga: (...args: unknown[]) => mockRequest(...args),
}));
let mockPersistError: Error | undefined;
let mockConfirmationResponseLost = false;
const mockLocks = new Map<string, string>();
type OwnershipRow = { login: boolean; independent: boolean; independent_pending?: boolean };
const mockRows = new Map<string, OwnershipRow>();
jest.mock("@/lib/mongodb", () => ({
  getCollection: async (name: string) => name === "agent_mutation_locks" ? {
    insertOne: async ({ _id, token }: { _id: string; token: string }) => {
      if (mockLocks.has(_id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
      mockLocks.set(_id, token);
    },
    deleteOne: async ({ _id, token }: { _id: string; token: string }) => {
      if (mockLocks.get(_id) === token) mockLocks.delete(_id);
    },
  } : {
    findOne: async ({ _id }: { _id: string }) => {
      const row = mockRows.get(_id);
      return row ? { _id, ...row } : null;
    },
    updateOne: async ({ _id }: { _id: string }, { $set, $unset }: { $set: OwnershipRow; $unset?: Record<string, string> }) => {
      if (mockPersistError) throw mockPersistError;
      const row = { ...mockRows.get(_id), ...$set };
      if ($unset?.independent_pending !== undefined) delete row.independent_pending;
      mockRows.set(_id, row);
      if ($unset?.independent_pending !== undefined && mockConfirmationResponseLost) throw new Error("Confirmation response lost");
    },
  },
}));
const tuple: OpenFgaTupleKey = { user: "user:test-user", relation: "admin", object: "organization:example" };
const key = JSON.stringify([tuple.user, tuple.relation, tuple.object]);
let stored: boolean;
const exists = jest.fn(async () => stored);
const apply = jest.fn(async (diff: TeamResourceTupleDiff) => {
  if (diff.deletes.length) stored = false;
  if (diff.writes.length) stored = true;
  return diff;
});

const assign = (source: "login" | "independent") => withAdminGrantOwnership({ writes: [tuple], deletes: [] }, source, exists, apply);
const remove = (source: "login" | "independent") => withAdminGrantOwnership({ writes: [], deletes: [tuple] }, source, exists, apply);
beforeEach(() => {
  process.env.CAIPE_ORG_KEY = "example";
  mockRows.clear(); mockLocks.clear(); jest.clearAllMocks(); stored = false; mockPersistError = undefined; mockConfirmationResponseLost = false;
});

it.each([false, true])("RBAC-01.03 quarantines an unconfirmed independent grant after tuple write applied=%s", async committed => {
  await expect(withAdminGrantOwnership({ writes: [tuple], deletes: [] }, "independent", exists, async () => {
    stored = committed;
    throw new Error("OpenFGA response lost");
  })).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  expect(mockRows.get(key)).toEqual({ login: false, independent: false, independent_pending: true });
  apply.mockClear();
  await expect(remove("login")).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  await expect(assign("login")).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  await expect(remove("independent")).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  expect(apply).not.toHaveBeenCalled();
  expect(stored).toBe(committed);
  expect(mockLocks.size).toBe(0);
});

it("does not record a grant as active when its existence read fails", async () => {
  const { createOpenFgaAdmin } = await import("@/lib/authz/engines/openfga");
  mockRequest.mockRejectedValueOnce(new Error("read unavailable"));
  await expect(createOpenFgaAdmin().grant({
    resource: { type: "system_config", id: "platform_settings" },
    grantee: { type: "user", id: "test-user" }, capability: "manage",
  })).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  expect([...mockRows.values()]).toEqual([{ login: false, independent: false, independent_pending: true }]);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest.mock.calls[0][0]).toMatch(/\/read$/);
});

it("reports pending when OpenFGA succeeds but ownership confirmation fails", async () => {
  await expect(withAdminGrantOwnership({ writes: [tuple], deletes: [] }, "independent", exists, async diff => {
    stored = true;
    mockPersistError = new Error("Mongo unavailable");
    return diff;
  })).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  expect(stored).toBe(true);
  expect(mockRows.get(key)).toEqual({ login: false, independent: false, independent_pending: true });
  mockPersistError = undefined;
  await expect(remove("login")).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
});

it("reports pending rather than failed if Mongo commits confirmation but its response is lost", async () => {
  await expect(withAdminGrantOwnership({ writes: [tuple], deletes: [] }, "independent", exists, async diff => {
    stored = true;
    mockConfirmationResponseLost = true;
    return diff;
  })).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  // The client cannot infer either rollback or denial from an ambiguous response.
  expect(mockRows.get(key)).toEqual({ login: false, independent: true });
  expect(stored).toBe(true);
  expect(mockLocks.size).toBe(0);
});

it("keeps an already confirmed independent reason when a repeated grant fails", async () => {
  await assign("independent");
  await expect(withAdminGrantOwnership({ writes: [tuple], deletes: [] }, "independent", exists, async () => {
    throw new Error("read unavailable");
  })).rejects.toThrow("read unavailable");
  expect(mockRows.get(key)).toEqual({ login: false, independent: true });
  await remove("login");
  expect(stored).toBe(true);
});

it("checks all pending records before changing another tuple's ownership", async () => {
  const secondary = { ...tuple, relation: "manager", object: "system_config:platform_settings" };
  const secondaryKey = JSON.stringify([secondary.user, secondary.relation, secondary.object]);
  mockRows.set(secondaryKey, { login: true, independent: false, independent_pending: true });
  await expect(withAdminGrantOwnership({ writes: [tuple, secondary], deletes: [] }, "login", exists, apply))
    .rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  expect(mockRows.has(key)).toBe(false);
  expect(apply).not.toHaveBeenCalled();
  expect(mockLocks.size).toBe(0);
});

it("keeps valid login ownership separate from an unconfirmed manual grant", async () => {
  await assign("login");
  await expect(withAdminGrantOwnership({ writes: [tuple], deletes: [] }, "independent", exists, async () => {
    throw new Error("read unavailable");
  })).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  expect(mockRows.get(key)).toEqual({ login: true, independent: false, independent_pending: true });
  expect(stored).toBe(true);
  await expect(remove("login")).rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
});

it("invalidates this replica's decisions when a CAS admin grant becomes pending", async () => {
  const { createOpenFgaAdmin, createOpenFgaEngine, getEngineStats, invalidateDecisionCache } = await import("@/lib/authz/engines/openfga");
  invalidateDecisionCache();
  const resource = { type: "system_config" as const, id: "platform_settings" };
  mockRequest.mockResolvedValueOnce(Response.json({ allowed: false }));
  expect((await createOpenFgaEngine().check({ subject: { type: "user", id: "test-user" }, resource, action: "manage" })).decision).toBe("DENY");
  expect(getEngineStats().cacheSize).toBe(1);
  mockRequest.mockRejectedValueOnce(new Error("read unavailable"));
  await expect(createOpenFgaAdmin().grant({ resource, grantee: { type: "user", id: "test-user" }, capability: "manage" }))
    .rejects.toMatchObject({ code: "AUTHZ_WRITE_PENDING" });
  expect(getEngineStats().cacheSize).toBe(0);
  invalidateDecisionCache();
});
it("removes login-only direct grants", async () => {
  await assign("login"); expect(stored).toBe(true);
  await remove("login"); expect(stored).toBe(false);
  expect(mockRows.get(key)).toEqual({ login: false, independent: false });
});
it.each(["before", "after"])("preserves a manual grant assigned %s login promotion", async (order) => {
  if (order === "before") await assign("independent");
  await assign("login");
  if (order === "after") await assign("independent");
  await remove("login"); expect(stored).toBe(true);
  expect(mockRows.get(key)).toEqual({ login: false, independent: true });
  await remove("independent"); expect(stored).toBe(false);
});
it("retains login access when only the independent reason is removed", async () => {
  await assign("login"); await assign("independent"); await remove("independent");
  expect(stored).toBe(true);
  await remove("login"); expect(stored).toBe(false);
});
it("does not claim a pre-existing unattributed grant on promotion", async () => {
  stored = true; await assign("login"); await remove("login");
  expect(stored).toBe(true); expect(mockRows.get(key)?.independent).toBe(true);
});
it("preserves and flags an unattributed legacy grant instead of guessing ownership", async () => {
  stored = true;
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  await remove("login"); expect(stored).toBe(true);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("operator review required"), tuple);
  expect(mockRows.size).toBe(0); warning.mockRestore();
});
it("retries deletion after the OpenFGA delete fails", async () => {
  await assign("login");
  await expect(withAdminGrantOwnership({ writes: [], deletes: [tuple] }, "login", exists, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(stored).toBe(true); await remove("login"); expect(stored).toBe(false);
});
it("does not apply a grant when ownership cannot be established", async () => {
  exists.mockRejectedValueOnce(new Error("offline"));
  await expect(assign("login")).rejects.toThrow("offline");
  expect(apply).not.toHaveBeenCalled(); expect(mockLocks.size).toBe(0);
});
it("serializes a stalled promotion and newer demotion across module instances", async () => {
  jest.resetModules();
  const replica = await import("../admin-grant-ownership");
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const sequence: string[] = [];
  const promotion = withAdminGrantLock("test-user", async () => {
    sequence.push("promotion-read"); started(); await waiting;
    await assign("login"); sequence.push("promotion-write");
  });
  await entered;
  const demotion = replica.withAdminGrantLock("test-user", async () => {
    sequence.push("demotion-read");
    await replica.withAdminGrantOwnership({ writes: [], deletes: [tuple] }, "login", exists, apply);
    sequence.push("demotion-write");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sequence).toEqual(["promotion-read"]);
  release(); await Promise.all([promotion, demotion]);
  expect(sequence).toEqual(["promotion-read", "promotion-write", "demotion-read", "demotion-write"]);
  expect(stored).toBe(false); expect(mockLocks.size).toBe(0);
});
it("does not retry side effects after an operation throws a conflict", async () => {
  const operation = jest.fn(async () => { throw Object.assign(new Error("write conflict"), { statusCode: 409 }); });
  await expect(withAdminGrantLock("test-user", operation)).rejects.toThrow("write conflict");
  expect(operation).toHaveBeenCalledTimes(1); expect(mockLocks.size).toBe(0);
});
it("allows other identities to proceed while one identity is blocked", async () => {
  await withAdminGrantLock("primary", () => withAdminGrantLock("secondary", async () => "done"));
  expect(mockLocks.size).toBe(0);
});

it("does not write OpenFGA when durable ownership persistence fails", async () => {
  mockPersistError = new Error("Mongo unavailable");
  await expect(assign("login")).rejects.toThrow("Mongo unavailable");
  expect(apply).not.toHaveBeenCalled(); expect(mockLocks.size).toBe(0);
});

it.each([false, true])("shared OpenFGA adapter honors login ownership and later manual assignment=%s", async (manual) => {
  const { writeOpenFgaTuples, deleteExactOpenFgaTuples } = await import("../openfga");
  mockRequest.mockImplementation(async (path: string, options: { body: string }) => {
    if (path.endsWith("/read")) return Response.json({ tuples: stored ? [{ key: tuple }] : [] });
    if (path.endsWith("/write")) {
      const body = JSON.parse(options.body);
      if (body.deletes) stored = false;
      if (body.writes) stored = true;
      return Response.json({});
    }
    throw new Error(`Unexpected OpenFGA request: ${path}`);
  });
  await writeOpenFgaTuples({ writes: [tuple], deletes: [] }, "login");
  expect(stored).toBe(true);
  if (manual) await writeOpenFgaTuples({ writes: [tuple], deletes: [] });
  await writeOpenFgaTuples({ writes: [], deletes: [tuple] }, "login");
  expect(stored).toBe(manual);
  expect(mockRows.get(key)).toEqual({ login: false, independent: manual });
  if (manual) {
    await deleteExactOpenFgaTuples([tuple]);
    expect(stored).toBe(false);
    await writeOpenFgaTuples({ writes: [], deletes: [tuple] }, "login");
    expect(stored).toBe(false);
    expect(mockRows.get(key)).toEqual({ login: false, independent: false });
  }
});

it("times out without stealing an existing writer's lock or running side effects", async () => {
  mockLocks.set("rbac-admin:test-user", "other-writer");
  const clock = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10_001);
  const operation = jest.fn();
  try {
    await expect(withAdminGrantLock("test-user", operation)).rejects.toThrow("save is in progress");
    expect(operation).not.toHaveBeenCalled();
    expect(mockLocks.get("rbac-admin:test-user")).toBe("other-writer");
  } finally {
    clock.mockRestore();
  }
});

it("bounds a stalled tuple read and releases the identity lock when it aborts", async () => {
  jest.useFakeTimers();
  const deadline = jest.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Read deadline exceeded", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  try {
    const { writeOpenFgaTuples } = await import("../openfga");
    mockRequest.mockImplementationOnce(async (_path: string, options: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    });
    const pending = writeOpenFgaTuples({ writes: [tuple], deletes: [] }, "login");
    const rejected = expect(pending).rejects.toThrow("Read deadline exceeded");
    await jest.advanceTimersByTimeAsync(4_999);
    expect(deadline).toHaveBeenCalledWith(5_000);
    expect(mockLocks.size).toBe(1);
    expect(mockRows.size).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    await rejected;
    expect(mockLocks.size).toBe(0);
    expect(mockRows.size).toBe(0);
  } finally {
    deadline.mockRestore();
    jest.useRealTimers();
  }
});


it.each(["before", "after"])("RBAC-01.01 CAS manual assignment %s login promotion survives repeated demotion", async order => {
  const { createOpenFgaAdmin } = await import("@/lib/authz/engines/openfga");
  const { writeOpenFgaTuples } = await import("../openfga");
  const target = { user: "user:test-user", relation: "manager", object: "system_config:platform_settings" };
  const ownershipKey = JSON.stringify([target.user, target.relation, target.object]);
  mockRequest.mockImplementation(async (path: string, options: { body: string }) => {
    if (path.endsWith("/read")) return Response.json({ tuples: stored ? [{ key: target }] : [] });
    if (path.endsWith("/write")) {
      const body = JSON.parse(options.body);
      if (body.deletes) stored = false;
      if (body.writes) stored = true;
      return Response.json({});
    }
    throw new Error(`Unexpected OpenFGA request: ${path}`);
  });
  const admin = createOpenFgaAdmin();
  const intent = { resource: { type: "system_config" as const, id: "platform_settings" }, grantee: { type: "user" as const, id: "test-user" }, capability: "manage" as const };
  if (order === "before") await admin.grant(intent);
  await writeOpenFgaTuples({ writes: [target], deletes: [] }, "login");
  if (order === "after") await admin.grant(intent);
  await writeOpenFgaTuples({ writes: [], deletes: [target] }, "login");
  await writeOpenFgaTuples({ writes: [], deletes: [target] }, "login");
  expect(stored).toBe(true);
  expect(mockRows.get(ownershipKey)).toEqual({ login: false, independent: true });
  await admin.revoke(intent);
  expect(stored).toBe(false);
  await writeOpenFgaTuples({ writes: [], deletes: [target] }, "login");
  expect(stored).toBe(false);
  expect(mockRows.get(ownershipKey)).toEqual({ login: false, independent: false });
});

it("RBAC-01.02 CAS revocation clears independent ownership without removing a current login reason", async () => {
  const { createOpenFgaAdmin } = await import("@/lib/authz/engines/openfga");
  const { writeOpenFgaTuples } = await import("../openfga");
  const target = { user: "user:test-user", relation: "manager", object: "system_config:platform_settings" };
  mockRequest.mockImplementation(async (path: string, options: { body: string }) => {
    if (path.endsWith("/read")) return Response.json({ tuples: stored ? [{ key: target }] : [] });
    if (path.endsWith("/write")) {
      const body = JSON.parse(options.body);
      if (body.deletes) stored = false;
      if (body.writes) stored = true;
      return Response.json({});
    }
    throw new Error(`Unexpected OpenFGA request: ${path}`);
  });
  const admin = createOpenFgaAdmin();
  const intent = { resource: { type: "system_config" as const, id: "platform_settings" }, grantee: { type: "user" as const, id: "test-user" }, capability: "manage" as const };
  await writeOpenFgaTuples({ writes: [target], deletes: [] }, "login");
  await admin.grant(intent);
  await admin.revoke(intent);
  expect(stored).toBe(true);
  expect(mockRows.get(JSON.stringify([target.user, target.relation, target.object]))).toEqual({ login: true, independent: false });
  await writeOpenFgaTuples({ writes: [], deletes: [target] }, "login");
  await writeOpenFgaTuples({ writes: [], deletes: [target] }, "login");
  expect(stored).toBe(false);
});

it.each([false, true])("RBAC-01.05 repairs a historical revoked reason with tuple present=%s", async present => {
  const { createOpenFgaAdmin } = await import("@/lib/authz/engines/openfga");
  const { writeOpenFgaTuples } = await import("../openfga");
  const target = { user: "user:test-user", relation: "manager", object: "system_config:platform_settings" };
  const ownershipKey = JSON.stringify([target.user, target.relation, target.object]);
  mockRows.set(ownershipKey, { login: present, independent: true });
  stored = present;
  mockRequest.mockImplementation(async (path: string, options: { body: string }) => {
    if (path.endsWith("/read")) return Response.json({ tuples: stored ? [{ key: target }] : [] });
    if (path.endsWith("/write")) {
      const body = JSON.parse(options.body);
      stored = Boolean(body.writes);
      return Response.json({});
    }
    throw new Error(`Unexpected OpenFGA request: ${path}`);
  });
  await createOpenFgaAdmin().revoke({
    resource: { type: "system_config", id: "platform_settings" },
    grantee: { type: "user", id: "test-user" }, capability: "manage",
  });
  expect(mockRows.get(ownershipKey)).toEqual({ login: present, independent: false });
  expect(stored).toBe(present);
  await writeOpenFgaTuples({ writes: [target], deletes: [] }, "login");
  await writeOpenFgaTuples({ writes: [], deletes: [target] }, "login");
  expect(stored).toBe(false);
  expect(mockRows.get(ownershipKey)).toEqual({ login: false, independent: false });
});
