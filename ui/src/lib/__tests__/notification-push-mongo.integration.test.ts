/** @jest-environment node */

import { createECDH, randomBytes } from "node:crypto";
import { saveBrowserPushDevice } from "@/lib/notifications/web-push.server";
import { MongoClient, type Db } from "mongodb";

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


});
