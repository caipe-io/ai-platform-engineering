/** @jest-environment node */

import {
  registerAppNotificationTypes,
  writeSubscription,
  deliveryAllowed,
  listNotificationSources,
  parseSubscriptionPatch,
  notificationKey,
} from "@/lib/notifications/subscriptions.server";

const mockUpdate = jest.fn().mockResolvedValue({ matchedCount: 1 });
const mockUser = jest.fn();
const mockApp = jest.fn();
const mockIdentity = jest.fn();
const mockRoles = jest.fn();
const mockSubscriptions = jest.fn();
const mockRegistrations = jest.fn();
const mockConfiguredApps = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: async (name: string) => ({
    updateOne: mockUpdate,
    findOne: (...args: unknown[]) => mockUser(...args),
    find: (filter: { _id?: { $in: string[] } }) => {
      const load = name === "notification_sources" ? mockRegistrations : mockSubscriptions;
      const toArray = async () => {
        const rows: Array<{ _id: string }> = await load();
        const ids = filter._id?.$in;
        return ids ? rows.filter((row) => ids.includes(row._id)) : rows;
      };
      return { toArray, limit: (count: number) => ({ toArray: async () => (await toArray()).slice(0, count) }) };
    },
  }),
}));
jest.mock("@/lib/agentic-apps/config", () => ({
  getConfiguredAgenticApp: (...args: unknown[]) => mockApp(...args),
  loadConfiguredAgenticApps: () => mockConfiguredApps(),
}));
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getRealmUserById: (...args: unknown[]) => mockIdentity(...args),
  listRealmRoleMappingsForUser: (...args: unknown[]) => mockRoles(...args),
}));

