/** @jest-environment node */
import {
  notificationCallbackPath,
  notificationCallbackUri,
} from "@/lib/notifications/callback";
import {
  absoluteNotificationCallback,
  resolveNotificationCallback,
} from "@/lib/notifications/callback.server";
import { sendExternalNotification } from "@/lib/notifications/adapters.server";
import { sendSlackNotification } from "@/lib/notifications/slack.server";
import { sendWebexNotification } from "@/lib/notifications/webex.server";
import type { NotificationDelivery } from "@/lib/notifications/delivery-types";

const mockFind = jest.fn();
const mockApp = jest.fn();
const mockPush = jest.fn();
const mockSlack = jest.fn();
const mockWebex = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: async (name: string) => ({
    findOne: (query: unknown) => mockFind(name, query),
  }),
}));
jest.mock("@/lib/agentic-apps/config", () => ({
  getConfiguredAgenticApp: (...args: unknown[]) => mockApp(...args),
}));
jest.mock("@/lib/notifications/web-push.server", () => ({
  sendBrowserPush: (...args: unknown[]) => mockPush(...args),
}));
jest.mock("@/lib/notifications/destinations.server", () => ({
  linkedNotificationAccounts: async () => ({
    slack: "example-slack-user",
    webex: "example-webex-user",
  }),
}));
jest.mock("@/lib/slack-bot-admin", () => ({
  callSlackBotAdmin: (...args: unknown[]) => mockSlack(...args),
}));
jest.mock("@/lib/webex-bot-admin", () => ({
  callWebexBotAdmin: (...args: unknown[]) => mockWebex(...args),
}));

const marker = "a".repeat(64);
const target =
  "/projects/example/wiki/overview.md?view=changes&item=example%20item#decision-42";
const originalEnv = { ...process.env };
const delivery = {
  _id: marker,
  notificationId: "example-job",
  channel: "web_push",
  sourceId: "platform",
  recipient: { subject: "test-user", email: "test-user@example.test" },
  href: target,
  title: "Example title",
  message: "Example update",
  targetId: "example-device",
} as NotificationDelivery;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXTAUTH_URL = "https://host.example.test";
  process.env.NOTIFICATION_SLACK_ENABLED = "true";
  process.env.NOTIFICATION_WEBEX_ENABLED = "true";
  mockFind.mockResolvedValue(delivery);
  mockApp.mockReturnValue({
    installation: { installed: true, enabled: true },
    manifest: { access: { requiredRoles: ["user"] } },
  });
});
afterEach(() => {
  process.env = { ...originalEnv };
});

it("accepts callbackUri and legacy href without losing query parameters or anchors", () => {
  expect(notificationCallbackUri(target)).toBe(target);
  expect(notificationCallbackUri(undefined, target)).toBe(target);
  expect(notificationCallbackUri(target, target)).toBe(target);
  expect(() => notificationCallbackUri(target, "/chat")).toThrow(
    "same destination",
  );
});
it.each([
  "https://other.example.test",
  "//other.example.test",
  "/\\other.example.test",
  "javascript:alert(1)",
  "/\n/other.example.test",
  "",
  "x".repeat(501),
])("rejects unsafe callbacks: %s", (value) => {
  expect(() => notificationCallbackUri(value)).toThrow();
});
it("returns only a recipient-bound marker in outbound links", () => {
  expect(notificationCallbackPath(marker)).toBe(
    `/notifications/open/${marker}`,
  );
  const uri = absoluteNotificationCallback(marker);
  expect(uri).toBe(`https://host.example.test/notifications/open/${marker}`);
  expect(uri).not.toMatch(/projects|test-user|view=/);
});
it("fails closed when the public origin is missing", () => {
  delete process.env.NEXTAUTH_URL;
  expect(() => absoluteNotificationCallback(marker)).toThrow("NEXTAUTH_URL");
});
it("resolves the exact destination only for the signed-in recipient and before expiry", async () => {
  expect(
    await resolveNotificationCallback(marker, "test-user", { role: "user" }),
  ).toBe(target);
  expect(mockFind).toHaveBeenCalledWith("notification_deliveries", {
    _id: marker,
    "recipient.subject": "test-user",
    expiresAt: { $gt: expect.any(Date) },
  });
});
it("keeps a retained personal inbox callback usable after the delivery row expires", async () => {
  mockFind.mockImplementation(async (name) =>
    name === "in_app_notifications"
      ? { href: target, source_id: "platform" }
      : null,
  );
  expect(
    await resolveNotificationCallback(marker, "test-user", { role: "user" }),
  ).toBe(target);
  expect(mockFind).toHaveBeenCalledWith(
    "in_app_notifications",
    expect.objectContaining({
      callback_marker: marker,
      recipient_user_subjects: "test-user",
      archived_at: { $exists: false },
    }),
  );
});
it("does not disclose a missing, expired, or different user's target", async () => {
  mockFind.mockResolvedValue(null);
  await expect(
    resolveNotificationCallback(marker, "other-user", {}),
  ).rejects.toMatchObject({ statusCode: 404 });
});
it("rejects malformed markers before looking up any data", async () => {
  await expect(
    resolveNotificationCallback("invalid", "test-user", {}),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(mockFind).not.toHaveBeenCalled();
});
it.each([false, true])(
  "rechecks current app access (app disabled=%s)",
  async (disabled) => {
    mockFind.mockResolvedValue({ ...delivery, sourceId: "app:example-app" });
    mockApp.mockReturnValue({
      installation: { installed: true, enabled: !disabled },
      manifest: { access: { requiredRoles: ["admin"] } },
    });
    await expect(
      resolveNotificationCallback(marker, "test-user", { role: "user" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  },
);
it("allows an authorized app recipient even if they later pause notifications", async () => {
  mockFind.mockResolvedValue({ ...delivery, sourceId: "app:example-app" });
  expect(
    await resolveNotificationCallback(marker, "test-user", { role: "user" }),
  ).toBe(target);
});
it.each([
  `/notifications/open/${marker}`,
  `/%6eotifications/open/${marker}`,
  "//other.example.test",
])("rejects recursive or corrupted stored callbacks: %s", async (href) => {
  mockFind.mockResolvedValue({ ...delivery, href });
  await expect(
    resolveNotificationCallback(marker, "test-user", {}),
  ).rejects.toMatchObject({ statusCode: 404 });
});
it("passes the opaque callback marker through browser push delivery", async () => {
  const device = { _id: "example-device" };
  mockFind.mockResolvedValue(device);
  await sendExternalNotification(delivery);
  expect(mockPush).toHaveBeenCalledWith(
    device,
    marker,
    `/notifications/open/${marker}`,
  );
});
it("adds a clickable callback to Slack and Webex without exposing the raw destination", async () => {
  await sendSlackNotification(delivery);
  await sendWebexNotification(delivery);
  const slack = mockSlack.mock.calls[0][1].body;
  const webex = mockWebex.mock.calls[0][1].body;
  expect(slack.text).toContain(
    `<https://host.example.test/notifications/open/${marker}|Open in CAIPE>`,
  );
  expect(webex.markdown).toContain(
    `[Open in CAIPE](https://host.example.test/notifications/open/${marker})`,
  );
  expect(JSON.stringify([slack, webex])).not.toContain(target);
});
