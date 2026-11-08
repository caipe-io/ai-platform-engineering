/** @jest-environment node */
import { notificationChannelAdapters, notificationChannelAvailability, notificationWebPushPublicKey, validateNotificationChannelChoices } from "@/lib/notifications/adapters.server";
afterEach(() => { delete notificationChannelAdapters.web_push; delete notificationChannelAdapters.webex; delete notificationChannelAdapters.slack; });
it("keeps missing integrations unavailable", async () => {
  expect(await notificationChannelAvailability("example-user")).toEqual({ in_app: true, web_push: false, webex: false, slack: false });
  expect(notificationWebPushPublicKey()).toBeNull();
  await expect(validateNotificationChannelChoices("example-user", { web_push: true })).rejects.toThrow();
});
it("does not mistake a provider failure for readiness", async () => {
  notificationChannelAdapters.slack = { available: async () => { throw new Error("unavailable"); } };
  expect((await notificationChannelAvailability("example-user")).slack).toBe(false);
});
it("checks the owned destination before enabling a channel", async () => {
  const validateEnable = jest.fn().mockRejectedValue(new Error("not subscribed"));
  notificationChannelAdapters.web_push = { available: async () => true, validateEnable };
  await expect(validateNotificationChannelChoices("example-user", { web_push: true })).rejects.toThrow("not subscribed");
  expect(validateEnable).toHaveBeenCalledWith("example-user");
});
