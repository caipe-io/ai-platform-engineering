import { notificationEventPolicy, notificationPolicyAllows, notificationPolicyInboxFilter, updateNotificationEventPolicy, changeNotificationEventLifecycle } from "../event-policy.server";
import { isNotificationEnabled } from "../preferences";
const mockFindOne = jest.fn();
const mockUpdate = jest.fn();
const mockInsert = jest.fn();
const mockAdmin = jest.fn();
const registration = { _id: "app:example", label: "Example", events: [{ id: "report.ready", label: "Report ready" }] };
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn(async (name: string) => name === "notification_sources" ? { findOne: async () => registration, find: () => ({ limit: () => ({ toArray: async () => [registration] }) }) } : name === "users" ? { findOne: async () => ({ email: "test-user@example.test" }) } : { find: () => ({ limit: () => ({ toArray: async () => [] }) }), findOne: (...args: unknown[]) => mockFindOne(...args), updateOne: (...args: unknown[]) => mockUpdate(...args), insertOne: (...args: unknown[]) => mockInsert(...args) }) }));
jest.mock("@/lib/agentic-apps/config", () => ({ getConfiguredAgenticApp: () => ({ installation: { installed: true, enabled: true } }), loadConfiguredAgenticApps: () => [{ manifest: { id: "example" }, installation: { installed: true, enabled: true } }] }));
jest.mock("@/lib/rbac/platform-admin", () => ({ hasOrganizationAdmin: (...args: unknown[]) => mockAdmin(...args) }));
const patch = { sourceId: "app:example", eventType: "report.ready", label: "Report", description: "Report prepared", enabled: true, defaultEnabled: true, audience: "recipients", allowedChannels: ["in_app"], revision: 0 };
beforeEach(() => { jest.clearAllMocks(); mockFindOne.mockResolvedValue(null); mockAdmin.mockResolvedValue(false); });
it("locks approval requests to existing authorized reviewers", async () => {
  expect(await notificationEventPolicy("platform", "approval.requested")).toMatchObject({ locked: true, audience: "approval_reviewers", allowedChannels: ["in_app"] });
  await expect(updateNotificationEventPolicy({ ...patch, sourceId: "platform", eventType: "approval.requested" }, "operator")).rejects.toMatchObject({ statusCode: 403 });
  expect(await notificationPolicyAllows("platform", "approval.requested", "user")).toBe(false);
});
it("rechecks the admin audience instead of trusting a subscription or recipient list", async () => {
  expect(await notificationPolicyAllows("platform", "service.degraded", "user")).toBe(false);
  mockAdmin.mockResolvedValue(true);
  expect(await notificationPolicyAllows("platform", "service.degraded", "user")).toBe(true);
});
it("rejects broadening the built-in admin audience", async () => {
  await expect(updateNotificationEventPolicy({ ...patch, sourceId: "platform", eventType: "service.degraded" }, "operator")).rejects.toThrow("Cannot broaden");
});
it("enforces disablement and channel restrictions for queued delivery", async () => {
  mockFindOne.mockResolvedValue({ ...patch, enabled: false, revision: 1 });
  expect(await notificationPolicyAllows("app:example", "report.ready", "user")).toBe(false);
  mockFindOne.mockResolvedValue({ ...patch, revision: 1 });
  expect(await notificationPolicyAllows("app:example", "report.ready", "user", "web_push")).toBe(false);
});
it("stores operator overrides separately from app registrations", async () => {
  await expect(updateNotificationEventPolicy(patch, "operator")).resolves.toMatchObject({ revision: 1 });
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ updatedBy: "operator", sourceId: "app:example" }));
});
it("rejects both first-write races and stale revisions", async () => {
  mockInsert.mockRejectedValueOnce({ code: 11000 });
  await expect(updateNotificationEventPolicy(patch, "operator")).rejects.toMatchObject({ statusCode: 409 });
  mockUpdate.mockResolvedValue({ matchedCount: 0 });
  await expect(updateNotificationEventPolicy({ ...patch, revision: 1 }, "operator")).rejects.toMatchObject({ statusCode: 409 });
});
it("rejects invented platform types and unknown policy fields", async () => {
  await expect(notificationEventPolicy("platform", "invented.event")).rejects.toThrow("Unknown");
  await expect(updateNotificationEventPolicy({ ...patch, publisher: "platform" }, "operator")).rejects.toThrow("Unknown");
});
it("narrows inbox visibility for non-admins without changing legacy reviewer routing", async () => {
  const filter = await notificationPolicyInboxFilter("user", false);
  expect(filter).toEqual({ $nor: expect.arrayContaining([expect.objectContaining({ event_type: "service.degraded" })]) });
  expect(JSON.stringify(filter)).not.toContain("approval.requested");
});
it("uses operator defaults only when the user has not made an explicit choice", () => {
  expect(isNotificationEnabled("agent.started", null, true)).toBe(true);
  expect(isNotificationEnabled("agent.started", { events: { "agent.started": false } }, true)).toBe(false);
});

it("rejects an array masquerading as an audience string", async () => {
  await expect(updateNotificationEventPolicy({ ...patch, audience: ["recipients"] }, "operator")).rejects.toMatchObject({ statusCode: 400 });
});

it("protects every built-in platform event from retirement", async () => {
  for (const eventType of ["service.degraded", "approval.requested", "agent.completed"])
    await expect(changeNotificationEventLifecycle({ action: "retire", sourceId: "platform", eventType, revision: 0 }, "operator")).rejects.toMatchObject({ statusCode: 403 });
});
it("blocks future delivery for retired app events but preserves authorized history access", async () => {
  mockFindOne.mockResolvedValue({ ...patch, retired: true, revision: 1 });
  expect(await notificationPolicyAllows("app:example", "report.ready", "user")).toBe(false);
  expect(await notificationPolicyAllows("app:example", "report.ready", "user", undefined, { history: true })).toBe(true);
  expect(JSON.stringify(await notificationPolicyInboxFilter("user", false))).not.toContain("report.ready");
});
it("does not replay pending deliveries after restoration", async () => {
  mockFindOne.mockResolvedValue({ ...patch, retired: false, revision: 2, discardBefore: "2026-01-01T12:00:00.000Z" });
  expect(await notificationPolicyAllows("app:example", "report.ready", "user", "in_app", { acceptedAt: new Date("2026-01-01T11:59:00Z") })).toBe(false);
  expect(await notificationPolicyAllows("app:example", "report.ready", "user", "in_app", { acceptedAt: new Date("2026-01-01T12:01:00Z") })).toBe(true);
});
it("rejects stale lifecycle actions and direct edits to retired events", async () => {
  mockFindOne.mockResolvedValue({ ...patch, retired: true, revision: 1 });
  await expect(changeNotificationEventLifecycle({ action: "restore", sourceId: "app:example", eventType: "report.ready", revision: 0 }, "operator")).rejects.toMatchObject({ statusCode: 409 });
  await expect(updateNotificationEventPolicy({ ...patch, revision: 1 }, "operator")).rejects.toMatchObject({ statusCode: 409 });
});
