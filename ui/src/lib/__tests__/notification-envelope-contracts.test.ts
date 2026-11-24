/** @jest-environment node */
import { notificationEventKey, parseNotificationEnvelope } from "@/lib/notifications/envelope";
import { parseNotificationEventRequest } from "@/lib/notifications/request";
const baseEvent = {
  id: "evt-1",
  type: "workflow.completed",
  version: 1,
  occurred_at: "2026-10-14T10:00:00Z",
  resource: { type: "workflow_run", id: "run-1" },
  attempt_id: "attempt-1",
  correlation_id: "corr-1",
  data: {
    status: "completed",
    title: "Workflow finished",
    summary: "Daily report completed.",
    href: "/workflows/run-1",
  },
};
const validEnvelope = {
  ...baseEvent,
  recipient_subject: "subject-1",
  recipient_email: "test-user@example.com",
};

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

  it("normalizes callbackUri to the existing destination without losing query or fragment", () => {
    const callbackUri = "/projects/example/wiki/overview.md?view=changes#decision-42";
    const result = parseNotificationEnvelope({ ...validEnvelope, data: { ...validEnvelope.data, href: undefined, callbackUri } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.data.href).toBe(callbackUri);
    expect(parseNotificationEnvelope({ ...validEnvelope, data: { ...validEnvelope.data, callbackUri } }).ok).toBe(false);
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

describe("event request recipients", () => {
  const overlong = "x".repeat(201);

  it.each([
    { recipients: [{ subject: overlong }] },
    { recipients: [{ email: overlong }] },
    { recipient_subject: overlong },
    { recipient_email: overlong },
  ])("rejects an oversized recipient before lookup", (recipientFields) => {
    expect(parseNotificationEventRequest({ ...baseEvent, ...recipientFields }).ok).toBe(false);
  });

  it("accepts and trims a recipient at the 200-character limit", () => {
    const subject = "x".repeat(200);
    expect(parseNotificationEventRequest({
      ...baseEvent,
      recipients: [{ subject: ` ${subject} ` }],
    })).toMatchObject({ ok: true, request: { recipients: [{ subject }] } });
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

  it("keeps delimiter-containing and literal escape sequences distinct", () => {
    const keys = [
      { id: "run:retry", attempt: "1" },
      { id: "run", attempt: "retry:1" },
      { id: "run%3Aretry", attempt: "1" },
    ].map(({ id, attempt }) => {
      const parsed = parseNotificationEnvelope({
        ...validEnvelope,
        resource: { ...validEnvelope.resource, id },
        attempt_id: attempt,
      });
      if (!parsed.ok) throw new Error("fixture should parse");
      const key = notificationEventKey(parsed.envelope, parsed.envelope.recipient_subject);
      expect(notificationEventKey(parsed.envelope, parsed.envelope.recipient_subject)).toBe(key);
      return key;
    });
    expect(new Set(keys).size).toBe(keys.length);
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
