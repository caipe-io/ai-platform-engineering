import { ALL_PRODUCT_TOUR_IDS, normalizeEnabledTours } from "../caipe-tour-policy";

describe("CAIPE Tour availability", () => {
  it("preserves default availability but respects an explicit empty list", () => {
    expect(normalizeEnabledTours(undefined)).toEqual(ALL_PRODUCT_TOUR_IDS);
    expect(normalizeEnabledTours([])).toEqual([]);
    expect(normalizeEnabledTours(["chat", "chat", "workspace"])).toEqual(["workspace", "chat"]);
  });
  it.each([null, "chat", ["__proto__"], ["unknown"]])("rejects invalid operator input: %p", (input) => {
    expect(() => normalizeEnabledTours(input, true)).toThrow();
    expect(normalizeEnabledTours(input)).toEqual([]);
  });
});
