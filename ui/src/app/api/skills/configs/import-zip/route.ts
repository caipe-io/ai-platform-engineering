import { NextRequest } from "next/server";

import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import {
BUILTIN_LOCKED_MESSAGE,
canMutateBuiltinSkill,
} from "@/lib/builtin-skill-policy";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import {
filterResourcesByPermission,
requireSkillPermission,
} from "@/lib/rbac/resource-authz";
import {
readSkillSharedTeamSlugsFromOpenFga,
reconcileSkillTeamShares,
} from "@/lib/rbac/skill-team-grants";
import {
generateSkillIdFromName,
type ImportConflictAction,
type ImportConflictDecision,
} from "@/lib/skill-import-helpers";
import { recordRevision } from "@/lib/skill-revisions";
import { scanSkillContent as runSkillScan } from "@/lib/skill-scan";
import { recordScanEvent } from "@/lib/skill-scan-history";
import {
buildConflictDecisions,
parseSkillZip,
type ZipParseFailureReason,
type ZipSkillCandidate,
} from "@/lib/skill-zip-import";
import type { AgentSkill,ScanStatus } from "@/types/agent-skill";

/**
 * POST /api/skills/configs/import-zip
 *
 * Two-phase zip import endpoint.
 *
 * Phase 1 — Analyze (no `resolutions` field in body):
 *   The UI uploads the zip once. We parse it, build the candidate
 *   list (one per `SKILL.md`), and project a `conflicts` list for
 *   names that already exist in the user's visible catalog. The UI
 *   uses that to drive `<ImportConflictDialog>`.
 *
 * Phase 2 — Import (`resolutions` field present, JSON-encoded):
 *   The UI re-uploads the same zip plus the user's per-conflict
 *   decisions. We re-parse (the zip is the source of truth — never
 *   trust client-side analysis state), run the scanner inline, and
 *   write the new `agent_skills` rows / overwrite existing ones.
 *
 * Why re-upload instead of caching: a server-side analysis cache
 * would require either user-keyed Redis or an in-memory map that
 * doesn't survive Next.js' multi-instance rollouts. The zip is
 * <= 50 MB by our caps and the user has already explicitly chosen
 * to import it; a second upload is the simpler, statelessly-safe
 * design.
 *
 * Auth: any authenticated user. Imports are owned by the caller. An
 * "overwrite" of a built-in skill is rejected with the same 403
 * messaging used by PUT /api/skills/configs.
 */

const STORAGE_TYPE = isMongoDBConfigured ? "mongodb" : "none";

/** 50 MB matches our MAX_TOTAL_UNCOMPRESSED_BYTES; raw upload cap. */
const MAX_RAW_UPLOAD_BYTES = 50 * 1024 * 1024;

// HTTP status mapping for parser-side failure reasons. Kept beside
// the route handler so the table is easy to audit when adding new
// failure modes to the parser.
const PARSE_FAILURE_STATUS: Record<ZipParseFailureReason, number> = {
  invalid_zip: 400,
  no_skills_found: 400,
  too_large: 413,
  too_many_entries: 413,
  too_many_skills: 413,
  traversal_attempt: 400,
};

interface ImportedSkillSummary {
  candidateId: string;
  skillId: string;
  name: string;
  scan_status: ScanStatus;
  scan_summary?: string;
  /** "create" or "overwrite" — UI surfaces both as success rows. */
  outcome: "created" | "overwritten" | "skipped" | "failed";
  /** Populated when outcome === "failed" so the UI can show why. */
  error?: string;
}

interface AnalyzePhaseResult {
  phase: "analyze";
  candidates: Array<{
    candidateId: string;
    directory: string;
    proposedName: string;
    description: string;
    bytes: number;
    ancillaryCount: number;
    skippedFiles: string[];
  }>;
  conflicts: ImportConflictDecision[];
  totalBytes: number;
  totalEntries: number;
}

interface ImportPhaseResult {
  phase: "import";
  imported: ImportedSkillSummary[];
}

type RunZipImportResult = AnalyzePhaseResult | ImportPhaseResult;

interface RunZipImportArgs {
  buffer: ArrayBuffer;
  resolutions?: ImportConflictDecision[];
  user: { email: string; role?: string };
  teamRefs?: string[];
  /**
   * Provider for the user's existing skills. Injected so tests can
   * skip Mongo and the production handler can use the real
   * collection. The shape is the minimum the analyze phase needs to
   * detect collisions and the import phase needs to find existing
   * rows for overwrite.
   */
  loadVisibleSkills: () => Promise<AgentSkill[]>;
  /** Provider for inserting/overwriting; same testability rationale. */
  persistSkill: (skill: AgentSkill, mode: "create" | "overwrite") => Promise<void>;
  /** Concrete authorization hook for overwriting an existing skill. */
  canOverwriteSkill?: (skill: AgentSkill) => Promise<void>;
  grantTeamAccess?: (teamRefs: string[], skillIds: string[]) => Promise<void>;
}

