/** @jest-environment node */

import { updateNotificationPreferences } from "@/lib/notifications/preferences.server";
import { createFakeUserSettings, DuplicateKeyError } from "@/lib/notifications/testing/fake-user-settings";

let fake = createFakeUserSettings();
let barrier: { arrive: () => Promise<void> } | null = null;

jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => fake.collection,
}));

const USER = "alice@example.com";

/** Holds the first `count` readers until all have read, so they see the same revision. */
function makeBarrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived === count) release();
      if (arrived <= count) await gate;
    },
  };
}

function stored() {
  return fake.docs.get(USER) as
    | { notification_preferences: { events: Record<string, boolean>; categories: Record<string, boolean> }; notification_preferences_rev: number }
    | undefined;
}

beforeEach(() => {
  barrier = null;
  fake = createFakeUserSettings({ beforeFindResolves: async () => barrier?.arrive() });
});

describe("updateNotificationPreferences", () => {
  it("creates the document at revision 1 for a new user", async () => {
    const result = await updateNotificationPreferences(USER, { events: { "workflow.failed": false } });

    expect(result.events).toEqual({ "workflow.failed": false });
    expect(stored()?.notification_preferences_rev).toBe(1);
  });

  it("increments the revision on every write", async () => {
    await updateNotificationPreferences(USER, { events: { "workflow.failed": false } });
    await updateNotificationPreferences(USER, { events: { "agent.failed": false } });
    expect(stored()?.notification_preferences_rev).toBe(2);
  });

  it("adopts a document written before revisions existed", async () => {
    fake.docs.set(USER, { user_id: USER, notification_preferences: { categories: {}, events: { "agent.failed": false } } });

    const result = await updateNotificationPreferences(USER, { events: { "workflow.failed": false } });

    expect(result.events).toEqual({ "agent.failed": false, "workflow.failed": false });
    expect(stored()?.notification_preferences_rev).toBe(1);
  });

  it("keeps both changes when two updates are based on the same revision", async () => {
    await updateNotificationPreferences(USER, { events: { "agent.completed": true } });
    barrier = makeBarrier(2);

    await Promise.all([
      updateNotificationPreferences(USER, { events: { "workflow.failed": false } }),
      updateNotificationPreferences(USER, { events: { "ingestion.failed": false } }),
    ]);

    expect(stored()?.notification_preferences.events).toEqual({
      "agent.completed": true,
      "workflow.failed": false,
      "ingestion.failed": false,
    });
    expect(stored()?.notification_preferences_rev).toBe(3);
  });

  it("does not restore a disabled notification when a stale writer edits another event", async () => {
    await updateNotificationPreferences(USER, { events: { "workflow.completed": true } });
    barrier = makeBarrier(2);

    await Promise.all([
      updateNotificationPreferences(USER, { events: { "workflow.completed": false } }),
      updateNotificationPreferences(USER, { events: { "agent.failed": false } }),
    ]);

    const events = stored()?.notification_preferences.events;
    expect(events?.["workflow.completed"]).toBe(false);
    expect(events?.["agent.failed"]).toBe(false);
  });

  it("keeps both changes when two first-time writers race to create the document", async () => {
    barrier = makeBarrier(2);

    await Promise.all([
      updateNotificationPreferences(USER, { events: { "workflow.failed": false } }),
      updateNotificationPreferences(USER, { categories: { agent: false } }),
    ]);

    expect(stored()?.notification_preferences.events).toEqual({ "workflow.failed": false });
    expect(stored()?.notification_preferences.categories).toEqual({ agent: false });
    expect(stored()?.notification_preferences_rev).toBe(2);
  });

  it("survives several simultaneous writers, each editing a different event", async () => {
    const types = ["workflow.failed", "workflow.completed", "agent.failed", "ingestion.failed"] as const;
    barrier = makeBarrier(types.length);

    await Promise.all(types.map((type) => updateNotificationPreferences(USER, { events: { [type]: false } })));

    expect(Object.keys(stored()?.notification_preferences.events ?? {}).sort()).toEqual([...types].sort());
  });

  it("returns an explicit conflict after bounded retries when the document keeps changing", async () => {
    const updateOne = jest.spyOn(fake.collection, "updateOne").mockRejectedValue(new DuplicateKeyError("E11000"));

    await expect(updateNotificationPreferences(USER, { events: { "workflow.failed": false } })).rejects.toMatchObject({
      statusCode: 409,
      code: "PREFERENCES_CONFLICT",
    });
    expect(updateOne).toHaveBeenCalledTimes(8);
  });

  it("does not swallow unrelated storage errors", async () => {
    jest.spyOn(fake.collection, "updateOne").mockRejectedValue(new Error("connection lost"));
    await expect(updateNotificationPreferences(USER, { events: { "workflow.failed": false } })).rejects.toThrow("connection lost");
  });

  it("is idempotent: the same patch twice leaves the same preferences", async () => {
    const patch = { events: { "workflow.failed": false as const } };
    await updateNotificationPreferences(USER, patch);
    const first = JSON.stringify(stored()?.notification_preferences);
    await updateNotificationPreferences(USER, patch);
    expect(JSON.stringify(stored()?.notification_preferences)).toBe(first);
  });
});
