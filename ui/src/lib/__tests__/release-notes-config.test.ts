/** @jest-environment node */
import { approvedReleaseNotesRepository, getReleaseNotesAllowedRepositories } from "../release-notes-config";

const original = process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
afterEach(() => {
  if (original === undefined) delete process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
  else process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = original;
});

it("defaults to a single repository and rejects arbitrary repositories", () => {
  delete process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
  const defaults = getReleaseNotesAllowedRepositories();
  expect(defaults).toHaveLength(1);
  expect(approvedReleaseNotesRepository(defaults[0])).toBe(defaults[0]);
  expect(approvedReleaseNotesRepository("https://github.com/example/other")).toBeNull();
});

it("replaces the default with approved forks, normalizes aliases and deduplicates", () => {
  delete process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
  const [upstream] = getReleaseNotesAllowedRepositories();
  process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = " https://github.com/Example/Primary.git,https://github.com/example/primary/,https://github.com/example/secondary ";
  expect(getReleaseNotesAllowedRepositories()).toEqual([
    "https://github.com/example/primary", "https://github.com/example/secondary",
  ]);
  expect(approvedReleaseNotesRepository("https://github.com/EXAMPLE/primary.git")).toBe("https://github.com/example/primary");
  expect(approvedReleaseNotesRepository(upstream)).toBeNull();
  expect(approvedReleaseNotesRepository("https://github.com/example/primary-extra")).toBeNull();
});

it.each(["", " ", "*", "https://github.com/example/primary,", "https://github.com/example/primary,https://user:password@github.com/example/private", "https://example.test/example/primary", Array(33).fill("https://github.com/example/primary").join(",")])(
  "fails closed for empty, malformed or excessive deployment lists: %s", (policy) => {
    process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = policy;
    expect(getReleaseNotesAllowedRepositories()).toEqual([]);
    expect(approvedReleaseNotesRepository("https://github.com/example/primary")).toBeNull();
  },
);