describe("notification subscriptions and app boundaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscriptions.mockResolvedValue([
      { _id: notificationKey("test-user", "*", "*"), sourceId: "*", eventType: "*", channels: { slack: true } },
      { _id: notificationKey("test-user", "app:example-app", "*"), sourceId: "app:example-app", eventType: "*", enabled: true },
    ]);
    mockConfiguredApps.mockReturnValue([]);
    mockRegistrations.mockResolvedValue([]);
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
  it("rejects coerced registration IDs before writing", async () => {
    await expect(registerAppNotificationTypes("example-app", "Example app", [
      { id: ["report.ready"], label: "Report ready" },
    ])).rejects.toMatchObject({ statusCode: 400 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
  it("enforces a global opt-out even after many stale event rules", async () => {
    mockUser.mockResolvedValue({ email: "test-user@example.test", events: [{ id: "report.ready" }] });
    mockApp.mockReturnValue({
      manifest: { access: { requiredRoles: ["example-editor"] } },
      installation: { installed: true, enabled: true },
    });
    mockIdentity.mockResolvedValue({ enabled: true });
    mockRoles.mockResolvedValue([{ name: "example-editor" }]);
    mockSubscriptions.mockResolvedValue([
      { _id: notificationKey("test-user", "app:example-app", "*"), sourceId: "app:example-app", eventType: "*", enabled: true },
      ...Array.from({ length: 101 }, (_, index) => ({
        _id: notificationKey("test-user", "app:example-app", `retired.${index}`),
        sourceId: "app:example-app",
        eventType: `retired.${index}`,
        enabled: true,
      })),
      { _id: notificationKey("test-user", "*", "*"), sourceId: "*", eventType: "*", enabled: false },
    ]);
    expect(await deliveryAllowed("test-user", "app:example-app", "report.ready", "in_app")).toBe(false);
    expect(mockIdentity).not.toHaveBeenCalled();
  });
  it("lists registered apps for an OIDC bearer user's effective custom role", async () => {
    const app = (id: string, requiredRole: string) => ({
      manifest: { id, access: { requiredRoles: [requiredRole] } },
      installation: { installed: true, enabled: true },
    });
    mockConfiguredApps.mockReturnValue([app("example-app", "example-editor"), app("example-admin", "admin")]);
    mockRegistrations.mockResolvedValue([
      { _id: "app:example-app", label: "Example app", events: [] },
      { _id: "app:example-admin", label: "Example admin", events: [] },
    ]);
    mockRoles.mockResolvedValue([{ name: "example-editor" }, { name: "admin" }]);
    const session = { authMethod: "bearer", principalType: "oidc_user", role: "user" };
    expect((await listNotificationSources("test-user", session)).map((source) => source.id))
      .toEqual(["platform", "app:example-app"]);
    expect(mockRoles).toHaveBeenCalledWith("test-user", true);
  });
  it("shows a saved platform event opt-out even when the catalog defaults to enabled", async () => {
    mockUser.mockResolvedValue(null);
    mockSubscriptions.mockResolvedValue([{
      _id: notificationKey("test-user", "platform", "workflow.failed"),
      enabled: false,
    }]);
    const [platform] = await listNotificationSources("test-user", {}, "user", "test-user@example.test");
    expect(platform.events.find((event) => event.id === "workflow.failed")?.subscription.enabled).toBe(false);
    expect(platform.events.find((event) => event.id === "workflow.completed")?.subscription.enabled).toBe(true);
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
    expect(() => parseSubscriptionPatch({ subject: "other-user" })).toThrow("Unknown");
  });
  it("rejects invalid quiet hours and channels", () => {
    expect(() => parseSubscriptionPatch({
      channels: { arbitrary: true },
    })).toThrow("Unknown channel");
    expect(() => parseSubscriptionPatch({
      quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "not-a-zone" },
    })).toThrow("Unknown time zone");
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
  it("admits the sign-in baseline user role without an explicit realm mapping", async () => {
    mockUser.mockImplementation(async () => ({ email: "test-user@example.test", events: [{ id: "report.ready" }] }));
    mockApp.mockReturnValue({ manifest: { access: { requiredRoles: ["user"] } }, installation: { installed: true, enabled: true } });
    mockIdentity.mockResolvedValue({ enabled: true });
    mockRoles.mockResolvedValue([{ name: "offline_access" }]);
    expect(await deliveryAllowed("test-user", "app:example-app", "report.ready", "in_app")).toBe(true);
    mockIdentity.mockResolvedValue({ enabled: false });
    expect(await deliveryAllowed("test-user", "app:example-app", "report.ready", "in_app")).toBe(false);
  });
  it("does not infer administrator access from a cached account role", async () => {
    mockUser.mockResolvedValue({ email: "test-user@example.test", metadata: { role: "admin" } });
    mockApp.mockReturnValue({ manifest: { access: { requiredRoles: ["admin"] } }, installation: { installed: true, enabled: true } });
    mockIdentity.mockResolvedValue({ enabled: true });
    mockRoles.mockResolvedValue([]);
    expect(await deliveryAllowed("test-user", "app:example-app", "report.ready", "in_app")).toBe(false);
  });
  it("requires an administrator session for admin-only apps even with the realm mapping", async () => {
    mockUser.mockResolvedValue({ email: "test-user@example.test", events: [{ id: "report.ready" }] });
    mockApp.mockReturnValue({ manifest: { access: { requiredRoles: ["admin"] } }, installation: { installed: true, enabled: true } });
    mockIdentity.mockResolvedValue({ enabled: true });
    mockRoles.mockResolvedValue([{ name: "admin" }]);
    expect(await deliveryAllowed("test-user", "app:example-app", "report.ready", "slack")).toBe(false);
  });

  it("continues to require a live custom role and honors its revocation", async () => {
    mockUser.mockResolvedValue({ email: "test-user@example.test", events: [{ id: "report.ready" }] });
    mockApp.mockReturnValue({ manifest: { access: { requiredRoles: ["example-editor"] } }, installation: { installed: true, enabled: true } });
    mockIdentity.mockResolvedValue({ enabled: true });
    mockRoles.mockResolvedValue([{ name: "example-editor" }]);
    expect(await deliveryAllowed("test-user", "app:example-app", "report.ready", "in_app")).toBe(true);
    mockRoles.mockResolvedValue([]);
    expect(await deliveryAllowed("test-user", "app:example-app", "report.ready", "in_app")).toBe(false);
  });
});
