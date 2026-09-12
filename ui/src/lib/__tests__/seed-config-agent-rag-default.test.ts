/** @jest-environment node */

const replaceOne = jest.fn();
const findAgent = jest.fn();
const mockGetCollection = jest.fn(async (name: string) => {
  if (name === "dynamic_agents") {
    return {
      findOne: findAgent,
      replaceOne,
    };
  }
  throw new Error(`unexpected collection ${name}`);
});

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  reconcileAgentRelationships: jest.fn().mockResolvedValue(undefined),
}));

import { seedAgents } from "../seed-config";

const baseAgent = {
  id: "agent-example",
  name: "Example agent",
  system_prompt: "Use trusted knowledge.",
  model: { id: "example-model", provider: "example-provider" },
  allowed_tools: { "knowledge-base": true },
};

describe("seedAgents RAG scope default", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findAgent.mockResolvedValue(null);
    replaceOne.mockResolvedValue({ acknowledged: true });
  });

  it("leaves a new config-driven RAG agent unrestricted by default", async () => {
    await seedAgents([baseAgent]);

    expect(replaceOne).toHaveBeenCalledWith(
      { _id: "agent-example" },
      expect.objectContaining({
        datasource_ids: undefined,
        rag_collection_ids: undefined,
      }),
      { upsert: true },
    );
    expect(mockGetCollection).not.toHaveBeenCalledWith("rag_collections");
  });

  it("preserves explicit empty arrays as an opt-out", async () => {
    await seedAgents([
      {
        ...baseAgent,
        datasource_ids: [],
        rag_collection_ids: [],
      },
    ]);

    expect(replaceOne).toHaveBeenCalledWith(
      { _id: "agent-example" },
      expect.objectContaining({ datasource_ids: [], rag_collection_ids: [] }),
      { upsert: true },
    );
  });

  it("leaves an existing config agent unrestricted when RAG is enabled without an explicit scope", async () => {
    findAgent.mockResolvedValue({
      _id: "agent-example",
      allowed_tools: { jira: true },
      config_driven: true,
      created_at: "2026-01-01T00:00:00.000Z",
    });

    await seedAgents([baseAgent]);

    expect(replaceOne).toHaveBeenCalledWith(
      { _id: "agent-example" },
      expect.objectContaining({
        datasource_ids: undefined,
        rag_collection_ids: undefined,
      }),
      { upsert: true },
    );
  });

  it("preserves an existing explicit empty scope", async () => {
    findAgent.mockResolvedValue({
      _id: "agent-example",
      allowed_tools: { "knowledge-base": true },
      datasource_ids: [],
      rag_collection_ids: [],
      config_driven: true,
      created_at: "2026-01-01T00:00:00.000Z",
    });

    await seedAgents([baseAgent]);

    expect(replaceOne).toHaveBeenCalledWith(
      { _id: "agent-example" },
      expect.objectContaining({ datasource_ids: [], rag_collection_ids: [] }),
      { upsert: true },
    );
  });
});
