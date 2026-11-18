import {
resolveHubAndSkillDir,
sanitizeRelPath,
} from "@/app/api/skills/hub/[hubId]/[skillId]/files/route";
import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import { resolveHubToken } from "@/lib/hub-crawl";
import { isMongoDBConfigured } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { NextRequest } from "next/server";

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";
const MAX_BYTES = 1_000_000; // 1 MB cap to keep responses small.

const TEXT_EXTENSIONS = new Set([
  "md", "mdx", "txt", "json", "yaml", "yml", "toml", "xml", "html", "htm",
  "css", "scss", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp",
  "sh", "bash", "zsh", "ps1", "sql", "ini", "conf", "cfg", "env",
  "dockerfile", "makefile", "gitignore", "editorconfig",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico"]);

export interface FileContentResponse {
  path: string;
  content?: string;
  /** Base64 image when type === "image". */
  image_base64?: string;
  /** MIME hint when type === "image". */
  image_mime?: string;
  size: number;
  truncated: boolean;
  type: "text" | "image" | "binary";
}

/**
 * GET /api/skills/hub/[hubId]/[skillId]/files/content?path=<rel>
 *
 * Returns the contents of a single file inside the skill folder. Text files
 * up to 1 MB are returned verbatim. Images are returned base64-encoded for
 * inline rendering. Other binaries return only metadata.
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
    const { searchParams } = new URL(request.url);
    const relPath = sanitizeRelPath(searchParams.get("path") ?? "");
    if (!relPath) {
      throw new ApiError("path query param is required", 400);
    }

    return await withAuth(request, async (_req, _user, session) => {
      await requireResourcePermission(session, {
        type: "skill",
        id: `hub-${hubId}-${skillId}`,
        action: "use",
      });
      const { hub, skillDir } = await resolveHubAndSkillDir(hubId, skillId);
      const fullPath = `${skillDir}/${relPath}`;
      const ext = relPath.split(".").pop()?.toLowerCase() || "";

      const raw =
        hub.type === "github"
          ? await fetchGitHubBlob(hub.location, fullPath, resolveHubToken(hub), hub.revision)
          : await fetchGitLabBlob(hub.location, fullPath, resolveHubToken(hub));

      const isImage = IMAGE_EXTENSIONS.has(ext);
      const isText = TEXT_EXTENSIONS.has(ext) || looksLikeText(raw.bytes);

      if (raw.size > MAX_BYTES && !isImage) {
        const payload: FileContentResponse = {
          path: relPath,
          size: raw.size,
          truncated: true,
          type: isText ? "text" : "binary",
        };
        return successResponse(payload);
      }

      if (isImage) {
        const payload: FileContentResponse = {
          path: relPath,
          image_base64: raw.bytes.toString("base64"),
          image_mime: imageMime(ext),
          size: raw.size,
          truncated: false,
          type: "image",
        };
        return successResponse(payload);
      }
      if (isText) {
        const payload: FileContentResponse = {
          path: relPath,
          content: raw.bytes.toString("utf-8"),
          size: raw.size,
          truncated: false,
          type: "text",
        };
        return successResponse(payload);
      }

      const payload: FileContentResponse = {
        path: relPath,
        size: raw.size,
        truncated: false,
        type: "binary",
      };
      return successResponse(payload);
    });
  },
);

interface RawBlob {
  bytes: Buffer;
  size: number;
}

async function fetchGitHubBlob(
  location: string,
  fullPath: string,
  token: string | undefined,
  revision?: string,
): Promise<RawBlob> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3.raw",
    "User-Agent": "caipe-hub-files/1.0",
  };
  if (token) headers.Authorization = `token ${token}`;
  const url = `https://api.github.com/repos/${location}/contents/${encodeURI(fullPath)}${revision ? `?ref=${revision}` : ""}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) {
    throw new ApiError(`File not found: ${fullPath}`, 404);
  }
  if (!res.ok) {
    throw new ApiError(`GitHub raw fetch failed: ${res.status}`, 502);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { bytes: buf, size: buf.length };
}

async function fetchGitLabBlob(
  location: string,
  fullPath: string,
  token: string | undefined,
): Promise<RawBlob> {
  const baseUrl = process.env.GITLAB_API_URL || "https://gitlab.com/api/v4";
  const headers: Record<string, string> = { "User-Agent": "caipe-hub-files/1.0" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  const project = encodeURIComponent(location);
  const path = encodeURIComponent(fullPath);
  const url = `${baseUrl}/projects/${project}/repository/files/${path}/raw?ref=HEAD`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) {
    throw new ApiError(`File not found: ${fullPath}`, 404);
  }
  if (!res.ok) {
    throw new ApiError(`GitLab raw fetch failed: ${res.status}`, 502);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { bytes: buf, size: buf.length };
}

function imageMime(ext: string): string {
  switch (ext) {
    case "svg":
      return "image/svg+xml";
    case "jpg":
      return "image/jpeg";
    case "ico":
      return "image/x-icon";
    default:
      return `image/${ext}`;
  }
}

/** Heuristic: treat as text if the first 512 bytes contain no NUL. */
function looksLikeText(buf: Buffer): boolean {
  const slice = buf.subarray(0, 512);
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) return false;
  }
  return true;
}
