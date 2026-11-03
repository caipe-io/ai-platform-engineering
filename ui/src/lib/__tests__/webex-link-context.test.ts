import { safeWebexReturnTo } from "../webex-link-context";
test.each(["https://example.test", "//example.test", "/\\example.test", "/%2f%2fexample.test", "/api/auth/webex-link/start", "/login"])("rejects unsafe return destination %s", (path) => { expect(safeWebexReturnTo(path)).toBeUndefined(); });
test("preserves local app state", () => { expect(safeWebexReturnTo("/apps/example?tab=chat#latest")).toBe("/apps/example?tab=chat#latest"); });
