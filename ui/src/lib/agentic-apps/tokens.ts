import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type MintAgenticAppTokenInput = {
  appId: string;
  subject: string;
  name?: string;
  email?: string;
  scopes: string[];
  decisionId: string;
  correlationId: string;
  ttlSeconds?: number;
};

export type VerifiedAgenticAppToken = Record<string, unknown> & {
  iss: string;
  aud: string;
  sub: string;
  app_id: string;
  scp: string[];
  decision_id: string;
  exp: number;
};

const DEFAULT_TTL_SECONDS = 5 * 60;

/** Fail startup before exposing an enabled runtime with no signing key. */
export function validateAgenticAppTokenConfiguration(): void {
  tokenSecret();
}

export function getAgenticAppTokenAudience(appId: string): string {
  return `agentic-app:${appId}`;
}

export async function mintAgenticAppToken(
  input: MintAgenticAppTokenInput,
): Promise<{ token: string; expiresAt: string }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload = {
    iss: tokenIssuer(),
    aud: getAgenticAppTokenAudience(input.appId),
    sub: input.subject,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    ...(input.email?.trim() ? { email: input.email.trim() } : {}),
    app_id: input.appId,
    scp: input.scopes,
    scope: input.scopes.join(" "),
    decision_id: input.decisionId,
    correlation_id: input.correlationId,
    jti: randomUUID(),
    iat: issuedAt,
    exp: expiresAt,
  };
  return {
    token: signHs256(payload),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

/** Runtime helper for app SDKs and contract tests. */
export async function verifyAgenticAppToken(
  token: string,
  appId: string,
): Promise<VerifiedAgenticAppToken> {
  const payload = verifyHs256(token);
  if (payload.iss !== tokenIssuer()) throw new Error("invalid token issuer");
  if (payload.aud !== getAgenticAppTokenAudience(appId)) {
    throw new Error("invalid token audience");
  }
  if (payload.app_id !== appId) throw new Error("invalid app id");
  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new Error("invalid token subject");
  }
  if (!Array.isArray(payload.scp)) throw new Error("invalid token scopes");
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("expired token");
  }
  return payload as VerifiedAgenticAppToken;
}

function tokenIssuer(): string {
  return process.env.AGENTIC_APP_TOKEN_ISSUER?.trim() || "caipe-agentic-apps";
}

function tokenSecret(): string {
  // Kubernetes/Vault values may carry a trailing newline. Normalize it here so
  // the signer and independently deployed verifiers derive the same HMAC key.
  const secret = process.env.AGENTIC_APP_TOKEN_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AGENTIC_APP_TOKEN_SECRET must be at least 32 bytes");
  }
  return secret;
}

function signHs256(payload: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createHmac("sha256", tokenSecret())
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function verifyHs256(token: string): Record<string, unknown> {
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) throw new Error("invalid token format");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as {
    alg?: string;
  };
  if (header.alg !== "HS256") throw new Error("invalid token algorithm");
  const expected = createHmac("sha256", tokenSecret())
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");
  if (signaturePart.length !== expected.length) throw new Error("invalid token signature");
  const actualBuffer = Buffer.from(signaturePart);
  const expectedBuffer = Buffer.from(expected);
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("invalid token signature");
  }
  return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
