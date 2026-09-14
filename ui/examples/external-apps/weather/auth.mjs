// SPDX-License-Identifier: Apache-2.0

import { createHmac, timingSafeEqual } from "node:crypto";

const APP_ID = "weather";
const AUDIENCE = `agentic-app:${APP_ID}`;
const DEFAULT_ISSUER = "caipe-agentic-apps";

/**
 * Create a verifier for the short-lived app-bound JWT issued by the CAIPE
 * runtime gateway. The dedicated secret is deliberately required at startup;
 * this sample has no production authentication bypass.
 */
export function createWeatherJwtVerifier({
  secret = process.env.AGENTIC_APP_TOKEN_SECRET,
  issuer = process.env.AGENTIC_APP_TOKEN_ISSUER ?? DEFAULT_ISSUER,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const normalizedSecret = requiredSecret(secret);
  const normalizedIssuer = String(issuer ?? "").trim();
  if (!normalizedIssuer) {
    throw new Error("AGENTIC_APP_TOKEN_ISSUER must not be empty");
  }

  return function verifyRequest(headers, requiredScope) {
    const token = extractBearer(headers);
    if (!token) return unauthorized("missing_bearer_token");

    let claims;
    try {
      claims = verifyToken(token, {
        secret: normalizedSecret,
        issuer: normalizedIssuer,
        now: now(),
      });
    } catch {
      return unauthorized("invalid_token");
    }

    const scopes = claims.scp.map((scope) => scope.trim());
    if (requiredScope && !scopes.includes(requiredScope)) {
      return {
        ok: false,
        status: 403,
        error: "insufficient_scope",
        requiredScope,
      };
    }

    return {
      ok: true,
      identity: {
        subject: claims.sub.trim(),
        appId: claims.app_id,
        audience: claims.aud,
        scopes,
      },
    };
  };
}

function verifyToken(token, { secret, issuer, now }) {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !isBase64Url(segment))) {
    throw new Error("invalid_token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJson(encodedHeader);
  if (header.alg !== "HS256") throw new Error("invalid_algorithm");

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("invalid_signature");
  }

  const claims = decodeJson(encodedPayload);
  if (
    claims.iss !== issuer ||
    claims.aud !== AUDIENCE ||
    claims.app_id !== APP_ID ||
    typeof claims.sub !== "string" ||
    !claims.sub.trim() ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Array.isArray(claims.scp) ||
    claims.scp.some((scope) => typeof scope !== "string" || !scope.trim())
  ) {
    throw new Error("invalid_claims");
  }
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) {
    throw new Error("token_not_active");
  }
  return claims;
}

function requiredSecret(value) {
  const secret = String(value ?? "").trim();
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "AGENTIC_APP_TOKEN_SECRET is required and must be at least 32 bytes after trimming",
    );
  }
  return secret;
}

function extractBearer(headers) {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = typeof value === "string" ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

function isBase64Url(value) {
  return typeof value === "string" && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function decodeJson(value) {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_json");
  }
  return parsed;
}

function unauthorized(error) {
  return { ok: false, status: 401, error };
}
