/** @jest-environment node */
import { reconcileExistingAgentOpenFgaTuples } from "../seed-config";
import { PermissionSaveConflictError } from "@/lib/authz/permission-sync";
const mockReconcile = jest.fn();
const mockDefault = jest.fn();
const mockAgents = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async () => ({ find: () => ({ toArray: () => mockAgents() }) }),
}));
jest.mock("@/lib/platform-default-agent", () => ({ getResolvedPlatformDefaultAgentId: () => mockDefault() }));
jest.mock("@/lib/rbac/openfga", () => ({ isOpenFgaReconciliationEnabled: () => true }));
jest.mock("@/lib/rbac/openfga-agent-tools", () => ({ reconcileAgentRelationships: (...args: unknown[]) => mockReconcile(...args) }));
jest.mock("@/lib/rbac/unlinked-service-account", () => ({
  resolveUnlinkedServiceAccountGrantState: async () => ({ sub: "example-service", explicitAgentIds: new Set(["explicit"]) }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockDefault.mockResolvedValue("default");
  mockAgents.mockResolvedValue([
    { _id: "global", visibility: "global" },
    { _id: "default", visibility: "team" },
    { _id: "team", visibility: "team" },
    { _id: "explicit", visibility: "team" },
  ]);
  mockReconcile.mockResolvedValue({ enabled: true, writes: 1, deletes: 1 });
});

it("repairs global/default grants and removes stale public grants independently of picker reads", async () => {
  expect(await reconcileExistingAgentOpenFgaTuples()).toBe(4);
  for (const [agentId, globalUserAccess, platformDefaultUserAccess, previousGlobalUserAccess] of [
    ["global", true, false, false], ["default", false, true, false], ["team", false, false, true],
  ]) {
    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({
      agentId, globalUserAccess, platformDefaultUserAccess, previousGlobalUserAccess, failClosed: true,
    }));
  }
  expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ agentId: "explicit", unlinkedGrantIsExplicit: true }));
});

it("does not report reconciliation success when the policy write fails", async () => {
  mockReconcile.mockRejectedValueOnce(new Error("PDP unavailable"));
  await expect(reconcileExistingAgentOpenFgaTuples()).rejects.toThrow("PDP unavailable");
});

it("continues to later agents after a snapshot conflict and reports the skipped agent", async () => {
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    mockReconcile.mockRejectedValueOnce(new PermissionSaveConflictError("AGENT_SAVE_CONFLICT"));
    expect(await reconcileExistingAgentOpenFgaTuples()).toBe(3);
    expect(mockReconcile).toHaveBeenCalledTimes(4);
    expect(mockReconcile).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "explicit" }));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("snapshot conflict"), { agentId: "global" });
  } finally {
    warning.mockRestore();
  }
});

it("does not count a pending agent as processed or prevent repair of later agents", async () => {
  mockAgents.mockResolvedValue([
    { _id: "pending", visibility: "global", _permission_sync: { state: "pending" } },
    { _id: "example", visibility: "global" },
  ]);
  expect(await reconcileExistingAgentOpenFgaTuples()).toBe(1);
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ agentId: "example", globalUserAccess: true }));
});

it("does not revoke anything if platform-default configuration cannot be read", async () => {
  mockDefault.mockRejectedValueOnce(new Error("Mongo unavailable"));
  await expect(reconcileExistingAgentOpenFgaTuples()).rejects.toThrow("Mongo unavailable");
  expect(mockReconcile).not.toHaveBeenCalled();
});
