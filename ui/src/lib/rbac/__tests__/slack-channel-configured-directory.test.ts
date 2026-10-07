/** @jest-environment node */

const mappingToArray = jest.fn();
const teamToArray = jest.fn();
const routeToArray = jest.fn();
const agentToArray = jest.fn();
const mappingFind = jest.fn(() => ({ toArray: mappingToArray }));
const teamFind = jest.fn(() => ({ toArray: teamToArray }));
const routeFind = jest.fn(() => ({ toArray: routeToArray }));
const agentFind = jest.fn(() => ({ toArray: agentToArray }));
const mockGetCollection = jest.fn((name: string) => {
  if (name === "channel_team_mappings") return { find: mappingFind };
  if (name === "teams") return { find: teamFind };
  if (name === "slack_channel_agent_routes") return { find: routeFind };
  if (name === "dynamic_agents") return { find: agentFind };
  throw new Error(`Unexpected collection: ${name}`);
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (name: string) => mockGetCollection(name),
}));

import { configuredSlackChannelsById } from "../slack-channel-configured-directory";

describe("configuredSlackChannelsById", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mappingToArray.mockResolvedValue([]);
    teamToArray.mockResolvedValue([]);
    routeToArray.mockResolvedValue([]);
    agentToArray.mockResolvedValue([]);
  });

  it("resolves a large discovery page with a fixed number of batched queries", async () => {
    mappingToArray.mockResolvedValue([
      {
        slack_channel_id: "C000",
        team_slug: "platform",
        active: true,
      },
      {
        slack_channel_id: "C199",
        team_slug: "security",
        active: true,
      },
    ]);
    teamToArray.mockResolvedValue([
      { slug: "platform", name: "Platform" },
      { slug: "security", name: "Security" },
    ]);
    routeToArray.mockResolvedValue([
      {
        channel_id: "C000",
        agent_id: "primary-agent",
        priority: 100,
      },
      {
        channel_id: "C000",
        agent_id: "secondary-agent",
        priority: 200,
      },
    ]);
    agentToArray.mockResolvedValue([
      { _id: "primary-agent", name: "Primary Agent" },
    ]);
    const channelIds = Array.from(
      { length: 200 },
      (_, index) => `C${String(index).padStart(3, "0")}`,
    );

    const result = await configuredSlackChannelsById([
      ...channelIds,
      "C000",
    ]);

    expect(mappingFind).toHaveBeenCalledTimes(1);
    expect(mappingFind).toHaveBeenCalledWith(
      {
        slack_channel_id: { $in: channelIds },
        active: { $ne: false },
      },
      { projection: { slack_channel_id: 1, team_slug: 1 } },
    );
    expect(teamFind).toHaveBeenCalledTimes(1);
    expect(teamFind).toHaveBeenCalledWith(
      { slug: { $in: ["platform", "security"] } },
      { projection: { slug: 1, name: 1 } },
    );
    expect(result.get("C000")?.teamName).toBe("Platform");
    expect(routeFind).toHaveBeenCalledTimes(1);
    expect(routeFind).toHaveBeenCalledWith(
      {
        channel_id: { $in: channelIds },
        status: "active",
        enabled: { $ne: false },
      },
      { projection: { channel_id: 1, agent_id: 1, priority: 1 } },
    );
    expect(agentFind).toHaveBeenCalledTimes(1);
    expect(agentFind).toHaveBeenCalledWith(
      { _id: { $in: ["primary-agent"] } },
      { projection: { _id: 1, name: 1 } },
    );
    expect(result.get("C000")?.agentId).toBe("primary-agent");
    expect(result.get("C000")?.agentName).toBe("Primary Agent");
    expect(result.get("C199")?.teamName).toBe("Security");
  });

  it("does not access MongoDB for an empty channel list", async () => {
    await expect(configuredSlackChannelsById(["", "   "])).resolves.toEqual(
      new Map(),
    );
    expect(mockGetCollection).not.toHaveBeenCalled();
  });
});
