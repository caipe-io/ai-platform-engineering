/** @jest-environment node */

import { resolveRecipients } from "@/lib/notifications/audience.server";
import { publishNotificationRequest } from "@/lib/notifications/fanout.server";
import { parseNotificationEventRequest } from "@/lib/notifications/request";

const mockFind = jest.fn();
const mockReadTuples = jest.fn();
const mockPublishEvent = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({
    find: (...args: unknown[]) => ({ toArray: async () => mockFind(...args) }),
  }),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadTuples(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:primary",
}));

jest.mock("@/lib/notifications/consumer.server", () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublishEvent(...args),
}));

const baseEvent = {
  id: "evt-1",
  type: "ingestion.completed",
  version: 1,
  occurred_at: "2026-10-14T10:00:00Z",
  resource: { type: "datasource", id: "datasource-example" },
  attempt_id: "job-1",
  data: { status: "completed", title: "Ingestion finished", summary: "Example source indexed." },
};

const alice = { email: "alice@example.com", keycloak_sub: "sub-alice" };
const bob = { email: "bob@example.com", metadata: { keycloak_sub: "sub-bob" } };

beforeEach(() => {
  jest.clearAllMocks();
  mockFind.mockResolvedValue([alice, bob]);
  mockReadTuples.mockResolvedValue({ tuples: [] });
  mockPublishEvent.mockResolvedValue("delivered");
});

