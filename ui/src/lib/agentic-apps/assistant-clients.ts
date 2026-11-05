import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { ApiError } from "@/lib/api-error";
import type { AuthResult } from "@/lib/da-proxy";
import type { Conversation } from "@/types/mongodb";
import type { AgenticAppManifest } from "@/types/agentic-app";

export const WEBEX_CONTEXT_HEADER = "x-caipe-webex-context";
export const WEBEX_SIGNATURE_HEADER = "x-caipe-webex-signature";
export const ASSISTANT_CONTEXT_HEADER = "x-caipe-assistant-context";
export type AssistantClientContext = {
  client: "webex";
  kind: "direct" | "group";
  conversationId: string;
  agentId: string;
  roomId: string;
  spaceId: string;
  threadId: string;
};

export function supportsAssistantClient(
  assistant: NonNullable<AgenticAppManifest["ui"]["assistant"]>,
  client: "webui" | "webex",
  kind?: "direct" | "group",
): boolean {
  return (assistant.supportedClients ?? ["webui"]).includes(client)
    && (client !== "webex" || kind !== "group" || assistant.webexGroupChat === true);
}

/** Verify bot assertions only after OIDC authentication and conversation/agent authorization. */
export async function verifyWebexAssistantContext(
  request: Request, auth: AuthResult, conversation: Conversation,
): Promise<AssistantClientContext> {
  const session = auth.authenticatedUser?.session;
  const expectedClient = process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID?.trim() || "caipe-webex-bot";
  if (!auth.subject || auth.isServiceAccount || !auth.bearerToken ||
      session?.authMethod !== "bearer" || session.authorizedParty !== expectedClient) {
    throw new ApiError("A linked user token issued to the Webex bot is required", 403);
  }
  const secret = process.env.WEBEX_LINK_HMAC_SECRET?.trim();
  const encoded = request.headers.get(WEBEX_CONTEXT_HEADER) ?? "";
  const signature = request.headers.get(WEBEX_SIGNATURE_HEADER) ?? "";
  if (!secret || Buffer.byteLength(secret) < 32 || !encoded || encoded.length > 8192 || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new ApiError("Signed Webex context is required; configure WEBEX_LINK_HMAC_SECRET on bot and host", 403);
  }
  const expected = createHmac("sha256", secret).update("caipe.webex.assistant.v1\n" + encoded).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new ApiError("Invalid Webex context signature", 403);
  let context: Record<string, unknown>;
  try { context = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new ApiError("Invalid Webex context", 403); }
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new ApiError("Invalid Webex context", 403);
  const now = Math.floor(Date.now() / 1000);
  const body = await request.clone().arrayBuffer();
  const metadata: Record<string, unknown> = conversation.metadata ?? {};
  const agent = conversation.participants.find(participant => participant.type === "agent")?.id;
  const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
  if (context.version !== 1 || context.client !== "webex" ||
      !Number.isSafeInteger(context.iat) || Math.abs(now - Number(context.iat)) > 60 ||
      context.method !== request.method || context.path !== new URL(request.url).pathname ||
      context.bodyHash !== createHash("sha256").update(Buffer.from(body)).digest("hex") ||
      context.tokenHash !== createHash("sha256").update(auth.bearerToken).digest("hex") ||
      context.conversationId !== conversation._id || context.agentId !== agent ||
      !validId(context.roomId) || !validId(context.spaceId) || !validId(context.threadId) ||
      context.roomId !== metadata.webex_room_id || context.spaceId !== metadata.webex_space_id ||
      context.threadId !== metadata.webex_message_id || typeof metadata.webex_is_direct !== "boolean" ||
      context.kind !== (metadata.webex_is_direct ? "direct" : "group")) {
    throw new ApiError("Webex context does not match this authenticated request and stored thread", 403);
  }
  return { client: "webex", kind: context.kind as "direct" | "group", conversationId: conversation._id,
    agentId: agent!, roomId: context.roomId, spaceId: context.spaceId, threadId: context.threadId };
}
