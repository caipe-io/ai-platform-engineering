/** @jest-environment node */

import {
  notificationEventKey,
  parseNotificationEnvelope,
} from "@/lib/notifications/envelope";
import {
  isNotificationEnabled,
  mergeNotificationPreferences,
  parseNotificationPreferencePatch,
} from "@/lib/notifications/preferences";
import { notificationRetentionDays, publishNotificationEvent } from "@/lib/notifications/consumer.server";
import { NOTIFICATION_EVENT_CATALOG } from "@/lib/notifications/taxonomy";

const mockGetCollection = jest.fn();
const mockCreateInAppNotification = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/in-app-notifications.server", () => ({
  createInAppNotification: (...args: unknown[]) => mockCreateInAppNotification(...args),
}));

const validEnvelope = {
  id: "evt-1",
  type: "workflow.completed",
  version: 1,
  occurred_at: "2026-10-14T10:00:00Z",
  resource: { type: "workflow_run", id: "run-1" },
  attempt_id: "attempt-1",
  recipient_subject: "subject-1",
  recipient_email: "test-user@example.com",
  correlation_id: "corr-1",
  data: {
    status: "completed",
    title: "Workflow finished",
    summary: "Daily report completed.",
    href: "/workflows/run-1",
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateInAppNotification.mockResolvedValue(undefined);
  mockGetCollection.mockResolvedValue({
    findOne: jest.fn().mockResolvedValue(null),
  });
});

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

