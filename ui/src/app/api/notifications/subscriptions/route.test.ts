/** @jest-environment node */

import { NextRequest } from "next/server";
import { PATCH } from "./route";

const mockWrite = jest.fn();
const mockUpdatePreferences = jest.fn();

jest.mock("@/lib/notifications/request-user.server", () => ({
  notificationUser: async () => ({
    subject: "example-user",
    session: { role: "user" },
    user: { role: "user", email: "example@example.test" },
  }),
}));
jest.mock("@/lib/notifications/subscriptions.server", () => ({
  ...jest.requireActual("@/lib/notifications/subscriptions.server"),
  listNotificationSources: async () => [{
    id: "platform",
    events: [{ id: "workflow.failed" }],
  }],
  writeSubscription: (...args: unknown[]) => mockWrite(...args),
}));
jest.mock("@/lib/notifications/preferences.server", () => ({
  updateNotificationPreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
}));

const patch = (body: Record<string, unknown>) =>
  PATCH(new NextRequest("https://host.example.test/api/notifications/subscriptions", {
    method: "PATCH",
    body: JSON.stringify({ sourceId: "platform", eventType: "workflow.failed", ...body }),
  }));

beforeEach(() => {
  mockWrite.mockReset().mockResolvedValue(undefined);
  mockUpdatePreferences.mockReset().mockResolvedValue(undefined);
});

it("rejects an invalid mixed patch before either write", async () => {
  const response = await patch({
    enabled: false,
    quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "not-a-zone" },
  });
  expect(response.status).toBe(400);
  expect(mockUpdatePreferences).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
});

it("reports a partial save if the subscription write fails after the preference saved", async () => {
  mockWrite.mockRejectedValue(new Error("database unavailable"));
  const response = await patch({ enabled: false, pausedUntil: null });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual(expect.objectContaining({
    code: "NOTIFICATION_SUBSCRIPTION_PARTIAL_SAVE",
  }));
  expect(mockUpdatePreferences).toHaveBeenCalledWith(
    "example@example.test",
    { events: { "workflow.failed": false } },
  );
  expect(mockWrite).toHaveBeenCalledWith("example-user", "platform", "workflow.failed", { pausedUntil: null });
});
