/** @jest-environment node */

import { platformHealthNotificationsEnabled } from "@/lib/notification-preferences.server";

const mockGetCollection = jest.fn();

jest.mock("@/lib/mongodb",() => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

it("defaults platform health notifications to enabled",async () => {
  mockGetCollection.mockResolvedValue({
    findOne: jest.fn().mockResolvedValue(null),
  });

  await expect(platformHealthNotificationsEnabled("user@example.com")).resolves.toBe(true);
});

it("honors a user's platform health opt-out",async () => {
  mockGetCollection.mockResolvedValue({
    findOne: jest.fn().mockResolvedValue({
      user_id: "user@example.com",
      notifications: { platform_health: false },
    }),
  });

  await expect(platformHealthNotificationsEnabled("user@example.com")).resolves.toBe(false);
});
