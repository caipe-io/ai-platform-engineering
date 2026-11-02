/** @jest-environment node */
import { MongoClient, type Db } from "mongodb";
import { registerOperatorNotificationType } from "../operator-registration.server";
import { registerAppNotificationTypes, getNotificationSource, deliveryAllowed } from "../subscriptions.server";
import { notificationEventPolicy, notificationPolicyInboxFilter, updateNotificationEventPolicy } from "../event-policy.server";
import { enqueueNotification, runNotificationDeliveriesOnce } from "../delivery.server";
import { resolveNotificationCallback } from "../callback.server";
let mockDb: Db;
const mockAdmin = jest.fn();
const mockInbox = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => mockDb.collection(name), isMongoDBConfigured: true }));
jest.mock("@/lib/agentic-apps/config", () => ({ getConfiguredAgenticApp: () => ({ manifest: { id: "example", displayName: "Example", access: { requiredRoles: [] } }, installation: { installed: true, enabled: true, bindings: { serviceAccountClientId: "publisher" } } }), loadConfiguredAgenticApps: () => [] }));
jest.mock("@/lib/agentic-apps/notification-producer", () => ({ findNotificationProducer: () => ({}) }));
jest.mock("@/lib/rbac/platform-admin", () => ({ hasOrganizationAdmin: () => mockAdmin() }));
jest.mock("@/lib/in-app-notifications.server", () => ({ createInAppNotification: (...args: unknown[]) => mockInbox(...args) }));
const run = process.env.NOTIFICATIONS_MONGO_TEST === "1" ? describe : describe.skip;
run("event policy MongoDB integration", () => {
  let client: MongoClient;
  beforeAll(async () => { client = new MongoClient(process.env.NOTIFICATIONS_MONGODB_URI!); await client.connect(); mockDb = client.db(`notification_policy_test_${process.pid}`); });
  beforeEach(async () => { await mockDb.dropDatabase(); jest.clearAllMocks(); mockAdmin.mockResolvedValue(true); });
  afterAll(async () => { await mockDb.dropDatabase(); await client.close(); });
  const patch = { sourceId: "app:example", eventType: "report.ready", label: "Report ready", description: "Example report", enabled: true, defaultEnabled: true, audience: "recipients", allowedChannels: ["in_app"], revision: 0 };
  it("keeps operator declarations and overrides across app re-registration", async () => {
    await registerOperatorNotificationType({ sourceId: "app:example", event: { id: "report.ready", label: "Report ready" } });
    await updateNotificationEventPolicy({ ...patch, label: "Operator label" }, "operator");
    await registerAppNotificationTypes("example", "Example", [{ id: "job.completed", label: "Job done" }]);
    expect((await getNotificationSource("app:example"))?.events.map((event) => event.id)).toEqual(["job.completed", "report.ready"]);
    expect(await notificationEventPolicy("app:example", "report.ready")).toMatchObject({ label: "Operator label", revision: 1 });
  });
  it("allows exactly one concurrent policy editor and one event registration", async () => {
    const inputs = { sourceId: "app:example", event: { id: "report.ready", label: "Report" } };
    const registrations = await Promise.allSettled([registerOperatorNotificationType(inputs), registerOperatorNotificationType(inputs)]);
    expect(registrations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const results = await Promise.allSettled([updateNotificationEventPolicy(patch, "operator"), updateNotificationEventPolicy(patch, "operator")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
  it("blocks queued delivery and callbacks after admin access is removed", async () => {
    await mockDb.collection("users").insertOne({ email: "test-user@example.test", keycloak_sub: "test-user" });
    await enqueueNotification({ id: "example-event", sourceId: "platform", sourceLabel: "Example", eventType: "service.degraded", recipient: { subject: "test-user", email: "test-user@example.test" }, title: "Example event", message: "Example service", href: "/admin/operations/health", severity: "warning" });
    mockAdmin.mockResolvedValue(false);
    expect(await deliveryAllowed("test-user", "platform", "service.degraded", "in_app")).toBe(false);
    await runNotificationDeliveriesOnce();
    expect(mockInbox).not.toHaveBeenCalled();
    const delivery = await mockDb.collection("notification_deliveries").findOne({ channel: "in_app" });
    expect(delivery?.status).toBe("skipped");
    await expect(resolveNotificationCallback(String(delivery!._id), "test-user", { roles: ["user"] })).rejects.toMatchObject({ statusCode: 404 });
    const filter = await notificationPolicyInboxFilter("test-user", false);
    await mockDb.collection("in_app_notifications").insertOne({ event_type: "service.degraded", source_id: "platform" });
    expect(await mockDb.collection("in_app_notifications").countDocuments(filter)).toBe(0);
  });
});
