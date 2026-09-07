import {
getAuthFromBearerOrSession,
withErrorHandler,
} from "@/lib/api-middleware";
import type { SkillHubDoc } from "@/lib/hub-crawl";
import {
projectAgentSkillCatalogDoc,
type AgentSkillCatalogDoc,
} from "@/lib/catalog-skill-projection";
import { checkOpenFgaTuple,type OpenFgaCheckResult,type OpenFgaTupleKey } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import { NextRequest,NextResponse } from "next/server";

/**
 * Skills Catalog API — Single source of truth for UI and assistant (FR-001).
 *
 * GET /api/skills
 *   Returns the merged skill catalog from default (filesystem) + agent_skills + hubs.
 *   Aggregates locally (Mongo + hubs + templates).
 *
 * Supports dual-auth: Bearer JWT (for CLI/remote) or NextAuth session (browser).
 *
 * Query params:
 *   q               — case-insensitive text search in skill name and description
 *   source          — filter by source: "default", "agent_skills", "hub", "github", "gitlab"
 *   repo            — filter hub skills by repository location (e.g. "owner/repo")
 *   tags            — comma-separated tag filter (metadata.tags includes any)
 *   include_content — include full SKILL.md body for each skill (default false)
 *   page            — page number, 1-indexed (default: omit for all results)
 *   page_size       — items per page, 1-100 (default: 50)
 *   visibility      — optional: global | team | personal (entitled subset filter)
 *
 * Response shape per contracts/catalog-api.md:
 *   { skills: [...], meta: { total, page, page_size, has_more, sources_loaded, unavailable_sources } }
 *
 * Error responses:
 *   401 — unauthorized
 *   503 — { error: "skills_unavailable", message: "..." }
 */

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  source: "default" | "agent_skills" | "hub";
  source_id: string | null;
  /** Owner email for Mongo-backed user skills. */
  owner_id?: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  /**
   * Sibling files (paths relative to the skill folder). Populated only
   * when the caller asks for `include_content=true`. Lets API gateway
   * consumers (Claude Code, Cursor, install.sh) materialise the full
   * skill folder verbatim instead of only SKILL.md.
   */
  ancillary_files?: Record<string, string>;
  /** Operator-facing summary of what was captured / skipped. */
  ancillary_summary?: {
    total_files: number;
    total_bytes: number;
    skipped_binary: number;
    skipped_too_large: number;
    truncated_at_count_cap: boolean;
    truncated_at_size_cap: boolean;
  };
  /**
   * Cached scan state, hydrated from the appropriate collection per source:
   *   - `agent_skills` doc directly (already projected here)
   *   - `builtin_skill_scans` keyed by template id (joined below)
   *   - hub crawler returns these on its own
   * Absent when the skill has never been scanned. The scanner only
   * ever writes one of the three values; the admin override is a
   * SEPARATE field (``scan_override`` below), not a magic status.
   */
  scan_status?: "passed" | "flagged" | "unscanned";
  scan_summary?: string;
  scan_updated_at?: string;
  /**
   * Admin override sub-doc — the audit record AND the runtime gate
   * signal for a flagged skill.
   *
   * Populated by ``POST /api/admin/skills/:source/:source_id/scan-override``
   * (and the hub variant) when an operator explicitly green-lights
   * a flagged skill with a written reason. Cleared by the matching
   * DELETE handler. Scanner write paths (per-skill rescan, scan-all,
   * hub auto-scan) never touch this field, so an override survives
   * any number of rescans until an admin explicitly clears it.
   *
   * Treated as runnable HERE (``applyRunnableGate``) AND on the
   * Python loader side (``scan_gate.is_skill_blocked``) when
   * present + ``ADMIN_SCAN_OVERRIDE_ENABLED`` is on (default).
   * Setting the env to ``false`` removes the escape hatch in
   * lockstep across both tiers — flagged becomes unconditional
   * regardless of override.
   *
   * ``prior_scan_status`` is the verdict the override replaced
   * (always ``"flagged"`` — there's no reason to override a passed
   * or unscanned skill) so the report dialog can render "Override
   * active. Scanner had returned: flagged" without a second lookup.
   */
  scan_override?: {
    set_by: string;
    set_at: string;
    reason: string;
    prior_scan_status: "flagged";
    prior_scan_summary?: string;
  };
  /**
   * Whether the skill is runnable / installable / ingestible. Set to
   * `false` whenever the security scanner has flagged the skill AND
   * there is no active admin override — the UI surfaces this as a
   * disabled card with a "Disabled — flagged" badge so admins can
   * still see and re-scan it. Defaults to `true` when omitted.
   *
   * The dynamic-agent runtime enforces the same rule independently
   * (``scan_gate`` module) so a stale UI badge
   * cannot make a flagged skill executable. A flagged skill with an
   * active ``scan_override`` is runnable on both sides (UI here,
   * Python there) when the admin-override feature is enabled.
   */
  runnable?: boolean;
  /** Operator-visible reason for ``runnable=false``. */
  blocked_reason?: "scan_flagged";
}

