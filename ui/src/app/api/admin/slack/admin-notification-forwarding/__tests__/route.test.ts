/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockWithAuth = jest.fn();
const mockRequireAdmin = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
      public code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    withAuth: (...args: unknown[]) => mockWithAuth(...args),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      (request: NextRequest) =>
        handler(request),
    requireRbacPermission: (...args: unknown[]) => mockRequireAdmin(...args),
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

describe("admin-notification-forwarding route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithAuth.mockImplementation((_request, handler) =>
      handler(_request, { email: "admin@example.com" }, { sub: "admin-sub", role: "admin" }),
    );
    mockRequireAdmin.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    });
  });

  it("requires admin system_config access before returning the config", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/slack/admin-notification-forwarding"));

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      { type: "system_config", id: "platform_settings", action: "admin" },
    );
  });

  it("returns the default config when nothing is stored", async () => {
    const { GET } = await import("../route");

    const body = await (
      await GET(request("/api/admin/slack/admin-notification-forwarding"))
    ).json();

    expect(body).toEqual({
      success: true,
      data: {
        enabled: false,
        channel_id: null,
        channel_name: null,
        ping_user_ids: [],
      },
    });
  });

  it("does not read config when access is denied", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("no access"));
    const { GET } = await import("../route");

    await expect(
      GET(request("/api/admin/slack/admin-notification-forwarding")),
    ).rejects.toThrow("no access");
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("persists a valid config on PATCH", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({ updateOne });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/slack/admin-notification-forwarding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          channel_id: "C0123456789",
          channel_name: "platform-alerts",
          ping_user_ids: ["U0123456789"],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      enabled: true,
      channel_id: "C0123456789",
      channel_name: "platform-alerts",
      ping_user_ids: ["U0123456789"],
    });
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({
          slack_admin_notification_forwarding: body.data,
          updated_by: "admin@example.com",
        }),
      }),
      { upsert: true },
    );
  });

  it("requires admin_ui admin before system_config admin on PATCH", async () => {
    const { PATCH } = await import("../route");

    await PATCH(
      request("/api/admin/slack/admin-notification-forwarding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );

    expect(mockRequireAdmin).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      "admin_ui",
      "admin",
    );
  });

  it("rejects enabling forwarding without a channel", async () => {
    const { PATCH } = await import("../route");

    await expect(
      PATCH(
        request("/api/admin/slack/admin-notification-forwarding", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
      ),
    ).rejects.toThrow(/channel is required/);
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("rejects an invalid channel id", async () => {
    const { PATCH } = await import("../route");

    await expect(
      PATCH(
        request("/api/admin/slack/admin-notification-forwarding", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel_id: "not-a-channel" }),
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ADMIN_NOTIFICATION_FORWARDING" });
  });
});
