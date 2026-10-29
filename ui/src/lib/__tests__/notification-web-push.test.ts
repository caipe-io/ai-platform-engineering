/** @jest-environment node */

import {
  validatePushEndpoint,
  sendBrowserPush,
} from "@/lib/notifications/web-push.server";

const mockSend = jest.fn();
const mockDelete = jest.fn();
jest.mock("web-push", () => ({
  __esModule: true,
  default: { sendNotification: (...args: unknown[]) => mockSend(...args) },
}));
jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({ deleteOne: mockDelete }),
}));

describe("browser web push", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NOTIFICATION_WEB_PUSH_PUBLIC_KEY = "example";
    process.env.NOTIFICATION_WEB_PUSH_PRIVATE_KEY = "example-private";
    process.env.NOTIFICATION_WEB_PUSH_SUBJECT = "mailto:admin@example.test";
  });
  afterAll(() => {
    delete process.env.NOTIFICATION_WEB_PUSH_PUBLIC_KEY;
    delete process.env.NOTIFICATION_WEB_PUSH_PRIVATE_KEY;
    delete process.env.NOTIFICATION_WEB_PUSH_SUBJECT;
  });
  it.each([
    "http://fcm.googleapis.com/test",
    "https://127.0.0.1/test",
    "https://other.example.test/test",
    "https://fcm.googleapis.com:444/test",
    "https://name:secret@fcm.googleapis.com/test",
  ])("rejects untrusted push endpoints: %s", (endpoint) =>
    expect(() => validatePushEndpoint(endpoint)).toThrow(),
  );
  it("uses private push content and removes expired devices", async () => {
    mockSend.mockRejectedValue({ statusCode: 410 });
    await expect(
      sendBrowserPush(
        {
          _id: "example-device",
          subject: "test-user",
          endpoint: "https://fcm.googleapis.com/example",
          keys: { p256dh: "example", auth: "example" },
          createdAt: new Date(),
          expiresAt: new Date(),
        },
        "example-notification",
      ),
    ).rejects.toEqual({ statusCode: 410 });
    expect(mockDelete).toHaveBeenCalledWith({
      _id: "example-device",
      subject: "test-user",
    });
    expect(JSON.parse(mockSend.mock.calls[0][1])).toMatchObject({
      title: "New CAIPE notification",
      body: "Open CAIPE to view this update.",
    });
  });
});
