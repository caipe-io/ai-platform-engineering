/** @jest-environment node */
import { NextRequest } from "next/server";
const mockAuth = jest.fn();
const mockAdmin = jest.fn();
const mockUpdate = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/api-middleware", () => ({ ...jest.requireActual("@/lib/api-middleware"), getAuthFromBearerOrSession: () => mockAuth() }));
jest.mock("@/lib/rbac/platform-admin", () => ({ hasOrganizationAdmin: () => mockAdmin() }));
jest.mock("@/lib/rbac/audit", () => ({ logOpenFgaRebacAuditEvent: (...args: unknown[]) => mockAudit(...args) }));
jest.mock("@/lib/notifications/event-policy.server", () => ({ listNotificationEventPolicies: async () => [], updateNotificationEventPolicy: (...args: unknown[]) => mockUpdate(...args) }));
jest.mock("@/lib/notifications/operator-registration.server", () => ({ registerOperatorNotificationType: jest.fn() }));
import { GET, PATCH } from "./route";
const request = () => new NextRequest("https://example.test/api/admin/notifications/events", { method: "PATCH", body: JSON.stringify({ sourceId: "app:example" }) });
beforeEach(() => { jest.clearAllMocks(); mockAuth.mockResolvedValue({ session: { sub: "operator" } }); mockAdmin.mockResolvedValue(true); });
it("denies non-admins and app service accounts", async () => {
  mockAdmin.mockResolvedValue(false);
  expect((await GET(request())).status).toBe(403);
  mockAdmin.mockResolvedValue(true); mockAuth.mockResolvedValue({ session: { sub: "publisher", isServiceAccount: true } });
  expect((await PATCH(request())).status).toBe(403);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("audits successful policy changes with their revision", async () => {
  mockUpdate.mockResolvedValue({ sourceId: "app:example", eventType: "report.ready", revision: 2 });
  expect((await PATCH(request())).status).toBe(200);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ sub: "operator", correlationId: "revision:2" }));
});