interface CatalogResponse {
  skills: CatalogSkill[];
  meta: {
    total: number;
    page?: number;
    page_size?: number;
    has_more?: boolean;
    sources_loaded: string[];
    unavailable_sources: string[];
  };
}

interface QueryParams {
  q: string;
  source: string;
  repo: string;
  visibility: string;
  tags: string[];
  includeContent: boolean;
  page: number | null; // null = no pagination
  pageSize: number;
}

function parseQueryParams(req: NextRequest): QueryParams {
  const sp = new URL(req.url).searchParams;
  const rawPage = sp.get("page");
  const rawPageSize = sp.get("page_size");

  let page: number | null = null;
  if (rawPage !== null) {
    page = Math.max(1, parseInt(rawPage, 10) || 1);
  }

  let pageSize = 50;
  if (rawPageSize !== null) {
    pageSize = Math.min(100, Math.max(1, parseInt(rawPageSize, 10) || 50));
  }

  const rawTags = sp.get("tags") || "";
  const tags = rawTags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return {
    q: (sp.get("q") || "").trim().toLowerCase(),
    source: (sp.get("source") || "").trim().toLowerCase(),
    repo: (sp.get("repo") || "").trim().toLowerCase(),
    visibility: (sp.get("visibility") || "").trim().toLowerCase(),
    tags,
    includeContent: sp.get("include_content") === "true",
    page,
    pageSize,
  };
}

/**
 * Apply in-memory filters to a skill list.
 */
function filterSkills(
  skills: CatalogSkill[],
  params: QueryParams,
): CatalogSkill[] {
  let result = skills;

  if (params.q) {
    result = result.filter(
      (s) =>
        s.name.toLowerCase().includes(params.q) ||
        s.description.toLowerCase().includes(params.q),
    );
  }

  if (params.source) {
    if (params.source === "github" || params.source === "gitlab") {
      result = result.filter(
        (s) =>
          s.source === "hub" &&
          (s.metadata as { hub_type?: string })?.hub_type === params.source,
      );
    } else {
      result = result.filter(
        (s) => s.source.toLowerCase() === params.source,
      );
    }
  }

  if (params.visibility) {
    const v = params.visibility;
    result = result.filter((s) => {
      const mv = (s.metadata as { visibility?: string })?.visibility;
      return (mv || "global").toLowerCase() === v;
    });
  }

  if (params.repo) {
    result = result.filter((s) => {
      const loc = (s.metadata as { hub_location?: string })?.hub_location;
      return loc ? loc.toLowerCase() === params.repo : false;
    });
  }

  if (params.tags.length > 0) {
    result = result.filter((s) => {
      const skillTags: string[] = Array.isArray(s.metadata?.tags)
        ? (s.metadata.tags as string[]).map((t) => t.toLowerCase())
        : [];
      return params.tags.some((t) => skillTags.includes(t));
    });
  }

  return result;
}

/**
 * Apply pagination to a filtered skill list and build the response meta.
 */
function paginate(
  skills: CatalogSkill[],
  params: QueryParams,
  baseMeta: { sources_loaded: string[]; unavailable_sources: string[] },
): CatalogResponse {
  const total = skills.length;

  // No pagination requested — backward compatible (return all)
  if (params.page === null) {
    return {
      skills,
      meta: { total, ...baseMeta },
    };
  }

  const start = (params.page - 1) * params.pageSize;
  const paged = skills.slice(start, start + params.pageSize);

  return {
    skills: paged,
    meta: {
      total,
      page: params.page,
      page_size: params.pageSize,
      has_more: start + params.pageSize < total,
      ...baseMeta,
    },
  };
}

type SkillOpenFgaMode = "read" | "use";

interface FilterSkillsByOpenFgaOptions {
  subject?: string | null;
  mode: SkillOpenFgaMode;
  isAdmin?: boolean;
  check?: (tuple: OpenFgaTupleKey) => Promise<OpenFgaCheckResult>;
}

