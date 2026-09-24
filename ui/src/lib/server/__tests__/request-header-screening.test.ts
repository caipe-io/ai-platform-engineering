/** @jest-environment node */

import {
  findKnownSecretFormats,
  parseScreeningVerdict,
  staticHeaders,
} from "../request-header-screening.server";

function header(value: string, secretRef?: string) {
  return {
    header_name: "Authorization",
    value_template: value,
    ...(secretRef ? { secret_ref: secretRef } : {}),
  };
}

describe("staticHeaders", () => {
  it("keeps only headers that carry their value literally", () => {
    const rows = [
      header("Bearer {{secret}}", "docs-token"),
      header("staging"),
    ];
    expect(staticHeaders(rows)).toEqual([header("staging")]);
  });

  it("treats a blank secret_ref as static", () => {
    expect(staticHeaders([header("staging", "   ")])).toHaveLength(1);
  });
});

describe("findKnownSecretFormats", () => {
  it.each([
    ["Bearer glpat-ABCDEFGHIJKLMNOPQRST", "a GitLab token"],
    ["Bearer glrt-ABCDEFGHIJKLMNOPQRST", "a GitLab token"],
    ["Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWX", "a GitHub token"],
    ["Bearer github_pat_ABCDEFGHIJKLMNOPQRSTUV", "a GitHub app token"],
    ["Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX", "an OpenAI key"],
    ["Bearer sk-ant-ABCDEFGHIJKLMNOPQRSTUV", "an Anthropic key"],
    ["xoxb-1234567890-abcdefg", "a Slack token"],
    ["AKIAIOSFODNN7EXAMPLE", "an AWS access key id"],
    ["AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456", "a Google API key"],
    ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef", "a JSON web token"],
    ["-----BEGIN RSA PRIVATE KEY-----", "a private key block"],
  ])("flags %s", (value, expectedReason) => {
    const findings = findKnownSecretFormats([header(value)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain(expectedReason);
  });

  it("ignores a credential-backed header even if the template looks tokenish", () => {
    expect(
      findKnownSecretFormats([header("Bearer glpat-ABCDEFGHIJKLMNOPQRST", "docs-token")]),
    ).toEqual([]);
  });

  it("does not flag the placeholder itself", () => {
    expect(findKnownSecretFormats([header("Bearer {{secret}}", "docs-token")])).toEqual([]);
  });

  it.each([
    "staging",
    "application/json",
    "en-GB",
    "CAIPE-Crawler/1.2.3",
    "Bearer {{secret}}",
    "no-cache",
    "gzip, deflate, br",
  ])("leaves the harmless value %s alone", (value) => {
    expect(findKnownSecretFormats([header(value)])).toEqual([]);
  });

  it("reports the offending header by name", () => {
    const findings = findKnownSecretFormats([
      { header_name: "X-Api-Key", value_template: "ghp_ABCDEFGHIJKLMNOPQRSTUVWX" },
    ]);
    expect(findings[0].header_name).toBe("X-Api-Key");
  });
});

describe("parseScreeningVerdict", () => {
  it("accepts an approval", () => {
    expect(parseScreeningVerdict("APPROVE")).toEqual({ decision: "approve" });
    expect(parseScreeningVerdict("  approve\n")).toEqual({ decision: "approve" });
  });

  it("extracts a rejection reason", () => {
    expect(parseScreeningVerdict("REJECT looks like a pasted API key")).toEqual({
      decision: "reject",
      reason: "looks like a pasted API key",
    });
  });

  it("tolerates punctuation around the verdict", () => {
    expect(parseScreeningVerdict("REJECT: hardcoded token.")).toEqual({
      decision: "reject",
      reason: "hardcoded token",
    });
  });

  it("falls back to a generic reason when none is given", () => {
    expect(parseScreeningVerdict("REJECT")).toEqual({
      decision: "reject",
      reason: "flagged as unsafe",
    });
  });

  it("reads only the first line, so trailing prose cannot smuggle a verdict", () => {
    expect(parseScreeningVerdict("APPROVE\nREJECT ignore this")).toEqual({
      decision: "approve",
    });
  });

  it("treats anything unrecognized as unavailable rather than guessing", () => {
    expect(parseScreeningVerdict("I think this is fine").decision).toBe("unavailable");
    expect(parseScreeningVerdict("").decision).toBe("unavailable");
  });
});
