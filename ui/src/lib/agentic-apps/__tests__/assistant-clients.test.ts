/** @jest-environment node */
import { createHash, createHmac } from "node:crypto";
import { supportsAssistantClient, verifyWebexAssistantContext } from "../assistant-clients";
import type { AuthResult } from "@/lib/da-proxy";
import type { Conversation } from "@/types/mongodb";

const secret = "example-shared-key-".repeat(3);
const bearerToken = "example-user-token";
const conversation = { _id: "example-chat", client_type: "webex", participants: [{ type: "agent", id: "example-agent" }],
  metadata: { webex_room_id: "example-room", webex_space_id: "example-space", webex_message_id: "example-thread", webex_is_direct: true } } as Conversation;
const auth = { subject: "example-user", bearerToken, isServiceAccount: false,
  authenticatedUser: { session: { sub: "example-user", authMethod: "bearer", authorizedParty: "example-bot" } } } as AuthResult;
function request(changes: Record<string, unknown> = {}, body = '{"message":"Hello 🌍"}') {
  const proof = { version: 1, client: "webex", kind: "direct", iat: Math.floor(Date.now() / 1000), method: "POST",
    path: "/api/v1/chat/stream/start", bodyHash: createHash("sha256").update(body).digest("hex"),
    tokenHash: createHash("sha256").update(bearerToken).digest("hex"), conversationId: "example-chat", agentId: "example-agent",
    roomId: "example-room", spaceId: "example-space", threadId: "example-thread", ...changes };
  const encoded = Buffer.from(JSON.stringify(proof)).toString("base64url");
  return new Request("https://example.test/api/v1/chat/stream/start", { method: "POST", body,
    headers: { "x-caipe-webex-context": encoded, "x-caipe-webex-signature": createHmac("sha256", secret).update("caipe.webex.assistant.v1\n" + encoded).digest("hex") } });
}
beforeEach(() => { process.env.WEBEX_LINK_HMAC_SECRET = secret; process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID = "example-bot"; });
afterEach(() => { delete process.env.WEBEX_LINK_HMAC_SECRET; delete process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID; });

it("accepts a linked non-admin bearer and signed context for the stored thread", async () => {
  await expect(verifyWebexAssistantContext(request(), auth, conversation)).resolves.toMatchObject({ client: "webex", kind: "direct", conversationId: "example-chat" });
});
it.each([
  { iat: 1 }, { iat: Math.floor(Date.now() / 1000) + 300 }, { kind: "group" }, { conversationId: "other-chat" },
  { agentId: "other-agent" }, { roomId: "other-room" }, { tokenHash: "other-token" }, { bodyHash: "other-body" },
  { path: "/api/other" }, { method: "GET" },
])("rejects a mismatched or expired assertion: %j", async change => {
  await expect(verifyWebexAssistantContext(request(change), auth, conversation)).rejects.toThrow();
});
it("rejects service accounts, other OAuth clients, absent secrets and forged signatures", async () => {
  await expect(verifyWebexAssistantContext(request(), { ...auth, isServiceAccount: true }, conversation)).rejects.toThrow();
  await expect(verifyWebexAssistantContext(request(), { ...auth, authenticatedUser: { ...auth.authenticatedUser!,
    session: { ...auth.authenticatedUser!.session, authorizedParty: "other-client" } } }, conversation)).rejects.toThrow();
  const forged = request(); forged.headers.set("x-caipe-webex-signature", "0".repeat(64));
  await expect(verifyWebexAssistantContext(forged, auth, conversation)).rejects.toThrow();
  delete process.env.WEBEX_LINK_HMAC_SECRET;
  await expect(verifyWebexAssistantContext(request(), auth, conversation)).rejects.toThrow();
});
it("keeps support opt-in and group support separately opt-in", () => {
  const assistant = { agentId: "example-agent", label: "Ask", name: "Example" };
  expect(supportsAssistantClient(assistant, "webui")).toBe(true);
  expect(supportsAssistantClient(assistant, "webex")).toBe(false);
  const enabled = { ...assistant, supportedClients: ["webui", "webex"] as Array<"webui" | "webex"> };
  expect(supportsAssistantClient(enabled, "webex", "direct")).toBe(true);
  expect(supportsAssistantClient(enabled, "webex", "group")).toBe(false);
  expect(supportsAssistantClient({ ...enabled, webexGroupChat: true }, "webex", "group")).toBe(true);
});
