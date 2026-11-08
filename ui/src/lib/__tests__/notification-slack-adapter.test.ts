/** @jest-environment node */
import { sendExternalNotification } from "@/lib/notifications/adapters.server";
import { sendSlackNotification } from "@/lib/notifications/slack.server";
import type { NotificationDelivery } from "@/lib/notifications/delivery-types";
const send = jest.fn().mockResolvedValue({});
const linked = jest.fn();
jest.mock("@/lib/slack-bot-admin", () => ({ callSlackBotAdmin: (...args: unknown[]) => send(...args) }));
jest.mock("@/lib/notifications/destinations.server", () => ({ linkedNotificationAccounts: (...args: unknown[]) => linked(...args) }));
const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; jest.clearAllMocks(); });
const delivery = { _id: "a".repeat(64), recipient: { subject: "example-user" }, title: "Example update", message: "Example run finished", href: "/private/example" } as NotificationDelivery;
it("keeps the channel opt-in", async () => {
  delete process.env.NOTIFICATION_SLACK_ENABLED;
  await expect(sendSlackNotification(delivery)).rejects.toThrow("not configured");
  expect(send).not.toHaveBeenCalled();
});
it("requires a linked owned destination", async () => {
  process.env.NOTIFICATION_SLACK_ENABLED = "true"; linked.mockResolvedValue({ slack: null });
  await expect(sendSlackNotification(delivery)).rejects.toThrow("Link your"); expect(send).not.toHaveBeenCalled();
});
it("sends an opaque callback rather than the private destination", async () => {
  process.env.NOTIFICATION_SLACK_ENABLED = "true"; process.env.NEXTAUTH_URL = "https://host.example.test"; linked.mockResolvedValue({ slack: "example-destination" });
  await sendExternalNotification({ ...delivery, channel: "slack" });
  const body = JSON.stringify(send.mock.calls[0][1].body);
  expect(body).toContain("https://host.example.test/notifications/open/" + delivery._id);
  expect(body).not.toContain("/private/example");
});
