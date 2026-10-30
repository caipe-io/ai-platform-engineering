/** @jest-environment node */

import {
  enqueueNotificationExports,
  enqueuePlatformNotificationExports,
} from "@/lib/notifications/exports.server";
import { storeNotificationEnvelope } from "@/lib/notifications/consumer.server";
import { MongoClient, type Db } from "mongodb";
import {
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

  const exported = {
    key: ["example-run"],
    sourceId: "platform",
    eventType: "workflow.completed",
    occurredAt: "2026-10-01T10:00:00Z",
    severity: "success" as const,
  };
  function collectors(): void {
    process.env.NOTIFICATION_SPLUNK_ENABLED = "true";
    process.env.NOTIFICATION_OTEL_ENABLED = "true";
    process.env.NOTIFICATION_SPLUNK_HEC_URL =
      "https://collector.example.test/services/collector/event";
    process.env.NOTIFICATION_SPLUNK_HEC_TOKEN = "example-test-token";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
      "https://collector.example.test/v1/logs";
  }
  it("exports once per sink across recipients whose notifications are disabled", async () => {
    collectors();
    const envelope = {
      id: "example-event",
      type: "workflow.completed" as const,
      version: 1 as const,
      occurred_at: exported.occurredAt,
      resource: { type: "workflow_run" as const, id: "example-run" },
      attempt_id: "example-attempt",
      recipient_subject: "test-user",
      recipient_email: "test-user@example.test",
      data: {
        status: "completed" as const,
        title: "Private title",
        summary: "Private summary",
      },
    };
    await mockDb.collection("user_settings").insertMany([
      {
        user_id: envelope.recipient_email,
        notification_preferences: { categories: { workflow: false } },
      },
      {
        user_id: "other-user@example.test",
        notification_preferences: { categories: { workflow: false } },
      },
    ]);
    await enqueuePlatformNotificationExports(envelope);
    expect(await storeNotificationEnvelope(envelope)).toBe("disabled");
    expect(
      await storeNotificationEnvelope({
        ...envelope,
        recipient_subject: "other-user",
        recipient_email: "other-user@example.test",
      }),
    ).toBe("disabled");
    expect(await mockDb.collection("notification_jobs").countDocuments()).toBe(
      0,
    );
    const queued = await mockDb
      .collection("notification_deliveries")
      .find()
      .toArray();
    expect(queued).toHaveLength(2);
    expect(queued[0].event.id).toBe(queued[1].event.id);
    expect(JSON.stringify(queued)).not.toMatch(
      /Private|test-user|other-user|example-run/,
    );
    expect(queued.every((row) => !row.recipient)).toBe(true);
  });
  it("retries only the failed collector and honors Retry-After independently of personal preferences", async () => {
    collectors();
    await enqueueNotificationExports(exported);
    mockAllowed.mockResolvedValue(false);
    global.fetch = jest.fn().mockImplementation(async (url) =>
      String(url).includes("/v1/logs")
        ? new Response("busy", {
            status: 503,
            headers: { "Retry-After": "120" },
          })
        : Response.json({ code: 0 }),
    );
    const started = Date.now();
    await runNotificationDeliveriesOnce();
    expect(mockAllowed).not.toHaveBeenCalled();
    const failed = await mockDb
      .collection("notification_deliveries")
      .findOne({ channel: "otel" });
    expect(failed).toMatchObject({ status: "pending", attempts: 1 });
    expect(failed?.availableAt.getTime()).toBeGreaterThanOrEqual(
      started + 120000,
    );
    expect(
      await mockDb
        .collection("notification_deliveries")
        .countDocuments({ channel: "splunk", status: "delivered" }),
    ).toBe(1);
    await mockDb
      .collection("notification_deliveries")
      .updateMany(
        { status: "pending" },
        { $set: { availableAt: new Date(0) } },
      );
    jest.mocked(fetch).mockResolvedValue(Response.json({}));
    await runNotificationDeliveriesOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      await mockDb
        .collection("notification_deliveries")
        .countDocuments({ status: "delivered" }),
    ).toBe(2);
  });
  it("fails OTLP partial rejection permanently while the other collector succeeds", async () => {
    collectors();
    await enqueueNotificationExports(exported);
    global.fetch = jest
      .fn()
      .mockImplementation(async (url) =>
        Response.json(
          String(url).includes("/v1/logs")
            ? { partialSuccess: { rejectedLogRecords: "1" } }
            : { code: 0 },
        ),
      );
    await runNotificationDeliveriesOnce();
    await runNotificationDeliveriesOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      await mockDb
        .collection("notification_deliveries")
        .findOne({ channel: "otel" }),
    ).toMatchObject({ status: "failed", attempts: 1 });
    expect(
      await mockDb
        .collection("notification_deliveries")
        .findOne({ channel: "splunk" }),
    ).toMatchObject({ status: "delivered" });
  });
  it("skips exports disabled by the operator after acceptance", async () => {
    collectors();
    await enqueueNotificationExports(exported);
    process.env.NOTIFICATION_OTEL_ENABLED = "false";
    process.env.NOTIFICATION_SPLUNK_ENABLED = "false";
    global.fetch = jest.fn();
    await runNotificationDeliveriesOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await mockDb
        .collection("notification_deliveries")
        .countDocuments({ status: "skipped" }),
    ).toBe(2);
  });

});
