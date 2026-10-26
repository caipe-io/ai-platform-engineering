/** @jest-environment node */
import { NextRequest } from "next/server";
const mockAuth = jest.fn();
const mockPermission = jest.fn();
const mockDirectory = jest.fn();
const mockConfigured = jest.fn();
const mockPending = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: (...args: unknown[]) => mockPermission(...args) }));
jest.mock("@/lib/slack-bot-admin", () => ({ callSlackBotDirectory: (...args: unknown[]) => mockDirectory(...args) }));
jest.mock("@/lib/rbac/slack-channel-configured-directory", () => ({ configuredSlackChannelsById: (...args: unknown[]) => mockConfigured(...args) }));
jest.mock("@/lib/publication-approval.server", () => ({
  activeConnectorPublicationRequestsByItemId: (...args: unknown[]) => mockPending(...args),
  publicationActorFromSession: () => ({ userId: "test-user" }),
  connectorPublicationRequestView: (value: unknown) => value,
}));
import { GET } from "../route";
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ session: { sub: "test-user" } });
  mockPermission.mockResolvedValue(undefined);
  mockConfigured.mockResolvedValue(new Map([["C1", { teamSlug: "example", teamName: "Example", agentId: "example-agent" }]]));
  mockPending.mockResolvedValue(new Map([["C2", { id: "request-1" }]]));
  delete process.env.SLACK_BOT_TOKEN;
});
it("retains channel authorization, configuration and publication enrichment on bot results", async () => {
  mockDirectory.mockResolvedValue({ channels: [{ id: "C1", name: "alpha" }, { id: "C2", name: "beta" }], next_cursor: "beta", cached: true });
  const response = await GET(new NextRequest("http://example.test/api/admin/slack/available-channels?limit=2"));
  const data = (await response.json()).data;
  expect(response.status).toBe(200);
  expect(mockPermission).toHaveBeenCalledWith({ sub: "test-user" }, { type: "admin_surface", id: "slack", action: "read" }, { bypassForOrgAdmin: true });
  expect(data).toMatchObject({ next_cursor: "beta", cached: true });
  expect(data.channels[0]).toMatchObject({ configured: true, configured_team_slug: "example", configured_agent_id: "example-agent" });
  expect(data.channels[1]).toMatchObject({ configured: false, pending_publication: { id: "request-1" } });
  expect(mockDirectory).toHaveBeenCalledWith("channels", expect.any(URLSearchParams));
});
it("does not call the bot before browser permission is checked", async () => {
  const { ApiError } = await import("@/lib/api-middleware");
  mockPermission.mockRejectedValue(new ApiError("Forbidden", 403));
  const response = await GET(new NextRequest("http://example.test/api/admin/slack/available-channels"));
  expect(response.status).toBe(403);
  expect(mockDirectory).not.toHaveBeenCalled();
});