export async function filterSkillsByOpenFga(
  skills: CatalogSkill[],
  options: FilterSkillsByOpenFgaOptions,
): Promise<CatalogSkill[]> {
  if (options.isAdmin) return skills;
  if (!options.subject) return [];

  const relation = options.mode === "use" ? "can_use" : "can_read";
  const check = options.check ?? checkOpenFgaTuple;
  let baselineUseAllowed: boolean | null = null;
  async function hasBaselineUseAccess(): Promise<boolean> {
    if (baselineUseAllowed !== null) return baselineUseAllowed;
    try {
      const result = await check({
        user: options.subject as string,
        relation: "can_use",
        object: organizationObjectId(),
      });
      baselineUseAllowed = result.allowed;
    } catch {
      baselineUseAllowed = false;
    }
    return baselineUseAllowed;
  }

  const decisions = await Promise.all(
    skills.map(async (skill) => {
      if (options.mode === "read" && skill.source === "default") return skill;
      if (options.mode === "use" && skill.source === "default" && await hasBaselineUseAccess()) {
        return skill;
      }
      try {
        const result = await check({
          user: options.subject as string,
          relation,
          object: `skill:${skill.id}`,
        });
        return result.allowed ? skill : null;
      } catch {
        return null;
      }
    }),
  );

  return decisions.filter((skill): skill is CatalogSkill => skill !== null);
}

/**
 * Local aggregation: merge skill-templates (filesystem) and
 * persisted agent skills from MongoDB (`agent_skills`) into a single catalog.
 */
