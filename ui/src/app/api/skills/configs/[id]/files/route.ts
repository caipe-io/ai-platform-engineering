import {
getAgentSkillVisibleToUser,
} from "@/lib/agent-skill-visibility";
import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { requireSkillPermission } from "@/lib/rbac/resource-authz";
import { recordRevision } from "@/lib/skill-revisions";
import type { AgentSkill } from "@/types/agent-skill";
import { NextRequest } from "next/server";

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";
const SKILL_MD_PATH = "SKILL.md";
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_FILES = 200;

interface ListEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

/**
 * GET    /api/skills/configs/[id]/files?path=<rel>
 * PUT    /api/skills/configs/[id]/files                — body: { path, content }
 * DELETE /api/skills/configs/[id]/files?path=<rel>
 *
 * Files API for non-hub skills. Treats `skill_content` as `SKILL.md` and
 * `ancillary_files` as a flat Record<path, text content>. Directories are
 * synthesized from path prefixes for the tree UI.
 */
export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    if (STORAGE_TYPE !== "mongodb") {
      throw new ApiError("Skills require MongoDB to be configured", 503);
    }
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const relPath = sanitizePath(searchParams.get("path") ?? "");

    return await withAuth(request, async (_req, user, session) => {
      const skill = await getAgentSkillVisibleToUser(id);
      if (!skill) throw new ApiError("Skill not found", 404);
      await requireSkillPermission(
        session,
        id,
        searchParams.get("file") ? "use" : "read",
      );

      // Listing
      if (!searchParams.get("file")) {
        const tree = listDir(skill, relPath);
        return successResponse({ entries: tree, path: relPath });
      }

      // Single file fetch
      const target = searchParams.get("file") ?? relPath;
      const cleanTarget = sanitizePath(target);
      const content = readFile(skill, cleanTarget);
      if (content == null) throw new ApiError("File not found", 404);
      return successResponse({
        path: cleanTarget,
        content,
        size: Buffer.byteLength(content, "utf-8"),
        truncated: false,
        type: "text",
      });
    });
  },
);

interface PutBody {
  path: string;
  content: string;
}

export const PUT = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    if (STORAGE_TYPE !== "mongodb") {
      throw new ApiError("Skills require MongoDB to be configured", 503);
    }
    const { id } = await context.params;
    return await withAuth(request, async (_req, user, session) => {
      const skill = await getAgentSkillVisibleToUser(id);
      if (!skill) throw new ApiError("Skill not found", 404);
      await requireSkillPermission(session, id, "write");
      if (skill.config_driven) {
        throw new ApiError("Config-driven skills are read-only. Update app-config.yaml.", 403);
      }

      const body = (await request.json()) as PutBody;
      const path = sanitizePath(body?.path ?? "");
      if (!path) throw new ApiError("`path` is required", 400);
      const content = typeof body.content === "string" ? body.content : "";
      if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) {
        throw new ApiError(
          `File exceeds ${MAX_FILE_BYTES} byte limit`,
          413,
        );
      }

      const collection = await getCollection<AgentSkill>("agent_skills");
      const now = new Date();

      // Capture the post-edit content shape locally so the revision
      // helper sees exactly what was persisted, regardless of whether
      // we wrote SKILL.md or an ancillary file.
      let nextSkillContent = skill.skill_content;
      let nextAncillary = skill.ancillary_files;

      if (path === SKILL_MD_PATH) {
        const result = await collection.updateOne(
          { id, config_driven: { $ne: true } },
          { $set: { skill_content: content, updated_at: now } },
        );
        if (!result.matchedCount) throw new ApiError("Skill changed during the request. Reload and retry.", 409);
        nextSkillContent = content;
      } else {
        const ancillary = { ...(skill.ancillary_files ?? {}) };
        if (
          !ancillary[path] &&
          Object.keys(ancillary).length >= MAX_TOTAL_FILES
        ) {
          throw new ApiError(
            `Skill exceeds the ${MAX_TOTAL_FILES} file cap`,
            413,
          );
        }
        ancillary[path] = content;
        const result = await collection.updateOne(
          { id, config_driven: { $ne: true } },
          { $set: { ancillary_files: ancillary, updated_at: now } },
        );
        if (!result.matchedCount) throw new ApiError("Skill changed during the request. Reload and retry.", 409);
        nextAncillary = ancillary;
      }

      // Per-file edits go straight to Mongo without touching the
      // scanner — they're cheap incremental saves from the workspace
      // file editor. We still snapshot history so a user who fat-
      // fingers a SKILL.md edit can roll back. The `file_edit` tag
      // distinguishes these from full-form saves in the timeline.
      await recordRevision({
        skillId: id,
        snapshot: {
          name: skill.name,
          description: skill.description,
          category: skill.category,
          tasks: skill.tasks ?? [],
          metadata: skill.metadata,
          is_quick_start: skill.is_quick_start,
          difficulty: skill.difficulty,
          thumbnail: skill.thumbnail,
          input_form: skill.input_form,
          skill_content: nextSkillContent,
          ancillary_files: nextAncillary,
          scan_status: skill.scan_status,
          scan_summary: skill.scan_summary,
        },
        trigger: "file_edit",
        actor: user.email,
        note: `Edited ${path}`,
      });
      return successResponse({ path, size: Buffer.byteLength(content, "utf-8") });
    });
  },
);

