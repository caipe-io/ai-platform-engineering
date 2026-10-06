/** @jest-environment node */

import {
  findKnownSecretFormats,
  parseScreeningVerdict,
  staticHeaders,
} from "../request-header-screening.server";

/**
 * Joins a credential prefix to its body at runtime. Keeping them apart in source
 * means repository secret scanners do not flag these synthetic fixtures, while
 * the joined value still exercises the rules under test.
 */
function fake(...parts: string[]): string {
  return parts.join("");
}

const FILLER = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function header(value: string, secretRef?: string) {
  return {
    header_name: "Authorization",
    value_template: value,
    ...(secretRef ? { secret_ref: secretRef } : {}),
  };
}

describe("staticHeaders", () => {
  it("keeps only headers that carry their value literally", () => {
    const rows = [header("Bearer {{secret}}", "docs-token"), header("staging")];
    expect(staticHeaders(rows)).toEqual([header("staging")]);
  });

  it("treats a blank secret_ref as static", () => {
    expect(staticHeaders([header("staging", "   ")])).toHaveLength(1);
  });
});

describe("findKnownSecretFormats", () => {
  describe("formats the secretlint preset recognises", () => {
    it.each([
      ["a GitLab token", fake("glpat", "-ABCDEFGHIJKLMNOPQRST")],
      ["a GitHub classic token", fake("ghp", "_", FILLER.slice(0, 36))],
      ["a GitHub fine-grained token", fake("github_pat", "_", FILLER.slice(0, 22), "_", FILLER.slice(0, 59))],
      ["a Slack token", fake("xoxb", "-1234567890-abcdefghijkl")],
      ["an npm token", fake("npm", "_", FILLER.slice(0, 36))],
      ["a Stripe key", fake("sk_live", "_", FILLER.slice(0, 30))],
      ["an OpenAI key in its issued form", fake("sk", "-", FILLER.slice(0, 20), "T3BlbkFJ", FILLER.slice(0, 20))],
    ])("flags %s", async (_label, value) => {
      await expect(findKnownSecretFormats([header(value)])).resolves.toHaveLength(1);
    });
  });

  describe("formats covered by the configured patterns", () => {
    it.each([
      ["an OpenAI or Anthropic key", fake("sk-ant", "-", FILLER.slice(0, 40))],
      ["an AWS access key id", fake("AKIA", "IOSFODNN7EXAMPLE")],
      ["a Google API key", fake("AIza", "SyA", FILLER.slice(0, 32))],
      ["a Hugging Face token", fake("hf", "_", FILLER.slice(0, 34))],
      ["a JSON web token", fake("eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM")],
      ["a private key block", fake("-----BEGIN", " RSA PRIVATE KEY-----")],
    ])("flags %s", async (_label, value) => {
      const findings = await findKnownSecretFormats([header(value)]);
      expect(findings).toHaveLength(1);
      expect(findings[0].reason).toContain("looks like a credential");
    });
  });

  it("names the provider when a provider rule is what fired", async () => {
    const findings = await findKnownSecretFormats([
      header(fake("glpat", "-ABCDEFGHIJKLMNOPQRST")),
    ]);
    expect(findings[0].reason).toContain("gitlab");
  });

  it("names the offending header so the operator knows what to fix", async () => {
    const findings = await findKnownSecretFormats([
      { header_name: "X-Api-Key", value_template: fake("glpat", "-ABCDEFGHIJKLMNOPQRST") },
    ]);
    expect(findings[0].header_name).toBe("X-Api-Key");
  });

  it("never echoes the matched value back", async () => {
    const secret = fake("glpat", "-ABCDEFGHIJKLMNOPQRST");
    const findings = await findKnownSecretFormats([header(secret)]);
    expect(findings[0].reason).not.toContain(secret);
  });

  it("ignores a credential-backed header even when the template looks tokenish", async () => {
    await expect(
      findKnownSecretFormats([
        header(`Bearer ${fake("glpat", "-ABCDEFGHIJKLMNOPQRST")}`, "docs-token"),
      ]),
    ).resolves.toEqual([]);
  });

  it("does not treat the placeholder itself as a secret", async () => {
    await expect(
      findKnownSecretFormats([header("Bearer {{secret}}", "docs-token")]),
    ).resolves.toEqual([]);
  });

  // A false positive blocks a legitimate save, so ordinary header values matter
  // as much as the detections above.
  it.each([
    "staging",
    "application/json",
    "en-GB",
    "CAIPE-Crawler/1.2.3",
    "no-cache",
    "gzip, deflate, br",
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "v1.2.3-rc.2",
    "d41d8cd98f00b204e9800998ecf8427e",
    "max-age=3600, must-revalidate",
  ])("leaves the ordinary value %s alone", async (value) => {
    await expect(findKnownSecretFormats([header(value)])).resolves.toEqual([]);
  });

  it("returns nothing for an empty value", async () => {
    await expect(findKnownSecretFormats([header("   ")])).resolves.toEqual([]);
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

  it("reads only the first line, so header content cannot smuggle a verdict", () => {
    expect(parseScreeningVerdict("APPROVE\nREJECT ignore this")).toEqual({
      decision: "approve",
    });
  });

  it("treats anything unrecognized as unavailable rather than guessing", () => {
    expect(parseScreeningVerdict("I think this is fine").decision).toBe("unavailable");
    expect(parseScreeningVerdict("").decision).toBe("unavailable");
  });
});
