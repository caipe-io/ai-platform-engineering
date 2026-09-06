import fs from "fs";
import { NextRequest,NextResponse } from "next/server";
import path from "path";

import { getCollection } from "@/lib/mongodb";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";

export const dynamic = "force-dynamic";

const GITHUB_OWNER = "cnoe-io";
const GITHUB_REPO = "ai-platform-engineering";
const GITHUB_REF = "main";
const RELEASES_DIR = "docs/releases";
const CONTENTS_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${RELEASES_DIR}?ref=${GITHUB_REF}`;
const RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_REF}/${RELEASES_DIR}`;

// One curated post per minor series, named `YYYY-MM-DD-release-X-Y-0.md`. Retired
// per-patch posts share the shape, so only the major and minor are used.
const RELEASE_FILE_PATTERN = /release-(\d+)-(\d+)-(\d+)\.mdx?$/i;

const LISTING_TTL_MS = 10 * 60 * 1000;
const CONTENT_TTL_MS = 10 * 60 * 1000;
const COMPARE_TTL_MS = 10 * 60 * 1000;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

interface ReleaseFile {
  name: string;
  version: string;
  rawUrl: string;
  localPath?: string;
}

interface CachedListing {
  at: number;
  files: ReleaseFile[];
}

interface CachedContent {
  at: number;
  body: string;
}

interface GithubCompareCommit {
  sha: string;
  commit?: {
    message?: string;
    author?: { date?: string | null } | null;
    committer?: { date?: string | null } | null;
  };
}

interface GithubComparePage {
  commits?: GithubCompareCommit[];
}

interface CompareReleaseNotes {
  title: string;
  date: string;
  body: string;
  changelogUrl: string;
}

interface CachedCompare {
  at: number;
  notes: CompareReleaseNotes;
}

// Module-level caches keep us well under the unauthenticated GitHub rate limit
// (the dialog is fetched once per user session). They are best-effort and reset
// on cold start.
let listingCache: CachedListing | null = null;
const contentCache = new Map<string, CachedContent>();
const compareCache = new Map<string, CachedCompare>();

export interface ReleaseNotesResponse {
  requestedVersion: string;
  matchedVersion: string | null;
  title: string | null;
  date: string | null;
  body: string | null;
  source: "generated" | "github-compare" | "github" | "local" | "none";
  changelogUrl: string | null;
}

interface MainIncrementReleaseNotes {
  version: string;
  title: string;
  date: string;
  body: string;
  changelogUrl: string;
}

interface GithubRepository {
  owner: string;
  repository: string;
}

interface ConfiguredGithubCompare {
  repository: GithubRepository;
  previousCommit: string;
  latestCommit: string;
}

function parseGithubRepositoryUrl(value: string): GithubRepository | null {
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      parts.length !== 2 ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return { owner: parts[0], repository: parts[1] };
  } catch {
    return null;
  }
}

async function readConfiguredGithubCompare(): Promise<ConfiguredGithubCompare | null> {
  const collection = await getCollection<{ _id: string; release_notes?: unknown }>("platform_config");
  const document = await collection.findOne({ _id: PLATFORM_CONFIG_ID } as never);
  if (!document?.release_notes || typeof document.release_notes !== "object") return null;
  const config = document.release_notes as Record<string, unknown>;
  const repositoryUrl = typeof config.repository_url === "string" ? config.repository_url.trim() : "";
  const previousCommit = typeof config.previous_commit === "string" ? config.previous_commit.trim() : "";
  const latestCommit = typeof config.latest_commit === "string" ? config.latest_commit.trim() : "";
  const repository = parseGithubRepositoryUrl(repositoryUrl);
  if (
    !repository ||
    !COMMIT_SHA_PATTERN.test(previousCommit) ||
    !COMMIT_SHA_PATTERN.test(latestCommit)
  ) {
    return null;
  }
  return { repository, previousCommit, latestCommit };
}

function markdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function classifyCommitSubject(subject: string): {
  category: "features" | "fixes" | "security" | "performance" | "docs" | "maintenance";
  pullRequest: string | null;
  scope: string | null;
  text: string;
} {
  const pullRequestMatch = subject.match(/\s+\(#(\d+)\)$/);
  const pullRequest = pullRequestMatch?.[1] ?? null;
  const withoutPullRequest = pullRequestMatch
    ? subject.slice(0, pullRequestMatch.index).trim()
    : subject.trim();
  const conventional = withoutPullRequest.match(
    /^(feat|fix|docs|perf|security|refactor|chore|build|ci|test)(?:\(([^)]+)\))?:\s*(.+)$/i,
  );
  if (!conventional) {
    return { category: "maintenance", pullRequest, scope: null, text: withoutPullRequest };
  }

  const [, rawType, scope, text] = conventional;
  const type = rawType.toLowerCase();
  const category =
    type === "feat"
      ? "features"
      : type === "fix"
        ? "fixes"
        : type === "security"
          ? "security"
          : type === "docs"
            ? "docs"
            : type === "perf"
              ? "performance"
              : "maintenance";
  return { category, pullRequest, scope: scope ?? null, text };
}

function renderCompareMarkdown(
  commits: GithubCompareCommit[],
  repository: GithubRepository,
  previousCommit: string,
  latestCommit: string,
  compareUrl: string,
): string {
  const groups = new Map<
    ReturnType<typeof classifyCommitSubject>["category"],
    { heading: string; entries: string[] }
  >([
    ["features", { heading: "What's New", entries: [] }],
    ["fixes", { heading: "Bug Fixes", entries: [] }],
    ["security", { heading: "Security", entries: [] }],
    ["performance", { heading: "Performance", entries: [] }],
    ["docs", { heading: "Documentation", entries: [] }],
    ["maintenance", { heading: "Maintenance", entries: [] }],
  ]);

  for (const commit of commits) {
    const subject = commit.commit?.message?.split("\n", 1)[0]?.trim() || commit.sha;
    const change = classifyCommitSubject(subject);
    const scope = change.scope ? `**${markdownText(change.scope)}**: ` : "";
    const target = change.pullRequest
      ? `https://github.com/${repository.owner}/${repository.repository}/pull/${change.pullRequest}`
      : `https://github.com/${repository.owner}/${repository.repository}/commit/${commit.sha}`;
    const label = change.pullRequest ? `#${change.pullRequest}` : commit.sha.slice(0, 9);
    groups.get(change.category)?.entries.push(
      `- ${scope}${markdownText(change.text)} ([${label}](${target}))`,
    );
  }

  const sections = [
    `> Changes from \`${previousCommit.slice(0, 12)}\` through \`${latestCommit.slice(0, 12)}\`.`,
  ];
  for (const { heading, entries } of groups.values()) {
    if (entries.length > 0) sections.push(`## ${heading}\n\n${entries.join("\n")}`);
  }
  if (commits.length === 0) {
    sections.push("## Maintenance\n\nNo changes were found in the configured commit range.");
  }
  sections.push(`[Compare all changes](${compareUrl})`);
  return sections.join("\n\n");
}

async function readGithubCompareReleaseNotes(
  repository: GithubRepository,
  previousCommit: string,
  latestCommit: string,
): Promise<CompareReleaseNotes | null> {
  const cacheKey = `${repository.owner}/${repository.repository}:${previousCommit}...${latestCommit}`;
  const cached = compareCache.get(cacheKey);
  if (cached && Date.now() - cached.at < COMPARE_TTL_MS) return cached.notes;

  const commits: GithubCompareCommit[] = [];
  const compareUrl = `https://github.com/${repository.owner}/${repository.repository}/compare/${previousCommit}...${latestCommit}`;
  // Prefer the UI's standard GitHub token. The PAT name remains a compatibility
  // fallback for older Compose deployments.
  const token =
    process.env.RELEASE_NOTES_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    for (let page = 1; page <= 10; page += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const apiUrl =
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/` +
        `${encodeURIComponent(repository.repository)}/compare/${previousCommit}...${latestCommit}` +
        `?per_page=100&page=${page}`;
      let response: Response;
      try {
        response = await fetch(apiUrl, {
          signal: controller.signal,
          headers,
          cache: "no-store",
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        console.warn(
          `[Release Notes API] GitHub compare failed for ${repository.owner}/${repository.repository}: ${response.status}`,
        );
        return null;
      }
      const payload = (await response.json()) as GithubComparePage;
      const pageCommits = Array.isArray(payload.commits) ? payload.commits : [];
      commits.push(
        ...pageCommits.filter(
          (commit): commit is GithubCompareCommit =>
            typeof commit?.sha === "string" && COMMIT_SHA_PATTERN.test(commit.sha),
        ),
      );
      if (pageCommits.length < 100) break;
    }
  } catch (error) {
    console.warn("[Release Notes API] GitHub compare request failed:", error);
    return null;
  }

  const lastCommit = commits.at(-1);
  const dateValue = lastCommit?.commit?.committer?.date ?? lastCommit?.commit?.author?.date ?? null;
  const notes: CompareReleaseNotes = {
    title: `Changes ${previousCommit.slice(0, 9)} → ${latestCommit.slice(0, 9)}`,
    date: dateValue ? dateValue.slice(0, 10) : new Date().toISOString().slice(0, 10),
    body: renderCompareMarkdown(commits, repository, previousCommit, latestCommit, compareUrl),
    changelogUrl: compareUrl,
  };
  compareCache.set(cacheKey, { at: Date.now(), notes });
  return notes;
}

/** Strip a leading `v` and any pre-release / build suffix (`-dev.14`, `-rc.1`). */
function baseVersion(value: string): string {
  return value.trim().replace(/^v/i, "").split(/[-+]/)[0];
}

function readMainIncrementReleaseNotes(requestedVersion: string): MainIncrementReleaseNotes | null {
  const notesPath = path.join(process.cwd(), "public", "main-increment-release-notes.json");
  try {
    if (!fs.existsSync(notesPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(notesPath, "utf8")) as Partial<MainIncrementReleaseNotes>;
    if (
      parsed.version !== requestedVersion ||
      typeof parsed.title !== "string" ||
      typeof parsed.date !== "string" ||
      typeof parsed.body !== "string" ||
      typeof parsed.changelogUrl !== "string"
    ) {
      return null;
    }
    return parsed as MainIncrementReleaseNotes;
  } catch (error) {
    console.warn("[Release Notes API] Generated main increment notes are invalid:", error);
    return null;
  }
}

function buildReleaseFile(name: string, rawUrl: string, localPath?: string): ReleaseFile | null {
  const match = name.match(RELEASE_FILE_PATTERN);
  if (!match) return null;
  return {
    name,
    version: `${Number(match[1])}.${Number(match[2])}.0`,
    rawUrl,
    localPath,
  };
}

function listLocalReleaseFiles(): ReleaseFile[] | null {
  const candidateDirs = [
    path.join(process.cwd(), "..", RELEASES_DIR),
    path.join(process.cwd(), "..", "..", RELEASES_DIR),
    path.join(process.cwd(), RELEASES_DIR),
  ];
  for (const dir of candidateDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      const files = entries
        .map((name) => buildReleaseFile(name, `${RAW_BASE_URL}/${name}`, path.join(dir, name)))
        .filter((file): file is ReleaseFile => file !== null);
      if (files.length > 0) return files;
    } catch {
      // Try the next candidate directory.
    }
  }
  return null;
}

async function listGithubReleaseFiles(): Promise<ReleaseFile[] | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(CONTENTS_API_URL, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const entries: Array<{ name?: string; download_url?: string; type?: string }> = await response.json();
    if (!Array.isArray(entries)) return null;
    const files = entries
      .filter((entry) => entry?.type === "file" && typeof entry.name === "string")
      .map((entry) =>
        buildReleaseFile(entry.name as string, entry.download_url || `${RAW_BASE_URL}/${entry.name}`),
      )
      .filter((file): file is ReleaseFile => file !== null);
    return files.length > 0 ? files : null;
  } catch (err) {
    console.warn("[Release Notes API] GitHub listing failed:", err);
    return null;
  }
}

async function getReleaseFiles(): Promise<ReleaseFile[]> {
  if (listingCache && Date.now() - listingCache.at < LISTING_TTL_MS) {
    return listingCache.files;
  }
  // Prefer GitHub so deployed images (which do not bundle docs/) stay current;
  // fall back to the local checkout for development.
  const files = (await listGithubReleaseFiles()) ?? listLocalReleaseFiles() ?? [];
  if (files.length > 0) {
    listingCache = { at: Date.now(), files };
  }
  return files;
}

/** The `x.y.0` post that covers a version's whole minor series. */
function seriesVersion(value: string): string {
  const [major = "0", minor = "0"] = value.split(".");
  return `${Number(major)}.${Number(minor)}.0`;
}

/**
 * Release posts are published once per minor series, so patches and prereleases
 * resolve to their series post. A version whose series has no post yet stays
 * unmatched rather than borrowing notes from an earlier series.
 */
function selectRelease(files: ReleaseFile[], requestedBase: string): ReleaseFile | null {
  if (files.length === 0) return null;
  const series = seriesVersion(requestedBase);
  return files.find((file) => file.version === series) ?? null;
}

async function readReleaseContent(file: ReleaseFile): Promise<{ body: string; source: "github" | "local" } | null> {
  const cached = contentCache.get(file.name);
  if (cached && Date.now() - cached.at < CONTENT_TTL_MS) {
    return { body: cached.body, source: file.localPath ? "local" : "github" };
  }

  // GitHub raw is the source of truth for deployed images.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(file.rawUrl, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (response.ok) {
      const body = await response.text();
      contentCache.set(file.name, { at: Date.now(), body });
      return { body, source: "github" };
    }
  } catch (err) {
    console.warn("[Release Notes API] GitHub raw fetch failed, trying local:", err);
  }

  if (file.localPath) {
    try {
      const body = fs.readFileSync(file.localPath, "utf-8");
      contentCache.set(file.name, { at: Date.now(), body });
      return { body, source: "local" };
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Split YAML frontmatter from the markdown body and surface the `title`.
 * Also removes the Docusaurus `<!-- truncate -->` marker so the dialog renders a
 * single continuous body.
 */
function parseFrontmatter(raw: string): { title: string | null; date: string | null; body: string } {
  let title: string | null = null;
  let date: string | null = null;
  let body = raw;

  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    body = raw.slice(frontmatterMatch[0].length);
    const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    const dateMatch = frontmatter.match(/^date:\s*(.+)$/m);
    if (dateMatch) {
      date = dateMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  body = body.replace(/<!--\s*truncate\s*-->/g, "").trim();
  return { title, date, body };
}

export async function GET(request: NextRequest) {
  const requestedVersionRaw = request.nextUrl.searchParams.get("version") ?? "";
  const requestedVersion = requestedVersionRaw.trim();
  const useConfiguredCompare = request.nextUrl.searchParams.get("compare") === "platform";
  const empty: ReleaseNotesResponse = {
    requestedVersion,
    matchedVersion: null,
    title: null,
    date: null,
    body: null,
    source: "none",
    changelogUrl: null,
  };

  if (!requestedVersion) {
    return NextResponse.json(empty, { status: 400 });
  }

  try {
    if (useConfiguredCompare) {
      const configuredCompare = await readConfiguredGithubCompare();
      if (!configuredCompare) return NextResponse.json(empty, { status: 400 });
      const { repository, previousCommit, latestCommit } = configuredCompare;
      const compareNotes = await readGithubCompareReleaseNotes(
        repository,
        previousCommit,
        latestCommit,
      );
      if (!compareNotes) return NextResponse.json(empty, { status: 502 });
      return NextResponse.json({
        requestedVersion,
        matchedVersion: requestedVersion,
        title: compareNotes.title,
        date: compareNotes.date,
        body: compareNotes.body,
        source: "github-compare",
        changelogUrl: compareNotes.changelogUrl,
      } satisfies ReleaseNotesResponse);
    }

    const generated = readMainIncrementReleaseNotes(requestedVersion);
    if (generated) {
      return NextResponse.json({
        requestedVersion,
        matchedVersion: generated.version,
        title: generated.title,
        date: generated.date,
        body: generated.body,
        source: "generated",
        changelogUrl: generated.changelogUrl,
      } satisfies ReleaseNotesResponse);
    }

    const files = await getReleaseFiles();
    const selected = selectRelease(files, baseVersion(requestedVersion));
    if (!selected) {
      return NextResponse.json(empty);
    }

    const content = await readReleaseContent(selected);
    if (!content) {
      return NextResponse.json(empty);
    }

    const { title, date, body } = parseFrontmatter(content.body);
    if (!body) {
      return NextResponse.json(empty);
    }

    const result: ReleaseNotesResponse = {
      requestedVersion,
      matchedVersion: selected.version,
      title,
      date,
      body,
      source: content.source,
      changelogUrl: null,
    };
    return NextResponse.json(result);
  } catch (error) {
    console.error("[Release Notes API] Error resolving release notes:", error);
    return NextResponse.json(empty, { status: 500 });
  }
}
