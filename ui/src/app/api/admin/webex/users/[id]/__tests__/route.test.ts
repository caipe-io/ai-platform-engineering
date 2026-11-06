/** @jest-environment node */

import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-middleware";
import { DELETE } from "../route";

const authenticate = jest.fn();
const authorize = jest.fn();
const mergeAttributes = jest.fn();
const syncRoutes = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: (...args: unknown[]) => authenticate(...args),
  requireRbacPermission: (...args: unknown[]) => authorize(...args),
}));
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  mergeUserAttributes: (...args: unknown[]) => mergeAttributes(...args),
}));
jest.mock("@/lib/rbac/webex-direct-user-route-store", () => ({
  setWebexIdentityForUserRoutes: (...args: unknown[]) => syncRoutes(...args),
}));

beforeEach(() => {
  authenticate.mockReset().mockResolvedValue({ session: { sub: "test-admin" } });
  authorize.mockReset().mockResolvedValue(undefined);
  mergeAttributes.mockReset().mockResolvedValue(undefined);
  syncRoutes.mockReset().mockResolvedValue(undefined);
});

function revoke(): Promise<Response> {
  return DELETE(new NextRequest("https://example.com/api/admin/webex/users/test-user"), {
    params: Promise.resolve({ id: "test-user" }),
  });
}

it("clears the selected user's route identity after admin authorization", async () => {
  const response = await revoke();
  expect(response.status).toBe(200);
  expect(authorize).toHaveBeenCalledWith({ sub: "test-admin" }, "admin_ui", "admin");
  expect(mergeAttributes).toHaveBeenCalledWith("test-user", { webex_user_id: undefined, webex_user_email: undefined });
  expect(syncRoutes).toHaveBeenCalledWith("test-user", null);
  expect(syncRoutes.mock.invocationCallOrder[0]).toBeGreaterThan(authorize.mock.invocationCallOrder[0]);
});

it("does not change identities or routes when admin authorization fails", async () => {
  authorize.mockRejectedValue(new ApiError("Forbidden", 403, "FORBIDDEN"));
  expect((await revoke()).status).toBe(403);
  expect(mergeAttributes).not.toHaveBeenCalled();
  expect(syncRoutes).not.toHaveBeenCalled();
});

it("returns an error when route invalidation fails", async () => {
  syncRoutes.mockRejectedValue(new Error("route store unavailable"));
  expect((await revoke()).status).toBe(500);
});
