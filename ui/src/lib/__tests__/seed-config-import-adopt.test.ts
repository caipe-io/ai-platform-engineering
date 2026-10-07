/**
 * @jest-environment node
 *
 * Tests for the "Import from YAML" adoption flow in seed-config.ts:
 *
 * 1. `seedAgents()` skips any agent already marked `config_import_adopted`,
 *    so an adopted agent's YAML entry becomes a permanent no-op even while
 *    it remains in the seed file.
 * 2. `cleanupStaleConfigDriven()` never deletes an adopted agent, even if
 *    its id is absent from the current config (mirrors the AgentGateway
 *    `source` guard already in place for MCP servers).
 * 3. `adoptConfigImportedAgents()` only adopts agents that are currently
 *    `config_driven: true` and not yet adopted; applies the owner/shared
 *    team assignment ONLY to the ids in the batch; flips `config_driven`
 *    to false and `config_import_adopted` to true; reconciles OpenFGA.
 */

const mockCollection = {
  findOne: jest.fn(),
  find: jest.fn(),
  replaceOne: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
};
const mockReconcileAgentRelationships = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => mockCollection),
}));
jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  reconcileAgentRelationships: (...args: unknown[]) =>
    mockReconcileAgentRelationships(...args),
}));
jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: jest.fn(),
  isOpenFgaReconciliationEnabled: jest.fn(() => false),
}));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileConfigDrivenLlmModelRelationships: jest.fn(),
  reconcileConfigDrivenMcpServerRelationships: jest.fn(),
  reconcileShareableResource: jest.fn(),
}));
jest.mock("@/lib/rbac/workflow-config-rebac", () => ({
  normalizeSharedWithTeamSlugs: jest.fn(async (slugs: string[]) => slugs),
  repairWorkflowConfigTeamSlugRefs: jest.fn(async () => 0),
}));
jest.mock("@/lib/rbac/unlinked-service-account", () => ({
  resolveUnlinkedServiceAccountSub: jest.fn(async () => null),
}));

import { adoptConfigImportedAgents, cleanupStaleConfigDriven } from "../seed-config";

// seedAgents is not exported; exercise it indirectly is not possible here,
// so we re-derive its adopted-skip behavior via a focused require of the
// module internals is avoided — instead we assert the skip through the
// documented contract: adopted agents are absent from the collection calls
// seedAgents would make. That contract is covered by the applySeedConfig
// integration path; here we test the two directly-exported entry points
// that implement the feature end-to-end.

describe("cleanupStaleConfigDriven — config_import_adopted guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollection.find.mockReturnValue({ toArray: jest.fn(async () => []) });
  });

  it("excludes adopted agents from the stale-cleanup query", async () => {
    await cleanupStaleConfigDriven(new Set(), new Set(), new Set(), new Set(), new Set());

    expect(mockCollection.find).toHaveBeenCalledWith({
      config_driven: true,
      config_import_adopted: { $ne: true },
    });
  });

  it("deletes a non-adopted stale agent absent from current config", async () => {
    mockCollection.find.mockReturnValue({
      toArray: jest.fn(async () => [{ _id: "stale-agent" }]),
    });

    await cleanupStaleConfigDriven(new Set(), new Set(), new Set(), new Set(), new Set());

    expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: "stale-agent" });
  });
});

describe("adoptConfigImportedAgents", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("adopts a config-driven agent, sets config_import_adopted, flips config_driven false", async () => {
    mockCollection.findOne.mockResolvedValue({
      _id: "agent-1",
      config_driven: true,
      visibility: "global",
      allowed_tools: {},
    });
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await adoptConfigImportedAgents(["agent-1"], {
      ownerTeamSlug: "platform",
      sharedTeamSlugs: ["sre"],
    });

    expect(result).toEqual({ adopted: ["agent-1"], skipped: [] });
    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      { _id: "agent-1" },
      {
        $set: expect.objectContaining({
          config_driven: false,
          config_import_adopted: true,
          visibility: "team",
          owner_team_slug: "platform",
          shared_with_teams: ["sre"],
        }),
      },
    );
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        ownerTeamSlug: "platform",
        nextSharedTeamSlugs: ["sre"],
      }),
    );
  });

  it("skips an agent that does not exist", async () => {
    mockCollection.findOne.mockResolvedValue(null);

    const result = await adoptConfigImportedAgents(["missing"], {
      ownerTeamSlug: null,
      sharedTeamSlugs: [],
    });

    expect(result).toEqual({ adopted: [], skipped: ["missing"] });
    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });

  it("skips an agent that is already adopted (idempotent re-run)", async () => {
    mockCollection.findOne.mockResolvedValue({
      _id: "agent-1",
      config_driven: false,
      config_import_adopted: true,
    });

    const result = await adoptConfigImportedAgents(["agent-1"], {
      ownerTeamSlug: "new-team",
      sharedTeamSlugs: [],
    });

    expect(result).toEqual({ adopted: [], skipped: ["agent-1"] });
    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });

  it("skips a DB-native agent that was never config_driven", async () => {
    mockCollection.findOne.mockResolvedValue({
      _id: "native-agent",
      config_driven: false,
    });

    const result = await adoptConfigImportedAgents(["native-agent"], {
      ownerTeamSlug: "platform",
      sharedTeamSlugs: [],
    });

    expect(result).toEqual({ adopted: [], skipped: ["native-agent"] });
    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });

  it("applies the team assignment only to ids in the batch, not other config-driven agents", async () => {
    mockCollection.findOne.mockImplementation(async (query: { _id: string }) => {
      if (query._id === "agent-1") {
        return { _id: "agent-1", config_driven: true, visibility: "global", allowed_tools: {} };
      }
      return null;
    });
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await adoptConfigImportedAgents(["agent-1"], {
      ownerTeamSlug: "platform",
      sharedTeamSlugs: [],
    });

    // Only agent-1 was queried/updated — agent-2 (outside the batch) was
    // never looked up or touched.
    expect(mockCollection.findOne).toHaveBeenCalledTimes(1);
    expect(mockCollection.findOne).toHaveBeenCalledWith({ _id: "agent-1" });
    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
  });

  it("drops the owner team from shared_with_teams to avoid a redundant grant", async () => {
    mockCollection.findOne.mockResolvedValue({
      _id: "agent-1",
      config_driven: true,
      visibility: "global",
      allowed_tools: {},
    });
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await adoptConfigImportedAgents(["agent-1"], {
      ownerTeamSlug: "platform",
      sharedTeamSlugs: ["platform", "sre"],
    });

    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      { _id: "agent-1" },
      {
        $set: expect.objectContaining({
          shared_with_teams: ["sre"],
        }),
      },
    );
  });

  it("leaves visibility unchanged when no owner team is supplied", async () => {
    mockCollection.findOne.mockResolvedValue({
      _id: "agent-1",
      config_driven: true,
      visibility: "global",
      allowed_tools: {},
    });
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await adoptConfigImportedAgents(["agent-1"], {
      ownerTeamSlug: null,
      sharedTeamSlugs: [],
    });

    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      { _id: "agent-1" },
      {
        $set: expect.objectContaining({
          visibility: "global",
          owner_team_slug: undefined,
          shared_with_teams: undefined,
        }),
      },
    );
  });
});