export const DELETE = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    if (STORAGE_TYPE !== "mongodb") {
      throw new ApiError("Skills require MongoDB to be configured", 503);
    }
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const path = sanitizePath(searchParams.get("path") ?? "");
    if (!path) throw new ApiError("`path` query param is required", 400);

    return await withAuth(request, async (_req, user, session) => {
      const skill = await getAgentSkillVisibleToUser(id);
      if (!skill) throw new ApiError("Skill not found", 404);
      await requireSkillPermission(session, id, "write");
      if (skill.config_driven) {
        throw new ApiError("Config-driven skills are read-only. Update app-config.yaml.", 403);
      }
      const collection = await getCollection<AgentSkill>("agent_skills");
      const now = new Date();

      let nextSkillContent = skill.skill_content;
      let nextAncillary = skill.ancillary_files;

      if (path === SKILL_MD_PATH) {
        const result = await collection.updateOne(
          { id, config_driven: { $ne: true } },
          { $set: { skill_content: "", updated_at: now } },
        );
        if (!result.matchedCount) throw new ApiError("Skill changed during the request. Reload and retry.", 409);
        nextSkillContent = "";
      } else {
        const ancillary = { ...(skill.ancillary_files ?? {}) };
        if (!(path in ancillary)) {
          throw new ApiError("File not found", 404);
        }
        delete ancillary[path];
        const result = await collection.updateOne(
          { id, config_driven: { $ne: true } },
          { $set: { ancillary_files: ancillary, updated_at: now } },
        );
        if (!result.matchedCount) throw new ApiError("Skill changed during the request. Reload and retry.", 409);
        nextAncillary = ancillary;
      }

      // Tag deletes distinctly from edits so the timeline can render
      // a deletion icon and the diff view knows the file vanished.
      await recordRevision({
        skillId: id,
        snapshot: {
          name: skill.name,
          description: skill.description,
          category: skill.category,
          tasks: skill.tasks ?? [],
          metadata: skill.metadata,
          is_quick_start: skill.is_quick_start,
          difficulty: skill.difficulty,
          thumbnail: skill.thumbnail,
          input_form: skill.input_form,
          skill_content: nextSkillContent,
          ancillary_files: nextAncillary,
          scan_status: skill.scan_status,
          scan_summary: skill.scan_summary,
        },
        trigger: "file_delete",
        actor: user.email,
        note: `Deleted ${path}`,
      });
      return successResponse({ path, deleted: true });
    });
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizePath(raw: string): string {
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

/** Project the flat (path → content) map into one directory level. */
function listDir(skill: AgentSkill, relPath: string): ListEntry[] {
  const entries = new Map<string, ListEntry>();
  const allPaths: string[] = [];
  if (skill.skill_content !== undefined) allPaths.push(SKILL_MD_PATH);
  for (const p of Object.keys(skill.ancillary_files ?? {})) allPaths.push(p);

  const prefix = relPath ? `${relPath}/` : "";
  for (const p of allPaths) {
    if (relPath && !p.startsWith(prefix)) continue;
    const remainder = relPath ? p.slice(prefix.length) : p;
    if (!remainder) continue;
    const slash = remainder.indexOf("/");
    if (slash === -1) {
      entries.set(remainder, {
        name: remainder,
        path: relPath ? `${relPath}/${remainder}` : remainder,
        type: "file",
        size:
          p === SKILL_MD_PATH
            ? Buffer.byteLength(skill.skill_content || "", "utf-8")
            : Buffer.byteLength(skill.ancillary_files?.[p] || "", "utf-8"),
      });
    } else {
      const dirName = remainder.slice(0, slash);
      if (!entries.has(dirName)) {
        entries.set(dirName, {
          name: dirName,
          path: relPath ? `${relPath}/${dirName}` : dirName,
          type: "dir",
        });
      }
    }
  }
  return [...entries.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function readFile(skill: AgentSkill, path: string): string | null {
  if (path === SKILL_MD_PATH) return skill.skill_content ?? "";
  const ancillary = skill.ancillary_files ?? {};
  return path in ancillary ? ancillary[path] : null;
}
