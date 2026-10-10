import { isSafeHostHref } from "../navigation";

describe("native extension host navigation", () => {
  it("accepts same-origin paths and query strings", () => {
    expect(isSafeHostHref("/example/detail?tab=one")).toBe(true);
  });

  it("rejects external, protocol-relative, and escaped URLs", () => {
    expect(isSafeHostHref("https://example.test")).toBe(false);
    expect(isSafeHostHref("//example.test")).toBe(false);
    expect(isSafeHostHref("/\\example.test")).toBe(false);
    expect(isSafeHostHref("/example\nother")).toBe(false);
  });
});
