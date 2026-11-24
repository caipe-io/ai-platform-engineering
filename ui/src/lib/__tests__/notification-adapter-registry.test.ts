/** @jest-environment node */
import { EXTERNAL_NOTIFICATION_TIMEOUT_MS, sendExternalNotification, notificationChannelAdapters, notificationChannelAvailability, notificationWebPushPublicKey, validateNotificationChannelChoices } from "@/lib/notifications/adapters.server";
import type { NotificationDelivery } from "@/lib/notifications/delivery-types";
afterEach(() => { jest.useRealTimers(); delete notificationChannelAdapters.web_push; delete notificationChannelAdapters.webex; delete notificationChannelAdapters.slack; });
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

it("aborts a slow send and supplies the same delivery key on retry", async () => {
  jest.useFakeTimers();
  const delivery = { _id: "example-delivery", channel: "slack" } as NotificationDelivery;
  const send = jest.fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce(undefined);
  notificationChannelAdapters.slack = { available: async () => true, send };
  const first = sendExternalNotification(delivery);
  const failure = expect(first).rejects.toMatchObject({ retryable: true, message: "Notification adapter timed out" });
  await jest.advanceTimersByTimeAsync(EXTERNAL_NOTIFICATION_TIMEOUT_MS);
  await failure;
  expect(send.mock.calls[0][1].signal.aborted).toBe(true);
  await sendExternalNotification(delivery);
  expect(send.mock.calls.map(([, options]) => options.idempotencyKey))
    .toEqual(["example-delivery", "example-delivery"]);
});
