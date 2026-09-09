const mockGetCollection = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/feature-flags/private-resources", () => ({
  isPrivateResourcesEnabled: () => true,
}));

import { privateResourceBatchPreChecks } from "../private-resource";

describe("private resource persisted-state prechecks", () => {
  beforeEach(() => jest.clearAllMocks());

  it("denies execution for pending and failed authorization revisions", async () => {
    mockGetCollection.mockResolvedValue({
      find: jest.fn(() => ({
        toArray: jest.fn(async () => [
          { _id: "pending", authz_sync_state: "pending" },
          { _id: "failed", authz_sync_state: "error" },
          {
            _id: "ready",
            authz_sync_state: "ready",
            authz_revision: 2,
            authz_last_synced_revision: 2,
          },
          { _id: "legacy" },
        ]),
      })),
    });

    const decisions = await privateResourceBatchPreChecks({
      subject: { type: "user", id: "user-a" },
      action: "discover",
      trustedContext: {
        interaction: {
          source: "web",
          conversationKind: "personal",
          verified: false,
        },
      },
      resourceType: "agent",
      ids: ["pending", "failed", "ready", "legacy"],
    });

    expect(decisions.get("pending")?.reason).toBe("AUTHZ_SYNC_PENDING");
    expect(decisions.get("failed")?.reason).toBe("AUTHZ_SYNC_ERROR");
    expect(decisions.has("ready")).toBe(false);
    expect(decisions.has("legacy")).toBe(false);
  });

  it.each([
    [
      "skill" as const,
      "invoke" as const,
      { id: "pending", authz_sync_state: "pending" },
    ],
    [
      "task" as const,
      "read" as const,
      { _id: "pending", authz_sync_state: "pending" },
    ],
  ])(
    "applies the sync gate to %s resources",
    async (resourceType, action, row) => {
      mockGetCollection.mockResolvedValue({
        find: jest.fn(() => ({ toArray: jest.fn(async () => [row]) })),
      });

      const decisions = await privateResourceBatchPreChecks({
        subject: { type: "user", id: "user-a" },
        action,
        resourceType,
        ids: ["pending"],
      });

      expect(decisions.get("pending")?.reason).toBe("AUTHZ_SYNC_PENDING");
    },
  );
});
