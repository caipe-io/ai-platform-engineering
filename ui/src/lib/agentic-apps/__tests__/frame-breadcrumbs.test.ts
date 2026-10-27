import { parseFrameBreadcrumbs } from "../frame-breadcrumbs";

const roots = ["/example", "/apps/example-app"];
it("accepts app-owned links and an initial host Home link", () => {
  const items = [{ label: "Home", href: "/" }, { label: "Example", href: "/example?tab=overview" }, { label: "Page" }];
  expect(parseFrameBreadcrumbs(items, roots)).toEqual(items);
});
it.each([
  [{ label: "External", href: "https://example.org" }],
  [{ label: "Escaped", href: "/example/../admin" }],
  [{ label: "Other app", href: "/apps/secondary" }],
  [{ label: "Bad", href: "//example.org" }],
  [{ label: "Bad", href: "/example\\admin" }],
  [{ label: "First" }, { label: "Home", href: "/" }],
  [{ label: "" }],
  [{ label: "x".repeat(121) }],
  [{ label: "Page", html: "<script>" }],
  Array.from({ length: 13 }, () => ({ label: "Page" })),
].map(items => ({ items })))("rejects invalid or out-of-app breadcrumb data: %j", ({ items }) => {
  expect(parseFrameBreadcrumbs(items, roots)).toBeNull();
});
