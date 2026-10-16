/** @jest-environment node */

// Runs only against a real MongoDB. Set NOTIFICATIONS_MONGO_TEST=1 and point
// MONGODB_URI at a scratch database. Writes only documents tagged with the
// test-verify prefix, and removes them before and after the run.
//   NOTIFICATIONS_MONGO_TEST=1 MONGODB_URI=... npx jest notifications-mongo

import { getCollection } from "@/lib/mongodb";
import { publishNotificationEvent } from "@/lib/notifications/consumer.server";
import type { InAppNotificationDocument } from "@/types/in-app-notification";
import type { UserSettings } from "@/types/mongodb";

const enabled = process.env.NOTIFICATIONS_MONGO_TEST === "1";
const describeIfMongo = enabled ? describe : describe.skip;

const EMAIL = "test-verify-user@example.com";
const SUBJECT = "test-verify-subject";
const PREFIX = "test-verify:";

function envelope(attempt: string) {
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

async function cleanup(): Promise<void> {
  const inbox = await getCollection<InAppNotificationDocument>("in_app_notifications");
  await inbox.deleteMany({ event_key: { $regex: PREFIX } } as never);
  const settings = await getCollection<UserSettings>("user_settings");
  await settings.deleteMany({ user_id: EMAIL });
}

describeIfMongo("notification persistence against MongoDB", () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it("stores one inbox entry with catalog severity and the server-side key", async () => {
    const outcome = await publishNotificationEvent(envelope("a1"));
    expect(outcome).toBe("delivered");

    const inbox = await getCollection<InAppNotificationDocument>("in_app_notifications");
    const doc = await inbox.findOne({ event_key: `workflow.completed:workflow_run:${PREFIX}run:a1:${SUBJECT}` } as never);
    expect(doc).not.toBeNull();
    expect(doc?.recipient_user_subjects).toEqual([SUBJECT]);
    expect(doc?.severity).toBe("success");
    expect(doc?.read_by_subjects).toEqual([]);
    expect(doc?.href).toBe("/workflows/run/verify");
  });

  it("does not write a second entry for a redelivered attempt", async () => {
    await publishNotificationEvent(envelope("a1"));
    await publishNotificationEvent(envelope("a1"));

    const inbox = await getCollection<InAppNotificationDocument>("in_app_notifications");
    const count = await inbox.countDocuments({
      event_key: `workflow.completed:workflow_run:${PREFIX}run:a1:${SUBJECT}`,
    } as never);
    expect(count).toBe(1);
  });

  it("skips delivery once the user turns the category off, and resumes after reset", async () => {
    const settings = await getCollection<UserSettings>("user_settings");
    await settings.updateOne(
      { user_id: EMAIL },
      { $set: { notification_preferences: { categories: { workflow: false }, events: {} } } },
      { upsert: true },
    );

    expect(await publishNotificationEvent(envelope("a2"))).toBe("disabled");

    await settings.updateOne(
      { user_id: EMAIL },
      { $set: { notification_preferences: { categories: {}, events: {} } } },
    );
    expect(await publishNotificationEvent(envelope("a3"))).toBe("delivered");
  });

  it("keeps an explicit event opt-in even when its category is off", async () => {
    const settings = await getCollection<UserSettings>("user_settings");
    await settings.updateOne(
      { user_id: EMAIL },
      { $set: { notification_preferences: { categories: { workflow: false }, events: { "workflow.completed": true } } } },
    );
    expect(await publishNotificationEvent(envelope("a4"))).toBe("delivered");
  });
});
