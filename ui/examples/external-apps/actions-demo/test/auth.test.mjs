// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createDemoJwtVerifier } from "../auth.mjs";
import { bearer, mintTestToken, TEST_SECRET } from "./helpers.mjs";

const verify = createDemoJwtVerifier({ secret: TEST_SECRET, issuer: "caipe-agentic-apps" });

test("requires a long dedicated secret", () => {
  assert.throws(() => createDemoJwtVerifier({ secret: "short" }), /at least 32 bytes/);
  assert.throws(() => createDemoJwtVerifier({ secret: "" }), /AGENTIC_APP_TOKEN_SECRET/);
});

test("accepts a valid token that carries the required scope", () => {
  const result = verify(bearer(mintTestToken()), "actions-demo:write");
  assert.equal(result.ok, true);
  assert.equal(result.identity.subject, "example-subject");
});

test("rejects a missing, malformed or unsigned token", () => {
  assert.equal(verify({}, undefined).status, 401);
  assert.equal(verify({ authorization: "Bearer not-a-jwt" }, undefined).status, 401);
  assert.equal(verify(bearer(mintTestToken({ secret: "x".repeat(40) })), undefined).status, 401);
  assert.equal(verify(bearer(mintTestToken({ algorithm: "none" })), undefined).status, 401);
});

test("rejects a token for another app, audience, issuer or time", () => {
  for (const overrides of [
    { appId: "weather" },
    { audience: "agentic-app:weather" },
    { issuer: "other-issuer" },
    { expiresAt: Math.floor(Date.now() / 1000) - 5 },
    { notBefore: Math.floor(Date.now() / 1000) + 600 },
  ]) {
    assert.equal(verify(bearer(mintTestToken(overrides)), undefined).status, 401, JSON.stringify(overrides));
  }
});

test("rejects a token without the required scope", () => {
  const result = verify(bearer(mintTestToken({ scopes: ["actions-demo:read"] })), "actions-demo:write");
  assert.equal(result.status, 403);
  assert.equal(result.requiredScope, "actions-demo:write");
});
