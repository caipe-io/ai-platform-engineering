/** @jest-environment node */
import { getCoordinationFeatures } from "../features.server";

const mockFind = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFind }) }));
jest.mock("@/lib/platform-default-agent", () => ({ PLATFORM_CONFIG_ID: "platform_settings" }));
beforeEach(() => { jest.resetAllMocks(); delete process.env.AGENT_COORDINATION_ENABLED; delete process.env.AGENT_TEAM_HANDOFFS_ENABLED; });
afterEach(() => { delete process.env.AGENT_COORDINATION_ENABLED; delete process.env.AGENT_TEAM_HANDOFFS_ENABLED; });

it("defaults to enabled and observes runtime changes without a process restart", async () => {
  mockFind.mockResolvedValueOnce(null).mockResolvedValueOnce({ agent_coordination: { team: false } }).mockResolvedValueOnce({ agent_coordination: { enabled: false } });
  expect(await getCoordinationFeatures()).toEqual({ enabled: true, team: true });
  expect(await getCoordinationFeatures()).toEqual({ enabled: true, team: false });
  expect(await getCoordinationFeatures()).toEqual({ enabled: false, team: false });
});
it("treats deployment disables as ceilings, including when runtime settings enable everything", async () => {
  mockFind.mockResolvedValue({ agent_coordination: { enabled: true, team: true } });
  process.env.AGENT_TEAM_HANDOFFS_ENABLED = "false";
  expect(await getCoordinationFeatures()).toEqual({ enabled: true, team: false });
  process.env.AGENT_COORDINATION_ENABLED = "false";
  expect(await getCoordinationFeatures()).toEqual({ enabled: false, team: false });
});
it("fails closed if runtime settings cannot be read", async () => {
  mockFind.mockRejectedValue(new Error("Database unavailable"));
  await expect(getCoordinationFeatures()).rejects.toThrow("Database unavailable");
});
