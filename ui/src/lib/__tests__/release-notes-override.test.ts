import { hasReleaseNotesOverride, normalizeReleaseNotesOverride, validateReleaseNotesOverride, validReleaseMarkdownPath } from "../release-notes-override";

test("manual notes need no repository, but are pinned to a release", () => {
  const override = normalizeReleaseNotesOverride({ source: "manual", release_version: "v1.3.2", markdown: "## Highlights" });
  expect(validateReleaseNotesOverride(override)).toBeNull();
  expect(hasReleaseNotesOverride({ override }, "1.3.2")).toBe(true);
  expect(hasReleaseNotesOverride({ override }, "1.3.3")).toBe(false);
  expect(validateReleaseNotesOverride({ ...override, markdown: "" })).toMatch(/Enter/);
  expect(validateReleaseNotesOverride({ ...override, changelog_url: "javascript:alert(1)" })).toMatch(/HTTPS/);
});
test.each(["../notes.md", "/notes.md", "docs/%2e%2e/notes.md", "docs/notes.md?token=x", "docs/notes.txt"])("rejects unsafe repository path %s", (path) => {
  expect(validReleaseMarkdownPath(path)).toBe(false);
});
test("automatic preserves inactive content without enabling it", () => {
  const override = normalizeReleaseNotesOverride({ source: "automatic", markdown: "Saved notes" });
  expect(override.markdown).toBe("Saved notes");
  expect(hasReleaseNotesOverride({ override }, "1.3.2")).toBe(false);
});
test("normalizes uppercase version prefixes without losing Markdown indentation", () => {
  const override = normalizeReleaseNotesOverride({ source: "manual", release_version: "V1.3.2", markdown: "\n    example command\n" });
  expect(override.release_version).toBe("1.3.2");
  expect(override.markdown).toBe("    example command");
  expect(hasReleaseNotesOverride({ override }, "V1.3.2")).toBe(true);
});
test("bounds manual content by UTF-8 bytes and rejects whitespace-only notes", () => {
  const override = normalizeReleaseNotesOverride({ source: "manual", release_version: "1.3.2", markdown: "例".repeat(45000) });
  expect(validateReleaseNotesOverride(override)).toMatch(/128 KiB/);
  expect(validateReleaseNotesOverride({ ...override, markdown: " \n " })).toMatch(/Enter/);
});
