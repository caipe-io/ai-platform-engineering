import { githubHubOptions } from "@/lib/github-hub-options";
import {
ApiError,
getAuthFromBearerOrSession,
validateCredentialsRef,
withErrorHandler,
} from "@/lib/api-middleware";
import type { CrawlEvent } from "@/lib/crawl-events";
import type { HubLastCrawlTruncation } from "@/lib/hub-crawl";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { requireAdminSurfaceManage,requireBaselineAdminSurfaceRead } from "@/lib/rbac/require-openfga";
import { ObjectId } from "mongodb";
import { NextRequest,NextResponse } from "next/server";
import {
normalizeHubLocation,
validateIncludePaths,
validateMaxTreePages,
} from "./_lib/normalize";

/**
 * Skill Hubs API — Admin endpoints for managing external skill hubs.
 *
 * GET  /api/skill-hubs       — List all registered hubs (authenticated read-only)
 * POST /api/skill-hubs       — Register a new hub (admin only)
 *
 * Per contracts/skill-hubs-api.md
 */

interface SkillHubDoc {
  _id?: ObjectId;
  id: string;
  type: "github" | "gitlab";
  location: string;
  enabled: boolean;
  credentials_ref: string | null;
  labels: string[];
  /** Team ids or slugs granted can_use on every skill crawled from this hub. */
  shared_with_teams?: string[];
  /** Optional path-prefix allow-list for hub crawl (FR-020). */
  include_paths?: string[];
  revision?: string;
  entry_paths?: string[];
  /**
   * GitLab only: per-hub override of the recursive-tree page cap.
   * Mirrors the canonical ``SkillHubDoc.max_tree_pages`` in
   * ``@/lib/hub-crawl``. Kept on this local interface so the
   * insertOne path round-trips with strict typing.
   */
  max_tree_pages?: number;
  /** Truncation summary from the most recent successful crawl (mirror of canonical). */
  last_truncation?: HubLastCrawlTruncation;
  /** Persisted, redacted log of the most recent ``forceFresh`` crawl. */
  last_crawl_log?: CrawlEvent[];
  /** ISO timestamp of when ``last_crawl_log`` was written. */
  last_crawl_log_at?: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_message: string | null;
  created_at: string;
  updated_at: string;
}

function sanitizeHub(doc: SkillHubDoc) {
  const rest: Omit<SkillHubDoc, "_id"> & { _id?: ObjectId } = { ...doc };
  delete rest._id;
  return rest;
}

function normalizeTeamRefs(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  if (!isMongoDBConfigured) {
    return NextResponse.json({ hubs: [] });
  }

  const { session } = await getAuthFromBearerOrSession(request);
  await requireBaselineAdminSurfaceRead(session, "skills");

    const collection = await getCollection<SkillHubDoc>("skill_hubs");
    const hubs = await collection.find().sort({ created_at: 1 }).toArray();

    // Per-hub counts: total cached skills + scan outcome buckets so the
    // admin section can render an accurate "X unscanned, Y flagged"
    // nudge without a second round-trip.
    const hubSkills = await getCollection("hub_skills");
    const counts = await hubSkills.aggregate<{
      _id: string;
      count: number;
      unscanned: number;
      flagged: number;
      passed: number;
    }>([
      {
        $group: {
          _id: "$hub_id",
          count: { $sum: 1 },
          // Treat "no scan_status field yet" as unscanned — that's what
          // the workspace UI does, and it's how a freshly-crawled skill
          // looks before the async scan finishes.
          unscanned: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$scan_status", "unscanned"] },
                    { $eq: [{ $ifNull: ["$scan_status", null] }, null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          flagged: {
            $sum: { $cond: [{ $eq: ["$scan_status", "flagged"] }, 1, 0] },
          },
          passed: {
            $sum: { $cond: [{ $eq: ["$scan_status", "passed"] }, 1, 0] },
          },
        },
      },
    ]).toArray();
    const countMap = new Map(counts.map((c) => [c._id, c]));

    return NextResponse.json({
      hubs: hubs.map((h) => {
        const c = countMap.get(h.id);
        return {
          ...sanitizeHub(h),
          skills_count: c?.count ?? 0,
          scan_unscanned_count: c?.unscanned ?? 0,
          scan_flagged_count: c?.flagged ?? 0,
          scan_passed_count: c?.passed ?? 0,
        };
      }),
    });
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  if (!isMongoDBConfigured) {
    throw new ApiError("Skill hubs require MongoDB to be configured", 503);
  }

  const { session } = await getAuthFromBearerOrSession(request);
  await requireAdminSurfaceManage(session, "skills");

    const body = await request.json();

    // Validate required fields
    const { type, location } = body;
    if (!type || !location) {
      throw new ApiError("Missing required fields: type, location", 400);
    }
    if (!["github", "gitlab"].includes(type)) {
      throw new ApiError(
        `Unsupported hub type: ${type}. Supported: "github", "gitlab".`,
        400,
      );
    }
    if (typeof location !== "string" || !location.includes("/")) {
      throw new ApiError(
        `Invalid location format. Expected "${type === "gitlab" ? "group/project" : "owner/repo"}".`,
        400,
      );
    }

    // Normalize full URLs to canonical form. GitHub stays flat owner/repo;
    // GitLab preserves every subgroup segment so e.g.
    // https://gitlab.com/mycorp/devops/platform → mycorp/devops/platform
    // (FR-022 / SC-010).
    const normalizedLocation = normalizeHubLocation(location, type);

    const labels: string[] = Array.isArray(body.labels)
      ? body.labels.map((l: unknown) => String(l).trim().toLowerCase()).filter(Boolean).slice(0, 20)
      : [];
    const sharedWithTeams = normalizeTeamRefs(body.shared_with_teams);

    const includePaths = validateIncludePaths(body.include_paths);
    // `max_tree_pages` only meaningfully changes GitLab behaviour — the
    // GitHub crawler issues a single non-paginated tree request. Reject
    // the value on a GitHub hub so admins don't paste it expecting it
    // to do something.
    const maxTreePagesRaw = validateMaxTreePages(body.max_tree_pages);
    if (type === "github" && typeof maxTreePagesRaw === "number") {
      throw new ApiError(
        "max_tree_pages applies to GitLab hubs only (GitHub fetches the tree in a single request).",
        400,
      );
    }
    const maxTreePages = typeof maxTreePagesRaw === "number" ? maxTreePagesRaw : undefined;

    const collection = await getCollection<SkillHubDoc>("skill_hubs");

    // Check for duplicate location (use normalized)
    const existing = await collection.findOne({ location: normalizedLocation });
    if (existing) {
      throw new ApiError(
        `A hub with location "${location}" is already registered.`,
        409,
      );
    }

    const now = new Date().toISOString();
    const hubDoc: SkillHubDoc = {
      ...(type === "github" ? githubHubOptions(body) : {}),
      id: new ObjectId().toHexString(),
      type,
      location: normalizedLocation,
      enabled: body.enabled !== false,
      credentials_ref: validateCredentialsRef(body.credentials_ref),
      labels,
      last_success_at: null,
      last_failure_at: null,
      last_failure_message: null,
      created_at: now,
      updated_at: now,
    };
    if (includePaths) hubDoc.include_paths = includePaths;
    if (maxTreePages !== undefined) hubDoc.max_tree_pages = maxTreePages;
    if (sharedWithTeams) hubDoc.shared_with_teams = sharedWithTeams;

    await collection.insertOne(hubDoc);

    return NextResponse.json(sanitizeHub(hubDoc), { status: 201 });
});
