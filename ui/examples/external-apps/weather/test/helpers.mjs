// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";

export const TEST_SECRET = ["weather", "example", "test", "key", "x".repeat(32)].join("-");

export function mintTestToken({
  secret = TEST_SECRET,
  issuer = "caipe-agentic-apps",
  audience = "agentic-app:weather",
  appId = "weather",
  subject = "example-subject",
  scopes = ["weather:read"],
  expiresAt = Math.floor(Date.now() / 1000) + 300,
  notBefore,
  algorithm = "HS256",
} = {}) {
  const header = encode({ alg: algorithm, typ: "JWT" });
  const payload = encode({
    iss: issuer,
    aud: audience,
    app_id: appId,
    sub: subject,
    scp: scopes,
    exp: expiresAt,
    ...(notBefore === undefined ? {} : { nbf: notBefore }),
  });
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", String(secret).trim())
    .update(input)
    .digest("base64url");
  return `${input}.${signature}`;
}

export function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
