/** @jest-environment node */
import { sendExternalNotification } from "@/lib/notifications/adapters.server";
import type { NotificationDelivery } from "@/lib/notifications/delivery-types";
const mockFind = jest.fn();
const mockPush = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: (...args: unknown[]) => mockFind(...args) }) }));
jest.mock("@/lib/notifications/web-push.server", () => ({ browserPushPublicKey: () => "example-key", sendBrowserPush: (...args: unknown[]) => mockPush(...args) }));
const delivery = { _id: "a".repeat(64), channel: "web_push", targetId: "example-device", recipient: { subject: "example-user" } } as NotificationDelivery;
beforeEach(() => { jest.clearAllMocks(); });
it("dispatches to an owned unexpired device with an opaque callback", async () => {
  const device = { _id: "example-device" }; mockFind.mockResolvedValue(device);
  await sendExternalNotification(delivery);
  expect(mockFind).toHaveBeenCalledWith({ _id: "example-device", subject: "example-user", expiresAt: { $gt: expect.any(Date) } });
  expect(mockPush).toHaveBeenCalledWith(device, delivery._id, `/notifications/open/${delivery._id}`);
});
it("does not send when the owned device is no longer available", async () => {
  mockFind.mockResolvedValue(null);
  await expect(sendExternalNotification(delivery)).rejects.toThrow("expired or was removed");
  expect(mockPush).not.toHaveBeenCalled();
});
