/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { ApiError } from "@/lib/api-middleware";
const mockAdmin = jest.fn();
const mockConfig = jest.fn();
const mockProxy = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
  withErrorHandler: (fn: (req: NextRequest) => Promise<Response>) => async (req: NextRequest) => { try { return await fn(req); } catch (e) { return new Response(null, { status: (e as { statusCode?: number }).statusCode || 500 }); } },
  withAuth: (req: NextRequest, fn: (req: NextRequest, user: { email: string }, session: { sub: string }) => Promise<Response>) => fn(req, { email: "admin@example.com" }, { sub: "admin-subject" }),
  requireRbacPermission: (...args: unknown[]) => mockAdmin(...args),
}));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: (...args: unknown[]) => mockConfig(...args) }));
jest.mock("@/lib/rbac/audit", () => ({ logRbacAdminAuditEvent: (...args: unknown[]) => mockAudit(...args) }));
jest.mock("@/lib/harness-engine-proxy", () => ({ getHarnessEngineConfig: () => ({ url: "http://engine.example.test", internalToken: "private-test-key" }), proxyHarnessEngine: (...args: unknown[]) => mockProxy(...args) }));
beforeEach(() => { jest.clearAllMocks(); mockAdmin.mockResolvedValue(undefined); mockConfig.mockResolvedValue(undefined); });
it.each([GET, POST])("rejects non-admin access before contacting Engine", async handler => {
  mockAdmin.mockRejectedValue(new ApiError("denied", 403));
  expect((await handler(new NextRequest("http://example.test/api/admin/harness-engine/operator-profiles"))).status).toBe(403);
  expect(mockProxy).not.toHaveBeenCalled();
});
it("requires platform configuration permission even for UI admins", async () => {
  mockConfig.mockRejectedValue(new ApiError("denied", 403));
  expect((await GET(new NextRequest("http://example.test/api/admin/harness-engine/operator-profiles"))).status).toBe(403);
  expect(mockProxy).not.toHaveBeenCalled();
});
it("audits publication and adds the trusted marker only after both checks", async () => {
  mockProxy.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { profile_id: "managed-test-v1" } }), { status: 201 }));
  const response = await POST(new NextRequest("http://example.test/api/admin/harness-engine/operator-profiles", { method: "POST", body: JSON.stringify({ profile_id: "managed-test-v1" }) }));
  expect(response.status).toBe(201);
  expect(mockAdmin).toHaveBeenCalled(); expect(mockConfig).toHaveBeenCalled();
  expect(mockProxy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ subject: "admin-subject" }), "/api/v1/admin/operator-profiles", expect.objectContaining({ headers: { "X-Harness-Engine-Admin": "true" } }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ operation: "operator_profile.create", resourceRef: "operator_profile:managed-test-v1" }));
});
