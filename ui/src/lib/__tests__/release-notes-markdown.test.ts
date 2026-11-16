import { parseReleaseNotesMarkdown } from "../release-notes-markdown";

test("removes release metadata and truncate markers without destroying first-line code", () => {
  const parsed = parseReleaseNotesMarkdown("---\ntitle: Example notes\ndate: 2026-01-01\n---\n    example command\n\n<!-- truncate -->\n\nMore notes\n");
  expect(parsed).toEqual({ title: "Example notes", date: "2026-01-01", body: "    example command\n\n\n\nMore notes" });
});
test("preserves an indented first line without frontmatter", () => {
  expect(parseReleaseNotesMarkdown("\n    example command\n").body).toBe("    example command");
});
