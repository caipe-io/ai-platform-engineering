/** @jest-environment node */

import { claimWebexIdentity } from "../webex-identity-link";

const findOwner = jest.fn();
const mergeAttributes = jest.fn();
const syncRoutes = jest.fn();
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  findRealmUserIdByAttribute: (...args: unknown[]) => findOwner(...args),
  mergeUserAttributes: (...args: unknown[]) => mergeAttributes(...args),
}));
jest.mock("@/lib/rbac/webex-direct-user-route-store", () => ({
  setWebexIdentityForUserRoutes: (...args: unknown[]) => syncRoutes(...args),
}));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error {
    constructor(message: string, public statusCode: number, public code: string) { super(message); }
  },
}));

beforeEach(() => {
  findOwner.mockReset().mockResolvedValue(null);
  mergeAttributes.mockReset().mockResolvedValue(undefined);
  syncRoutes.mockReset().mockResolvedValue(undefined);
});

it.each([null, "test-user"])("synchronizes routes only after both ownership checks pass (owner=%s)", async (owner) => {
  findOwner.mockResolvedValue(owner);
  await claimWebexIdentity("test-person", "test-user", { webex_user_id: ["test-person"] });
  expect(syncRoutes).toHaveBeenCalledWith("test-user", "test-person");
  expect(findOwner).toHaveBeenCalledTimes(2);
  expect(syncRoutes.mock.invocationCallOrder[0]).toBeGreaterThan(findOwner.mock.invocationCallOrder[1]);
});

it("does not synchronize routes when another user already owns the identity", async () => {
  findOwner.mockResolvedValue("other-user");
  await expect(claimWebexIdentity("test-person", "test-user", { webex_user_id: ["test-person"] }))
    .rejects.toMatchObject({ code: "WEBEX_ID_ALREADY_LINKED" });
  expect(mergeAttributes).not.toHaveBeenCalled();
  expect(syncRoutes).not.toHaveBeenCalled();
});

it("does not bind routes after losing a concurrent ownership claim", async () => {
  findOwner.mockResolvedValueOnce(null).mockResolvedValueOnce("other-user");
  await expect(claimWebexIdentity("test-person", "test-user", { webex_user_id: ["test-person"] }))
    .rejects.toMatchObject({ code: "WEBEX_ID_ALREADY_LINKED" });
  expect(mergeAttributes).toHaveBeenLastCalledWith("test-user", { webex_user_id: undefined, webex_user_email: undefined });
  expect(syncRoutes).not.toHaveBeenCalled();
});

it("does not bind routes if saving the verified identity fails", async () => {
  mergeAttributes.mockRejectedValue(new Error("identity store unavailable"));
  await expect(claimWebexIdentity("test-person", "test-user", { webex_user_id: ["test-person"] }))
    .rejects.toThrow("identity store unavailable");
  expect(syncRoutes).not.toHaveBeenCalled();
});

it("propagates synchronization failure instead of reporting a successful link", async () => {
  syncRoutes.mockRejectedValue(new Error("route store unavailable"));
  await expect(claimWebexIdentity("test-person", "test-user", { webex_user_id: ["test-person"] }))
    .rejects.toThrow("route store unavailable");
});
