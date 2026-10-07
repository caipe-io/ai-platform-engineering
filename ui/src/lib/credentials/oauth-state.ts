import { createHash,createHmac,randomBytes,timingSafeEqual } from "crypto";

import { ApiError } from "@/lib/api-error";

export interface OAuthStatePayload {
  providerKey: string;
  ownerId: string;
  state: string;
  codeVerifier: string;
  issuedAt: number;
  // The user's per-connection scope selection chosen at connect time. Absent
  // ⇒ the connector default was used (legacy behavior). Carried through the
  // signed state cookie so the callback can persist it on the connection.
  requestedScopes?: string[];
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function stateSecret(): string {
  return process.env.CREDENTIAL_OAUTH_STATE_SECRET || process.env.NEXTAUTH_SECRET || "caipe-local-oauth-state";
}

export function randomOAuthValue(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function createOAuthStateCookie(input: {
  providerKey: string;
  ownerId: string;
  state: string;
  codeVerifier: string;
  requestedScopes?: string[];
  secret?: string;
  nowMs?: number;
}): string {
  const payload: OAuthStatePayload = {
    providerKey: input.providerKey,
    ownerId: input.ownerId,
    state: input.state,
    codeVerifier: input.codeVerifier,
    issuedAt: input.nowMs ?? Date.now(),
    ...(input.requestedScopes ? { requestedScopes: input.requestedScopes } : {}),
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, input.secret ?? stateSecret())}`;
}

// Matches the cookie's own Max-Age=600 (start/connect routes) so a state
// value that outlives its cookie's intended lifetime — e.g. one recovered
// from a log — doesn't still verify.
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

export function parseOAuthStateCookie(
  value: string,
  secret = stateSecret(),
  options: { maxAgeMs?: number; nowMs?: number } = {}
): OAuthStatePayload {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) {
    throw new ApiError("Invalid OAuth state", 400, "INVALID_OAUTH_STATE");
  }
  const expected = sign(encoded, secret);
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    throw new ApiError("Invalid OAuth state", 400, "INVALID_OAUTH_STATE");
  }
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  if (nowMs - payload.issuedAt > maxAgeMs) {
    throw new ApiError("Invalid OAuth state", 400, "INVALID_OAUTH_STATE");
  }
  return payload;
}

export function oauthStateCookieName(providerKey: string): string {
  return `caipe_oauth_state_${providerKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
