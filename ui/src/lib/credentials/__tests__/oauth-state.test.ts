import {
  createOAuthStateCookie,
  parseOAuthStateCookie,
  pkceChallenge,
} from "@/lib/credentials/oauth-state";

describe("OAuth state helper", () => {
  it("round-trips signed state and produces an S256 PKCE challenge", () => {
    const cookie = createOAuthStateCookie({
      providerKey: "github",
      ownerId: "alice-sub",
      state: "state-1",
      codeVerifier: "verifier-1",
      secret: "test-secret",
      nowMs: Date.parse("2026-01-01T00:00:00Z"),
    });

    expect(
      parseOAuthStateCookie(cookie, "test-secret", {
        nowMs: Date.parse("2026-01-01T00:05:00Z"),
      }),
    ).toMatchObject({
      providerKey: "github",
      ownerId: "alice-sub",
      state: "state-1",
      codeVerifier: "verifier-1",
    });
    expect(pkceChallenge("verifier-1")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a state cookie older than the max age", () => {
    const cookie = createOAuthStateCookie({
      providerKey: "github",
      ownerId: "alice-sub",
      state: "state-1",
      codeVerifier: "verifier-1",
      secret: "test-secret",
      nowMs: Date.parse("2026-01-01T00:00:00Z"),
    });

    expect(() =>
      parseOAuthStateCookie(cookie, "test-secret", {
        nowMs: Date.parse("2026-01-01T00:10:01Z"),
      }),
    ).toThrow("Invalid OAuth state");
  });

  it("rejects tampered state cookies", () => {
    const cookie = createOAuthStateCookie({
      providerKey: "github",
      ownerId: "alice-sub",
      state: "state-1",
      codeVerifier: "verifier-1",
      secret: "test-secret",
    });

    expect(() => parseOAuthStateCookie(`${cookie}tamper`, "test-secret")).toThrow(
      "Invalid OAuth state",
    );
  });
});
