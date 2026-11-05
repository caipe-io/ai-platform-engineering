/** @jest-environment node */
import { prepareAgentExecution } from "../harness-agent-publication";

const proxy = jest.fn();
jest.mock("@/lib/harness-engine-proxy", () => ({ getHarnessEngineConfig: () => ({ url: "http://engine.example.test", internalToken: "example" }), proxyHarnessEngine: (...args: unknown[]) => proxy(...args) }));
const agent = { _id: "example", name: "Example", execution_harness_id: "example_sdk", system_prompt: "Help" };
const draft = { blueprint: { harness: { id: "example_sdk" } }, expected_revision: 1 };
const reply = (data: unknown) => Response.json({ success: true, data });

afterEach(() => { jest.resetAllMocks(); delete process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED; });

it("requires the blueprint before changing a non-native agent", async () => {
  await expect(prepareAgentExecution(agent, "test-user")).rejects.toThrow("blueprint");
  expect(proxy).not.toHaveBeenCalled();
});

it("keeps native rollback edits independent of Engine availability", async () => {
  expect(await prepareAgentExecution({ ...agent, execution_harness_id: "dynamic_agents", execution_blueprint_version: 3 }, "test-user")).toBeNull();
  expect(proxy).not.toHaveBeenCalled();
});

it("prepares against the latest Engine revision after an unpublished version", async () => {
  proxy.mockResolvedValueOnce(reply({ record: { revision: 5 } }))
    .mockResolvedValueOnce(reply({ record: { revision: 6 }, version: { version: 6 } }));
  expect(await prepareAgentExecution(agent, "test-user", draft)).toEqual({ revision: 6, version: 6 });
  expect(JSON.parse(proxy.mock.calls[1][3].body).expected_revision).toBe(5);
});