async function aggregateLocally(
  includeContent: boolean,
): Promise<CatalogResponse> {
  const skills: CatalogSkill[] = [];
  const sourcesLoaded: string[] = [];
  const unavailableSources: string[] = [];

  // 1. Skill templates (filesystem / SKILLS_DIR)
  // Skip when HIDE_BUILTIN_SKILLS=true — users load templates explicitly via "Import template skills".
  const hideBuiltin = process.env.HIDE_BUILTIN_SKILLS === "true";
  if (!hideBuiltin) try {
    const { loadSkillTemplatesInternal } = await import(
      "./skill-templates-loader"
    );
    const templates = loadSkillTemplatesInternal();

    // Best-effort lookup of cached scan results so the gallery shield
    // shows fresh badges immediately after a sweep / per-template scan.
    // If Mongo is down we just leave scan_status undefined → "Unscanned".
    // Built-in skills can never be admin-overridden today (templates
    // live on disk and have no per-skill admin UI). The override
    // sub-doc is still projected for symmetry with the catalog
    // shape — a hand-edited row in builtin_skill_scans should round-
    // trip cleanly rather than crash the union narrowing — but no
    // UI flow writes it.
    type BuiltinScanDoc = {
      id: string;
      scan_status: "passed" | "flagged" | "unscanned";
      scan_summary?: string;
      scan_updated_at?: Date;
      scan_override?: CatalogSkill["scan_override"];
    };
    let builtinScans = new Map<string, BuiltinScanDoc>();
    try {
      const { getCollection: getColForScans, isMongoDBConfigured: scansMongoOk } =
        await import("@/lib/mongodb");
      if (scansMongoOk) {
        const scansCol = await getColForScans<BuiltinScanDoc>(
          "builtin_skill_scans",
        );
        const scanDocs = await scansCol
          .find({})
          .project<BuiltinScanDoc>({ _id: 0 })
          .toArray();
        builtinScans = new Map(scanDocs.map((d) => [d.id, d]));
      }
    } catch (err) {
      console.warn(
        "[Skills] Failed to load builtin_skill_scans cache (badges will show as Unscanned):",
        err,
      );
    }

    for (const t of templates) {
      const meta: Record<string, unknown> = {
        category: t.category,
        icon: t.icon,
        tags: t.tags,
      };
      if (t.input_variables && t.input_variables.length > 0) {
        meta.input_variables = t.input_variables;
      }
      const scan = builtinScans.get(t.id);
      skills.push({
        id: t.id,
        name: t.name,
        description: t.description,
        source: "default",
        source_id: null,
        content: includeContent ? t.content : null,
        metadata: meta,
        ...(scan?.scan_status ? { scan_status: scan.scan_status } : {}),
        ...(scan?.scan_summary !== undefined
          ? { scan_summary: scan.scan_summary }
          : {}),
        ...(scan?.scan_updated_at
          ? {
              scan_updated_at:
                scan.scan_updated_at instanceof Date
                  ? scan.scan_updated_at.toISOString()
                  : String(scan.scan_updated_at),
            }
          : {}),
        ...(scan?.scan_override ? { scan_override: scan.scan_override } : {}),
      });
    }
    sourcesLoaded.push("default");
  } catch (err) {
    console.error("[Skills] Failed to load skill templates:", err);
    unavailableSources.push("default");
  } // end if (!hideBuiltin)

  // 2. Agent skills (MongoDB) — match any content field
  try {
    const { getCollection, isMongoDBConfigured } = await import(
      "@/lib/mongodb"
    );
    if (isMongoDBConfigured) {
      const collection = await getCollection<AgentSkillCatalogDoc>("agent_skills");
      const docs = await collection
        .find(
          {
            $or: [
              { skill_content: { $exists: true, $ne: "" } },
              { skill_template: { $exists: true, $ne: "" } },
              { "tasks.0.llm_prompt": { $exists: true, $ne: "" } },
            ],
          },
          {
            projection: {
              _id: 0,
              id: 1,
              name: 1,
              description: 1,
              skill_content: 1,
              skill_template: 1,
              tasks: 1,
              owner_id: 1,
              visibility: 1,
              is_system: 1,
              category: 1,
              metadata: 1,
              ancillary_files: 1,
              scan_status: 1,
              scan_summary: 1,
              scan_updated_at: 1,
              // Admin override metadata (set_by / set_at / reason /
              // prior_scan_status / prior_scan_summary). Pulled in
              // every catalog response so the report-status dialog
              // can render the audit trail without an extra round
              // trip. Absent on docs without an override.
              scan_override: 1,
            },
          },
        )
        .toArray();

      for (const doc of docs) {
        const projected = projectAgentSkillCatalogDoc(doc, includeContent);
        if (projected) skills.push(projected);
      }
      sourcesLoaded.push("agent_skills");
    }
  } catch (err) {
    console.error("[Skills] Failed to load agent_skills:", err);
    unavailableSources.push("agent_skills");
  }

  // 3. Hub skills (GitHub / GitLab)
  try {
    const { getCollection: getCol, isMongoDBConfigured: mongoOk } = await import(
      "@/lib/mongodb"
    );
    if (mongoOk) {
      const { getHubSkills } = await import("@/lib/hub-crawl");
      const hubsCol = await getCol<SkillHubDoc>("skill_hubs");
      const enabledHubs = await hubsCol.find({ enabled: true }).toArray();
      for (const hub of enabledHubs) {
        try {
          const hubSkills = await getHubSkills(hub);
          for (const s of hubSkills) {
            // Hub crawler always returns content + ancillary_files in the
            // CatalogSkill shape; strip them when the caller didn't ask
            // for content so the listing payload stays small.
            skills.push({
              ...s,
              content: includeContent ? s.content : null,
              ancillary_files: includeContent ? s.ancillary_files : undefined,
            });
          }
          sourcesLoaded.push(`hub:${hub.id}`);
        } catch (err) {
          console.error(`[Skills] Hub ${hub.location} failed:`, err);
          unavailableSources.push(`hub:${hub.id}`);
        }
      }
    }
  } catch {
    // Hub loading is best-effort
  }

  // Apply precedence: default wins over agent_skills (by name)
  const merged = new Map<string, CatalogSkill>();
  const priority: Record<string, number> = {
    default: 0,
    agent_skills: 1,
    hub: 2,
  };
  for (const skill of skills) {
    const existing = merged.get(skill.name);
    if (!existing || priority[skill.source] < priority[existing.source]) {
      merged.set(skill.name, skill);
    }
  }

  const sortedSkills = Array.from(merged.values()).sort((a, b) => {
    const pa = priority[a.source] ?? 99;
    const pb = priority[b.source] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  return {
    skills: sortedSkills,
    meta: {
      total: sortedSkills.length,
      sources_loaded: sourcesLoaded,
      unavailable_sources: unavailableSources,
    },
  };
}

/**
 * Strip leading `<!-- caipe-skill: ... -->` XML comments from skill content.
 * These annotations are used as source markers in hub repositories but are
 * not valid SKILL.md content — they appear before the YAML frontmatter and
 * prevent agents from recognising the `name:` and `description:` fields.
 */
function sanitizeSkillContent(content: string | null): string | null {
  if (!content) return content;
  return content.replace(/^(<!--[\s\S]*?-->\s*\n?)+/, "");
}

/**
 * Whether the admin scan-override feature is enabled. Defaults to true
 * to match the Python ``scan_gate.is_admin_override_enabled``: regulated
 * deployments flip ``ADMIN_SCAN_OVERRIDE_ENABLED=false`` to remove the
 * escape hatch entirely. We mirror the Python parsing here (any non-
 * explicit-false string keeps it on) so a typo can't silently disable
 * the feature on only one of the two sides.
 *
 * Exported for tests; not meant for use outside this module.
 */
export function isAdminOverrideEnabled(): boolean {
  const raw = (process.env.ADMIN_SCAN_OVERRIDE_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  return !["false", "0", "no", "off"].includes(raw);
}

/**
 * Stamp ``runnable`` / ``blocked_reason`` on every skill based on its
 * cached scan status AND any active admin override. Default is
 * ``runnable: true``.
 *
 * Flagging rules (mirror ``scan_gate.is_status_blocked`` in Python):
 *   - ``flagged`` WITHOUT an active ``scan_override`` ⇒ not-runnable.
 *   - ``flagged`` WITH ``scan_override`` AND
 *     ``ADMIN_SCAN_OVERRIDE_ENABLED`` on (default) ⇒ runnable. The
 *     admin's audit-logged "I trust this" assertion is honoured.
 *   - ``flagged`` WITH ``scan_override`` AND the env flag flipped to
 *     false ⇒ not-runnable. A single env flip removes the escape
 *     hatch in lockstep with the Python tier.
 *   - everything else (including ``unscanned``) ⇒ runnable here. The
 *     Python loader applies stricter ``SKILL_SCANNER_GATE=strict`` rules
 *     for the runtime; this UI gate is intentionally permissive so the
 *     gallery still shows skills the runtime would refuse, with the
 *     scan-status badge explaining why.
 *
 * Why the override is a separate field, not a magic ``scan_status``
 * value: the previous implementation set ``scan_status =
 * "admin_overridden"``, which collided with every scanner write
 * path — any rescan would blindly overwrite ``scan_status =
 * "flagged"`` and silently nuke the override. Splitting the signals
 * means scan routes only ever touch ``scan_status``/``scan_summary``
 * and the override stays stable until an admin clears it.
 *
 * This is the single UI-facing enforcement point so the gallery,
 * runner, and downstream consumers (Skills API gateway, install.sh)
 * all agree without each having to re-derive the rule. The Python
 * dynamic agents enforce the same policy via ``scan_gate.py``; this stamp
 * is for UI affordances + defense in
 * depth against a backend that hasn't yet been updated.
 */
export function applyRunnableGate(skill: CatalogSkill): CatalogSkill {
  if (skill.scan_status === "flagged") {
    const hasOverride = !!skill.scan_override;
    if (hasOverride && isAdminOverrideEnabled()) {
      // Admin override honoured — runnable despite scanner verdict.
      // Leave ``scan_status`` and ``scan_override`` as-is so the
      // gallery can render the amber "Admin override active" badge
      // alongside the audit metadata.
      return { ...skill, runnable: true };
    }
    return { ...skill, runnable: false, blocked_reason: "scan_flagged" };
  }
  return { ...skill, runnable: skill.runnable ?? true };
}

function sanitizeCatalogResponse(data: CatalogResponse): CatalogResponse {
  return {
    ...data,
    skills: data.skills.map((s) =>
      applyRunnableGate({
        ...s,
        content: sanitizeSkillContent(s.content),
      }),
    ),
  };
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  // Dual-auth: Bearer JWT or session cookie
  const { user, session } = await getAuthFromBearerOrSession(req);

  const params = parseQueryParams(req);
  const skillAuth = {
    subject: typeof session?.sub === "string" ? `user:${session.sub}` : null,
    mode: params.includeContent ? ("use" as const) : ("read" as const),
    isAdmin: user.role === "admin" || session?.role === "admin",
  };

  // Local aggregation (Mongo + hubs + templates).
  try {
    const catalog = await aggregateLocally(params.includeContent);
    const filtered = filterSkills(catalog.skills, params);
    const authorized = await filterSkillsByOpenFga(filtered, skillAuth);
    const response = paginate(authorized, params, {
      sources_loaded: catalog.meta.sources_loaded,
      unavailable_sources: catalog.meta.unavailable_sources,
    });
    return NextResponse.json(sanitizeCatalogResponse(response));
  } catch (err) {
    console.error("[Skills] Catalog unavailable:", err);
    return NextResponse.json(
      {
        error: "skills_unavailable",
        message:
          "Skills are temporarily unavailable. Please try again later.",
      } as unknown as CatalogResponse,
      { status: 503 },
    );
  }
});
