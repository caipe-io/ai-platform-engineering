/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET } from "@/app/api/access/operations/[id]/route";

const mockAuth = jest.fn();
const mockFind = jest.fn();
const mockPermission = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: () => mockAuth(),
}));
jest.mock("@/lib/auth-config", () => ({ authOptions: {} }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFind }) }));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: (...args: unknown[]) => mockPermission(...args) }));

const id = "00000000-0000-4000-8000-000000000001";
const call = () => GET(new NextRequest(`https://example.test/api/access/operations/${id}`), { params: Promise.resolve({ id }) });
beforeEach(() => {
  jest.resetAllMocks();
  mockAuth.mockResolvedValue({ session: { sub: "example-user" } });
  mockFind.mockResolvedValue({ _id: "example-agent", _permission_sync: {
    id, state: "pending", requested_at: "2026-01-01", diff: { secret: "private" },
    context: { caller: { type: "user", id: "example-user" } }, lease: { owner: "private-worker" },
  } });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it("allows the initiating user to see progress, but no private journal fields", async () => {
  const response = await call();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ success: true, data: { id, state: "pending", requested_at: "2026-01-01" } });
  expect(mockPermission).not.toHaveBeenCalled();
});

it("requires resource management for a different caller", async () => {
  mockAuth.mockResolvedValue({ session: { sub: "another-user" } });
  mockPermission.mockRejectedValue(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
  expect((await call()).status).toBe(403);
  expect(mockPermission).toHaveBeenCalledWith({ sub: "another-user" }, { type: "agent", id: "example-agent", action: "manage" });
});

it("does not confuse a service account with a user having the same subject", async () => {
  mockAuth.mockResolvedValue({ session: { sub: "example-user", isServiceAccount: true } });
  await call();
  expect(mockPermission).toHaveBeenCalledTimes(1);
});

it("authenticates before reading the journal", async () => {
  mockAuth.mockRejectedValue(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));
  expect((await call()).status).toBe(401);
  expect(mockFind).not.toHaveBeenCalled();
});

it("does not report deleted or superseded operations as applied", async () => {
  mockFind.mockResolvedValue(null);
  expect((await call()).status).toBe(404);
});
