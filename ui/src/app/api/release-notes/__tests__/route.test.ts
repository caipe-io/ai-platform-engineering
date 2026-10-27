/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import fs from "fs";

const mockGetCollection = jest.fn();
const mockAuth = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  ApiError: jest.requireActual("@/lib/api-error").ApiError,
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

const RAW_BASE = "https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/docs/releases";
const githubUrls: string[] = [];

const LISTING = [
  { name: "README.md", type: "file", download_url: `${RAW_BASE}/README.md` },
  { name: "2026-05-26-release-0-5-0.md", type: "file", download_url: `${RAW_BASE}/2026-05-26-release-0-5-0.md` },
  { name: "2026-06-01-release-0-6-0.md", type: "file", download_url: `${RAW_BASE}/2026-06-01-release-0-6-0.md` },
  { name: "subdir", type: "dir", download_url: null },
];

const BODY_050 = `---
slug: release-0.5.0
title: "Release 0.5.0 — Admin UI Polish"
date: 2026-05-26
---

> Released: 2026-05-26

## Highlights

A small maintenance release.

<!-- truncate -->

## What's New

- **Admin UI**: shared pickers

## Upgrade Guide: 0.4.0 → 0.5.0

Run the migration runbook before applying schema changes.
`;

const BODY_060 = `---
title: "Release 0.6.0 — Big Stuff"
date: 2026-06-01
---

## Highlights

Newest available notes.
`;

