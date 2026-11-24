/** @jest-environment node */

import { NextRequest } from "next/server";
import { PATCH } from "./route";

const mockWrite = jest.fn();
const mockRead = jest.fn();
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
  readSubscription: (...args: unknown[]) => mockRead(...args),
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
  mockRead.mockReset().mockResolvedValue(null);
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

it("rejects an unavailable channel in a scoped patch before saving", async () => {
  expect((await patch({ channels: { web_push: true }, enabled: true })).status).toBe(400);
  expect(mockUpdatePreferences).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
});

it("allows a scoped opt-out when the channel is unavailable", async () => {
  expect((await patch({ channels: { web_push: false } })).status).toBe(200);
  expect(mockWrite).toHaveBeenCalledWith("example-user", "platform", "workflow.failed", { channels: { web_push: false } });
});

it("reenables an explicitly disabled platform event and its legacy preference", async () => {
  mockRead.mockResolvedValue({ enabled: false });
  expect((await patch({ enabled: true })).status).toBe(200);
  expect(mockUpdatePreferences).toHaveBeenCalledWith("example@example.test", {
    events: { "workflow.failed": true },
  });
  expect(mockWrite).toHaveBeenCalledWith("example-user", "platform", "workflow.failed", { enabled: true });
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
