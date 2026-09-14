// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createWeatherJwtVerifier } from "../auth.mjs";
import { bearer, mintTestToken, TEST_SECRET } from "./helpers.mjs";

test("requires a dedicated secret of at least 32 trimmed bytes", () => {
  assert.throws(
    () => createWeatherJwtVerifier({ secret: `  ${"x".repeat(31)}  ` }),
    /at least 32 bytes after trimming/,
  );
  assert.doesNotThrow(() => createWeatherJwtVerifier({ secret: `  ${TEST_SECRET}  ` }));
});

test("accepts the exact app identity and required scope", () => {
  const verify = createWeatherJwtVerifier({ secret: TEST_SECRET });
  const result = verify(bearer(mintTestToken()), "weather:read");

  assert.equal(result.ok, true);
  assert.deepEqual(result.identity, {
    subject: "example-subject",
    appId: "weather",
    audience: "agentic-app:weather",
    scopes: ["weather:read"],
  });
});

test("returns forbidden when the app token lacks the route scope", () => {
  const verify = createWeatherJwtVerifier({ secret: TEST_SECRET });
  const result = verify(
    bearer(mintTestToken({ scopes: ["weather:write"] })),
    "weather:read",
  );

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: "insufficient_scope",
    requiredScope: "weather:read",
  });
});

for (const [name, overrides] of [
  ["issuer", { issuer: "another-issuer" }],
  ["audience", { audience: "agentic-app:another-app" }],
  ["app id", { appId: "another-app" }],
  ["stable subject", { subject: "   " }],
  ["expiry", { expiresAt: 1 }],
  ["scope shape", { scopes: "weather:read" }],
  ["algorithm", { algorithm: "HS512" }],
]) {
  test(`rejects an invalid ${name}`, () => {
    const verify = createWeatherJwtVerifier({ secret: TEST_SECRET });
    const result = verify(bearer(mintTestToken(overrides)), "weather:read");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.error, "invalid_token");
  });
}

test("rejects a bad signature and a token that is not active", () => {
  const now = 2_000_000_000;
  const verify = createWeatherJwtVerifier({ secret: TEST_SECRET, now: () => now });

  assert.equal(
    verify(
      bearer(mintTestToken({
        secret: ["different", "test", "key", "y".repeat(32)].join("-"),
        expiresAt: now + 60,
      })),
      "weather:read",
    ).status,
    401,
  );
  assert.equal(
    verify(
      bearer(mintTestToken({ expiresAt: now + 60, notBefore: now + 1 })),
      "weather:read",
    ).status,
    401,
  );
});