function mockGithub() {
  githubUrls.length = 0;
  global.fetch = jest.fn(async (url: string | URL) => {
    const u = String(url);
    githubUrls.push(u);
    let hostname = "";
    try {
      hostname = new URL(u).hostname;
    } catch {
      hostname = "";
    }
    if (hostname === "api.github.com") {
      return { ok: true, json: async () => LISTING } as unknown as Response;
    }
    if (u.endsWith("0-5-0.md")) {
      return { ok: true, text: async () => BODY_050 } as unknown as Response;
    }
    if (u.endsWith("0-6-0.md")) {
      return { ok: true, text: async () => BODY_060 } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function callGet(version: string) {
  jest.resetModules();
  mockGithub();
  const { GET } = await import("../route");
  const res = await GET(new NextRequest(`http://localhost/api/release-notes?version=${version}`));
  return res.json();
}

const originalAllowedRepositories = process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
afterEach(() => {
  if (originalAllowedRepositories === undefined) delete process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
  else process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = originalAllowedRepositories;
});

describe("/api/release-notes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = "https://github.com/example/repository";
    mockAuth.mockResolvedValue({ user: { role: "user" }, session: { role: "user" } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RELEASE_NOTES_GITHUB_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  it("returns the series notes with frontmatter and truncate marker stripped", async () => {
    const data = await callGet("0.5.0");
    expect(data.matchedVersion).toBe("0.5.0");
    expect(data.title).toBe("Release 0.5.0 — Admin UI Polish");
    // Frontmatter is removed.
    expect(data.body).not.toContain("slug: release-0.5.0");
    // Docusaurus truncate marker is removed.
    expect(data.body).not.toContain("<!-- truncate -->");
    // Real markdown content is preserved.
    expect(data.body).toContain("## What's New");
    expect(data.body).toContain("Run the migration runbook");
  });

  it("lists release posts from the canonical GitHub repository", async () => {
    await callGet("0.5.0");
    expect(githubUrls).toContain(
      "https://api.github.com/repos/caipe-io/ai-platform-engineering/contents/docs/releases?ref=main",
    );
  });

  it("resolves a patch version to its minor series post", async () => {
    const data = await callGet("0.5.42");
    expect(data.matchedVersion).toBe("0.5.0");
    expect(data.title).toBe("Release 0.5.0 — Admin UI Polish");
  });

  it("resolves a prerelease to its own series post", async () => {
    const data = await callGet("0.6.1-dev.14");
    expect(data.matchedVersion).toBe("0.6.0");
    expect(data.title).toBe("Release 0.6.0 — Big Stuff");
  });

  it("does not fall back to an older series when the requested series has no post", async () => {
    const data = await callGet("1.0.0-rc.1");
    expect(data.matchedVersion).toBeNull();
    expect(data.body).toBeNull();
    expect(data.source).toBe("none");
  });

  it("builds release notes from an explicitly configured GitHub commit range", async () => {
    jest.resetModules();
    process.env.RELEASE_NOTES_GITHUB_TOKEN = "test-token";
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        release_notes: {
          repository_url: "https://github.com/example/repository",
          previous_commit: "1111111",
          latest_commit: "3333333",
        },
      }),
    });
    global.fetch = jest.fn(async (_url: string | URL, init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        commits: [
          {
            sha: "2222222",
            commit: {
              message: "feat(ui): add a useful setting (#42)",
              committer: { date: "2026-08-14T12:00:00Z" },
            },
          },
          {
            sha: "3333333",
            commit: {
              message: "fix(api): handle invalid input",
              committer: { date: "2026-08-15T12:00:00Z" },
            },
          },
        ],
      }),
      headers: init?.headers,
    })) as unknown as typeof fetch;

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest("https://app.example.test/api/release-notes?version=1.0.0-example.1&compare=platform"),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      requestedVersion: "1.0.0-example.1",
      matchedVersion: "1.0.0-example.1",
      source: "github-compare",
      date: "2026-08-15",
      changelogUrl: "https://github.com/example/repository/compare/1111111...3333333",
    });
    expect(data.body).toContain("## What's New");
    expect(data.body).toContain("add a useful setting");
    expect(data.body).toContain("## Bug Fixes");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockAuth).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/repos/example/repository/compare/1111111...3333333"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
  });

  it("rejects an incomplete stored GitHub compare configuration", async () => {
    jest.resetModules();
    mockGithub();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        release_notes: { previous_commit: "1111111" },
      }),
    });
    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest("https://app.example.test/api/release-notes?version=1.0.0-example.1&compare=platform"),
    );

    expect(response.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks stored unapproved repositories and rechecks policy before serving a warm cache", async () => {
    jest.resetModules();
    mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue({ release_notes: {
      repository_url: "https://github.com/example/repository", previous_commit: "1111111", latest_commit: "2222222",
    } }) });
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ commits: [] }) })) as unknown as typeof fetch;
    const { GET } = await import("../route");
    const request = () => new NextRequest("https://app.example.test/api/release-notes?version=1&compare=platform&repository_url=https://github.com/example/repository");
    expect((await GET(request())).status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = "https://github.com/example/secondary";
    const response = await GET(request());
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).body).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("rejects denied compare readers before DB/network work (%s)", async (status) => {
    jest.resetModules();
    const { ApiError } = await import("@/lib/api-error");
    mockAuth.mockRejectedValueOnce(new ApiError("Denied", status));
    mockGithub();
    const { GET } = await import("../route");
    const response = await GET(new NextRequest("https://app.example.test/api/release-notes?version=1&compare=platform"));
    expect(response.status).toBe(status);
    expect(mockGetCollection).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("encodes branch refs and does not serve a warmed cache after auth is lost", async () => {
    jest.resetModules();
    const { ApiError } = await import("@/lib/api-error");
    mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue({ release_notes: {
      repository_url: "https://github.com/example/repository", previous_commit: "release/primary", latest_commit: "release/secondary",
    } }) });
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ commits: [] }) })) as unknown as typeof fetch;
    const { GET } = await import("../route");
    const request = () => new NextRequest("https://app.example.test/api/release-notes?version=1&compare=platform");
    expect((await GET(request())).status).toBe(200);
    expect((await GET(request())).status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("release%2Fprimary...release%2Fsecondary"), expect.anything());
    mockAuth.mockRejectedValueOnce(new ApiError("Denied", 401));
    mockGetCollection.mockClear();
    const denied = await GET(request());
    expect(denied.status).toBe(401);
    expect((await denied.json()).body).toBeNull();
    expect(mockGetCollection).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails rather than caching a partial compare at the pagination limit", async () => {
    jest.resetModules();
    mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue({ release_notes: {
      repository_url: "https://github.com/example/repository", previous_commit: "1111111", latest_commit: "2222222",
    } }) });
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ commits: Array.from({ length: 100 }, () => ({ sha: "2222222" })) }) })) as unknown as typeof fetch;
    const { GET } = await import("../route");
    const response = await GET(new NextRequest("https://app.example.test/api/release-notes?version=1&compare=platform"));
    expect(response.status).toBe(502);
    expect((await response.json()).body).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(10);
  });

  it("keeps configuration failures private without logging database details", async () => {
    jest.resetModules();
    mockGetCollection.mockRejectedValueOnce(new Error("example private database details"));
    const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("../route");
    const response = await GET(new NextRequest("https://app.example.test/api/release-notes?version=1&compare=platform"));
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(log).toHaveBeenCalledWith("[Release Notes API] Configured compare unavailable");
  });

  it("returns 400 when no version is provided", async () => {
    jest.resetModules();
    mockGithub();
    const { GET } = await import("../route");
    const res = await GET(new NextRequest("http://localhost/api/release-notes"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.body).toBeNull();
  });

  it("uses generated build notes only for the exact deployed version", async () => {
    jest.resetModules();
    mockGithub();
    const { GET } = await import("../route");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({
      version: "1.0.0-example.1", title: "Example increment", date: "2026-01-01", body: "Generated changes",
      changelogUrl: "https://github.com/example/repository/compare/primary...secondary",
    }) as never);
    const exact = await GET(new NextRequest("https://app.example.test/api/release-notes?version=1.0.0-example.1"));
    expect(await exact.json()).toMatchObject({ source: "generated", body: "Generated changes" });
    const other = await GET(new NextRequest("https://app.example.test/api/release-notes?version=0.5.0"));
    expect(await other.json()).toMatchObject({ source: "github", matchedVersion: "0.5.0" });
  });
});
