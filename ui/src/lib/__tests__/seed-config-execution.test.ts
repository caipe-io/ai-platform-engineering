/** @jest-environment node */
import YAML from "yaml";
import { seedAgents } from "../seed-config";
import { exportAgentConfiguration } from "../dynamic-agents/config-export";
import { normalizeAgentExecution } from "../dynamic-agents/execution-config";
import { toYaml } from "../yaml-serializer";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";

const mockReplaceOne = jest.fn();
const mockFindOne = jest.fn();
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true, getCollection: async () => ({ findOne: mockFindOne, replaceOne: mockReplaceOne }) }));
jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  reconcileAgentRelationships: jest.fn(async (input: { persistence?: { id: string; set: Record<string, unknown> } }) => {
    // The host uses the canonical durable permission-save boundary; upstream
    // currently persists the same document before relationship reconciliation.
    if (input.persistence) await mockReplaceOne({ _id: input.persistence.id }, input.persistence.set, { upsert: true });
  }),
}));
jest.mock("@/lib/rbac/unlinked-service-account", () => ({ resolveUnlinkedServiceAccountSub: jest.fn().mockResolvedValue(null) }));

const base = { id: "example-agent", name: "Example agent", system_prompt: "Use admitted platform tools.", allowed_tools: {} };
beforeEach(() => { jest.clearAllMocks(); mockFindOne.mockResolvedValue(null); mockReplaceOne.mockResolvedValue({ acknowledged: true }); });

it("defaults legacy seeds to native and preserves legacy/backend-default model behavior", async () => {
  await seedAgents([{ ...base, model_id: "example-model", model_provider: "example-provider" }]);
  expect(mockReplaceOne.mock.calls[0][1]).toMatchObject({ execution: { kind: "native" }, model: { id: "example-model", provider: "example-provider" } });
  await seedAgents([{ ...base, model: null }]);
  expect(mockReplaceOne.mock.calls[1][1]).toMatchObject({ execution: { kind: "native" }, model: { id: "", provider: "" } });
});

it.each([undefined, null])("seeds sandbox placement without inventing a model when configured model is %p", async (model) => {
  await seedAgents([{ ...base, execution: { kind: "sandbox", profile_id: "primary" }, model }]);
  expect(mockReplaceOne.mock.calls[0][1]).toMatchObject({ execution: { kind: "sandbox", profile_id: "primary" } });
  expect(mockReplaceOne.mock.calls[0][1].model).toBeUndefined();
});

it("preserves an explicitly retained model on a sandbox definition", async () => {
  const model = { id: "retained-model", provider: "example-provider", reasoning_effort: "medium" };
  await seedAgents([{ ...base, execution: { kind: "sandbox", profile_id: "primary" }, model }]);
  expect(mockReplaceOne.mock.calls[0][1].model).toEqual(model);
});

it.each([null, { kind: "sandbox" }, { kind: "sandbox", profile_id: "https://untrusted.example.test" }, { kind: "sandbox", profile_id: "primary", endpoint: "https://untrusted.example.test" }, { kind: "native", profile_id: "primary" }])("rejects invalid operator execution configuration %p before writing", async (execution) => {
  await expect(seedAgents([{ ...base, execution }])).rejects.toMatchObject({ code: "INVALID_AGENT_EXECUTION" });
  expect(mockReplaceOne).not.toHaveBeenCalled();
});

it.each(["native", "sandbox"] as const)("round trips %s execution through the actual YAML export and seed path", async (kind) => {
  const execution = kind === "sandbox" ? { kind, profile_id: "primary" } : { kind };
  const agent = { ...base, _id: base.id, execution, model: kind === "native" ? { id: "example-model", provider: "example-provider" } : undefined,
    visibility: "global", subagents: [], skills: [], enabled: true, owner_id: "system", is_system: false, created_at: "", updated_at: "" } as DynamicAgentConfig;
  const parsed = YAML.parse(toYaml(exportAgentConfiguration(agent)));
  expect(parsed.execution).toEqual(execution);
  await seedAgents([parsed]);
  expect(mockReplaceOne.mock.calls[0][1].execution).toEqual(execution);
  expect(mockReplaceOne.mock.calls[0][1].model).toEqual(agent.model);
});

it("validates placement in a pure helper without requiring a live catalog", () => {
  expect(normalizeAgentExecution({ kind: "sandbox", profile_id: "primary" })).toEqual({ kind: "sandbox", profile_id: "primary" });
});
