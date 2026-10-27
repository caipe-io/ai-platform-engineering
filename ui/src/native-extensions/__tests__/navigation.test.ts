import { filterAccessibleNativeNavigation, isSafeHostHref } from "../navigation";
import type { NativeExtensionManifest } from "../types";

const manifest = (id: string, navigation = true) => ({
  id,
  navigation: navigation ? { href: `/${id}`, label: id, placement: "after-chat" as const } : undefined,
}) as NativeExtensionManifest;

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

describe("filterAccessibleNativeNavigation", () => {
  it("only exposes configured navigation for extensions authorized for the user", () => {
    expect(filterAccessibleNativeNavigation(
      [manifest("allowed"), manifest("denied"), manifest("no-nav", false)],
      new Set(["allowed", "no-nav"]),
    ).map((item) => item.id)).toEqual(["allowed"]);
  });

  it("fails closed while authorization has not loaded", () => {
    expect(filterAccessibleNativeNavigation([manifest("example")], new Set())).toEqual([]);
  });
});
