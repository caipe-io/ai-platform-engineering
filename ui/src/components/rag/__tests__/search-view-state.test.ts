import {
  parseSearchViewState,
  serializeSearchViewState,
} from "../search-view-state";

describe("search deep-link state", () => {
  it("round-trips the query, tool, result limit, and typed filters", () => {
    const state = {
      query: "deployment guide",
      tool: "documentation-search",
      limit: 25,
      filters: {
        doc_type: "guide",
        is_current: true,
        archived: false,
      },
    };

    const params = serializeSearchViewState(state);
    expect(params.get("q")).toBe("deployment guide");
    expect(parseSearchViewState(params)).toEqual(state);
  });

  it("bounds an invalid result limit and ignores empty filter keys", () => {
    const params = new URLSearchParams("q=test&limit=1000&filter.=ignored&filter.valid=true");
    expect(parseSearchViewState(params)).toEqual({
      query: "test",
      tool: "search",
      limit: 100,
      filters: { valid: true },
    });
  });
});
