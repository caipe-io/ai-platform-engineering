import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth-config";
import { getStoredSession } from "@/lib/auth-token-store";
import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import { randomUUID } from "node:crypto";

export interface CoordinationPolicy {
  _id: string;
  generation: string;
  mode: "mentions" | "team";
  owner: string;
  sessionId?: string;
  expiresAt: Date;
}

export async function coordinationPolicy(conversationId: string) {
  return (await getCollection<CoordinationPolicy>("chat_coordination_policies")).findOne({ _id: conversationId });
}

/** Store a reference to the existing encrypted login; never copy rotating credentials. */
export async function setCoordinationPolicy(request: NextRequest, conversationId: string, owner: string, mode: "mentions" | "team") {
  let sessionId: string | undefined;
  let expiresAt = new Date();
  if (mode === "team") {
    const token = await getToken({ req: request, cookieName: authOptions.cookies!.sessionToken!.name, decode: authOptions.jwt!.decode });
    if (token?.sub !== owner || typeof token.sessionId !== "string" || token.error) {
      throw new ApiError("Sign in to enable team coordination for this chat.", 401);
    }
    const session = await getStoredSession(token.sessionId, owner);
    sessionId = session.sessionId;
    expiresAt = new Date(session.sessionExpiresAt * 1000);
  }
  const policy: CoordinationPolicy = { _id: conversationId, generation: randomUUID(), mode, owner, sessionId, expiresAt };
  await (await getCollection<CoordinationPolicy>("chat_coordination_policies")).replaceOne({ _id: conversationId }, policy, { upsert: true });
}
