/**
 * @jest-environment node
 */

const mockCollection = {
  find: jest.fn(),
};
const mockReconcileAgentRelationships = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => mockCollection),
}));
jest.mock("@/lib/rbac/openfga", () => ({
  isOpenFgaReconciliationEnabled: jest.fn(() => true),
  writeOpenFgaTuples: jest.fn(),
}));
jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  reconcileAgentRelationships: (...args: unknown[]) =>
    mockReconcileAgentRelationships(...args),
}));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  deleteAllIngestionSourceRelationshipTuples: jest.fn(),
  reconcileConfigDrivenLlmModelRelationships: jest.fn(),
  reconcileConfigDrivenMcpServerRelationships: jest.fn(),
  reconcileDataSourceRelationships: jest.fn(),
  reconcileIngestionSourceRelationships: jest.fn(),
  reconcileKnowledgeBaseRelationships: jest.fn(),
  reconcileShareableResource: jest.fn(),
}));
jest.mock("@/lib/rbac/unlinked-service-account", () => ({
  resolveUnlinkedServiceAccountSub: jest.fn(async () => null),
  resolveUnlinkedServiceAccountGrantState: jest.fn(async () => ({
    sub: null,
    explicitAgentIds: new Set<string>(),
  })),
}));
jest.mock("@/lib/rbac/platform-default", () => ({
  getPlatformDefaultAgentId: jest.fn(async () => null),
}));
jest.mock("@/lib/rbac/workflow-config-rebac", () => ({
  normalizeSharedWithTeamSlugs: jest.fn(async (slugs: string[]) => slugs),
  repairWorkflowConfigTeamSlugRefs: jest.fn(async () => 0),
}));

import { reconcileExistingAgentOpenFgaTuples } from "../seed-config";

describe("reconcileExistingAgentOpenFgaTuples", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconcileAgentRelationships.mockResolvedValue({
      enabled: true,
      writes: 1,
      deletes: 0,
    });
  });

  it("reasserts configured tool grants so missing caller tuples self-heal", async () => {
    const allowedTools = { "mcp-gh-user": true };
    mockCollection.find.mockReturnValue({
      toArray: jest.fn(async () => [
        {
          _id: "agent-personal-assistant",
          allowed_tools: allowedTools,
          owner_subject: "alice-sub",
          visibility: "global",
        },
      ]),
    });

    await expect(reconcileExistingAgentOpenFgaTuples()).resolves.toBe(1);

    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-personal-assistant",
        previousAllowedTools: {},
        nextAllowedTools: allowedTools,
      }),
    );
  });
});
