/** @jest-environment node */

const mockReplace = jest.fn().mockResolvedValue({ acknowledged: true });
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async (name: string) => {
    if (name !== "dynamic_agents") throw new Error(`unexpected collection ${name}`);
    return { findOne: jest.fn().mockResolvedValue(null), replaceOne: mockReplace };
  }),
}));
jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  reconcileAgentRelationships: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/rbac/unlinked-service-account", () => ({
  resolveUnlinkedServiceAccountSub: jest.fn().mockResolvedValue(null),
}));

import { seedAgents } from "../seed-config";

const agent = {
  id: "example-agent", name: "Example Agent", system_prompt: "Help with examples.",
  model: { id: "example-model", provider: "example" },
};

beforeEach(() => jest.clearAllMocks());

it("persists only an explicitly configured app-context projection", async () => {
  const policy = { app_ids: ["example-app"], fields: ["title", "selection.city"], max_bytes: 4096 };
  await seedAgents([{ ...agent, app_context_prompt: policy }]);
  expect(mockReplace).toHaveBeenCalledWith(
    { _id: "example-agent" }, expect.objectContaining({ app_context_prompt: policy }), { upsert: true },
  );
});

it("does not opt in an ordinary seeded agent", async () => {
  await seedAgents([agent]);
  expect(mockReplace.mock.calls[0][1].app_context_prompt).toBeUndefined();
});
