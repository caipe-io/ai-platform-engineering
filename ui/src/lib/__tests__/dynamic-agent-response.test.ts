jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(),
}));

import { getCollection } from "@/lib/mongodb";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";

import { dynamicAgentsForBrowser } from "../dynamic-agent-response";

const mockGetCollection = getCollection as jest.MockedFunction<typeof getCollection>;

function agent(overrides: Partial<DynamicAgentConfig> = {}): DynamicAgentConfig {
  return {
    _id: "example-agent",
    name: "Example Agent",
    system_prompt: "Help with examples.",
    allowed_tools: {},
    model: { id: "example-model", provider: "example-provider" },
    visibility: "private",
    subagents: [],
    skills: [],
    enabled: true,
    owner_id: "owner@example.test",
    owner_subject: "owner-sub",
    creator_id: "creator@example.test",
    creator_subject: "creator-sub",
    is_system: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("dynamicAgentsForBrowser", () => {
  beforeEach(() => {
    mockGetCollection.mockReset();
  });

  it("removes stable subjects and returns directory-resolved creator and owner labels", async () => {
    mockGetCollection.mockResolvedValue({
      find: jest.fn(() => ({
        toArray: jest.fn(async () => [
          {
            email: "creator@example.test",
            name: "Example Creator",
            keycloak_sub: "creator-sub",
            metadata: { sso_provider: "example", sso_id: "creator-sub", role: "user" },
          },
          {
            email: "owner@example.test",
            name: "Example Owner",
            keycloak_sub: "owner-sub",
            metadata: { sso_provider: "example", sso_id: "owner-sub", role: "user" },
          },
        ]),
      })),
    } as never);

    const [result] = await dynamicAgentsForBrowser([agent()]);

    expect(result).not.toHaveProperty("owner_subject");
    expect(result).not.toHaveProperty("creator_subject");
    expect(result.creator).toEqual({
      label: "Example Creator",
      name: "Example Creator",
      email: "creator@example.test",
    });
    expect(result.owner).toEqual({
      label: "Example Owner",
      name: "Example Owner",
      email: "owner@example.test",
    });
  });

  it("falls back to the persisted creator email when the directory is unavailable", async () => {
    mockGetCollection.mockRejectedValue(new Error("directory unavailable"));

    const [result] = await dynamicAgentsForBrowser([agent()]);

    expect(result.creator).toEqual({
      label: "creator@example.test",
      email: "creator@example.test",
    });
  });
});
