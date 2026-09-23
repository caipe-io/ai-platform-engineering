/** @jest-environment node */

import { optionalAuthHeaders, optionalWebSettings } from "../ingestion-source-config";

describe("optionalAuthHeaders", () => {
  const valid = {
    header_name: "Authorization",
    value_template: "Bearer {{secret}}",
    secret_ref: "docs-site-token",
  };

  it("returns undefined when unset", () => {
    expect(optionalAuthHeaders(undefined)).toBeUndefined();
    expect(optionalAuthHeaders(null)).toBeUndefined();
  });

  it("treats an empty array as an explicit removal", () => {
    expect(optionalAuthHeaders([])).toEqual([]);
  });

  it("normalizes a valid entry", () => {
    expect(optionalAuthHeaders([{ ...valid, header_name: " Authorization " }])).toEqual([valid]);
  });

  it.each([
    ["Bearer {{secret}}\r\nX-Injected: 1"],
    ["Bearer {{secret}}\nX-Injected: 1"],
  ])("rejects a template containing line breaks: %s", (value_template) => {
    expect(() => optionalAuthHeaders([{ ...valid, value_template }])).toThrow(
      /without line breaks/,
    );
  });

  it("rejects a template with no placeholder", () => {
    expect(() =>
      optionalAuthHeaders([{ ...valid, value_template: "Bearer literal-token" }]),
    ).toThrow(/\{\{secret\}\}/);
  });

  it.each([["Bad Header"], ["Bad:Header"], ["Bad\nHeader"], [""]])(
    "rejects an invalid header name: %s",
    (header_name) => {
      expect(() => optionalAuthHeaders([{ ...valid, header_name }])).toThrow(
        /valid header_name/,
      );
    },
  );

  it("rejects a malformed secret_ref", () => {
    expect(() => optionalAuthHeaders([{ ...valid, secret_ref: "has spaces" }])).toThrow(
      /valid secret_ref/,
    );
  });

  it("accepts a static header with no credential", () => {
    expect(
      optionalAuthHeaders([{ header_name: "X-Environment", value_template: "staging" }]),
    ).toEqual([{ header_name: "X-Environment", value_template: "staging" }]);
  });

  it("rejects a placeholder with no credential to substitute", () => {
    expect(() => optionalAuthHeaders([{ ...valid, secret_ref: "" }])).toThrow(
      /require a secret_ref/,
    );
  });

  it("rejects a credential with no placeholder marking where it belongs", () => {
    expect(() =>
      optionalAuthHeaders([{ ...valid, value_template: "Bearer static" }]),
    ).toThrow(/containing \{\{secret\}\}/);
  });

  it("rejects an empty value", () => {
    expect(() =>
      optionalAuthHeaders([{ header_name: "X-Environment", value_template: "   " }]),
    ).toThrow(/require a value_template/);
  });

  it("rejects a repeated header name regardless of case", () => {
    expect(() =>
      optionalAuthHeaders([valid, { ...valid, header_name: "authorization", secret_ref: "other" }]),
    ).toThrow(/must not repeat header/);
  });

  it("allows distinct headers", () => {
    const headers = optionalAuthHeaders([
      valid,
      { header_name: "X-Api-Key", value_template: "{{secret}}", secret_ref: "api-key" },
    ]);
    expect(headers).toHaveLength(2);
  });

  it("rejects more than ten entries", () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      ...valid,
      header_name: `X-Header-${index}`,
    }));
    expect(() => optionalAuthHeaders(many)).toThrow(/at most 10/);
  });

  it("rejects non-array and non-object shapes", () => {
    expect(() => optionalAuthHeaders("nope")).toThrow(/must be an array/);
    expect(() => optionalAuthHeaders(["nope"])).toThrow(/must be objects/);
  });
});

describe("optionalWebSettings auth_headers passthrough", () => {
  it("carries validated headers through", () => {
    const settings = optionalWebSettings({
      crawl_mode: "single",
      auth_headers: [
        {
          header_name: "Authorization",
          value_template: "token {{secret}}",
          secret_ref: "docs-site-token",
        },
      ],
    });
    expect(settings?.auth_headers).toEqual([
      {
        header_name: "Authorization",
        value_template: "token {{secret}}",
        secret_ref: "docs-site-token",
      },
    ]);
  });

  it("omits the key when the caller sends nothing", () => {
    expect(optionalWebSettings({ crawl_mode: "single" })).not.toHaveProperty("auth_headers");
  });

  it("surfaces an invalid header as a payload error", () => {
    expect(() =>
      optionalWebSettings({
        crawl_mode: "single",
        auth_headers: [{ header_name: "Authorization", value_template: "Bearer x", secret_ref: "r" }],
      }),
    ).toThrow(/auth_headers/);
  });
});
