/** @jest-environment node */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

describe("notification service worker without an open application page", () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const showNotification = jest.fn().mockResolvedValue(undefined);
  const openWindow = jest.fn().mockResolvedValue(undefined);
  const skipWaiting = jest.fn().mockResolvedValue(undefined);
  const claim = jest.fn().mockResolvedValue(undefined);
  const matchAll = jest.fn();
  const receipt = jest.fn().mockResolvedValue({ ok: true });
  beforeEach(() => {
    jest.clearAllMocks();
    matchAll.mockResolvedValue([]);
    runInNewContext(
      readFileSync(
        resolve(process.cwd(), "public/caipe-notification-sw.js"),
        "utf8",
      ),
      {
        URL,
        fetch: receipt,
        self: {
          addEventListener: (
            name: string,
            handler: (event: unknown) => void,
          ) => {
            handlers[name] = handler;
          },
          registration: { showNotification },
          skipWaiting,
          location: { origin: "https://host.example.test" },
          clients: { matchAll, openWindow, claim },
        },
      },
    );
  });
  it("acknowledges browser display independently of provider acceptance", async () => {
    let completed: Promise<unknown> | undefined;
    handlers.push({
      data: { json: () => ({ data: { deliveryId: "a".repeat(64) } }) },
      waitUntil: (value: Promise<unknown>) => {
        completed = value;
      },
    });
    await completed;
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledWith(
      "/api/notifications/push-receipts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ deliveryId: "a".repeat(64) }),
      }),
    );
  });
  it("activates an updated worker without waiting for all application tabs to close", async () => {
    const pending: Promise<unknown>[] = [];
    for (const name of ["install", "activate"])
      handlers[name]({
        waitUntil: (value: Promise<unknown>) => pending.push(value),
      });
    await Promise.all(pending);
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });
  it("shows a push alert with no page client and opens the host on click", async () => {
    let completed: Promise<unknown> | undefined;
    handlers.push({
      data: {
        json: () => ({
          title: "New notification",
          body: "Open your inbox",
          data: { href: "/settings/notifications" },
        }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        completed = promise;
      },
    });
    await completed;
    expect(showNotification).toHaveBeenCalledWith(
      "New notification",
      expect.objectContaining({ body: "Open your inbox" }),
    );
    handlers.notificationclick({
      notification: {
        close: jest.fn(),
        data: { href: "/settings/notifications" },
      },
      waitUntil: (promise: Promise<unknown>) => {
        completed = promise;
      },
    });
    await completed;
    expect(openWindow).toHaveBeenCalledWith(
      "https://host.example.test/settings/notifications",
    );
    expect(handlers.fetch).toBeUndefined();
  });
  it("opens the callback marker in an existing tab and focuses it", async () => {
    const navigate = jest.fn().mockResolvedValue(undefined),
      focus = jest.fn().mockResolvedValue(undefined);
    const nestedNavigate = jest.fn();
    matchAll.mockResolvedValue([{ frameType: "nested", navigate: nestedNavigate }, { frameType: "top-level", navigate, focus }]);
    const marker = "/notifications/open/" + "a".repeat(64);
    let completed: Promise<unknown> | undefined;
    handlers.notificationclick({
      notification: { close: jest.fn(), data: { href: marker } },
      waitUntil: (value: Promise<unknown>) => {
        completed = value;
      },
    });
    await completed;
    expect(navigate).toHaveBeenCalledWith("https://host.example.test" + marker);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(nestedNavigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });
  it("keeps notification clicks on the host origin", async () => {
    let completed: Promise<unknown> | undefined;
    handlers.notificationclick({
      notification: {
        close: jest.fn(),
        data: { href: "/\\other.example.test" },
      },
      waitUntil: (promise: Promise<unknown>) => {
        completed = promise;
      },
    });
    await completed;
    expect(openWindow).toHaveBeenCalledWith(
      "https://host.example.test/settings/notifications",
    );
  });
});
