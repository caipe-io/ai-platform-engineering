/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";
import { getUserSessions, getUserFederatedIdentities, listRealmRoleMappingsForUser } from "@/lib/rbac/keycloak-admin";
import { requireAdminSimulationUserProfileRead } from "@/lib/rbac/admin-simulation-server";

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: jest.fn(async () => ({ session: { sub: "reader" } })),
  successResponse: (data: unknown) => NextResponse.json({ success: true, data }),
  withErrorHandler: (handler: unknown) => handler,
}));
jest.mock("@/lib/rbac/admin-simulation-server", () => ({ requireAdminSimulationUserProfileRead: jest.fn() }));
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getKeycloakRealm: () => "example",
  getUserSessions: jest.fn(),
  getUserFederatedIdentities: jest.fn(),
  listRealmRoleMappingsForUser: jest.fn(),
}));

const invoke = () => GET(new NextRequest("https://example.test/api/admin/users/test-user/identity"), { params: Promise.resolve({ id: "test-user" }) });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(requireAdminSimulationUserProfileRead).mockResolvedValue(undefined);
  jest.mocked(getUserSessions).mockResolvedValue([{ id: "session", start: 100, lastAccess: 200, ipAddress: "192.0.2.1" }]);
  jest.mocked(getUserFederatedIdentities).mockResolvedValue([{ identityProvider: "primary", userId: "external-user", userName: "test-user" }]);
  jest.mocked(listRealmRoleMappingsForUser).mockResolvedValue([]);
});

it("returns source context and only selected identity fields with no caching", async () => {
  const response = await invoke();
  const { data } = await response.json();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(data).toMatchObject({ realm: "example", unavailable: [], lastAccess: 200, realmRoles: [], sessions: [{ id: "session", start: 100, lastAccess: 200 }] });
  expect(data.federatedIdentities[0].userId).toBe("external-user");
  expect(data.sessions[0]).not.toHaveProperty("ipAddress");
  expect(Number.isNaN(Date.parse(data.fetchedAt))).toBe(false);
  expect(requireAdminSimulationUserProfileRead).toHaveBeenCalledWith(expect.any(URLSearchParams), { sub: "reader" }, "test-user");
});

it("keeps successful sections when an upstream lookup fails", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.mocked(getUserFederatedIdentities).mockRejectedValue(new Error("private upstream body"));
  const { data } = await (await invoke()).json();
  expect(data.unavailable).toEqual(["federatedIdentities"]);
  expect(data.federatedIdentities).toEqual([]);
  expect(data.lastAccess).toBe(200);
  expect(JSON.stringify(data)).not.toContain("private upstream body");
  expect(warn).toHaveBeenCalledWith("[admin-user-identity] federatedIdentities lookup failed");
  warn.mockRestore();
});

it("does not retrieve diagnostics before the profile-read gate permits it", async () => {
  jest.mocked(requireAdminSimulationUserProfileRead).mockRejectedValue(new Error("denied"));
  await expect(invoke()).rejects.toThrow("denied");
  expect(getUserSessions).not.toHaveBeenCalled();
  expect(getUserFederatedIdentities).not.toHaveBeenCalled();
  expect(listRealmRoleMappingsForUser).not.toHaveBeenCalled();
});
