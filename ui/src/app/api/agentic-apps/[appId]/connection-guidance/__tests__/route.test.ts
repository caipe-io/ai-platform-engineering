/** @jest-environment node */
import { NextRequest } from "next/server";
import { MongoServerError } from "mongodb";
import { ApiError } from "@/lib/api-error";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";

const mockGate = jest.fn();
const mockResourceGate = jest.fn();
const mockUpdate = jest.fn();
const mockFind = jest.fn();
const mockApp = jest.fn();
const mockWebexConfigured = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: async () => ({ session: { sub: "test-user", role: "user" }, user: { role: "user", email: "test-user@example.test" } }),
  requireRbacPermission: (...args: unknown[]) => mockGate(...args),
}));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: (...args: unknown[]) => mockResourceGate(...args) }));
jest.mock("@/lib/integration-config", () => ({ isWebexIdentityLinkingEnabled: () => mockWebexConfigured() }));
jest.mock("@/lib/agentic-apps/config", () => ({ isAgenticAppsEnabled: () => true, getConfiguredAgenticApp: (...args: unknown[]) => mockApp(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFind, updateOne: mockUpdate }) }));
import { GET, PUT } from "../route";
const guide = { id: "primary", enabled: true, label: "Connect", title: "Instructions", markdown: "Start a DM with example-bot@example.test", action_label: "", action_url: "" };
const context = { params: Promise.resolve({ appId: "example" }) };
const request = (revision: string | null = null) => new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance", { method: "PUT", body: JSON.stringify({ guides: [guide], revision }) });
beforeEach(() => {
  jest.resetAllMocks();
  mockApp.mockReturnValue({ installation: { installed: true, enabled: true }, manifest: { access: { requiredRoles: ["user"] } } });
  mockUpdate.mockResolvedValue({ matchedCount: 1, upsertedCount: 0 });
});
test("persists per-app guides after both admin gates with a new revision", async () => {
  const result = await PUT(request(), context);
  expect(result.status).toBe(200);
  expect(mockGate).toHaveBeenCalledWith(expect.anything(), "admin_ui", "admin");
  expect(mockResourceGate).toHaveBeenCalledWith(expect.anything(), { type: "system_config", id: PLATFORM_CONFIG_ID, action: "admin" });
  expect(mockUpdate).toHaveBeenCalledWith({ _id: "example", revision: null }, { $set: expect.objectContaining({ guides: [guide], revision: expect.any(String) }) }, { upsert: true });
  expect((await result.json()).data.revision).toEqual(expect.any(String));
});
test.each([mockGate, mockResourceGate])("denied writes cannot mutate storage (%#)", async gate => {
  gate.mockRejectedValue(new ApiError("Forbidden", 403));
  expect((await PUT(request(), context)).status).toBe(403);
  expect(mockUpdate).not.toHaveBeenCalled();
});
test("reads the selected app and returns its guides and revision without caching", async () => {
  mockFind.mockResolvedValue({ guides: [guide], revision: "primary" });
  const result = await GET(new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance"), context);
  expect(mockFind).toHaveBeenCalledWith({ _id: "example" });
  expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await result.json()).toEqual({ success: true, data: { guides: [guide], revision: "primary" } });
});
test("rejects stale writes and concurrent first saves", async () => {
  mockUpdate.mockResolvedValueOnce({ matchedCount: 0, upsertedCount: 0 });
  expect((await PUT(request("stale"), context)).status).toBe(409);
  expect(mockUpdate).toHaveBeenLastCalledWith({ _id: "example", revision: "stale" }, expect.anything(), { upsert: false });
  mockUpdate.mockRejectedValueOnce(new MongoServerError({ code: 11000, message: "Duplicate key" }));
  expect((await PUT(request(), context)).status).toBe(409);
});
test("requires a read revision before saving", async () => {
  const input = new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance", { method: "PUT", body: JSON.stringify({ guides: [guide] }) });
  expect((await PUT(input, context)).status).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});
test("uses admin read permissions for the editor while ordinary reads require launch access", async () => {
  mockApp.mockReturnValue({ installation: { installed: true, enabled: true }, manifest: { access: { requiredRoles: ["restricted-role"] } } });
  expect((await GET(new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance"), context)).status).toBe(404);
  expect((await GET(new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance?editor=true"), context)).status).toBe(200);
  expect(mockGate).toHaveBeenCalled();
  expect(mockResourceGate).toHaveBeenCalled();
  mockResourceGate.mockRejectedValueOnce(new ApiError("Forbidden", 403));
  expect((await GET(new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance?editor=true"), context)).status).toBe(403);
});
test("hides unconfigured identity actions from users while retaining admin configuration", async () => {
  const configured = { ...guide, action_url: "/api/auth/webex-link/start?returnTo=chat", action_label: "Link identity" };
  mockFind.mockResolvedValue({ guides: [configured] });
  const url = "https://example.test/api/agentic-apps/example/connection-guidance";
  expect((await (await GET(new NextRequest(url), context)).json()).data.guides).toEqual([guide]);
  expect((await (await GET(new NextRequest(`${url}?editor=true`), context)).json()).data.guides).toEqual([configured]);
  mockWebexConfigured.mockReturnValue(true);
  expect((await (await GET(new NextRequest(url), context)).json()).data.guides).toEqual([configured]);
});
