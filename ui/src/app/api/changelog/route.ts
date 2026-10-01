import fs from "fs";
import { NextResponse } from "next/server";
import path from "path";

export const dynamic = "force-dynamic";

const CHANGELOG_URL =
  "https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/CHANGELOG.md";
const STABLE_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export interface ChangelogItem {
  text: string;
  scope: string | null;
}

export interface ChangelogRelease {
  version: string;
  date: string;
  sections: { type: string; items: ChangelogItem[] }[];
}

function extractScope(text: string): { scope: string | null; text: string } {
  const match = text.match(/^\*\*([a-zA-Z0-9_/.-]+)\*\*:\s*/);
  if (match) {
    return { scope: match[1].toLowerCase(), text };
  }
  return { scope: null, text };
}

function collectScopes(releases: ChangelogRelease[]): string[] {
  const scopeSet = new Set<string>();
  for (const release of releases) {
    for (const section of release.sections) {
      for (const item of section.items) {
        if (item.scope) scopeSet.add(item.scope);
      }
    }
  }
  return Array.from(scopeSet).sort();
}

function normalizeVersion(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^v/i, "");
}

function versionParts(version: string): [number, number, number] | null {
  const match = normalizeVersion(version).match(RELEASE_VERSION_PATTERN);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) return 0;

  for (let index = 0; index < leftParts.length; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) return delta;
  }

  return 0;
}

function prereleaseBase(version: string): string | null {
  const normalized = normalizeVersion(version);
  if (STABLE_RELEASE_VERSION_PATTERN.test(normalized)) return null;
  const base = normalized.split("-")[0].split("+")[0];
  return STABLE_RELEASE_VERSION_PATTERN.test(base) ? base : null;
}

function appendSections(
  target: ChangelogRelease["sections"],
  sections: ChangelogRelease["sections"]
): void {
  for (const section of sections) {
    const existing = target.find((item) => item.type === section.type);
    if (existing) {
      existing.items.push(...section.items);
    } else {
      target.push({ type: section.type, items: [...section.items] });
    }
  }
}

function shouldRollIntoStable(
  prerelease: ChangelogRelease,
  stable: ChangelogRelease,
  nextStable: ChangelogRelease | null
): boolean {
  const base = prereleaseBase(prerelease.version);
  if (!base || compareVersions(base, stable.version) >= 0) return false;
  return !nextStable || compareVersions(base, nextStable.version) >= 0;
}

function stableReleasesWithRolledUpPrereleases(releases: ChangelogRelease[]): ChangelogRelease[] {
  const stableIndexes = releases
    .map((release, index) => ({ release, index }))
    .filter(({ release }) => STABLE_RELEASE_VERSION_PATTERN.test(release.version));

  return stableIndexes.map(({ release, index }, stablePosition) => {
    const nextStable = stableIndexes[stablePosition + 1] ?? null;
    const nextStableIndex = nextStable?.index ?? releases.length;
    const sections = release.sections.map((section) => ({
      type: section.type,
      items: [...section.items],
    }));

    // assisted-by Codex Codex-sonnet-4-6
    for (const candidate of releases.slice(index + 1, nextStableIndex)) {
      if (shouldRollIntoStable(candidate, release, nextStable?.release ?? null)) {
        appendSections(sections, candidate.sections);
      }
    }

    return { ...release, sections };
  });
}

function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  const lines = markdown.split("\n");

  let currentRelease: ChangelogRelease | null = null;
  let currentSection: { type: string; items: ChangelogItem[] } | null = null;

  for (const line of lines) {
    const versionMatch = line.match(
      /^## v?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.]+)*)\s*\((\d{4}-\d{2}-\d{2})\)/
    );
    if (versionMatch) {
      const [, version, date] = versionMatch;
      if (currentRelease) {
        if (currentSection && currentSection.items.length > 0) {
          currentRelease.sections.push(currentSection);
        }
        releases.push(currentRelease);
      }
      currentRelease = { version, date, sections: [] };
      currentSection = null;
      continue;
    }

    if (!currentRelease) continue;

    const sectionMatch = line.match(/^### (.+)/);
    if (sectionMatch) {
      if (currentSection && currentSection.items.length > 0) {
        currentRelease.sections.push(currentSection);
      }
      currentSection = { type: sectionMatch[1].trim(), items: [] };
      continue;
    }

    const itemMatch = line.match(/^- (.+)/);
    if (itemMatch && currentSection) {
      const { scope, text } = extractScope(itemMatch[1].trim());
      currentSection.items.push({ text, scope });
    }
  }

  if (currentRelease) {
    if (currentSection && currentSection.items.length > 0) {
      currentRelease.sections.push(currentSection);
    }
    releases.push(currentRelease);
  }

  return releases;
}

// The running build's version, baked into public/version.json at image build.
function readDeployedVersion(): string {
  try {
    const versionPath = path.join(process.cwd(), "public", "version.json");
    if (!fs.existsSync(versionPath)) return "";
    const parsed = JSON.parse(fs.readFileSync(versionPath, "utf-8")) as { version?: string };
    return normalizeVersion(parsed.version);
  } catch (err) {
    console.warn("[Changelog API] Could not read deployed version:", err);
    return "";
  }
}

/**
 * Prereleases are normally folded into the stable release that supersedes them,
 * which hides the running version whenever a prerelease is deployed. Surface
 * that one entry on its own; older prereleases stay rolled up.
 */
function withDeployedPrerelease(
  stableReleases: ChangelogRelease[],
  allReleases: ChangelogRelease[],
  deployedVersion: string
): ChangelogRelease[] {
  if (!deployedVersion || STABLE_RELEASE_VERSION_PATTERN.test(deployedVersion)) {
    return stableReleases;
  }
  const deployed = allReleases.find(
    (release) => normalizeVersion(release.version) === deployedVersion
  );
  return deployed ? [deployed, ...stableReleases] : stableReleases;
}

async function fetchChangelogContent(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(CHANGELOG_URL, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
      cache: "no-store",
    });
    clearTimeout(timeout);

    if (response.ok) {
      return await response.text();
    }
  } catch (err) {
    console.warn("[Changelog API] GitHub fetch failed, trying local fallback:", err);
  }

  const localPaths = [
    path.join(process.cwd(), "..", "CHANGELOG.md"),
    path.join(process.cwd(), "CHANGELOG.md"),
  ];
  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf-8");
    }
  }

  return null;
}

export async function GET() {
  try {
    const markdown = await fetchChangelogContent();

    if (!markdown) {
      return NextResponse.json(
        { error: "Failed to fetch changelog", releases: [], scopes: [] },
        { status: 502 }
      );
    }

    const allReleases = parseChangelog(markdown);

    const releases = withDeployedPrerelease(
      stableReleasesWithRolledUpPrereleases(allReleases),
      allReleases,
      readDeployedVersion()
    );
    const scopes = collectScopes(releases);

    return NextResponse.json({ releases, scopes });
  } catch (error) {
    console.error("[Changelog API] Error fetching changelog:", error);
    return NextResponse.json(
      { error: "Failed to fetch changelog", releases: [], scopes: [] },
      { status: 500 }
    );
  }
}
