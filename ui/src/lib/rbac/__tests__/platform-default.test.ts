/** @jest-environment node */
import { getPlatformDefaultAgentId, isPlatformDefaultAgent } from "../platform-default";
const mockFindOne = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: (...args: unknown[]) => mockFindOne(...args) }) }));
const originalDefault = process.env.DEFAULT_AGENT_ID;
afterEach(() => {
  if (originalDefault === undefined) delete process.env.DEFAULT_AGENT_ID;
  else process.env.DEFAULT_AGENT_ID = originalDefault;
});
it("uses the database override before the environment default", async () => {
  process.env.DEFAULT_AGENT_ID = "environment";
  mockFindOne.mockResolvedValue({ default_agent_id: "database" });
  expect(await getPlatformDefaultAgentId()).toBe("database");
});
it("uses the environment default when the override is cleared", async () => {
  process.env.DEFAULT_AGENT_ID = "environment";
  mockFindOne.mockResolvedValue({ default_agent_id: null });
  expect(await getPlatformDefaultAgentId()).toBe("environment");
});
it("does not bypass a default-agent mutation guard when the config read fails", async () => {
  delete process.env.DEFAULT_AGENT_ID;
  mockFindOne.mockRejectedValue(new Error("Mongo unavailable"));
  await expect(isPlatformDefaultAgent("database")).rejects.toThrow("Mongo unavailable");
});
