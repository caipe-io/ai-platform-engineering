import { computeReorder } from "../reorder";

describe("computeReorder",() => {
  it("moves an item forward in the list",() => {
    expect(computeReorder(["a","b","c"],"a","c")).toEqual(["b","c","a"]);
  });

  it("moves an item backward in the list",() => {
    expect(computeReorder(["a","b","c"],"c","a")).toEqual(["c","a","b"]);
  });

  it("returns null when dropped on itself",() => {
    expect(computeReorder(["a","b","c"],"b","b")).toBeNull();
  });

  it("returns null when the active id isn't in the list",() => {
    expect(computeReorder(["a","b","c"],"missing","a")).toBeNull();
  });

  it("returns null when the over id isn't in the list",() => {
    expect(computeReorder(["a","b","c"],"a","missing")).toBeNull();
  });

  it("does not mutate the input array",() => {
    const ids = ["a","b","c"];
    computeReorder(ids,"a","c");
    expect(ids).toEqual(["a","b","c"]);
  });
});
