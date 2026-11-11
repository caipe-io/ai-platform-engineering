/** @jest-environment node */

import { NextRequest } from "next/server";

import { DELETE } from "../[id]/route";

const mockAuth = jest.fn();
const mockPermission = jest.fn();
const mockUnlink = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
  requireRbacPermission: (...args: unknown[]) => mockPermission(...args),
}));
jest.mock("@/lib/rbac/webex-identity-link", () => ({
  unlinkWebexIdentity: (...args: unknown[]) => mockUnlink(...args),
}));

beforeEach(() => {
  jest.resetAllMocks();
  mockAuth.mockResolvedValue({ session: { sub: "admin-user" } });
});

test("admin revoke uses the same suppression and route-unbinding helper as self-service", async () => {
  const response = await DELETE(new NextRequest("http://localhost/api/admin/webex/users/user-1"), {
    params: Promise.resolve({ id: "user-1" }),
  });
  expect(response.status).toBe(200);
  expect(mockPermission).toHaveBeenCalledWith({ sub: "admin-user" }, "admin_ui", "admin");
  expect(mockUnlink).toHaveBeenCalledWith("user-1");
});

test("a caller denied admin access cannot revoke an identity", async () => {
  const { ApiError } = await import("@/lib/api-error");
  mockPermission.mockRejectedValue(new ApiError("forbidden", 403, "FORBIDDEN"));
  const response = await DELETE(new NextRequest("http://localhost/api/admin/webex/users/user-1"), {
    params: Promise.resolve({ id: "user-1" }),
  });
  expect(response.status).toBe(403);
  expect(mockUnlink).not.toHaveBeenCalled();
});
