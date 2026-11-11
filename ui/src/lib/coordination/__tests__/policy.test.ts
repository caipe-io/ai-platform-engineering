/** @jest-environment node */
import { NextRequest } from "next/server";
import { setCoordinationPolicy } from "../policy.server";
const mockReplace = jest.fn();
const mockDecode = jest.fn();
const mockSession = jest.fn();
jest.mock("@/lib/auth-config", () => ({ authOptions: {
  cookies: { sessionToken: { name: "next-auth.session-token" } },
  jwt: { decode: (...args: unknown[]) => mockDecode(...args) },
} }));
jest.mock("@/lib/auth-token-store", () => ({ getStoredSession: (...args: unknown[]) => mockSession(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ replaceOne: mockReplace }) }));
beforeEach(() => {
  jest.resetAllMocks();
  process.env.NEXTAUTH_SECRET = "test-session-encryption-key";
  process.env.NEXTAUTH_URL = "https://example.test";
  mockDecode.mockResolvedValue({ sub: "test-owner", sessionId: "test-login" });
  mockSession.mockResolvedValue({ sessionId: "test-login", sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
});
it("uses the configured login cookie name even on HTTPS and stores only its reference", async () => {
  const request = new NextRequest("https://example.test/api/chat/conversations/example/agents", { headers: { cookie: "next-auth.session-token=example-encrypted-cookie" } });
  await setCoordinationPolicy(request, "example-chat", "test-owner", "team");
  expect(mockDecode).toHaveBeenCalledWith(expect.objectContaining({ token: "example-encrypted-cookie" }));
  expect(mockReplace).toHaveBeenCalledWith({ _id: "example-chat" }, expect.objectContaining({ owner: "test-owner", sessionId: "test-login", mode: "team" }), { upsert: true });
  expect(JSON.stringify(mockReplace.mock.calls)).not.toContain("example-encrypted-cookie");
});
it("rejects a different login subject and an expired session without saving authorization", async () => {
  const request = new NextRequest("https://example.test/api/chat/conversations/example/agents", { headers: { cookie: "next-auth.session-token=example" } });
  mockDecode.mockResolvedValueOnce({ sub: "other-owner", sessionId: "other-login" });
  await expect(setCoordinationPolicy(request, "example-chat", "test-owner", "team")).rejects.toThrow("Sign in");
  mockSession.mockRejectedValueOnce(new Error("Session revoked"));
  await expect(setCoordinationPolicy(request, "example-chat", "test-owner", "team")).rejects.toThrow();
  expect(mockReplace).not.toHaveBeenCalled();
});
it("can disable coordination without retaining the delegated session reference", async () => {
  await setCoordinationPolicy(new NextRequest("https://example.test"), "example-chat", "test-owner", "mentions");
  expect(mockReplace.mock.calls[0][1].sessionId).toBeUndefined();
  expect(mockDecode).not.toHaveBeenCalled();
});
