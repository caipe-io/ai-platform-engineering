/** @jest-environment node */
import { NextRequest } from "next/server";
const mockDirectory = jest.fn();
const mockEnabled = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: async () => ({ session: { sub: "test-user" } }),
  requireRbacPermission: async () => undefined,
}));
jest.mock("@/lib/slack-bot-admin", () => ({ callSlackBotDirectory: (...args: unknown[]) => mockDirectory(...args) }));
jest.mock("@/lib/integration-config", () => ({ isSlackIntegrationEnabled: () => mockEnabled() }));
import { GET } from "../route";
beforeEach(() => jest.clearAllMocks());
it("returns the authenticated bot-owned status with no UI provider token", async () => {
  mockEnabled.mockReturnValue(true);
  const payload = { configured: true, bot_admin: { reachable: true }, users: { status: "ready" }, emoji: { status: "warming" } };
  mockDirectory.mockResolvedValue(payload);
  const response = await GET(new NextRequest("http://example.test/api/admin/slack/directory/status"));
  expect((await response.json()).data).toEqual(payload);
});
it("keeps a botless installation disabled", async () => {
  mockEnabled.mockReturnValue(false);
  const response = await GET(new NextRequest("http://example.test/api/admin/slack/directory/status"));
  expect((await response.json()).data.configured).toBe(false);
  expect(mockDirectory).not.toHaveBeenCalled();
});
it("reports unreachable bot without a failed status endpoint", async () => {
  mockEnabled.mockReturnValue(true);
  mockDirectory.mockRejectedValue(new Error("Bot unavailable"));
  const response = await GET(new NextRequest("http://example.test/api/admin/slack/directory/status"));
  expect((await response.json()).data.bot_admin).toEqual({ reachable: false, error: "Bot unavailable" });
});
