/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";

import { GET } from "../chat/conversations/[id]/presence/route";
import { authenticateChatStreamRequest } from "../v1/chat/_stream-auth";

const mockAuth = jest.fn();
const mockAccess = jest.fn();
const mockStream = jest.fn();
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/auth/dev-auth-provider", () => ({ isDevAnonymousAuthEnabled: () => false }));
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true }));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({ authorizeConversationReadAccess: (...args: unknown[]) => mockAccess(...args) }));
jest.mock("@/lib/conversation-presence", () => ({ conversationPresenceStream: (...args: unknown[]) => mockStream(...args) }));
jest.mock("@/lib/api-middleware", () => ({ withErrorHandler: (handler: unknown) => handler, validateConversationId: (id: string) => /^[a-z-]+$/.test(id) }));

const auth = { subject: "primary", authenticatedUser: { user: { name: "Example User" }, session: { authMethod: "session" } } };
const request = (headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) => new NextRequest("https://example.test/api/chat/conversations/chat-example/presence", { headers });
const context = { params: Promise.resolve({ id: "chat-example" }) };
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NEXTAUTH_URL;
  mockAuth.mockResolvedValue(auth);
  mockAccess.mockResolvedValue({ denial: null });
  mockStream.mockReturnValue(new ReadableStream({ start(controller) { controller.close(); } }));
});

it("allows read-only viewers and takes identity only from authenticated credentials", async () => {
  const response = await GET(request(), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(mockAccess).toHaveBeenCalledWith(auth, "chat-example");
  expect(mockStream.mock.calls[0].slice(0, 2)).toEqual(["chat-example", auth]);
});

it("does not register or reveal viewers to an unauthorized caller", async () => {
  mockAccess.mockResolvedValue({ denial: NextResponse.json({ error: "Denied" }, { status: 403 }) });
  expect((await GET(request(), context)).status).toBe(403);
  expect(mockStream).not.toHaveBeenCalled();
  mockAuth.mockResolvedValue(NextResponse.json({ error: "Sign in" }, { status: 401 }));
  expect((await GET(request(), context)).status).toBe(401);
});

it("rechecks session validity and conversation permissions on the live connection", async () => {
  await GET(request(), context);
  const reauthorize = mockStream.mock.calls[0][3];
  expect(await reauthorize()).toBe(true);
  mockAccess.mockResolvedValue({ denial: new NextResponse(null, { status: 403 }) });
  expect(await reauthorize()).toBe(false);
  mockAuth.mockResolvedValue(new NextResponse(null, { status: 401 }));
  expect(await reauthorize()).toBe(false);
});

it("allows transient auth failures to reconnect rather than permanently closing as revoked", async () => {
  await GET(request(), context);
  const reauthorize = mockStream.mock.calls[0][3];
  mockAuth.mockResolvedValue(new NextResponse(null, { status: 503 }));
  await expect(reauthorize()).rejects.toThrow("temporarily unavailable");
  mockAuth.mockResolvedValue(auth);
  mockAccess.mockResolvedValue({ denial: new NextResponse(null, { status: 503 }) });
  await expect(reauthorize()).rejects.toThrow("temporarily unavailable");
});

it.each([
  {}, { "sec-fetch-site": "cross-site" },
  { "sec-fetch-site": "same-origin", origin: "https://other.example.test" },
])("rejects missing or cross-site origin evidence for cookie streams: %j", async headers => {
  expect((await GET(request(headers), context)).status).toBe(403);
  expect(mockStream).not.toHaveBeenCalled();
});

it("still requires Origin on cookie-authenticated mutations and rejects malformed bearer credentials", async () => {
  const post = new NextRequest("https://example.test/api/v1/chat/stream/start", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
  expect((await authenticateChatStreamRequest(post) as NextResponse).status).toBe(403);
  expect((await GET(request({ authorization: "Bearer invalid token" }), context)).status).toBe(401);
  expect(mockStream).not.toHaveBeenCalled();
});
