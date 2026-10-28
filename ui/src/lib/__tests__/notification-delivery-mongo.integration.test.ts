/** @jest-environment node */

import { createECDH, randomBytes } from "node:crypto";
import { saveBrowserPushDevice } from "@/lib/notifications/web-push.server";
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
  beforeEach(async () => {
    await mockDb.dropDatabase();
    jest.clearAllMocks();
    mockAllowed.mockResolvedValue(true);
    mockSubscription.mockResolvedValue(null);
    mockExternal.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await mockDb.dropDatabase();
    await client.close();
  });

  it("accepts once, expands after restart, and claims each delivery across replicas", async () => {
    await Promise.all([enqueueNotification(input), enqueueNotification(input)]);
    expect(await mockDb.collection("notification_jobs").countDocuments()).toBe(
      1,
    );
    expect(mockCreateInbox).not.toHaveBeenCalled();
    await Promise.all([
      runNotificationDeliveriesOnce(),
      runNotificationDeliveriesOnce(),
    ]);
    expect(mockCreateInbox).toHaveBeenCalledTimes(1);
    expect(mockExternal).toHaveBeenCalledTimes(2);
    expect(
      await mockDb
        .collection("notification_deliveries")
        .countDocuments({ status: "delivered" }),
    ).toBe(3);
  });

  it("retries a failed channel without repeating successful channels", async () => {
    await enqueueNotification(input);
    mockExternal.mockImplementation(async (delivery) => {
      if (delivery.channel === "slack") throw new Error("example outage");
    });
    await runNotificationDeliveriesOnce();
    expect(mockCreateInbox).toHaveBeenCalledTimes(1);
    expect(
      await mockDb
        .collection("notification_deliveries")
        .countDocuments({ status: "pending", channel: "slack" }),
    ).toBe(1);
    mockExternal.mockResolvedValue(undefined);
    await mockDb
      .collection("notification_deliveries")
      .updateMany(
        { status: "pending" },
        { $set: { availableAt: new Date(0) } },
      );
    await runNotificationDeliveriesOnce();
    expect(mockCreateInbox).toHaveBeenCalledTimes(1);
    expect(
      await mockDb
        .collection("notification_deliveries")
        .countDocuments({ status: "delivered" }),
    ).toBe(3);
  });

  it("checks opt-outs after acceptance and before sending", async () => {
    await enqueueNotification(input);
    mockAllowed.mockResolvedValue(false);
    await runNotificationDeliveriesOnce();
    expect(mockCreateInbox).not.toHaveBeenCalled();
    expect(mockExternal).not.toHaveBeenCalled();
    expect(
      await mockDb
        .collection("notification_deliveries")
        .countDocuments({ status: "skipped" }),
    ).toBe(3);
  });

  it("keeps the inbox active while quiet hours defer external channels", async () => {
    await enqueueNotification(input);
    const zone = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(Date.now());
    mockSubscription.mockResolvedValue({
      quietHours: {
        enabled: true,
        start: zone,
        end: zone === "23:59" ? "23:58" : "23:59",
        timeZone: "UTC",
      },
    });
    await runNotificationDeliveriesOnce();
    expect(mockCreateInbox).toHaveBeenCalledTimes(1);
    expect(mockExternal).not.toHaveBeenCalled();
    expect(
      await mockDb
        .collection("notification_deliveries")
        .countDocuments({ status: "pending", attempts: 0 }),
    ).toBe(2);
  });
  it("cannot reassign another user's browser subscription", async () => {
    process.env.NOTIFICATION_WEB_PUSH_PUBLIC_KEY = "example";
    process.env.NOTIFICATION_WEB_PUSH_PRIVATE_KEY = "example-private";
    process.env.NOTIFICATION_WEB_PUSH_SUBJECT = "mailto:admin@example.test";
    try {
      const curve = createECDH("prime256v1");
      curve.generateKeys();
      const input = {
        endpoint: "https://fcm.googleapis.com/example",
        keys: {
          p256dh: curve.getPublicKey().toString("base64url"),
          auth: randomBytes(16).toString("base64url"),
        },
      };
      await saveBrowserPushDevice("test-user", input);
      await expect(saveBrowserPushDevice("other-user", input)).rejects.toThrow(
        "another account",
      );
      await expect(
        saveBrowserPushDevice("other-user", {
          ...input,
          endpoint: "https://FCM.GOOGLEAPIS.COM/example",
        }),
      ).rejects.toThrow("another account");
      expect(
        await mockDb
          .collection("notification_push_devices")
          .countDocuments({ subject: "test-user" }),
      ).toBe(1);
    } finally {
      delete process.env.NOTIFICATION_WEB_PUSH_PUBLIC_KEY;
      delete process.env.NOTIFICATION_WEB_PUSH_PRIVATE_KEY;
      delete process.env.NOTIFICATION_WEB_PUSH_SUBJECT;
    }
  });

  it("fences a stale worker after its lease expires", async () => {
    await enqueueNotification({ ...input, channels: ["slack"] });
    let rejectFirst: (reason: Error) => void = () => undefined;
    let started: () => void = () => undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    mockExternal
      .mockImplementationOnce(() => {
        started();
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      })
      .mockResolvedValue(undefined);
    const first = runNotificationDeliveriesOnce();
    await began;
    await mockDb
      .collection("notification_deliveries")
      .updateMany(
        { status: "processing" },
        { $set: { leaseUntil: new Date(0) } },
      );
    await runNotificationDeliveriesOnce();
    rejectFirst(
      new Error("stale worker failed after another replica completed"),
    );
    await first;
    const delivery = await mockDb
      .collection("notification_deliveries")
      .findOne({ channel: "slack" });
    expect(delivery?.status).toBe("delivered");
    expect(delivery?.attempts).toBe(2);
    expect(delivery?.lastError).toBeUndefined();
  });
});
