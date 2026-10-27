/** @jest-environment node */
import { persistPermissionChange, publicPermissionDocument, syncPermissionDocument } from "../permission-sync";

const mockCollection = { insertOne: jest.fn(), updateOne: jest.fn(), findOneAndUpdate: jest.fn(), findOne: jest.fn(), deleteOne: jest.fn() };
const mockApply = jest.fn();
const mockConfigured = jest.fn();
const mockEnabled = jest.fn();
const mockDefault = jest.fn();
const mockAgent = jest.fn();
const mockUnlinked = jest.fn();
jest.mock("node:crypto", () => ({ ...jest.requireActual("node:crypto"), randomUUID: () => "example-operation" }));
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true, getCollection: async (name: string) => name === "dynamic_agents" ? { ...mockCollection, findOne: mockAgent } : mockCollection }));
jest.mock("@/lib/rbac/openfga", () => ({
  isOpenFgaConfigured: () => mockConfigured(), isOpenFgaReconciliationEnabled: () => mockEnabled(),
  applyOpenFgaProjection: (...args: unknown[]) => mockApply(...args),
}));
jest.mock("@/lib/rbac/platform-default", () => ({ getPlatformDefaultAgentId: () => mockDefault() }));
jest.mock("@/lib/rbac/unlinked-service-account", () => ({ resolveUnlinkedServiceAccountGrantState: () => mockUnlinked() }));
jest.mock("../audit", () => ({ emitReconcileAudit: jest.fn() }));
jest.mock("../engines/openfga", () => ({ invalidateDecisionCache: jest.fn() }));

const tuple = { user: "user:*", relation: "user", object: "agent:example" };
const diff = { writes: [tuple], deletes: [] };
const command = { collection: "platform_config" as const, id: "platform_settings", previous: { updated_at: "before", authz_write_id: "before" }, set: { default_agent_id: "example" } };
const context = { caller: { type: "user" as const, id: "example-user" } };
const pending = { id: "example-operation", state: "pending" as const, requested_at: "2026-01-01T00:00:00.000Z", diff, context };

