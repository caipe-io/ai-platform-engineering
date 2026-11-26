/** @jest-environment node */
const mockPrepare = jest.fn();
const mockLock = jest.fn(async (_id: string, run: () => Promise<unknown>) => run());
let mockSaved: Record<string, unknown> | null = null;
const mockReplace = jest.fn(async (_query: unknown, doc: Record<string, unknown>) => { mockSaved = doc; });
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true, getCollection: async () => ({ findOne: async () => mockSaved, replaceOne: mockReplace }) }));
jest.mock("@/lib/harness-agent-publication", () => ({ prepareAgentExecution: (...args: unknown[]) => mockPrepare(...args) }));
jest.mock("@/lib/agent-mutation-lock", () => ({ withAgentMutationLock: (...args: [string, () => Promise<unknown>]) => mockLock(...args) }));
jest.mock("@/lib/rbac/openfga-agent-tools", () => ({ reconcileAgentRelationships: jest.fn().mockResolvedValue(undefined) }));
import { seedAgents } from "../seed-config";
const agent = { id: "agent-example", name: "Example", system_prompt: "Use sources.", allowed_tools: { primary: ["read"] }, model: { id: "example", provider: "example" } };
describe("config-driven execution publication", () => {
  const previous = process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED;
  beforeEach(() => { jest.clearAllMocks(); mockSaved = null; process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = "true"; mockPrepare.mockResolvedValue({ version: 7, revision: 7 }); });
  afterAll(() => { if (previous === undefined) delete process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED; else process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = previous; });
  it("publishes once, preserves the version across restarts, and republishes changed tools", async () => {
    await seedAgents([agent]);
    expect(mockPrepare).toHaveBeenCalledWith(expect.objectContaining({ allowed_tools: { primary: ["read"] } }), "system");
    expect(mockSaved).toEqual(expect.objectContaining({ execution_blueprint_version: 7 }));
    await seedAgents([agent]);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    mockPrepare.mockResolvedValue({ version: 8, revision: 8 });
    await seedAgents([{ ...agent, allowed_tools: { primary: ["read", "render"] } }]);
    expect(mockPrepare).toHaveBeenCalledTimes(2);
    expect(mockSaved).toEqual(expect.objectContaining({ execution_blueprint_version: 8 }));
    expect(mockLock).toHaveBeenCalledTimes(3);
  });
  it("does not replace the current configuration if publication fails", async () => {
    mockSaved = { _id: agent.id, allowed_tools: { primary: ["read"] } };
    const before = mockSaved;
    mockPrepare.mockRejectedValue(new Error("Publication unavailable"));
    await expect(seedAgents([agent])).rejects.toThrow("Publication unavailable");
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockSaved).toBe(before);
  });
  it("leaves explicitly adopted agents unchanged", async () => {
    mockSaved = { _id: agent.id, config_import_adopted: true };
    await seedAgents([agent]);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
