import { isValidReleaseNotesRef, parseReleaseNotesRepository } from "../release-notes-ref";

describe("release notes coordinates", () => {
  it.each(["1111111", "a".repeat(64), "v1.2.3", "release/primary", "refs/tags/v1.2.3"])("accepts a ref: %s", (ref) => {
    expect(isValidReleaseNotesRef(ref)).toBe(true);
  });
  it.each(["", "@", "a".repeat(257), "a..b", "a/", "/a", "a//b", ".hidden/a", "a/.hidden", "a.lock/b", "a~1", "a...b", "a@{1}", "a#b", "a%b", "a?b", "a\\b", "a\nb", "a\u007fb"])("rejects a ref: %s", (ref) => {
    expect(isValidReleaseNotesRef(ref)).toBe(false);
  });
  it("normalizes ordinary repository URLs", () => {
    expect(parseReleaseNotesRepository("https://github.com/example/repository.git")).toEqual({ owner: "example", repository: "repository" });
  });
  it.each(["http://github.com/example/repository", "https://example.test/example/repository", "https://user:password@github.com/example/repository", "https://github.com:444/example/repository", "https://github.com/example/repository?token=example", "https://github.com/example/repository#fragment", "https://github.com/example/repository/extra", "https://github.com/example/repo%2Fother"])("rejects unsafe repository coordinates: %s", (url) => {
    expect(parseReleaseNotesRepository(url)).toBeNull();
  });
});
