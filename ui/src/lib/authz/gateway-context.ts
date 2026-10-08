import { createHmac, timingSafeEqual } from "crypto";

import type { Subject } from "./contract";
import type { GatewayContext } from "./gateway-contract";

const AUDIENCE = "caipe-gateway";
const MAX_AGE_SECONDS = 300;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.~-]{0,191}$/;

/** Temporary coordinated dev cutover, not support for mixed protocol versions. */
export function gatewayCasEnabled(): boolean {
  return process.env.CAIPE_GATEWAY_CAS_ENABLED === "true";
}

export function isGatewayIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isCaller(value: unknown): value is Subject {
  if (!value || typeof value !== "object") return false;
  const caller = value as Partial<Subject>;
  return (caller.type === "user" || caller.type === "service_account") && isGatewayIdentifier(caller.id);
}

function signingSecret(): string {
  const secret = process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("Gateway context signing requires a secret of at least 32 characters");
  return secret;
}

/** Trusted BFF producers only. Context proves binding, never grants permission. */
export function signGatewayContext(
  caller: Subject, agentId?: string, now = Math.floor(Date.now() / 1000),
): { encoded: string; signature: string } {
  if (!isCaller(caller) || (agentId !== undefined && !isGatewayIdentifier(agentId))) {
    throw new Error("Invalid gateway context identity");
  }
  const payload: GatewayContext = {
    version: 1, audience: AUDIENCE, caller,
    kind: agentId === undefined ? "direct" : "dynamic",
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    iat: now, exp: now + MAX_AGE_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { encoded, signature: createHmac("sha256", signingSecret()).update(encoded).digest("hex") };
}

export function verifyGatewayContext(
  signed: { encoded: string; signature: string } | undefined, caller: Subject,
  now = Math.floor(Date.now() / 1000),
): GatewayContext | null {
  const currentSecret = signingSecret();
  if (!signed || signed.encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(signed.encoded) ||
      !/^[a-f0-9]{64}$/.test(signed.signature)) return null;
  // Remove the previous key after old issuers stop and their five-minute contexts expire.
  const previous = process.env.CAIPE_AGENT_CONTEXT_PREVIOUS_HMAC_SECRET?.trim();
  const secrets = [currentSecret, ...(previous && previous.length >= 32 ? [previous] : [])];
  const signature = Buffer.from(signed.signature, "hex");
  if (!secrets.some((secret) => timingSafeEqual(
    signature, createHmac("sha256", secret).update(signed.encoded).digest(),
  ))) return null;
  let payload: Partial<GatewayContext>;
  try { payload = JSON.parse(Buffer.from(signed.encoded, "base64url").toString("utf8")); } catch { return null; }
  if (!payload || payload.version !== 1 || payload.audience !== AUDIENCE || !isCaller(payload.caller) ||
      payload.caller.type !== caller.type || payload.caller.id !== caller.id ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null;
  const { iat, exp } = payload as GatewayContext;
  if (iat > now + 5 || exp <= now || exp <= iat || exp - iat > MAX_AGE_SECONDS) return null;
  if (payload.kind === "dynamic" ? !isGatewayIdentifier(payload.agent_id) :
      payload.kind !== "direct" || payload.agent_id !== undefined) return null;
  return payload as GatewayContext;
}