describe("envelope validation", () => {
  it("accepts a well-formed envelope and drops unknown fields", () => {
    const result = parseNotificationEnvelope({
      ...validEnvelope,
      prompt: "should never be stored",
      data: { ...validEnvelope.data, tool_output: "secret" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope).not.toHaveProperty("prompt");
    expect(result.envelope.data).not.toHaveProperty("tool_output");
  });

  it("rejects unknown event types", () => {
    const result = parseNotificationEnvelope({ ...validEnvelope, type: "billing.paid" });
    expect(result.ok).toBe(false);
  });

  it("rejects external hrefs", () => {
    const result = parseNotificationEnvelope({
      ...validEnvelope,
      data: { ...validEnvelope.data, href: "https://attacker.example.com" },
    });
    expect(result.ok).toBe(false);
    const protocolRelative = parseNotificationEnvelope({
      ...validEnvelope,
      data: { ...validEnvelope.data, href: "//attacker.example.com" },
    });
    expect(protocolRelative.ok).toBe(false);
  });

  it("rejects missing recipient, bad timestamps, and oversized summaries", () => {
    expect(parseNotificationEnvelope({ ...validEnvelope, recipient_subject: "" }).ok).toBe(false);
    expect(parseNotificationEnvelope({ ...validEnvelope, occurred_at: "yesterday" }).ok).toBe(false);
    expect(
      parseNotificationEnvelope({
        ...validEnvelope,
        data: { ...validEnvelope.data, summary: "x".repeat(501) },
      }).ok,
    ).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(parseNotificationEnvelope(null).ok).toBe(false);
    expect(parseNotificationEnvelope("workflow.completed").ok).toBe(false);
  });
});

describe("event key", () => {
  it("is stable for redelivery of the same attempt", () => {
    const parsed = parseNotificationEnvelope(validEnvelope);
    if (!parsed.ok) throw new Error("fixture should parse");
    const first = notificationEventKey(parsed.envelope, "test-user@example.com");
    const second = notificationEventKey(parsed.envelope, "test-user@example.com");
    expect(first).toBe(second);
  });

  it("differs for a retry of the same resource", () => {
    const parsed = parseNotificationEnvelope(validEnvelope);
    const retry = parseNotificationEnvelope({ ...validEnvelope, attempt_id: "attempt-2" });
    if (!parsed.ok || !retry.ok) throw new Error("fixtures should parse");
    expect(notificationEventKey(parsed.envelope, "test-user@example.com")).not.toBe(
      notificationEventKey(retry.envelope, "test-user@example.com"),
    );
  });
});

describe("publishNotificationEvent", () => {
  it("writes an inbox entry using the catalog severity and a deterministic key", async () => {
    const outcome = await publishNotificationEvent(validEnvelope);

    expect(outcome).toBe("delivered");
    expect(mockCreateInAppNotification).toHaveBeenCalledWith({
      eventKey: "workflow.completed:workflow_run:run-1:attempt-1:subject-1",
      recipientUserSubjects: ["subject-1"],
      title: "Workflow finished",
      message: "Daily report completed.",
      href: "/workflows/run-1",
      severity: NOTIFICATION_EVENT_CATALOG["workflow.completed"].severity,
      category: "general",
      sourceLabel: "workflow",
      correlationKey: "corr-1",
      eventType: "workflow.completed",
      retentionDays: 90,
    });
  });

  it("skips delivery when the recipient turned the event off", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        notification_preferences: { categories: { workflow: false } },
      }),
    });

    const outcome = await publishNotificationEvent(validEnvelope);

    expect(outcome).toBe("disabled");
    expect(mockCreateInAppNotification).not.toHaveBeenCalled();
  });

  it("does not let one user's preferences affect another user", async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    mockGetCollection.mockResolvedValue({ findOne });

    await publishNotificationEvent(validEnvelope);

    expect(findOne).toHaveBeenCalledWith(
      { user_id: "test-user@example.com" },
      { projection: { notification_preferences: 1 } },
    );
  });

  it("keys preferences by email and the inbox audience by subject", async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    mockGetCollection.mockResolvedValue({ findOne });

    await publishNotificationEvent(validEnvelope);

    expect(findOne).toHaveBeenCalledWith(
      { user_id: "test-user@example.com" },
      expect.anything(),
    );
    expect(mockCreateInAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserSubjects: ["subject-1"] }),
    );
  });

  it("rejects an envelope with no recipient email", async () => {
    const outcome = await publishNotificationEvent({
      ...validEnvelope,
      recipient_email: undefined,
    });
    expect(outcome).toBe("invalid");
    expect(mockCreateInAppNotification).not.toHaveBeenCalled();
  });

  it("is a no-op when the operator disables event notifications", async () => {
    const previous = process.env.NOTIFICATION_EVENTS_ENABLED;
    process.env.NOTIFICATION_EVENTS_ENABLED = "false";
    try {
      const outcome = await publishNotificationEvent(validEnvelope);
      expect(outcome).toBe("disabled");
      expect(mockGetCollection).not.toHaveBeenCalled();
      expect(mockCreateInAppNotification).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.NOTIFICATION_EVENTS_ENABLED;
      else process.env.NOTIFICATION_EVENTS_ENABLED = previous;
    }
  });

  it("returns invalid without touching storage for a malformed envelope", async () => {
    const outcome = await publishNotificationEvent({ ...validEnvelope, type: "unknown.event" });

    expect(outcome).toBe("invalid");
    expect(mockGetCollection).not.toHaveBeenCalled();
    expect(mockCreateInAppNotification).not.toHaveBeenCalled();
  });

  it("never throws when storage fails, so the producing job is unaffected", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockCreateInAppNotification.mockRejectedValue(new Error("mongo unavailable"));

    await expect(publishNotificationEvent(validEnvelope)).resolves.toBe("failed");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("notification retention", () => {
  const previous = process.env.NOTIFICATION_RETENTION_DAYS;
  afterEach(() => {
    if (previous === undefined) delete process.env.NOTIFICATION_RETENTION_DAYS;
    else process.env.NOTIFICATION_RETENTION_DAYS = previous;
  });

  it("defaults to 90 days", () => {
    delete process.env.NOTIFICATION_RETENTION_DAYS;
    expect(notificationRetentionDays()).toBe(90);
  });

  it("uses a configured number of days", () => {
    process.env.NOTIFICATION_RETENTION_DAYS = "30";
    expect(notificationRetentionDays()).toBe(30);
  });

  it("keeps entries forever when set to 0", () => {
    process.env.NOTIFICATION_RETENTION_DAYS = "0";
    expect(notificationRetentionDays()).toBeUndefined();
  });

  it.each(["abc", "-5", "1.5", "99999", ""])("falls back to the default for %p", (value) => {
    process.env.NOTIFICATION_RETENTION_DAYS = value;
    expect(notificationRetentionDays()).toBe(90);
  });

  it("passes the configured retention to the inbox write", async () => {
    process.env.NOTIFICATION_RETENTION_DAYS = "7";
    await publishNotificationEvent(validEnvelope);
    expect(mockCreateInAppNotification).toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 7 }));
  });
});
