import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { TrustedAuthorizeContext } from "./contract";

const MAX_CLOCK_SKEW_SECONDS = 90;
const HEADER_SOURCE = "x-caipe-interaction-source";
const HEADER_KIND = "x-caipe-interaction-kind";
const HEADER_TIMESTAMP = "x-caipe-interaction-timestamp";
const HEADER_SIGNATURE = "x-caipe-interaction-signature";
const HEADER_CLIENT_SOURCE = "x-client-source";

export type TrustedInteraction = NonNullable<TrustedAuthorizeContext["interaction"]>;

function signingSecret(source: string): string {
  if (source === "slack") {
    return process.env.SLACK_LINK_HMAC_SECRET?.trim()
      || process.env.SLACK_SIGNING_SECRET?.trim()
      || "";
  }
  if (source === "webex") {
    return process.env.WEBEX_LINK_HMAC_SECRET?.trim()
      || process.env.WEBEX_SIGNING_SECRET?.trim()
      || "";
  }
  return "";
}

function signaturePayload(input: {
  source: string;
  kind: string;
  timestamp: string;
  method: string;
  pathname: string;
}): string {
  return [input.source, input.kind, input.timestamp, input.method.toUpperCase(), input.pathname].join("\n");
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Verify bot-authored interaction metadata. Public body fields such as
 * client_context.surface_kind are deliberately ignored.
 */
interface InteractionRequest {
  headers: { get(name: string): string | null };
  method: string;
  nextUrl: { pathname: string };
}

export function trustedInteractionFromRequest(request: InteractionRequest): TrustedInteraction {
  const source = request.headers.get(HEADER_SOURCE)?.trim().toLowerCase() ?? "";
  const kind = request.headers.get(HEADER_KIND)?.trim().toLowerCase() ?? "";
  const timestamp = request.headers.get(HEADER_TIMESTAMP)?.trim() ?? "";
  const suppliedSignature = request.headers.get(HEADER_SIGNATURE)?.trim() ?? "";
  const secret = signingSecret(source);
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const identifiedBotSource = (() => {
    const clientSource = request.headers.get(HEADER_CLIENT_SOURCE)?.trim().toLowerCase() ?? "";
    if (clientSource.includes("slack")) return "slack" as const;
    if (clientSource.includes("webex")) return "webex" as const;
    return null;
  })();
  const assertedBotSource = source === "slack" || source === "webex" ? source : null;

  if (
    (source !== "slack" && source !== "webex")
    || (kind !== "direct" && kind !== "group")
    || !Number.isSafeInteger(timestampSeconds)
    || Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS
    || !secret
  ) {
    // A bot that identifies itself must never fall back to the browser policy
    // when its signing secret is absent, stale, or malformed. Treat it as an
    // unverified bot request so private use fails closed.
    if (identifiedBotSource || assertedBotSource) {
      return {
        source: identifiedBotSource ?? assertedBotSource!,
        conversationKind: "unknown",
        verified: false,
      };
    }
    return { source: "web", conversationKind: "personal", verified: false };
  }

  const expected = createHmac("sha256", secret)
    .update(signaturePayload({
      source,
      kind,
      timestamp,
      method: request.method,
      pathname: request.nextUrl.pathname,
    }))
    .digest("hex");

  if (!constantTimeEqualHex(suppliedSignature, expected)) {
    if (identifiedBotSource || assertedBotSource) {
      return {
        source: identifiedBotSource ?? assertedBotSource!,
        conversationKind: "unknown",
        verified: false,
      };
    }
    return { source: "web", conversationKind: "personal", verified: false };
  }

  return {
    source,
    conversationKind: kind,
    verified: true,
  };
}

export const TRUSTED_INTERACTION_HEADERS = {
  source: HEADER_SOURCE,
  kind: HEADER_KIND,
  timestamp: HEADER_TIMESTAMP,
  signature: HEADER_SIGNATURE,
} as const;

const INTERNAL_CONTEXT_HEADER = "X-CAIPE-Trusted-Interaction";
const INTERNAL_SIGNATURE_HEADER = "X-CAIPE-Trusted-Interaction-Signature";

function internalSecret(): string {
  return process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET?.trim() || "";
}

export function addTrustedInteractionToBody(
  body: Record<string, unknown>,
  interaction: TrustedInteraction,
  subject?: string,
): void {
  const existing = body.client_context;
  const context = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};
  delete context._caipe_trusted_interaction;
  delete context._caipe_trusted_interaction_signature;

  const headers = trustedInteractionProofHeaders(interaction, subject && typeof body.agent_id === "string"
    ? { subject, agentId: body.agent_id, executionId: randomUUID() }
    : undefined);
  const token = headers[INTERNAL_CONTEXT_HEADER];
  const signature = headers[INTERNAL_SIGNATURE_HEADER];
  if (token && signature) {
    context._caipe_trusted_interaction = token;
    context._caipe_trusted_interaction_signature = signature;
  }
  body.client_context = context;
}

