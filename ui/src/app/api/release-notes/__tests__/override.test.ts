/** @jest-environment node */
import { NextRequest } from "next/server";
const mockAuth = jest.fn();
const mockFind = jest.fn();
jest.mock("@/lib/api-middleware", () => ({ ApiError: jest.requireActual("@/lib/api-error").ApiError, getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFind }) }));
import { GET } from "../route";
const request = () => new NextRequest("https://example.test/api/release-notes?version=1.3.2&compare=platform");
beforeEach(() => { jest.clearAllMocks(); mockAuth.mockResolvedValue({}); process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = "https://github.com/example/repository"; });
afterEach(() => { delete process.env.RELEASE_NOTES_GITHUB_TOKEN; });
test("manual notes override compare without fetching GitHub", async () => {
  mockFind.mockResolvedValue({ release_notes: { override: { source: "manual", release_version: "1.3.2", markdown: "---\ntitle: Notes\n---\n## Highlights\n\n<!-- truncate -->\nUseful changes" }, repository_url: "https://github.com/example/repository", previous_commit: "primary", latest_commit: "secondary" } });
  global.fetch = jest.fn();
  const result = await GET(request());
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toMatchObject({ source: "manual", title: "Notes", changelogUrl: null });
  expect(body.body).toContain("Useful changes");
  expect(body.body).not.toContain("truncate");
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockAuth).toHaveBeenCalled();
});
test("repository notes use server credentials and recheck policy before cache", async () => {
  mockFind.mockResolvedValue({ release_notes: { override: { source: "repository", release_version: "1.3.2", markdown_repository: "https://github.com/example/repository", markdown_ref: "release/1.3.2", markdown_path: "docs/notes.md" } } });
  process.env.RELEASE_NOTES_GITHUB_TOKEN = "example-token";
  global.fetch = jest.fn().mockResolvedValue(new Response("## Release\n[Guide](guide.md)"));
  const result = await GET(request());
  expect(await result.json()).toMatchObject({ source: "repository-markdown", changelogUrl: "https://github.com/example/repository/blob/release%2F1.3.2/docs/notes.md" });
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("ref=release%2F1.3.2"), expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer example-token" }) }));
  process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = "";
  expect((await GET(request())).status).toBe(400);
});
test("missing file returns an actionable error", async () => {
  mockFind.mockResolvedValue({ release_notes: { override: { source: "repository", release_version: "1.3.2", markdown_repository: "https://github.com/example/repository", markdown_ref: "primary", markdown_path: "missing.md" } } });
  global.fetch = jest.fn().mockResolvedValue(new Response("", { status: 404 }));
  const result = await GET(request());
  expect(result.status).toBe(502);
  expect((await result.json()).error).toContain("HTTP 404");
});
