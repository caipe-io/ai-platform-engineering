import fs from "fs";
import { NextRequest,NextResponse } from "next/server";
import path from "path";

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

// Module-level caches keep us well under the unauthenticated GitHub rate limit
// (the dialog is fetched once per user session). They are best-effort and reset
// on cold start.
let listingCache: CachedListing | null = null;
const contentCache = new Map<string, CachedContent>();

export interface ReleaseNotesResponse {
  requestedVersion: string;
  matchedVersion: string | null;
  title: string | null;
  date: string | null;
  body: string | null;
  source: "github" | "local" | "none";
}

/** Strip a leading `v` and any pre-release / build suffix (`-dev.14`, `-rc.1`). */
function baseVersion(value: string): string {
  return value.trim().replace(/^v/i, "").split(/[-+]/)[0];
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
  const empty: ReleaseNotesResponse = {
    requestedVersion,
    matchedVersion: null,
    title: null,
    date: null,
    body: null,
    source: "none",
  };

  if (!requestedVersion) {
    return NextResponse.json(empty, { status: 400 });
  }

  try {
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
    };
    return NextResponse.json(result);
  } catch (error) {
    console.error("[Release Notes API] Error resolving release notes:", error);
    return NextResponse.json(empty, { status: 500 });
  }
}