beforeEach(() => {
  jest.resetAllMocks();
  mockConfigured.mockReturnValue(true);
  mockEnabled.mockReturnValue(true);
  mockDefault.mockResolvedValue("example");
  mockAgent.mockResolvedValue({ _id: "example", visibility: "team" });
  mockCollection.updateOne.mockResolvedValue({ matchedCount: 1 });
  mockCollection.findOneAndUpdate.mockResolvedValue({ _id: command.id, _permission_sync: pending });
  mockCollection.findOne.mockResolvedValue({ _permission_sync: pending });
  mockApply.mockImplementation(async (_diff, lease) => { await lease(); return { enabled: true, writes: 1, deletes: 0 }; });
  mockUnlinked.mockResolvedValue({ sub: null, explicitAgentIds: new Set() });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it("stages settings and recovery intent atomically, before any graph mutation", async () => {
  mockApply.mockImplementation(async () => {
    expect(mockCollection.updateOne.mock.calls[0]).toEqual([
      expect.objectContaining({ _id: command.id, authz_write_id: "before", "_permission_sync.state": { $ne: "pending" } }),
      { $set: expect.objectContaining({ default_agent_id: "example", _permission_sync: expect.objectContaining({ state: "pending", diff }) }) },
      expect.objectContaining({ writeConcern: { w: "majority", wtimeoutMS: 5000 } }),
    ]);
    return { enabled: true, writes: 1, deletes: 0 };
  });
  await persistPermissionChange(command, diff, context);
  expect(mockApply).toHaveBeenCalledTimes(1);
});

it.each(["conflict", "unavailable"])("never touches OpenFGA when Mongo staging fails: %s", async failure => {
  if (failure === "conflict") mockCollection.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
  else mockCollection.updateOne.mockRejectedValueOnce(new Error("Mongo unavailable"));
  await expect(persistPermissionChange(command, diff, context)).rejects.toThrow();
  expect(mockApply).not.toHaveBeenCalled();
});

it("rejects overlapping saves while recovery is pending", async () => {
  await expect(persistPermissionChange({ ...command, previous: { _permission_sync: pending } }, diff, context)).rejects.toMatchObject({ statusCode: 409 });
  expect(mockCollection.updateOne).not.toHaveBeenCalled();
});

it("does not stage or bump the snapshot for a genuinely empty existing-resource command", async () => {
  const previous = { ...command.previous, _permission_sync: { ...pending, state: "applied" } };
  expect(await persistPermissionChange({ ...command, previous, set: {} }, { writes: [], deletes: [] }, context)).toMatchObject({ state: "applied" });
  expect(mockCollection.updateOne).not.toHaveBeenCalled();
  expect(mockCollection.findOneAndUpdate).not.toHaveBeenCalled();
  expect(mockApply).not.toHaveBeenCalled();
});

it("still projects repair tuples when the settings are unchanged", async () => {
  await persistPermissionChange({ ...command, set: {} }, diff, context);
  expect(mockApply).toHaveBeenCalledWith(diff, expect.any(Function));
});

it("an empty command cannot bypass pending-operation or disabled-writer guards", async () => {
  const empty = { writes: [], deletes: [] };
  await expect(persistPermissionChange({ ...command, previous: { _permission_sync: pending }, set: {} }, empty, context)).rejects.toMatchObject({ statusCode: 409 });
  mockEnabled.mockReturnValue(false);
  await expect(persistPermissionChange({ ...command, set: {} }, empty, context)).rejects.toMatchObject({ code: "ACCESS_WRITES_DISABLED" });
  expect(mockCollection.updateOne).not.toHaveBeenCalled();
});

it.each(["create", "unset", "delete"])("does not discard a %s operation with an empty tuple diff", async operation => {
  mockCollection.deleteOne.mockResolvedValue({ deletedCount: 1 });
  await persistPermissionChange({ ...command, set: {},
    ...(operation === "create" ? { previous: null } : {}),
    ...(operation === "unset" ? { unset: { default_agent_id: "" } } : {}),
    ...(operation === "delete" ? { deleteResource: true } : {}),
  }, { writes: [], deletes: [] }, context);
  expect(mockCollection.findOneAndUpdate).toHaveBeenCalledTimes(1);
});

it("returns pending after a graph outage and leaves retry work durable", async () => {
  mockApply.mockRejectedValueOnce(new Error("OpenFGA unavailable"));
  expect(await persistPermissionChange(command, diff, context)).toMatchObject({ state: "pending" });
  expect(mockCollection.updateOne).toHaveBeenLastCalledWith(
    expect.objectContaining({ "_permission_sync.id": pending.id }),
    { $set: { "_permission_sync.retry_at": expect.any(Date) }, $unset: { "_permission_sync.lease": "" } }, expect.any(Object),
  );
});

it("replays stored intent without replaying a request's settings callback", async () => {
  await syncPermissionDocument("platform_config", command.id);
  expect(mockApply).toHaveBeenCalledWith(diff, expect.any(Function));
  expect(mockCollection.updateOne).toHaveBeenLastCalledWith(
    expect.objectContaining({ "_permission_sync.id": pending.id, "_permission_sync.lease.owner": expect.any(String) }),
    expect.objectContaining({ $set: { "_permission_sync.state": "applied", "_permission_sync.applied_at": expect.any(String) } }), expect.any(Object),
  );
  expect(mockCollection.updateOne.mock.calls.some(([, update]) => update.$set?.default_agent_id)).toBe(false);
});

it("does not replay old deletes from completed operations", async () => {
  const previous = { ...command.previous, _permission_sync: { ...pending, state: "applied", diff: { writes: [], deletes: [tuple] } } };
  await persistPermissionChange({ ...command, previous }, { writes: [], deletes: [] }, context);
  expect(mockCollection.updateOne.mock.calls[0][1].$set._permission_sync.diff).toEqual({ writes: [], deletes: [] });
});

it.each(["default", "global"])("retains public access still justified by %s", async reason => {
  mockDefault.mockResolvedValue(reason === "default" ? "example" : null);
  mockAgent.mockResolvedValue({ visibility: reason === "global" ? "global" : "team" });
  mockCollection.findOneAndUpdate.mockResolvedValue({ _permission_sync: { ...pending, diff: { writes: [], deletes: [tuple] } } });
  await syncPermissionDocument("platform_config", command.id);
  expect(mockApply).toHaveBeenCalledWith(diff, expect.any(Function));
});

it("keeps pending if a shared public-access reason changes while writing", async () => {
  mockDefault.mockResolvedValueOnce("example").mockResolvedValue(null);
  await syncPermissionDocument("platform_config", command.id);
  expect(mockCollection.updateOne.mock.calls.some(([, update]) => update.$set?.["_permission_sync.state"] === "applied")).toBe(false);
});

it("does not project when another replica owns the operation", async () => {
  mockCollection.findOneAndUpdate.mockResolvedValue(null);
  await syncPermissionDocument("platform_config", command.id);
  expect(mockApply).not.toHaveBeenCalled();
});

it("requires the same live lease before writing and acknowledging", async () => {
  mockCollection.updateOne.mockResolvedValue({ matchedCount: 0 });
  await syncPermissionDocument("platform_config", command.id);
  expect(mockCollection.updateOne.mock.calls.some(([, update]) => update.$set?.["_permission_sync.state"] === "applied")).toBe(false);
});

it("rejects configured-disabled writers before storage; supports storage-only mode", async () => {
  mockEnabled.mockReturnValue(false);
  await expect(persistPermissionChange(command, diff, context)).rejects.toMatchObject({ code: "ACCESS_WRITES_DISABLED" });
  expect(mockCollection.updateOne).not.toHaveBeenCalled();
  mockConfigured.mockReturnValue(false);
  expect(await persistPermissionChange(command, diff, context)).toBeUndefined();
  expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
  expect(mockApply).not.toHaveBeenCalled();
});

it("redacts tuple intent, actor and lease from public resource responses", () => {
  const result = publicPermissionDocument({ _id: "example", name: "Example", _permission_sync: pending });
  expect(result).toEqual({ _id: "example", name: "Example", permission_sync: { id: pending.id, state: "pending", requested_at: pending.requested_at } });
});
