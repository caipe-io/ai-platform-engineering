/** @jest-environment node */
import { createHash, createHmac } from "node:crypto";
import { proxyAgenticAppAssistantStream } from "../assistant-stream";
import { getAgenticAppRoutingSnapshot } from "../config";
import { proxyAgenticAppRequest } from "../proxy";
import type { AuthResult } from "@/lib/da-proxy";
import type { Conversation } from "@/types/mongodb";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

jest.mock("../config", () => ({ ...jest.requireActual("../config"), getAgenticAppRoutingSnapshot: jest.fn() }));
jest.mock("../proxy", () => ({ proxyAgenticAppRequest: jest.fn() }));
const secret = "example-key-".repeat(4);
const body = JSON.stringify({ conversation_id: "example-chat", agent_id: "example-agent", message: "Hello", protocol: "agui" });
const auth = { subject: "example-user", bearerToken: "example-token", authenticatedUser: { user: { role: "user" },
  session: { authMethod: "bearer", authorizedParty: "example-bot" } } } as AuthResult;
const conversation = { _id: "example-chat", client_type: "webex", participants: [{ type: "agent", id: "example-agent" }],
  metadata: { webex_room_id: "example-room", webex_space_id: "example-space", webex_message_id: "example-thread", webex_is_direct: true } } as Conversation;
let app: ConfiguredAgenticApp;
const mockFindAgent = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn(async () => ({ findOne: mockFindAgent })) }));
function request() {
  const proof = { version: 1, client: "webex", kind: "direct", conversationId: conversation._id, agentId: "example-agent",
    roomId: "example-room", spaceId: "example-space", threadId: "example-thread", method: "POST", path: "/api/v1/chat/stream/start",
    iat: Math.floor(Date.now() / 1000), tokenHash: createHash("sha256").update("example-token").digest("hex"),
    bodyHash: createHash("sha256").update(body).digest("hex") };
  const encoded = Buffer.from(JSON.stringify(proof)).toString("base64url");
  return new Request("https://example.test/api/v1/chat/stream/start", { method: "POST", body,
    headers: { "x-caipe-webex-context": encoded, "x-caipe-webex-signature": createHmac("sha256", secret).update("caipe.webex.assistant.v1\n" + encoded).digest("hex") } });
}
beforeEach(() => {
  jest.clearAllMocks(); mockFindAgent.mockResolvedValue({ _id: "example-agent" }); process.env.WEBEX_LINK_HMAC_SECRET = secret; process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID = "example-bot";
  app = { installation: { appId: "example-app", installed: true, enabled: true }, manifest: { ui: { assistant: {
    agentId: "example-agent", label: "Ask", name: "Example", streamPath: "/api/example/chat", supportedClients: ["webui", "webex"] } } } } as ConfiguredAgenticApp;
  jest.mocked(getAgenticAppRoutingSnapshot).mockReturnValue([app]);
  jest.mocked(proxyAgenticAppRequest).mockResolvedValue(new Response("data: example\n\n", { headers: { "content-type": "text/event-stream" } }));
});
afterEach(() => { delete process.env.WEBEX_LINK_HMAC_SECRET; delete process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID; });
it("forwards the authorized human and verified Webex context to the existing app proxy", async () => {
  const result = await proxyAgenticAppAssistantStream(request(), auth, conversation, JSON.parse(body), "start");
  expect(result!.status).toBe(200);
  expect(proxyAgenticAppRequest).toHaveBeenCalledWith(expect.any(Request), expect.anything(), auth.authenticatedUser,
    expect.objectContaining({ client: "webex", kind: "direct", conversationId: "example-chat" }), expect.any(Function));
});
it.each(["unsupported", "disabled", "service-account", "bad-agent", "missing-proof", "unsupported-operation"])("never falls back or forwards %s", async variant => {
  let caller = auth, input = JSON.parse(body);
  const req = request();
  if (variant === "unsupported") delete app.manifest.ui.assistant!.supportedClients;
  if (variant === "disabled") app.installation.enabled = false;
  if (variant === "service-account") caller = { ...auth, isServiceAccount: true };
  if (variant === "bad-agent") input = { ...input, agent_id: "other-agent" };
  if (variant === "missing-proof") req.headers.delete("x-caipe-webex-context");
  const result = await proxyAgenticAppAssistantStream(req, caller, conversation, input, variant === "unsupported-operation" ? "resume" : "start");
  expect(result).not.toBeNull(); expect(result!.ok).toBe(false); expect(proxyAgenticAppRequest).not.toHaveBeenCalled();
});
it("preserves the browser caller and rejects a non-SSE native response", async () => {
  const browser = { ...auth, bearerToken: undefined, authenticatedUser: { ...auth.authenticatedUser!, session: { authMethod: "session" } } } as AuthResult;
  const chat = { ...conversation, client_type: "webui" } as Conversation;
  jest.mocked(proxyAgenticAppRequest).mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
  expect((await proxyAgenticAppAssistantStream(request(), browser, chat, JSON.parse(body), "start"))!.status).toBe(502);
});


