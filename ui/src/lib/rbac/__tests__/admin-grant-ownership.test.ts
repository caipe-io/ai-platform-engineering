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
const mockLocks = new Map<string, string>();
const mockRows = new Map<string, { login: boolean; independent: boolean }>();
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
    updateOne: async ({ _id }: { _id: string }, { $set }: { $set: { login: boolean; independent: boolean } }) => {
      if (mockPersistError) throw mockPersistError;
      mockRows.set(_id, { ...$set });
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
  mockRows.clear(); mockLocks.clear(); jest.clearAllMocks(); stored = false; mockPersistError = undefined;
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


it.each(["before", "after"])("CAS manual assignment %s login promotion survives repeated demotion", async order => {
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

it("CAS revocation clears independent ownership without removing a current login reason", async () => {
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
