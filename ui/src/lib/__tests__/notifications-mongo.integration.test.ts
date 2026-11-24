/** @jest-environment node */

import { createInAppNotification, listInAppNotifications, markAllInAppNotificationsRead, markInAppNotificationRead } from "@/lib/in-app-notifications.server";
import { notificationEventKey, type NotificationEnvelope } from "@/lib/notifications/envelope";
import { runNotificationDeliveriesOnce } from "@/lib/notifications/delivery.server";
import { notificationKey } from "@/lib/notifications/subscriptions.server";

// Runs only against a real MongoDB. Set NOTIFICATIONS_MONGO_TEST=1 and point
// MONGODB_URI at a scratch database. Writes only documents tagged with the
// test-verify prefix, and removes them before and after the run.
//   NOTIFICATIONS_MONGO_TEST=1 MONGODB_URI=... npx jest notifications-mongo

import { closeConnection, getCollection } from "@/lib/mongodb";
import { publishNotificationEvent as originalPublish } from "@/lib/notifications/consumer.server";
import { updateNotificationPreferences } from "@/lib/notifications/preferences.server";
import type { InAppNotificationDocument } from "@/types/in-app-notification";
import type { UserSettings } from "@/types/mongodb";

const enabled = process.env.NOTIFICATIONS_MONGO_TEST === "1";
const describeIfMongo = enabled ? describe : describe.skip;
jest.setTimeout(60_000);

const EMAIL = "test-verify-user@example.com";
const SUBJECT = "test-verify-subject";
const PREFIX = "test-verify:";

function envelope(attempt: string): NotificationEnvelope {
  return {
    id: `${PREFIX}evt-${attempt}`,
    type: "workflow.completed",
    version: 1,
    occurred_at: "2026-10-14T10:00:00Z",
    resource: { type: "workflow_run", id: `${PREFIX}run` },
    attempt_id: attempt,
    recipient_subject: SUBJECT,
    recipient_email: EMAIL,
    data: {
      status: "completed",
      title: "Workflow completed",
      summary: "Verification run finished.",
      href: "/workflows/run/verify",
    },
  };
}

async function publishAndRun(input: unknown) {
  const outcome = await originalPublish(input);
  await runNotificationDeliveriesOnce();
  return outcome;
}
function inboxKey(attempt: string) {
  return notificationKey(
    "platform",
    notificationEventKey(envelope(attempt), SUBJECT),
    SUBJECT,
  );
}

async function cleanup(): Promise<void> {
  const inbox = await getCollection<InAppNotificationDocument>(
    "in_app_notifications",
  );
  await inbox.deleteMany({ recipient_user_subjects: SUBJECT } as never);
  for (const name of ["notification_jobs", "notification_deliveries"])
    await (
      await getCollection(name)
    ).deleteMany({ "recipient.subject": SUBJECT });
  const settings = await getCollection<UserSettings>("user_settings");
  await settings.deleteMany({ user_id: EMAIL });
}

