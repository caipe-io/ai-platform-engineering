/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockProducer = jest.fn();
const mockRegister = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/agentic-apps/notification-producer", () => ({
  findNotificationProducer: (...args: unknown[]) => mockProducer(...args),
}));
jest.mock("@/lib/notifications/subscriptions.server", () => ({
  registerAppNotificationTypes: (...args: unknown[]) => mockRegister(...args),
}));
jest.mock("@/lib/notifications/limits.server", () => ({
  consumeNotificationQuota: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from "./route";

describe("app notification registration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({
      session: {
        isServiceAccount: true,
        serviceAccountClientId: "example-client",
      },
    });
    mockProducer.mockReturnValue({
      manifest: { id: "example-app", displayName: "Example app" },
    });
    mockRegister.mockResolvedValue(undefined);
  });
  const request = (body: unknown) =>
    new NextRequest(
      "https://host.example.test/api/notifications/registrations",
      { method: "POST", body: JSON.stringify(body) },
    );
  it("binds the source to the authenticated installed app", async () => {
    const events = [{ id: "report.ready", label: "Report ready" }];
    expect((await POST(request({ appId: "other-app", events }))).status).toBe(
      200,
    );
    expect(mockRegister).toHaveBeenCalledWith(
      "example-app",
      "Example app",
      events,
    );
  });
  it("rejects user credentials and disabled or unregistered service accounts", async () => {
    mockAuth.mockResolvedValue({ session: { sub: "test-user" } });
    expect((await POST(request({ events: [] }))).status).toBe(403);
    mockAuth.mockResolvedValue({
      session: {
        isServiceAccount: true,
        serviceAccountClientId: "example-client",
      },
    });
    mockProducer.mockReturnValue(null);
    expect((await POST(request({ events: [] }))).status).toBe(403);
    expect(mockRegister).not.toHaveBeenCalled();
  });
  it("bounds request payloads before registration", async () => {
    expect(
      (await POST(request({ unused: "x".repeat(33 * 1024) }))).status,
    ).toBe(413);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