describe("notification event request", () => {
  it("accepts an explicit recipient list", () => {
    const result = parseNotificationEventRequest({
      ...baseEvent,
      recipients: [{ email: "alice@example.com" }, { subject: "sub-bob" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.request.recipients).toHaveLength(2);
    expect(result.request.includeOrgAdmins).toBe(false);
  });

  it("accepts org admins alone", () => {
    expect(parseNotificationEventRequest({ ...baseEvent, include_org_admins: true }).ok).toBe(true);
  });

  it("still accepts the single recipient pair as a one-person list", () => {
    const result = parseNotificationEventRequest({
      ...baseEvent,
      recipient_subject: "sub-alice",
      recipient_email: "alice@example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.request.recipients).toEqual([{ subject: "sub-alice", email: "alice@example.com" }]);
  });

  it("rejects a request with no audience", () => {
    expect(parseNotificationEventRequest(baseEvent).ok).toBe(false);
    expect(parseNotificationEventRequest({ ...baseEvent, recipients: [] }).ok).toBe(false);
  });

  it("rejects more than 50 recipients", () => {
    const recipients = Array.from({ length: 51 }, (_, i) => ({ email: `user${i}@example.com` }));
    expect(parseNotificationEventRequest({ ...baseEvent, recipients }).ok).toBe(false);
  });

  it("rejects malformed recipients and flags", () => {
    expect(parseNotificationEventRequest({ ...baseEvent, recipients: [{}] }).ok).toBe(false);
    expect(parseNotificationEventRequest({ ...baseEvent, recipients: [{ email: 5 }] }).ok).toBe(false);
    expect(parseNotificationEventRequest({ ...baseEvent, recipients: "alice" }).ok).toBe(false);
    expect(parseNotificationEventRequest({ ...baseEvent, include_org_admins: "yes" }).ok).toBe(false);
  });

  it("rejects an invalid event even when the audience is valid", () => {
    const result = parseNotificationEventRequest({
      ...baseEvent,
      type: "billing.paid",
      include_org_admins: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("recipient resolution", () => {
  it("fills the missing identifier from the user records", async () => {
    const audience = await resolveRecipients(
      [{ email: "alice@example.com" }, { subject: "sub-bob" }],
      { includeOrgAdmins: false },
    );
    expect(audience.recipients).toEqual([
      { subject: "sub-alice", email: "alice@example.com" },
      { subject: "sub-bob", email: "bob@example.com" },
    ]);
    expect(audience.skipped).toBe(0);
  });

  it("skips people who cannot be resolved to both identifiers", async () => {
    mockFind.mockResolvedValue([]);
    const audience = await resolveRecipients([{ email: "stranger@example.com" }], {
      includeOrgAdmins: false,
    });
    expect(audience.recipients).toEqual([]);
    expect(audience.skipped).toBe(1);
  });

  it("de-duplicates the same person listed twice", async () => {
    const audience = await resolveRecipients(
      [{ email: "alice@example.com" }, { subject: "sub-alice" }],
      { includeOrgAdmins: false },
    );
    expect(audience.recipients).toHaveLength(1);
  });

  it("adds direct org admins and ignores team-based tuples", async () => {
    mockReadTuples.mockResolvedValue({
      tuples: [
        { key: { user: "user:sub-alice", relation: "admin", object: "organization:primary" } },
        { key: { user: "team:platform#admin", relation: "admin", object: "organization:primary" } },
      ],
    });
    const audience = await resolveRecipients([], { includeOrgAdmins: true });
    expect(audience.recipients).toEqual([{ subject: "sub-alice", email: "alice@example.com" }]);
    expect(mockReadTuples).toHaveBeenCalledWith(
      expect.objectContaining({ tuple: { relation: "admin", object: "organization:primary" } }),
    );
  });

  it("skips an org admin who has no user record", async () => {
    mockReadTuples.mockResolvedValue({
      tuples: [{ key: { user: "user:sub-unknown", relation: "admin", object: "organization:primary" } }],
    });
    mockFind.mockResolvedValue([]);
    const audience = await resolveRecipients([], { includeOrgAdmins: true });
    expect(audience.recipients).toEqual([]);
    expect(audience.skipped).toBe(1);
  });

  it("still returns explicit recipients when OpenFGA is unavailable", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockReadTuples.mockRejectedValue(new Error("OPENFGA_HTTP is not set"));
    const audience = await resolveRecipients([{ email: "alice@example.com" }], { includeOrgAdmins: true });
    expect(audience.recipients).toHaveLength(1);
    consoleError.mockRestore();
  });

  it("counts a person once when they are both listed and an org admin", async () => {
    mockReadTuples.mockResolvedValue({
      tuples: [{ key: { user: "user:sub-alice", relation: "admin", object: "organization:primary" } }],
    });
    const audience = await resolveRecipients([{ email: "alice@example.com" }], { includeOrgAdmins: true });
    expect(audience.recipients).toHaveLength(1);
  });
});

describe("fan-out", () => {
  const request = {
    base: baseEvent as Record<string, unknown>,
    recipients: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
    includeOrgAdmins: false,
  };

  it("publishes one event per recipient with that recipient's identifiers", async () => {
    const result = await publishNotificationRequest(request);

    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    expect(mockPublishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_subject: "sub-alice", recipient_email: "alice@example.com", id: "evt-1" }),
    );
    expect(mockPublishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_subject: "sub-bob", recipient_email: "bob@example.com" }),
    );
    expect(result.recipients).toBe(2);
    expect(result.results.delivered).toBe(2);
  });

  it("lets each recipient's own preferences decide, so one opt-out does not block others", async () => {
    mockPublishEvent.mockResolvedValueOnce("disabled").mockResolvedValueOnce("delivered");
    const result = await publishNotificationRequest(request);
    expect(result.results.disabled).toBe(1);
    expect(result.results.delivered).toBe(1);
  });

  it("reports failures per recipient without stopping the others", async () => {
    mockPublishEvent.mockResolvedValueOnce("failed").mockResolvedValueOnce("delivered");
    const result = await publishNotificationRequest(request);
    expect(result.results.failed).toBe(1);
    expect(result.results.delivered).toBe(1);
  });

  it("reports one failure and publishes nothing when recipients cannot be resolved", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockFind.mockRejectedValue(new Error("mongo unavailable"));
    const result = await publishNotificationRequest(request);
    expect(result.results.failed).toBe(1);
    expect(mockPublishEvent).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
