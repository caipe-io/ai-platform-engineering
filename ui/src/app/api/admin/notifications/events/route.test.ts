/** @jest-environment node */
import { NextRequest } from "next/server";
const mockAuth = jest.fn();
const mockAdmin = jest.fn();
const mockUpdate = jest.fn();
const mockLifecycle = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/api-middleware", () => ({ ...jest.requireActual("@/lib/api-middleware"), getAuthFromBearerOrSession: () => mockAuth() }));
jest.mock("@/lib/rbac/platform-admin", () => ({ hasOrganizationAdmin: () => mockAdmin() }));
jest.mock("@/lib/rbac/audit", () => ({ logOpenFgaRebacAuditEvent: (...args: unknown[]) => mockAudit(...args) }));
jest.mock("@/lib/notifications/event-policy.server", () => ({ changeNotificationEventLifecycle: (...args: unknown[]) => mockLifecycle(...args), listNotificationEventPolicies: async () => [], updateNotificationEventPolicy: (...args: unknown[]) => mockUpdate(...args) }));
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

it("requires an admin for retirement and audits lifecycle changes", async () => {
  const body = { action: "retire", sourceId: "app:example", eventType: "report.ready", revision: 0 };
  const make = () => new NextRequest("https://example.test/api/admin/notifications/events", { method: "PATCH", body: JSON.stringify(body) });
  mockAdmin.mockResolvedValue(false); expect((await PATCH(make())).status).toBe(403);
  expect(mockLifecycle).not.toHaveBeenCalled();
  mockAdmin.mockResolvedValue(true); mockLifecycle.mockResolvedValue({ ...body, revision: 1, retired: true });
  expect((await PATCH(make())).status).toBe(200);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ operation: "notification.event.retire", correlationId: "revision:1" }));
});
