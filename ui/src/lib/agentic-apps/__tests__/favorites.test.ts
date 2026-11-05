import { normalizeFavoriteAppIds, parseFavoriteAppIds } from "../favorites";

it("validates and deduplicates favorite app IDs before storing them", () => {
  expect(parseFavoriteAppIds(["example-app", "example-app", "secondary"])).toEqual(["example-app", "secondary"]);
  for (const invalid of ["example-app", ["../other"], ["UPPERCASE"], Array(101).fill("example")]) {
    expect(() => parseFavoriteAppIds(invalid)).toThrow("Invalid favorite_agentic_apps");
  }
});

it("ignores malformed saved preferences without showing unknown apps", () => {
  expect(normalizeFavoriteAppIds(["example-app", 5, "../other", "example-app"])).toEqual(["example-app"]);
});