function isPermittedPrivateInteraction(interaction: TrustedInteraction): boolean {
  if (interaction.source === "web" && interaction.conversationKind === "personal") {
    return true;
  }
  return interaction.verified
    && interaction.conversationKind === "direct"
    && (interaction.source === "slack" || interaction.source === "webex");
}

/** Mint the short-lived BFF proof forwarded to credential and MCP enforcement. */
export function trustedInteractionProofHeaders(
  interaction: TrustedInteraction,
  execution?: { subject: string; agentId: string; executionId: string },
): Record<string, string> {
  const secret = internalSecret();
  if (!secret || !isPermittedPrivateInteraction(interaction)) return {};
  const now = Math.floor(Date.now() / 1000);
  const token = Buffer.from(JSON.stringify({
    source: interaction.source,
    conversationKind: interaction.conversationKind,
    iat: now,
    exp: now + MAX_CLOCK_SKEW_SECONDS,
    ...(execution ? {
      subject: execution.subject, agent_id: execution.agentId,
      execution_id: execution.executionId, renewal_exp: now + 900,
    } : {}),
  })).toString("base64url");
  return {
    [INTERNAL_CONTEXT_HEADER]: token,
    [INTERNAL_SIGNATURE_HEADER]: createHmac("sha256", secret).update(token).digest("hex"),
  };
}

export function trustedInteractionFromInternalHeaders(headers: Headers, subject?: string): TrustedInteraction {
  const token = headers.get(INTERNAL_CONTEXT_HEADER)?.trim() || "";
  const suppliedSignature = headers.get(INTERNAL_SIGNATURE_HEADER)?.trim() || "";
  const secret = internalSecret();
  if (!token || !secret) return { source: "api", conversationKind: "unknown", verified: false };
  const expected = createHmac("sha256", secret).update(token).digest("hex");
  if (!constantTimeEqualHex(suppliedSignature, expected)) {
    return { source: "api", conversationKind: "unknown", verified: false };
  }
  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (
      !(
        (payload.source === "web" && payload.conversationKind === "personal")
        || ((payload.source === "slack" || payload.source === "webex")
          && payload.conversationKind === "direct")
      )
      || (payload.subject !== undefined && payload.subject !== subject)
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
      || payload.iat > now + MAX_CLOCK_SKEW_SECONDS
      || payload.exp < now
      || payload.exp - payload.iat > MAX_CLOCK_SKEW_SECONDS
    ) {
      return { source: "api", conversationKind: "unknown", verified: false };
    }
    return {
      source: payload.source,
      conversationKind: payload.conversationKind,
      verified: true,
    } as TrustedInteraction;
  } catch {
    return { source: "api", conversationKind: "unknown", verified: false };
  }
}

export const INTERNAL_TRUSTED_INTERACTION_HEADERS = {
  token: INTERNAL_CONTEXT_HEADER,
  signature: INTERNAL_SIGNATURE_HEADER,
} as const;
