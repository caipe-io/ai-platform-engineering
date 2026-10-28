/** @jest-environment node */
import { NextRequest } from "next/server";
const mockAuth = jest.fn();
const mockPermission = jest.fn();
const mockDirectory = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
  requireRbacPermission: (...args: unknown[]) => mockPermission(...args),
}));
jest.mock("@/lib/slack-bot-admin", () => ({ callSlackBotDirectory: (...args: unknown[]) => mockDirectory(...args) }));
import { GET } from "../route";

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ session: { sub: "test-user" } });
  mockPermission.mockResolvedValue(undefined);
  delete process.env.SLACK_BOT_TOKEN;
});
it("proxies authorized directory requests without provider credentials", async () => {
  const payload = { emoji: [], cached: true, fetched_at: 123, query: { q: "example" } };
  mockDirectory.mockResolvedValue(payload);
  const response = await GET(new NextRequest("http://example.test/api/admin/slack/emoji?q=example"));
  expect(response.status).toBe(200);
  expect((await response.json()).data).toEqual(payload);
  expect(mockPermission).toHaveBeenCalledWith({ sub: "test-user" }, "admin_ui", "view");
  expect(mockDirectory).toHaveBeenCalledWith("emoji", expect.any(URLSearchParams));
});
it("does not contact the bot when browser authorization fails", async () => {
  const { ApiError } = await import("@/lib/api-middleware");
  mockPermission.mockRejectedValue(new ApiError("Forbidden", 403));
  const response = await GET(new NextRequest("http://example.test/api/admin/slack/emoji?q=example"));
  expect(response.status).toBe(403);
  expect(mockDirectory).not.toHaveBeenCalled();
});
