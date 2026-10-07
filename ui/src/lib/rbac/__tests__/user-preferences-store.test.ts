/**
 * @jest-environment node
 */

const mockCollection = {
  findOne: jest.fn(),
  updateOne: jest.fn(),
  createIndex: jest.fn(),
};

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => mockCollection),
}));

import {
  getUserPreference,
  updateUserPreferences,
  type UserPreferenceDocument,
} from "../user-preferences-store";

describe("user-preferences-store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollection.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  describe("getUserPreference", () => {
    it("returns null when no document exists for the user", async () => {
      mockCollection.findOne.mockResolvedValue(null);

      const result = await getUserPreference({ tenantId: "default", userId: "alice-sub" });

      expect(result).toEqual({
        web_default_agent_id: null,
        slack_default_agent_id: null,
      });
      expect(mockCollection.findOne).toHaveBeenCalledWith({
        tenant_id: "default",
        user_id: "alice-sub",
      });
    });

    it("returns the saved surface defaults", async () => {
      mockCollection.findOne.mockResolvedValue({
        tenant_id: "default",
        user_id: "alice-sub",
        web_default_agent_id: "agent-web",
        slack_default_agent_id: "agent-slack",
      } satisfies Partial<UserPreferenceDocument>);

      const result = await getUserPreference({ tenantId: "default", userId: "alice-sub" });

      expect(result).toEqual({
        web_default_agent_id: "agent-web",
        slack_default_agent_id: "agent-slack",
      });
    });

    it("returns null for surfaces that have not been configured", async () => {
      mockCollection.findOne.mockResolvedValue({
        tenant_id: "default",
        user_id: "alice-sub",
        web_default_agent_id: "agent-web",
      } satisfies Partial<UserPreferenceDocument>);

      const result = await getUserPreference({ tenantId: "default", userId: "alice-sub" });

      expect(result).toEqual({
        web_default_agent_id: "agent-web",
        slack_default_agent_id: null,
      });
    });

    it("keeps explicit null surface values", async () => {
      mockCollection.findOne.mockResolvedValue({
        tenant_id: "default",
        user_id: "alice-sub",
        web_default_agent_id: "web-agent",
        slack_default_agent_id: null,
      } satisfies Partial<UserPreferenceDocument>);

      const result = await getUserPreference({ tenantId: "default", userId: "alice-sub" });

      expect(result).toEqual({
        web_default_agent_id: "web-agent",
        slack_default_agent_id: null,
      });
    });

    it("scopes reads by tenant", async () => {
      mockCollection.findOne.mockResolvedValue(null);
      await getUserPreference({ tenantId: "acme", userId: "alice-sub" });
      expect(mockCollection.findOne).toHaveBeenCalledWith({
        tenant_id: "acme",
        user_id: "alice-sub",
      });
    });
  });

  describe("updateUserPreferences", () => {
    it("atomically upserts multiple surface defaults and refreshes updated_at", async () => {
      const before = Date.now();

      await updateUserPreferences({
        tenantId: "default",
        userId: "alice-sub",
        preferences: {
          web_default_agent_id: "web-agent",
          slack_default_agent_id: null,
        },
      });

      const after = Date.now();
      expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
      const [filter, update, options] = mockCollection.updateOne.mock.calls[0];
      expect(filter).toEqual({ tenant_id: "default", user_id: "alice-sub" });
      expect(options).toEqual({ upsert: true });
      expect(update.$set.web_default_agent_id).toBe("web-agent");
      expect(update.$set.slack_default_agent_id).toBeNull();
      expect(update.$set.tenant_id).toBe("default");
      expect(update.$set.user_id).toBe("alice-sub");
      const updatedAt = new Date(update.$set.updated_at).getTime();
      expect(updatedAt).toBeGreaterThanOrEqual(before);
      expect(updatedAt).toBeLessThanOrEqual(after);
    });

    it("rejects empty or malformed agent ids before touching Mongo", async () => {
      await expect(
        updateUserPreferences({
          tenantId: "default",
          userId: "alice-sub",
          preferences: { web_default_agent_id: "" },
        }),
      ).rejects.toThrow(/agent/i);
      await expect(
        updateUserPreferences({
          tenantId: "default",
          userId: "alice-sub",
          preferences: { slack_default_agent_id: "../bad" },
        }),
      ).rejects.toThrow(/agent/i);
      expect(mockCollection.updateOne).not.toHaveBeenCalled();
    });

    it("rejects an empty update before touching Mongo", async () => {
      await expect(
        updateUserPreferences({
          tenantId: "default",
          userId: "alice-sub",
          preferences: {},
        }),
      ).rejects.toThrow(/preference/i);
      expect(mockCollection.updateOne).not.toHaveBeenCalled();
    });

    it("rejects empty or malformed user ids before touching Mongo", async () => {
      await expect(
        updateUserPreferences({
          tenantId: "default",
          userId: "",
          preferences: { web_default_agent_id: "agent-x" },
        }),
      ).rejects.toThrow(/user/i);
      expect(mockCollection.updateOne).not.toHaveBeenCalled();
    });
  });
});
