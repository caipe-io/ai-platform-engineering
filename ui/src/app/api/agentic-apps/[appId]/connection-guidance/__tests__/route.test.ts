/** @jest-environment node */
import { NextRequest } from "next/server";
const mockGate = jest.fn();
const mockUpdate = jest.fn();
const mockFind = jest.fn();
const mockApp = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: async () => ({ session: { sub: "test-user", role: "user" }, user: { role: "user", email: "test-user@example.test" } }),
  requireRbacPermission: (...args: unknown[]) => mockGate(...args),
}));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: jest.fn() }));
jest.mock("@/lib/agentic-apps/config", () => ({ isAgenticAppsEnabled: () => true, getConfiguredAgenticApp: (...args: unknown[]) => mockApp(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFind, updateOne: mockUpdate }) }));
import { GET, PUT } from "../route";
import { ApiError } from "@/lib/api-error";
const guide = { id: "webex", enabled: true, label: "Connect", title: "Instructions", markdown: "Start a DM with example-bot@example.test", action_label: "", action_url: "" };
const context = { params: Promise.resolve({ appId: "example" }) };
beforeEach(() => {
  jest.resetAllMocks();
  mockApp.mockReturnValue({ installation: { installed: true, enabled: true }, manifest: { access: { requiredRoles: ["user"] } } });
});
test("persists per-app guides after both admin gates", async () => {
  const result = await PUT(new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance", { method: "PUT", body: JSON.stringify({ guides: [guide] }) }), context);
  expect(result.status).toBe(200);
  expect(mockGate).toHaveBeenCalledWith(expect.anything(), "admin_ui", "admin");
  expect(mockUpdate).toHaveBeenCalledWith({ _id: "example" }, { $set: expect.objectContaining({ guides: [guide] }) }, { upsert: true });
});
test("denied writes cannot mutate storage", async () => {
  mockGate.mockRejectedValue(new ApiError("Forbidden", 403));
  const result = await PUT(new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance", { method: "PUT", body: JSON.stringify({ guides: [guide] }) }), context);
  expect(result.status).toBe(403); expect(mockUpdate).not.toHaveBeenCalled();
});
test("reads use only the selected app and do not cache privately configured content", async () => {
  mockFind.mockResolvedValue({ guides: [guide] });
  const result = await GET(new NextRequest("https://example.test/api/agentic-apps/example/connection-guidance"), context);
  expect(mockFind).toHaveBeenCalledWith({ _id: "example" });
  expect(result.headers.get("Cache-Control")).toBe("private, no-store");
});
