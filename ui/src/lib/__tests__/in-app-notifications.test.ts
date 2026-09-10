/** @jest-environment node */

import {
  createInAppNotification,
  listInAppNotifications,
  markInAppNotificationRead,
} from "@/lib/in-app-notifications.server";
import type { InAppNotificationDocument } from "@/types/in-app-notification";

const mockGetCollection = jest.fn();
const mockListOpenFgaObjects = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:primary",
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockListOpenFgaObjects.mockResolvedValue({ objects: ["team:reviewers"] });
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
});

it("creates one durable notification per event", async () => {
  const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
  mockGetCollection.mockResolvedValue({ updateOne });

  await createInAppNotification({
    eventKey: "publication:request-primary:approved",
    recipientUserSubjects: ["requester-subject", "requester-subject"],
    title: "Request approved",
    message: "Primary source was approved.",
    href: "/admin?cat=security&tab=approvals&view=history",
    severity: "success",
  });

  expect(updateOne).toHaveBeenCalledWith(
    { event_key: "publication:request-primary:approved" },
    expect.objectContaining({
      $setOnInsert: expect.objectContaining({
        recipient_user_subjects: ["requester-subject"],
        recipient_team_slugs: [],
        recipient_organization_admins: false,
        severity: "success",
        read_by_subjects: [],
      }),
    }),
    { upsert: true },
  );
});

it("paginates direct, team, and organization-admin notifications", async () => {
  const rows: InAppNotificationDocument[] = [{
    _id: "notification-primary",
    event_key: "publication:request-primary:rejected",
    recipient_user_subjects: ["requester-subject"],
    recipient_team_slugs: [],
    recipient_organization_admins: false,
    title: "Request rejected",
    message: "Primary source was rejected.",
    severity: "error",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    read_by_subjects: [],
  }];
  const cursor = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue(rows),
  };
  const collection = {
    countDocuments: jest.fn()
      .mockResolvedValueOnce(21)
      .mockResolvedValueOnce(3),
    find: jest.fn().mockReturnValue(cursor),
  };
  mockGetCollection.mockResolvedValue(collection);

  const result = await listInAppNotifications("requester-subject", {
    page: 2,
    pageSize: 20,
  });

  expect(collection.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
    $or: expect.arrayContaining([
      { recipient_user_subjects: "requester-subject" },
      { recipient_team_slugs: { $in: ["reviewers"] } },
      { recipient_organization_admins: true },
      { recipient_platform_users: true },
    ]),
  }));
  expect(cursor.skip).toHaveBeenCalledWith(20);
  expect(cursor.limit).toHaveBeenCalledWith(20);
  expect(result).toMatchObject({
    unread_count: 3,
    pagination: { page: 2, page_size: 20, total: 21, total_pages: 2 },
    notifications: [{ id: "notification-primary", read: false }],
  });
});

it("creates a global Platform notification without changing personal audiences",async () => {
  const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
  mockGetCollection.mockResolvedValue({ updateOne });

  await createInAppNotification({
    eventKey: "platform-health:chat-runtime:incident-primary:opened",
    recipientPlatformUsers: true,
    title: "Chat Runtime is degraded",
    message: "Two health audits reported a degraded runtime.",
    severity: "warning",
    category: "platform_health",
    sourceLabel: "Platform",
    lifecycleStatus: "active",
  });

  expect(updateOne).toHaveBeenCalledWith(
    { event_key: "platform-health:chat-runtime:incident-primary:opened" },
    expect.objectContaining({
      $setOnInsert: expect.objectContaining({
        recipient_user_subjects: [],
        recipient_team_slugs: [],
        recipient_platform_users: true,
        category: "platform_health",
        source_label: "Platform",
        lifecycle_status: "active",
      }),
    }),
    { upsert: true },
  );
});

it("excludes Platform health notifications when an admin viewer opted out",async () => {
  const cursor = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  const collection = {
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockReturnValue(cursor),
  };
  mockGetCollection.mockResolvedValue(collection);

  await listInAppNotifications("requester-subject",{
    includePlatformNotifications: false,
  });

  const audience = collection.countDocuments.mock.calls[0][0];
  expect(audience.category).toEqual({ $ne: "platform_health" });
  expect(audience.$or).toEqual(expect.arrayContaining([
    { recipient_user_subjects: "requester-subject" },
    { recipient_team_slugs: { $in: ["reviewers"] } },
    { recipient_organization_admins: true },
    { recipient_platform_users: true },
  ]));
});

it("marks only a notification in the viewer's audience as read", async () => {
  const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
  mockGetCollection.mockResolvedValue({ updateOne });

  await expect(markInAppNotificationRead(
    "requester-subject",
    "notification-primary",
  )).resolves.toBe(true);

  expect(updateOne).toHaveBeenCalledWith(
    expect.objectContaining({
      $and: expect.arrayContaining([{ _id: "notification-primary" }]),
    }),
    expect.objectContaining({
      $addToSet: { read_by_subjects: "requester-subject" },
    }),
  );
});
