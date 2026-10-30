/** @jest-environment node */

import {
  registerAppNotificationTypes,
  writeSubscription,
  deliveryAllowed,
  notificationKey,
} from "@/lib/notifications/subscriptions.server";

const mockUpdate = jest.fn().mockResolvedValue({ matchedCount: 1 });
const mockUser = jest.fn();
const mockApp = jest.fn();
const mockIdentity = jest.fn();
const mockRoles = jest.fn();
const mockSubscriptions = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({
    updateOne: mockUpdate,
    findOne: (...args: unknown[]) => mockUser(...args),
    find: () => ({ limit: () => ({ toArray: () => mockSubscriptions() }) }),
  }),
}));
jest.mock("@/lib/agentic-apps/config", () => ({
  getConfiguredAgenticApp: (...args: unknown[]) => mockApp(...args),
  loadConfiguredAgenticApps: () => [],
}));
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getRealmUserById: (...args: unknown[]) => mockIdentity(...args),
  listRealmRoleMappingsForUser: (...args: unknown[]) => mockRoles(...args),
}));

describe("notification subscriptions and app boundaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscriptions.mockResolvedValue([
      { sourceId: "*", eventType: "*", channels: { slack: true } },
      { sourceId: "app:example-app", eventType: "*", enabled: true },
    ]);
  });
  it("namespaces registrations and rejects duplicate type ids", async () => {
    await registerAppNotificationTypes("example-app", "Example app", [
      { id: "report.ready", label: "Report ready" },
    ]);
    expect(mockUpdate).toHaveBeenCalledWith(
      { _id: "app:example-app" },
      expect.anything(),
      { upsert: true },
    );
    await expect(
      registerAppNotificationTypes("example-app", "Example app", [
        { id: "report.ready", label: "One" },
        { id: "report.ready", label: "Two" },
      ]),
    ).rejects.toThrow("unique");
  });
  it("updates one owned choice without overwriting other events or channels", async () => {
    await writeSubscription("test-user", "app:example-app", "report.ready", {
      channels: { slack: false },
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      { _id: notificationKey("test-user", "app:example-app", "report.ready") },
      {
        $set: expect.objectContaining({
          subject: "test-user",
          "channels.slack": false,
        }),
      },
      { upsert: true },
    );
    expect(mockUpdate.mock.calls[0][1].$set.channels).toBeUndefined();
    await expect(
      writeSubscription("test-user", "app:example-app", "*", {
        subject: "other-user",
      }),
    ).rejects.toThrow("Unknown");
  });
  it("rejects invalid quiet hours and channels", async () => {
    await expect(
      writeSubscription("test-user", "*", "*", {
        channels: { arbitrary: true },
      }),
    ).rejects.toThrow();
    await expect(
      writeSubscription("test-user", "*", "*", {
        quietHours: {
          enabled: true,
          start: "22:00",
          end: "07:00",
          timeZone: "not-a-zone",
        },
      }),
    ).rejects.toThrow();
  });
  it("rechecks disabled apps and revoked roles before any delivery", async () => {
    mockUser.mockResolvedValue({ email: "test-user@example.test" });
    mockApp.mockReturnValue(null);
    expect(
      await deliveryAllowed(
        "test-user",
        "app:example-app",
        "report.ready",
        "slack",
      ),
    ).toBe(false);
    mockApp.mockReturnValue({
      manifest: { access: { requiredRoles: ["example-editor"] } },
      installation: { installed: true, enabled: true },
    });
    mockIdentity.mockResolvedValue({ enabled: true });
    mockRoles.mockResolvedValue([{ name: "user" }]);
    expect(
      await deliveryAllowed(
        "test-user",
        "app:example-app",
        "report.ready",
        "slack",
      ),
    ).toBe(false);
    expect(mockRoles).toHaveBeenCalledWith("test-user", true);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
  it("skips identity-provider lookups for disabled delivery channels", async () => {
    mockSubscriptions.mockResolvedValue([]);
    expect(
      await deliveryAllowed(
        "test-user",
        "app:example-app",
        "report.ready",
        "slack",
      ),
    ).toBe(false);
    expect(mockIdentity).not.toHaveBeenCalled();
    expect(mockRoles).not.toHaveBeenCalled();
  });
});
