/** @jest-environment node */

import { inboxViewOptions, platformHealthNotificationsEnabled } from "@/lib/notification-preferences.server";

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

describe("inboxViewOptions",() => {
  function settingsDoc(doc: unknown) {
    mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue(doc) });
  }

  it("hides nothing for a user with no saved preferences",async () => {
    settingsDoc(null);
    await expect(inboxViewOptions("user@example.com")).resolves.toEqual({
      includePlatformNotifications: true,
      excludedEventTypes: [],
    });
  });

  it("hides only the shared service events the user turned off",async () => {
    settingsDoc({ notification_preferences: { events: { "service.recovered": false } } });
    const options = await inboxViewOptions("user@example.com");
    expect(options.excludedEventTypes).toEqual(["service.recovered"]);
  });

  it("hides both service events when the platform category is off",async () => {
    settingsDoc({ notification_preferences: { categories: { platform: false } } });
    const options = await inboxViewOptions("user@example.com");
    expect(options.excludedEventTypes).toEqual(["service.degraded","service.recovered"]);
  });

  it("lets an explicit event opt-in win over its category",async () => {
    settingsDoc({
      notification_preferences: {
        categories: { platform: false },
        events: { "service.degraded": true },
      },
    });
    const options = await inboxViewOptions("user@example.com");
    expect(options.excludedEventTypes).toEqual(["service.recovered"]);
  });

  it("still honors the older platform health switch",async () => {
    settingsDoc({ notifications: { platform_health: false } });
    const options = await inboxViewOptions("user@example.com");
    expect(options.includePlatformNotifications).toBe(false);
  });

  it("returns defaults without reading settings when no email is available",async () => {
    mockGetCollection.mockClear();
    await expect(inboxViewOptions("  ")).resolves.toEqual({
      includePlatformNotifications: true,
      excludedEventTypes: [],
    });
    expect(mockGetCollection).not.toHaveBeenCalled();
  });
});
