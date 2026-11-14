/** @jest-environment node */

import { resolveNotificationCallback } from "@/lib/notifications/callback.server";
import { MongoClient, type Db } from "mongodb";
import {
  enqueueNotification,
  runNotificationDeliveriesOnce,
} from "@/lib/notifications/delivery.server";

let mockDb: Db;
const mockCreateInbox = jest.fn().mockResolvedValue(true);
const mockExternal = jest.fn().mockResolvedValue(undefined);
const mockAllowed = jest.fn().mockResolvedValue(true);
const mockSubscription = jest.fn().mockResolvedValue(null);
jest.mock("@/lib/mongodb", () => ({
  getCollection: async (name: string) => mockDb.collection(name),
  isMongoDBConfigured: true,
}));
jest.mock("@/lib/in-app-notifications.server", () => ({
  createInAppNotification: (...args: unknown[]) => mockCreateInbox(...args),
}));
jest.mock("@/lib/notifications/adapters.server", () => ({
  sendExternalNotification: (...args: unknown[]) => mockExternal(...args),
}));
jest.mock("@/lib/notifications/subscriptions.server", () => ({
  ...jest.requireActual("@/lib/notifications/subscriptions.server"),
  deliveryAllowed: (...args: unknown[]) => mockAllowed(...args),
  readSubscription: (...args: unknown[]) => mockSubscription(...args),
}));

const run =
  process.env.NOTIFICATIONS_MONGO_TEST === "1" ? describe : describe.skip;
run("durable notification deliveries against MongoDB", () => {
  let client: MongoClient;
  const input = {
    id: "example-event",
    sourceId: "platform",
    sourceLabel: "Example",
    eventType: "workflow.completed",
    recipient: { subject: "test-user", email: "test-user@example.test" },
    title: "Example finished",
    message: "The example run completed.",
    severity: "info" as const,
  };
  beforeAll(async () => {
    client = new MongoClient(
      process.env.NOTIFICATIONS_MONGODB_URI ?? "mongodb://127.0.0.1:27017",
    );
    await client.connect();
    mockDb = client.db(`notification_delivery_test_${process.pid}`);
  });
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.NOTIFICATION_SPLUNK_ENABLED;
    delete process.env.NOTIFICATION_OTEL_ENABLED;
    global.fetch = originalFetch;
    await mockDb.dropDatabase();
    jest.clearAllMocks();
    mockAllowed.mockResolvedValue(true);
    mockSubscription.mockResolvedValue(null);
    mockExternal.mockResolvedValue(undefined);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });
  afterAll(async () => {
    await mockDb.dropDatabase();
    await client.close();
  });

  it("resolves a persisted section callback for its recipient and refuses another user", async () => {
    const href = "/projects/example/wiki/overview.md?view=changes#decision-42";
    await enqueueNotification({ ...input, href, channels: ["in_app"] });
    await runNotificationDeliveriesOnce();
    const delivery = await mockDb
      .collection("notification_deliveries")
      .findOne({ channel: "in_app" });
    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({ href, callbackMarker: delivery?._id }),
    );
    const marker = String(delivery?._id);
    expect(
      await resolveNotificationCallback(marker, input.recipient.subject, {}),
    ).toBe(href);
    await expect(
      resolveNotificationCallback(marker, "other-user", {}),
    ).rejects.toMatchObject({ statusCode: 404 });
    await mockDb
      .collection("notification_deliveries")
      .updateOne({ _id: delivery?._id }, { $set: { expiresAt: new Date(0) } });
    await mockDb
      .collection("in_app_notifications")
      .insertOne({
        callback_marker: marker,
        recipient_user_subjects: [input.recipient.subject],
        href,
        source_id: "platform",
      });
    expect(
      await resolveNotificationCallback(marker, input.recipient.subject, {}),
    ).toBe(href);
    await mockDb
      .collection("in_app_notifications")
      .updateOne(
        { callback_marker: marker },
        { $set: { archived_at: new Date().toISOString() } },
      );
    await expect(
      resolveNotificationCallback(marker, input.recipient.subject, {}),
    ).rejects.toMatchObject({ statusCode: 404 });
  });


});
