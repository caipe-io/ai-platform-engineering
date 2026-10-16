/** @jest-environment node */

import { createInAppNotification, listInAppNotifications } from "@/lib/in-app-notifications.server";

const mockGetCollection = jest.fn();

jest.mock("@/lib/mongodb", () => ({ getCollection: (...args: unknown[]) => mockGetCollection(...args) }));
jest.mock("@/lib/admin-notification-forwarding.server", () => ({
  forwardAdminNotificationToSlack: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/rbac/openfga", () => ({
  listOpenFgaObjects: jest.fn().mockResolvedValue({ objects: [] }),
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: false }),
}));
jest.mock("@/lib/rbac/organization", () => ({ organizationObjectId: () => "organization:primary" }));

function listCollection() {
  const toArray = jest.fn().mockResolvedValue([]);
  const cursor = { sort: () => cursor, skip: () => cursor, limit: () => cursor, toArray };
  return {
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockReturnValue(cursor),
  };
}

beforeEach(() => jest.clearAllMocks());

describe("inbox event_type", () => {
  it("stores the event type on a new entry", async () => {
    const updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    mockGetCollection.mockResolvedValue({ updateOne });

    await createInAppNotification({
      eventKey: "k1",
      recipientOrganizationAdmins: true,
      title: "Service degraded",
      message: "Detail",
      eventType: "service.degraded",
    });

    const update = updateOne.mock.calls[0][1] as { $setOnInsert: Record<string, unknown> };
    expect(update.$setOnInsert.event_type).toBe("service.degraded");
  });

  it("omits event_type when none is given, so older producers are unchanged", async () => {
    const updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    mockGetCollection.mockResolvedValue({ updateOne });

    await createInAppNotification({ eventKey: "k2", recipientUserSubjects: ["s"], title: "t", message: "m" });

    const update = updateOne.mock.calls[0][1] as { $setOnInsert: Record<string, unknown> };
    expect(update.$setOnInsert).not.toHaveProperty("event_type");
  });

  it("sets an expiry date when a retention period is given", async () => {
    const updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    mockGetCollection.mockResolvedValue({ updateOne });
    const before = Date.now();

    await createInAppNotification({
      eventKey: "k3", recipientUserSubjects: ["s"], title: "t", message: "m", retentionDays: 30,
    });

    const update = updateOne.mock.calls[0][1] as { $setOnInsert: { expires_at: Date } };
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    expect(update.$setOnInsert.expires_at).toBeInstanceOf(Date);
    expect(Math.abs(update.$setOnInsert.expires_at.getTime() - expected)).toBeLessThan(5000);
  });

  it("sets no expiry without a retention period, so platform incidents never expire", async () => {
    const updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    mockGetCollection.mockResolvedValue({ updateOne });

    await createInAppNotification({ eventKey: "k4", recipientOrganizationAdmins: true, title: "t", message: "m" });

    const update = updateOne.mock.calls[0][1] as { $setOnInsert: Record<string, unknown> };
    expect(update.$setOnInsert).not.toHaveProperty("expires_at");
  });

  it("filters excluded event types from the list and the unread count", async () => {
    const collection = listCollection();
    mockGetCollection.mockResolvedValue(collection);

    await listInAppNotifications("subject-example", { excludedEventTypes: ["service.recovered"] });

    const audience = collection.countDocuments.mock.calls[0][0] as Record<string, unknown>;
    expect(audience.event_type).toEqual({ $nin: ["service.recovered"] });
    const unreadQuery = JSON.stringify(collection.countDocuments.mock.calls[1][0]);
    expect(unreadQuery).toContain("service.recovered");
  });

  it("applies no event filter when nothing is excluded", async () => {
    const collection = listCollection();
    mockGetCollection.mockResolvedValue(collection);

    await listInAppNotifications("subject-example", { excludedEventTypes: [] });

    const audience = collection.countDocuments.mock.calls[0][0] as Record<string, unknown>;
    expect(audience).not.toHaveProperty("event_type");
  });
});