/**
 * Pure import driver. Exported for unit tests so we don't have to
 * stand up Mongo and NextAuth to assert behaviour.
 *
 * Returns either an analyze projection or an import summary depending
 * on whether `resolutions` was provided. The route handler thinly
 * wraps this with auth + multipart parsing + Mongo wiring.
 */
export async function runZipImport(
  args: RunZipImportArgs,
): Promise<RunZipImportResult> {
  const parsed = await parseSkillZip(args.buffer);
  // Narrow on the success branch so TypeScript knows `parsed.candidates`
  // exists; the failure branch carries `reason`/`message` for HTTP
  // mapping.
  if (parsed.ok !== true) {
    throw new ApiError(parsed.message, PARSE_FAILURE_STATUS[parsed.reason]);
  }

  const visibleSkills = await args.loadVisibleSkills();

  // ---- Phase 1: analyze --------------------------------------------------
  if (!args.resolutions) {
    const conflicts = buildConflictDecisions(
      parsed.candidates,
      visibleSkills.map((s) => ({ id: s.id, name: s.name })),
    );
    return {
      phase: "analyze",
      candidates: parsed.candidates.map((c) => ({
        candidateId: c.candidateId,
        directory: c.directory,
        proposedName: c.proposedName,
        description: c.parsed.description,
        bytes: c.totalBytes,
        ancillaryCount: Object.keys(c.ancillaryFiles).length,
        skippedFiles: c.skippedFiles,
      })),
      conflicts,
      totalBytes: parsed.totalBytes,
      totalEntries: parsed.totalEntries,
    };
  }

  // ---- Phase 2: import ---------------------------------------------------
  // Resolutions are keyed by candidateId; non-conflicting candidates
  // (no entry in resolutions) are imported as new rows.
  const resolutionByCandidate = new Map<string, ImportConflictDecision>();
  for (const r of args.resolutions) {
    resolutionByCandidate.set(r.candidateId, r);
  }
  const visibleByName = new Map<string, AgentSkill>();
  for (const s of visibleSkills) {
    visibleByName.set(normalise(s.name), s);
  }

  const imported: ImportedSkillSummary[] = [];
  const teamRefs = normalizeStringList(args.teamRefs);

  for (const cand of parsed.candidates) {
    const decision = resolutionByCandidate.get(cand.candidateId);
    try {
      const summary = await importOne({
        candidate: cand,
        decision,
        existingByName: visibleByName,
        user: args.user,
        teamRefs,
        persistSkill: args.persistSkill,
        canOverwriteSkill: args.canOverwriteSkill,
      });
      imported.push(summary);
    } catch (err) {
      // A single failed candidate must not derail the rest — surface
      // it in the response so the UI can show a per-row error.
      // Re-throw for built-in lock so the operator sees a hard 403
      // (matches the existing PUT semantics).
      if (
        (err instanceof ApiError && err.statusCode === 403) ||
        (typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 403)
      ) {
        throw err;
      }
      imported.push({
        candidateId: cand.candidateId,
        skillId: "",
        name: cand.proposedName,
        scan_status: "unscanned",
        outcome: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const grantSkillIds = imported
    .filter((skill) => skill.outcome === "created" || skill.outcome === "overwritten")
    .map((skill) => skill.skillId)
    .filter(Boolean);
  if (grantSkillIds.length > 0 && args.grantTeamAccess) {
    await args.grantTeamAccess(teamRefs, grantSkillIds);
  }

  return { phase: "import", imported };
}

interface ImportOneArgs {
  candidate: ZipSkillCandidate;
  decision: ImportConflictDecision | undefined;
  existingByName: Map<string, AgentSkill>;
  user: { email: string; role?: string };
  teamRefs: string[];
  persistSkill: (skill: AgentSkill, mode: "create" | "overwrite") => Promise<void>;
  canOverwriteSkill?: (skill: AgentSkill) => Promise<void>;
}

async function importOne(
  args: ImportOneArgs,
): Promise<ImportedSkillSummary> {
  const { candidate, decision, existingByName, user, teamRefs, persistSkill, canOverwriteSkill } = args;

  // No conflict resolution provided: the candidate name didn't
  // collide at analyze time, so we treat it as a brand-new import.
  // We still defend against a race (someone else created the same
  // name between analyze and import) by falling back to "rename"
  // semantics with a `(imported)` suffix.
  let action: ImportConflictAction;
  let saveAsName: string;

  if (decision) {
    action = decision.action;
    saveAsName =
      decision.action === "rename"
        ? (decision.renameTo || candidate.proposedName).trim()
        : candidate.proposedName;
  } else {
    action = "rename"; // logically: "create new"
    saveAsName = candidate.proposedName;
    // Race-window guard: if a row sprouted with the same name,
    // promote to a rename (suffix) rather than failing.
    if (existingByName.has(normalise(saveAsName))) {
      saveAsName = `${saveAsName} (imported)`;
    }
  }

  if (action === "skip") {
    return {
      candidateId: candidate.candidateId,
      skillId: decision?.existingId || "",
      name: candidate.proposedName,
      scan_status: "unscanned",
      outcome: "skipped",
    };
  }

  // Run the scanner inline. "Scan before save" — flagged candidates
  // still persist (matches POST /api/skills/configs behaviour) but
  // their `scan_status: "flagged"` is enforced by the runnable gate
  // so they're imported as non-runnable rows. The user sees the
  // verdict in the import response and can decide whether to
  // un-flag (e.g. by editing) or delete.
  const tStart = Date.now();
  const scanResult = await runSkillScan(saveAsName, candidate.skillContent, undefined, {
    ancillaryFiles: candidate.ancillaryFiles,
  });

  if (action === "overwrite" && decision?.existingId) {
    return await overwriteExisting({
      candidate,
      decision,
      existingByName,
      saveAsName,
      scanResult,
      user,
      teamRefs,
      persistSkill,
      canOverwriteSkill,
      durationMs: Date.now() - tStart,
    });
  }

  // Action === "rename" or no-decision-fresh-import → create new row.
  return await createNew({
    candidate,
    saveAsName,
    scanResult,
    user,
    teamRefs,
    persistSkill,
    durationMs: Date.now() - tStart,
  });
}

interface CreateNewArgs {
  candidate: ZipSkillCandidate;
  saveAsName: string;
  scanResult: { scan_status: ScanStatus; scan_summary?: string };
  user: { email: string; role?: string };
  teamRefs: string[];
  persistSkill: (skill: AgentSkill, mode: "create" | "overwrite") => Promise<void>;
  durationMs: number;
}

async function createNew(args: CreateNewArgs): Promise<ImportedSkillSummary> {
  const { candidate, saveAsName, scanResult, user, teamRefs, persistSkill, durationMs } = args;
  const id = generateSkillIdFromName(saveAsName);
  const now = new Date();
  const normalizedTeamRefs = normalizeStringList(teamRefs);

  // Synthesize a single quick-start task so the imported skill has
  // something runnable. Mirrors how the templates importer seeds
  // packaged skills: the SKILL.md body becomes the task prompt; the
  // user can refine in the workspace.
  const skillMdBody = candidate.skillContent;
  const skill: AgentSkill = {
    id,
    name: saveAsName,
    description: candidate.parsed.description || "",
    category: "imported",
    tasks: [
      {
        display_text: saveAsName,
        llm_prompt: skillMdBody,
        subagent: "skills",
      },
    ],
    owner_id: user.email,
    is_system: false,
    created_at: now,
    updated_at: now,
    visibility: normalizedTeamRefs.length > 0 ? "team" : "private",
    skill_content: skillMdBody,
    ancillary_files: Object.keys(candidate.ancillaryFiles).length
      ? candidate.ancillaryFiles
      : undefined,
    scan_status: scanResult.scan_status,
    scan_summary: scanResult.scan_summary,
    scan_updated_at: skillMdBody.trim() ? now : undefined,
    is_quick_start: true,
  };

  await persistSkill(skill, "create");

  await recordScanEvent({
    trigger: "auto_save",
    skill_id: id,
    skill_name: saveAsName,
    source: "agent_skills",
    actor: user.email,
    scan_status: scanResult.scan_status,
    scan_summary: scanResult.scan_summary,
    scanner_unavailable: scanResult.scan_status === "unscanned",
    duration_ms: durationMs,
  });
  await recordRevision({
    skillId: id,
    snapshot: extractSnapshot(skill),
    trigger: "import",
    actor: user.email,
    note: `Imported from ${candidate.directory || "(zip root)"}`,
  });

  return {
    candidateId: candidate.candidateId,
    skillId: id,
    name: saveAsName,
    scan_status: scanResult.scan_status,
    scan_summary: scanResult.scan_summary,
    outcome: "created",
  };
}

interface OverwriteArgs {
  candidate: ZipSkillCandidate;
  decision: ImportConflictDecision;
  existingByName: Map<string, AgentSkill>;
  saveAsName: string;
  scanResult: { scan_status: ScanStatus; scan_summary?: string };
  user: { email: string; role?: string };
  teamRefs: string[];
  persistSkill: (skill: AgentSkill, mode: "create" | "overwrite") => Promise<void>;
  canOverwriteSkill?: (skill: AgentSkill) => Promise<void>;
  durationMs: number;
}

async function overwriteExisting(
  args: OverwriteArgs,
): Promise<ImportedSkillSummary> {
  const {
    candidate,
    decision,
    existingByName,
    saveAsName,
    scanResult,
    user,
    teamRefs,
    persistSkill,
    canOverwriteSkill,
    durationMs,
  } = args;
  const existing = existingByName.get(normalise(decision.existingName)) ||
    existingByName.get(normalise(saveAsName));
  if (!existing) {
    throw new ApiError(
      `Cannot overwrite "${decision.existingName}" — skill no longer exists.`,
      404,
    );
  }

  // Same authorisation rules as PUT /api/skills/configs.
  if (existing.is_system && !canMutateBuiltinSkill(existing)) {
    throw new ApiError(BUILTIN_LOCKED_MESSAGE, 403);
  }
  if (canOverwriteSkill) {
    await canOverwriteSkill(existing);
  }

  const now = new Date();
  const normalizedTeamRefs = normalizeStringList(teamRefs);
  // Capture the pre-overwrite state as a revision BEFORE we mutate
  // the row. The Versions tab in the workspace lets the owner
  // restore that revision if the import wasn't what they wanted.
  await recordRevision({
    skillId: existing.id,
    snapshot: extractSnapshot(existing),
    trigger: "update",
    actor: user.email,
    note: `Pre-import snapshot before overwrite from zip (${candidate.directory || "(root)"})`,
  });

  const updated: AgentSkill = {
    ...existing,
    name: saveAsName,
    description:
      candidate.parsed.description || existing.description,
    skill_content: candidate.skillContent,
    ancillary_files: Object.keys(candidate.ancillaryFiles).length
      ? candidate.ancillaryFiles
      : undefined,
    scan_status: scanResult.scan_status,
    scan_summary: scanResult.scan_summary,
    scan_updated_at: candidate.skillContent.trim() ? now : existing.scan_updated_at,
    updated_at: now,
    ...(normalizedTeamRefs.length > 0 ? { visibility: "team" as const } : {}),
    // Tasks: replace the prompt body so the runnable behaviour
    // matches the new SKILL.md, but keep the existing display_text /
    // subagent so users don't lose their custom labelling.
    tasks: existing.tasks?.length
      ? [
          {
            ...existing.tasks[0],
            llm_prompt: candidate.skillContent,
          },
          ...existing.tasks.slice(1),
        ]
      : [
          {
            display_text: saveAsName,
            llm_prompt: candidate.skillContent,
            subagent: "skills",
          },
        ],
  };

  await persistSkill(updated, "overwrite");

  await recordScanEvent({
    trigger: "auto_save",
    skill_id: existing.id,
    skill_name: saveAsName,
    source: "agent_skills",
    actor: user.email,
    scan_status: scanResult.scan_status,
    scan_summary: scanResult.scan_summary,
    scanner_unavailable: scanResult.scan_status === "unscanned",
    duration_ms: durationMs,
  });
  // Capture the post-overwrite state too so the Versions timeline
  // tells the full story (before-import, after-import).
  await recordRevision({
    skillId: existing.id,
    snapshot: extractSnapshot(updated),
    trigger: "import",
    actor: user.email,
    note: `Imported from ${candidate.directory || "(zip root)"}`,
  });

  return {
    candidateId: candidate.candidateId,
    skillId: existing.id,
    name: saveAsName,
    scan_status: scanResult.scan_status,
    scan_summary: scanResult.scan_summary,
    outcome: "overwritten",
  };
}

function extractSnapshot(skill: AgentSkill) {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    tasks: skill.tasks ?? [],
    metadata: skill.metadata,
    is_quick_start: skill.is_quick_start,
    difficulty: skill.difficulty,
    thumbnail: skill.thumbnail,
    input_form: skill.input_form,
    skill_content: skill.skill_content,
    ancillary_files: skill.ancillary_files,
    scan_status: skill.scan_status,
    scan_summary: skill.scan_summary,
  };
}

function normalise(s: string): string {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeStringList(values: string[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function parseTeamRefsFromForm(form: FormData): string[] {
  const raw = form.get("shared_with_teams") ?? form.get("team_refs");
  if (typeof raw !== "string" || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeStringList(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch (err) {
      throw new ApiError(
        `Invalid 'shared_with_teams' JSON: ${err instanceof Error ? err.message : String(err)}`,
        400,
      );
    }
  }
  return normalizeStringList(trimmed.split(","));
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = withErrorHandler(async (request: NextRequest) => {
  if (STORAGE_TYPE !== "mongodb") {
    throw new ApiError("Skills require MongoDB to be configured", 503);
  }

  return await withAuth(request, async (req, user, session) => {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(
        "Expected multipart/form-data with a 'file' field.",
        400,
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError("Missing 'file' field in multipart body.", 400);
    }
    if (file.size === 0) {
      throw new ApiError("Uploaded zip is empty.", 400);
    }
    if (file.size > MAX_RAW_UPLOAD_BYTES) {
      throw new ApiError(
        `Zip exceeds the ${(MAX_RAW_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB upload cap.`,
        413,
      );
    }
    const buffer = await file.arrayBuffer();
    const teamRefs = parseTeamRefsFromForm(form);
    const ownerSubject =
      typeof session?.sub === "string" ? session.sub.trim() : "";
    if (!ownerSubject) {
      throw new ApiError(
        "A stable user subject is required to import a skill.",
        401,
      );
    }

    let resolutions: ImportConflictDecision[] | undefined;
    const rawResolutions = form.get("resolutions");
    if (typeof rawResolutions === "string" && rawResolutions.trim()) {
      try {
        const parsed = JSON.parse(rawResolutions);
        if (!Array.isArray(parsed)) {
          throw new ApiError(
            "'resolutions' must be a JSON array of decisions.",
            400,
          );
        }
        resolutions = parsed as ImportConflictDecision[];
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(
          `Invalid 'resolutions' JSON: ${err instanceof Error ? err.message : String(err)}`,
          400,
        );
      }
    }

    // Real-world plumbing — load this user's catalog snapshot and
    // expose a writer that uses the same auth checks as the plain
    // CRUD route.
    const collection = await getCollection<AgentSkill>("agent_skills");
    const candidates = await collection.find({}).toArray();
    const scopedCandidates = candidates.filter((skill) => {
      if ((skill.visibility ?? "private") !== "private") return true;
      return skill.owner_subject
        ? skill.owner_subject === ownerSubject
        : skill.owner_id.trim().toLowerCase() === user.email.toLowerCase();
    });
    const visible = await filterResourcesByPermission(session, scopedCandidates, {
      type: "skill",
      action: "discover",
      id: (skill) => skill.id,
    });
    const previousById = new Map(candidates.map((skill) => [skill.id, skill]));

    const result = await runZipImport({
      buffer,
      resolutions,
      user,
      teamRefs,
      loadVisibleSkills: async () => visible,
      canOverwriteSkill: async (skill) => {
        await requireSkillPermission(session, skill.id, "write");
      },
      grantTeamAccess: async (refs, skillIds) => {
        for (const skillId of skillIds) {
          const previous = previousById.get(skillId);
          const current = await collection.findOne({ id: skillId });
          if (!current) continue;
          const previousTeamRefs =
            previous?.visibility === "team"
              ? previous.shared_with_teams?.length
                ? previous.shared_with_teams
                : await readSkillSharedTeamSlugsFromOpenFga(skillId)
              : [];
          const nextTeamRefs =
            current.visibility === "team"
              ? current.shared_with_teams?.length
                ? current.shared_with_teams
                : refs
              : [];
          await reconcileSkillTeamShares({
            skillId,
            ownerSubject,
            previousTeamRefs,
            nextTeamRefs,
            nextVisibility: current.visibility ?? "private",
            previousVisibility: previous?.visibility ?? "private",
          });
        }
      },
      persistSkill: async (skill, mode) => {
        const previous = previousById.get(skill.id);
        const persistedTeamRefs =
          skill.visibility === "team"
            ? teamRefs.length > 0
              ? teamRefs
              : previous?.shared_with_teams ??
                (await readSkillSharedTeamSlugsFromOpenFga(skill.id))
            : [];
        const mongoRow: AgentSkill = {
          ...skill,
          owner_subject:
            skill.owner_subject ?? previous?.owner_subject ?? ownerSubject,
          shared_with_teams: persistedTeamRefs,
        };
        if (mode === "create") {
          await collection.insertOne(mongoRow);
        } else {
          await collection.updateOne(
            { id: skill.id },
            { $set: mongoRow },
          );
        }
      },
    });

    return successResponse(result);
  });
});
