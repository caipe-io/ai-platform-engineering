/** @jest-environment node */
import { getHarnessToolReadiness } from "../harness-tool-readiness";
const mockServers = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ find: (...args: unknown[]) => { mockServers(...args); return { toArray: async () => mockServers() }; } }) }));
const agent = { _id: "example", execution_harness_id: "claude_code_cli_acp", allowed_tools: { primary: ["lookup"] } };
beforeEach(() => { jest.clearAllMocks(); mockServers.mockReturnValue([{ _id: "primary", enabled: true }]); });
it.each([{ servers: [] }, { servers: [{ _id: "primary", enabled: false }] }])("blocks missing/disabled dependencies without calling any provider", async ({ servers }) => {
  mockServers.mockReturnValue(servers);
  expect((await getHarnessToolReadiness([agent])).get(agent._id)).toMatchObject({ ready: false, code: "HARNESS_AGENT_NOT_READY" });
  expect(mockServers).toHaveBeenCalledWith({}, { projection: { _id: 1, enabled: 1 } });
});
it("checks the pinned tool set against current grants and longest matching server ID", async () => {
  mockServers.mockReturnValue([{ _id: "primary" }, { _id: "primary.child" }]);
  const value = { ...agent, allowed_tools: { "primary.child": ["lookup"], unavailable: ["old"] } };
  expect((await getHarnessToolReadiness([value], ["primary.child.lookup"])).get(agent._id)).toEqual({ ready: true });
  expect((await getHarnessToolReadiness([value], ["primary.child.delete"])).get(agent._id)?.ready).toBe(false);
});
it("keeps tool-free Claude agents and unrelated runtimes working without a catalog query", async () => {
  expect((await getHarnessToolReadiness([{ ...agent, allowed_tools: {} }])).get(agent._id)).toEqual({ ready: true });
  expect((await getHarnessToolReadiness([{ ...agent, execution_harness_id: "agentcore" }])).size).toBe(0);
  expect(mockServers).not.toHaveBeenCalled();
});
it("ignores explicitly deselected servers and honors wildcard tool grants", async () => {
  expect((await getHarnessToolReadiness([{ ...agent, allowed_tools: { primary: true, disabled: false } }], ["primary.lookup"])).get(agent._id)).toEqual({ ready: true });
});
