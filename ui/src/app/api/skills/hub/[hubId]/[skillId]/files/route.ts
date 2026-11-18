import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import {
resolveHubToken,
type HubSkillDoc,
type SkillHubDoc,
} from "@/lib/hub-crawl";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { NextRequest } from "next/server";

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";

/**
 * GET /api/skills/hub/[hubId]/[skillId]/files?path=<rel>
 *
 * Lists the contents of a directory inside a hub-crawled skill folder.
 * Lazy-fetches from GitHub/GitLab Contents API on each request — no caching
 * beyond what `getHubSkills` already stores for SKILL.md.
 *
 * Path is interpreted relative to the skill directory; `..` segments and
 * absolute paths are rejected so callers cannot escape the skill folder.
 */
export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ hubId: string; skillId: string }> },
  ) => {
    if (STORAGE_TYPE !== "mongodb") {
      throw new ApiError("Skill hubs require MongoDB to be configured", 503);
    }

    const { hubId, skillId } = await context.params;
    if (!hubId || !skillId) {
      throw new ApiError("hubId and skillId are required", 400);
    }

    const { searchParams } = new URL(request.url);
    const relPath = sanitizeRelPath(searchParams.get("path") ?? "");

    return await withAuth(request, async (_req, _user, session) => {
      await requireResourcePermission(session, {
        type: "skill",
        id: `hub-${hubId}-${skillId}`,
        action: "read",
      });
      const { hub, skillDir } = await resolveHubAndSkillDir(hubId, skillId);

      const fullPath = relPath ? `${skillDir}/${relPath}` : skillDir;

      if (hub.type === "github") {
        return successResponse(await listGitHubDir(hub, fullPath, skillDir));
      }
      if (hub.type === "gitlab") {
        return successResponse(await listGitLabDir(hub, fullPath, skillDir));
      }
      throw new ApiError(`Unsupported hub type: ${hub.type}`, 400);
    });
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sanitizeRelPath(raw: string): string {
  const cleaned = raw.replace(/^\/+|\/+$/g, "").trim();
  if (!cleaned) return "";
  if (cleaned.startsWith("/")) {
    throw new ApiError("Absolute paths are not allowed", 400);
  }
  const parts = cleaned.split("/");
  if (parts.some((p) => p === ".." || p === "" || p === ".")) {
    throw new ApiError("Path traversal segments are not allowed", 400);
  }
  return parts.join("/");
}

export async function resolveHubAndSkillDir(
  hubId: string,
  skillId: string,
): Promise<{ hub: SkillHubDoc; skillDir: string; doc: HubSkillDoc }> {
  const hubsCol = await getCollection<SkillHubDoc>("skill_hubs");
  const hub = await hubsCol.findOne({ id: hubId });
  if (!hub) {
    throw new ApiError("Skill hub not found", 404);
  }
  const docsCol = await getCollection<HubSkillDoc>("hub_skills");
  const doc = await docsCol.findOne({ hub_id: hubId, skill_id: skillId });
  if (!doc) {
    throw new ApiError(
      "Skill not found in hub cache. Re-crawl the hub from Admin.",
      404,
    );
  }
  // Path stored on the cache doc points at `<dir>/SKILL.md`; the skill folder
  // is the parent directory.
  const skillDir = doc.path.slice(0, doc.path.lastIndexOf("/"));
  const revision = typeof doc.metadata?.upstream_revision === "string" && /^[a-f0-9]{40}$/.test(doc.metadata.upstream_revision) ? doc.metadata.upstream_revision : hub.revision;
  return { hub: { ...hub, revision }, skillDir, doc };
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

interface GitHubContentsItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
}

async function listGitHubDir(
  hub: SkillHubDoc,
  fullPath: string,
  skillDir: string,
): Promise<{ entries: FileEntry[]; path: string }> {
  const token = resolveHubToken(hub);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "caipe-hub-files/1.0",
  };
  if (token) headers.Authorization = `token ${token}`;

  const url = `https://api.github.com/repos/${hub.location}/contents/${encodeURI(fullPath)}${hub.revision ? `?ref=${hub.revision}` : ""}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    throw new ApiError(`Path not found: ${fullPath}`, 404);
  }
  if (!res.ok) {
    throw new ApiError(
      `GitHub Contents API error: ${res.status} ${res.statusText}`,
      502,
    );
  }
  const data = (await res.json()) as GitHubContentsItem | GitHubContentsItem[];
  const items = Array.isArray(data) ? data : [data];
  const entries: FileEntry[] = items
    .filter((it) => it.type === "file" || it.type === "dir")
    .map((it) => ({
      name: it.name,
      path: stripSkillDir(it.path, skillDir),
      type: it.type as "file" | "dir",
      size: it.type === "file" ? it.size : undefined,
    }))
    .sort(byDirsFirst);
  return { entries, path: stripSkillDir(fullPath, skillDir) };
}

interface GitLabContentsItem {
  name: string;
  path: string;
  type: "tree" | "blob";
}

async function listGitLabDir(
  hub: SkillHubDoc,
  fullPath: string,
  skillDir: string,
): Promise<{ entries: FileEntry[]; path: string }> {
  const token = resolveHubToken(hub);
  const baseUrl = process.env.GITLAB_API_URL || "https://gitlab.com/api/v4";
  const headers: Record<string, string> = { "User-Agent": "caipe-hub-files/1.0" };
  if (token) headers["PRIVATE-TOKEN"] = token;

  const project = encodeURIComponent(hub.location);
  const url = `${baseUrl}/projects/${project}/repository/tree?path=${encodeURIComponent(
    fullPath,
  )}&per_page=100&ref=HEAD`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    throw new ApiError(`Path not found: ${fullPath}`, 404);
  }
  if (!res.ok) {
    throw new ApiError(
      `GitLab Tree API error: ${res.status} ${res.statusText}`,
      502,
    );
  }
  const items = (await res.json()) as GitLabContentsItem[];
  const entries: FileEntry[] = items
    .map((it) => ({
      name: it.name,
      path: stripSkillDir(it.path, skillDir),
      type: it.type === "tree" ? ("dir" as const) : ("file" as const),
    }))
    .sort(byDirsFirst);
  return { entries, path: stripSkillDir(fullPath, skillDir) };
}

/** Convert a repo-rooted path like "skills/foo/bar.md" to "bar.md". */
function stripSkillDir(repoPath: string, skillDir: string): string {
  if (!skillDir) return repoPath;
  const prefix = `${skillDir}/`;
  if (repoPath === skillDir) return "";
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
}

function byDirsFirst(a: FileEntry, b: FileEntry): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}