describe("additional registered agents", () => {
  const browser = { ...auth, bearerToken: undefined, authenticatedUser: { ...auth.authenticatedUser!, session: { authMethod: "session" } } } as AuthResult;
  const chat = { ...conversation, client_type: "webui" } as Conversation;
  beforeEach(() => {
    app.manifest.ui.assistant!.agentId = "primary-agent";
    app.installation.bindings = { agentStreams: [{ id: "secondary", agentId: "example-agent", streamPath: "/api/example/secondary/start",
      cancelPath: "/api/example/secondary/cancel", statusPath: "/api/example/secondary/status" }] };
  });
  it("dispatches an enabled registered agent with the exact caller and publisher route", async () => {
    const response = await proxyAgenticAppAssistantStream(request(), browser, chat, JSON.parse(body), "start");
    expect(response!.status).toBe(200);
    expect(mockFindAgent).toHaveBeenCalledWith({ _id: "example-agent", enabled: true }, { projection: { _id: 1 } });
    expect(proxyAgenticAppRequest).toHaveBeenCalledWith(expect.any(Request),
      { params: expect.any(Promise) }, browser.authenticatedUser, undefined, expect.any(Function));
    const { params } = jest.mocked(proxyAgenticAppRequest).mock.calls[0][1];
    expect(await params).toEqual({ appId: "example-app", path: ["api", "example", "secondary", "start"] });
  });
  it("does not inherit the primary agent's Webex support", async () => {
    expect((await proxyAgenticAppAssistantStream(request(), auth, conversation, JSON.parse(body), "start"))!.status).toBe(403);
    expect(proxyAgenticAppRequest).not.toHaveBeenCalled();
    app.installation.bindings!.agentStreams![0].supportedClients = ["webex"];
    expect((await proxyAgenticAppAssistantStream(request(), auth, conversation, JSON.parse(body), "start"))!.status).toBe(200);
  });
  it.each(["disabled", "registry failure"])("never falls back for %s", async (failure) => {
    if (failure === "disabled") mockFindAgent.mockResolvedValue(null);
    else mockFindAgent.mockRejectedValue(new Error("temporarily unavailable"));
    const response = await proxyAgenticAppAssistantStream(request(), browser, chat, JSON.parse(body), "start");
    expect(response!.status).toBe(failure === "disabled" ? 409 : 503);
    expect(proxyAgenticAppRequest).not.toHaveBeenCalled();
  });
  it.each(["cancel", "status"] as const)("permits %s for an existing run after disabling its agent", async (operation) => {
    mockFindAgent.mockResolvedValue(null);
    jest.mocked(proxyAgenticAppRequest).mockResolvedValue(Response.json({ success: true }));
    const response = await proxyAgenticAppAssistantStream(request(), browser, chat, JSON.parse(body), operation);
    expect(response!.status).toBe(200);
    expect(response!.headers.get("cache-control")).toBe("private, no-store");
    expect(mockFindAgent).not.toHaveBeenCalled();
  });
});

it("preserves a primary logical app assistant without requiring a native agent registry row", async () => {
  mockFindAgent.mockResolvedValue(null);
  const browser = { ...auth, bearerToken: undefined, authenticatedUser: { ...auth.authenticatedUser!, session: { authMethod: "session" } } } as AuthResult;
  const response = await proxyAgenticAppAssistantStream(request(), browser, { ...conversation, client_type: "webui" } as Conversation, JSON.parse(body), "start");
  expect(response!.status).toBe(200); expect(mockFindAgent).not.toHaveBeenCalled();
});
