import { safeWebexReturnTo } from "../webex-link-context";

test.each([
  "https://example.test", "//example.test", "/\\example.test", "/%2f%2fexample.test",
  "/api/auth/webex-link/start", "/login", "/a/..//example.test",
  "/a/..//example.test/path?tab=chat#latest", "/a/../api/auth/webex-link/start",
])("rejects unsafe return destination %s", path => {
  expect(safeWebexReturnTo(path)).toBeUndefined();
});

test.each(["/apps/example?tab=chat#latest", "/projects/../apps/example?tab=chat#latest"])(
  "preserves local app state from %s", path => {
    expect(safeWebexReturnTo(path)).toBe("/apps/example?tab=chat#latest");
  },
);