describeIfMongo("notification persistence against MongoDB", () => {
  beforeAll(async () => {
    await cleanup();
    await (
      await getCollection("users")
    ).updateOne(
      { keycloak_sub: SUBJECT },
      { $set: { email: EMAIL, metadata: { role: "user" } } },
      { upsert: true },
    );
  });
  afterAll(async () => {
    await cleanup();
    await (await getCollection("users")).deleteOne({ keycloak_sub: SUBJECT });
    await closeConnection();
  });

  it("stores one inbox entry with catalog severity and the server-side key", async () => {
    const outcome = await publishAndRun(envelope("a1"));
    expect(outcome).toBe("queued");

    const inbox = await getCollection<InAppNotificationDocument>(
      "in_app_notifications",
    );
    const doc = await inbox.findOne({ event_key: inboxKey("a1") } as never);
    expect(doc).not.toBeNull();
    expect(doc?.recipient_user_subjects).toEqual([SUBJECT]);
    expect(doc?.severity).toBe("success");
    expect(doc?.read_by_subjects).toEqual([]);
    expect(doc?.href).toBe("/workflows/run/verify");
    expect(doc?.callback_marker).toMatch(/^[a-f0-9]{64}$/);
    expect((await inbox.indexes()).find(index => index.name === "callback_marker_1")?.sparse).toBe(true);
  });

  it("does not write a second entry for a redelivered attempt", async () => {
    await publishAndRun(envelope("a1"));
    await publishAndRun(envelope("a1"));

    const inbox = await getCollection<InAppNotificationDocument>(
      "in_app_notifications",
    );
    const count = await inbox.countDocuments({
      event_key: inboxKey("a1"),
    } as never);
    expect(count).toBe(1);
  });

  it("shares app visibility across inbox reads and read markers, including legacy rows", async () => {
    for (const entry of [
      { eventKey: "app:example-app:legacy", title: "Allowed legacy" },
      { eventKey: "app:example-app-extra:legacy", title: "Hidden legacy" },
      { eventKey: "example-hidden", sourceId: "app:example-app-extra", title: "Hidden current" },
      { eventKey: "example-app-event", sourceId: "app:example-app", eventType: "service.degraded", title: "Allowed current" },
      { eventKey: "example-platform-event", sourceId: "platform", eventType: "service.degraded", title: "Hidden platform" },
      { eventKey: "example-old-platform-event", eventType: "service.degraded", title: "Hidden legacy platform" },
    ]) {
      await createInAppNotification({ ...entry, message: "Example update", recipientUserSubjects: [SUBJECT] });
    }
    const view = { allowedAppSourceIds: ["app:example-app"], excludedEventTypes: ["service.degraded"] };
    const page = await listInAppNotifications(SUBJECT, view);
    const titles = page.notifications.map((notification) => notification.title);
    expect(titles).toEqual(expect.arrayContaining(["Allowed legacy", "Allowed current"]));
    expect(titles.filter((title) => title.startsWith("Hidden"))).toEqual([]);
    const inbox = await getCollection<InAppNotificationDocument>("in_app_notifications");
    const hidden = await inbox.findOne({ event_key: "app:example-app-extra:legacy" });
    expect(hidden).not.toBeNull();
    await expect(markInAppNotificationRead(SUBJECT, hidden!._id, view)).resolves.toBe(false);
    await markAllInAppNotificationsRead(SUBJECT, view);
    const restored = await listInAppNotifications(SUBJECT, {
      ...view,
      allowedAppSourceIds: ["app:example-app", "app:example-app-extra"],
    });
    expect(restored.notifications.filter((row) => row.title.startsWith("Hidden"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Hidden current", read: false }),
      expect.objectContaining({ title: "Hidden legacy", read: false }),
    ]));
  });

  it("skips delivery once the user turns the category off, and resumes after reset", async () => {
    const settings = await getCollection<UserSettings>("user_settings");
    await settings.updateOne(
      { user_id: EMAIL },
      {
        $set: {
          notification_preferences: {
            categories: { workflow: false },
            events: {},
          },
        },
      },
      { upsert: true },
    );

    expect(await publishAndRun(envelope("a2"))).toBe("disabled");

    await settings.updateOne(
      { user_id: EMAIL },
      { $set: { notification_preferences: { categories: {}, events: {} } } },
    );
    expect(await publishAndRun(envelope("a3"))).toBe("queued");
  });

  it("keeps an explicit event opt-in even when its category is off", async () => {
    const settings = await getCollection<UserSettings>("user_settings");
    await settings.updateOne(
      { user_id: EMAIL },
      {
        $set: {
          notification_preferences: {
            categories: { workflow: false },
            events: { "workflow.completed": true },
          },
        },
      },
    );
    expect(await publishAndRun(envelope("a4"))).toBe("queued");
  });

  describe("concurrent preference edits", () => {
    const RACE_EMAIL = "test-verify-race@example.com";
    const EVENT_TYPES = [
      "workflow.failed",
      "workflow.completed",
      "agent.failed",
      "ingestion.failed",
      "agent.completed",
      "ingestion.completed",
    ] as const;

    beforeEach(async () => {
      const settings = await getCollection<UserSettings>("user_settings");
      // The app creates this index at startup. The creation race depends on it.
      await settings.createIndex({ user_id: 1 }, { unique: true });
      await settings.deleteMany({ user_id: RACE_EMAIL });
    });
    afterAll(async () => {
      const settings = await getCollection<UserSettings>("user_settings");
      await settings.deleteMany({ user_id: RACE_EMAIL });
    });

    it("keeps every change when several writers race to create the document", async () => {
      await Promise.all(
        EVENT_TYPES.map((type) =>
          updateNotificationPreferences(RACE_EMAIL, {
            events: { [type]: false },
          }),
        ),
      );

      const settings = await getCollection<UserSettings>("user_settings");
      const doc = await settings.findOne({ user_id: RACE_EMAIL });
      expect(
        Object.keys(doc?.notification_preferences?.events ?? {}).sort(),
      ).toEqual([...EVENT_TYPES].sort());
      expect(doc?.notification_preferences_rev).toBe(EVENT_TYPES.length);
    });

    it("keeps every change when several writers edit an existing document", async () => {
      await updateNotificationPreferences(RACE_EMAIL, {
        categories: { platform: false },
      });
      await Promise.all(
        EVENT_TYPES.map((type) =>
          updateNotificationPreferences(RACE_EMAIL, {
            events: { [type]: true },
          }),
        ),
      );

      const settings = await getCollection<UserSettings>("user_settings");
      const doc = await settings.findOne({ user_id: RACE_EMAIL });
      expect(
        Object.keys(doc?.notification_preferences?.events ?? {}).sort(),
      ).toEqual([...EVENT_TYPES].sort());
      expect(doc?.notification_preferences?.categories).toEqual({
        platform: false,
      });
    });

    it("stores event names with dots as literal keys", async () => {
      await updateNotificationPreferences(RACE_EMAIL, {
        events: { "workflow.failed": false },
      });
      const settings = await getCollection<UserSettings>("user_settings");
      const raw = await settings.findOne({ user_id: RACE_EMAIL });
      expect(Object.keys(raw?.notification_preferences?.events ?? {})).toEqual([
        "workflow.failed",
      ]);
    });
  });
});
