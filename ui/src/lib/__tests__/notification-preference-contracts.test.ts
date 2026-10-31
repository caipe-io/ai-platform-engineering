/** @jest-environment node */
import { isNotificationEnabled, mergeNotificationPreferences, parseNotificationPreferencePatch } from "@/lib/notifications/preferences";

describe("notification preference resolution", () => {
  it("uses the catalog default when no preference is stored", () => {
    expect(isNotificationEnabled("workflow.completed", null)).toBe(true);
    expect(isNotificationEnabled("workflow.started", null)).toBe(false);
  });

  it("lets a category override the default", () => {
    const prefs = { categories: { workflow: false } };
    expect(isNotificationEnabled("workflow.completed", prefs)).toBe(false);
    expect(isNotificationEnabled("agent.completed", prefs)).toBe(true);
  });

  it("lets an explicit event setting win over its category", () => {
    const prefs = {
      categories: { workflow: false },
      events: { "workflow.completed": true },
    };
    expect(isNotificationEnabled("workflow.completed", prefs)).toBe(true);
    expect(isNotificationEnabled("workflow.failed", prefs)).toBe(false);
  });

  it("returns the same result for repeated identical preferences", () => {
    const prefs = { events: { "ingestion.started": true } };
    expect(isNotificationEnabled("ingestion.started", prefs)).toBe(true);
    expect(isNotificationEnabled("ingestion.started", prefs)).toBe(true);
  });
});

describe("preference patch validation", () => {
  it("accepts known categories and events with boolean values", () => {
    const result = parseNotificationPreferencePatch({
      categories: { workflow: false },
      events: { "agent.failed": true },
    });
    expect(result).toEqual({
      ok: true,
      patch: { categories: { workflow: false }, events: { "agent.failed": true } },
    });
  });

  it("rejects unknown sections, keys, and non-boolean values", () => {
    expect(parseNotificationPreferencePatch({ admin: {} }).ok).toBe(false);
    expect(parseNotificationPreferencePatch({ categories: { billing: true } }).ok).toBe(false);
    expect(parseNotificationPreferencePatch({ events: { "workflow.completed": "yes" } }).ok).toBe(false);
    expect(parseNotificationPreferencePatch([]).ok).toBe(false);
    expect(parseNotificationPreferencePatch(null).ok).toBe(false);
  });
});

describe("preference merge", () => {
  it("sets an override and keeps other overrides", () => {
    const merged = mergeNotificationPreferences(
      { categories: { workflow: false }, events: { "agent.failed": true } },
      { events: { "workflow.completed": false } },
    );
    expect(merged).toEqual({
      categories: { workflow: false },
      events: { "agent.failed": true, "workflow.completed": false },
    });
  });

  it("removes an override when the patch value is null, returning to the default", () => {
    const current = { events: { "workflow.completed": false } };
    const merged = mergeNotificationPreferences(current, { events: { "workflow.completed": null } });
    expect(merged.events).toEqual({});
    expect(isNotificationEnabled("workflow.completed", merged)).toBe(true);
    // The stored input is not mutated.
    expect(current.events).toEqual({ "workflow.completed": false });
  });

  it("accepts null in a patch and rejects other non-boolean values", () => {
    expect(parseNotificationPreferencePatch({ events: { "agent.failed": null } }).ok).toBe(true);
    expect(parseNotificationPreferencePatch({ events: { "agent.failed": 0 } }).ok).toBe(false);
  });

  it("is idempotent: applying the same patch twice gives the same result", () => {
    const patch = { categories: { ingestion: true } };
    const once = mergeNotificationPreferences(null, patch);
    const twice = mergeNotificationPreferences(once, patch);
    expect(twice).toEqual(once);
  });
});

