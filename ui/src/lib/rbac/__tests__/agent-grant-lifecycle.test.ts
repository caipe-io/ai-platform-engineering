/** @jest-environment node */
import { buildAgentRelationshipTupleDiff, reconcileAgentRelationships, deleteAllAgentToolTuples } from "../openfga-agent-tools";

const mockReconcile = jest.fn();
const mockRead = jest.fn();
jest.mock("@/lib/authz", () => ({ reconcileTupleDiff: (...args: unknown[]) => mockReconcile(...args) }));
jest.mock("../openfga", () => ({
  isOpenFgaReconciliationEnabled: () => true,
  readOpenFgaTuples: (...args: unknown[]) => mockRead(...args),
}));

const base = { agentId: "example", nextAllowedTools: {} };
const publicGrant = { user: "user:*", relation: "user", object: "agent:example" };
beforeEach(() => {
  jest.clearAllMocks();
  mockReconcile.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
});

it.each([false, true])("ensures a non-global platform default has a human grant (previously global: %s)", previousGlobalUserAccess => {
  const diff = buildAgentRelationshipTupleDiff({ ...base, platformDefaultUserAccess: true, previousGlobalUserAccess });
  expect(diff.writes).toContainEqual(publicGrant);
  expect(diff.deletes).not.toContainEqual(publicGrant);
});

it("does not give a service account access just because the agent is the default", () => {
  const diff = buildAgentRelationshipTupleDiff({
    ...base, platformDefaultUserAccess: true, previousGlobalUserAccess: true,
    unlinkedServiceAccountSub: "example-service",
  });
  const serviceGrant = { user: "service_account:example-service", relation: "user", object: "agent:example" };
  expect(diff.writes).not.toContainEqual(serviceGrant);
  expect(diff.deletes).toContainEqual(serviceGrant);
});

it("preserves explicit service-account access independently of visibility", () => {
  const diff = buildAgentRelationshipTupleDiff({
    ...base, platformDefaultUserAccess: true, previousGlobalUserAccess: true,
    unlinkedServiceAccountSub: "example-service", unlinkedGrantIsExplicit: true,
  });
  const serviceGrant = { user: "service_account:example-service", relation: "user", object: "agent:example" };
  expect(diff.writes).toContainEqual(serviceGrant);
  expect(diff.deletes).not.toContainEqual(serviceGrant);
});

it("routes global-to-team revocation through CAS without a picker read", async () => {
  await reconcileAgentRelationships({ ...base, previousGlobalUserAccess: true, globalUserAccess: false });
  expect(mockReconcile).toHaveBeenCalledWith(
    { writes: [], deletes: [publicGrant] }, { source: "agent_relationships" },
  );
});

it("propagates CAS failure to the lifecycle caller", async () => {
  mockReconcile.mockRejectedValueOnce(new Error("PDP write failed"));
  await expect(reconcileAgentRelationships({ ...base, globalUserAccess: true })).rejects.toThrow("PDP write failed");
});

it("deletes incoming and outgoing agent relationships through CAS across read pages", async () => {
  const outgoing = { user: "agent:example", relation: "caller", object: "tool:example/read" };
  mockRead.mockResolvedValueOnce({ tuples: [{ key: publicGrant }], continuationToken: "next" })
    .mockResolvedValueOnce({ tuples: [{ key: outgoing }, { key: { ...publicGrant, object: "agent:unrelated" } }] });
  await deleteAllAgentToolTuples("example");
  expect(mockReconcile).toHaveBeenCalledWith({ writes: [], deletes: [publicGrant, outgoing] }, { source: "agent_delete" });
});
