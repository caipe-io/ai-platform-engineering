/**
 * Lenient SKILL.md zip parser.
 *
 * Design goals (from the product spec):
 *   * Find EVERY `SKILL.md` anywhere in the archive — not just at the
 *     root. A user dropping `awesome-skills-2026.zip` should get back
 *     a checklist of every skill it contains.
 *   * Each `SKILL.md`'s "skill directory" is its parent directory.
 *     Sibling/descendant files inside that directory become the
 *     skill's ancillary files. A SKILL.md at the very root claims
 *     every file not already claimed by a nested skill, preserving
 *     paths such as `scripts/run.sh` and `references/guide.md`.
 *   * Two SKILL.md files at the same depth share their parent? Each
 *     keeps its OWN files; the parser scopes ancillaries to "files
 *     under this SKILL.md's directory that are NOT under any deeper
 *     SKILL.md's directory". That's the only behaviour that
 *     matches user intuition.
 *
 * Non-goals:
 *   * We do NOT execute or even read uncompressed bytes for files
 *     we'll never use (binary blobs > 5 MB, anything outside a
 *     skill directory). That keeps zip-bomb risk bounded.
 *   * We do NOT try to be clever about repo-style top-level
 *     directories ("skills/argocd-rollback/SKILL.md" is grouped by
 *     its parent "skills/argocd-rollback", not by the top-level
 *     "skills"). Lenient = "find SKILL.md", not "infer hub layout".
 *
 * Security:
 *   * Reject path-traversal entries (`..`, leading `/`, NUL).
 *   * Hard cap on entry count (1000) and total uncompressed bytes
 *     (50 MB). Anything exceeding the cap aborts with `tooLarge`
 *     so the route handler returns 413.
 *   * Hard cap on per-ancillary file size (1 MB) — files bigger
 *     than that are tracked as `skippedFiles` so the user knows
 *     why they're missing.
 */

import type {
ImportConflictAction,
ImportConflictDecision,
} from "@/lib/skill-import-helpers";
import { parseSkillMd,type ParsedSkillMd } from "@/lib/skill-md-parser";

// --- Caps ------------------------------------------------------------------

/**
 * Default reject threshold for total zip entries.
 *
 * Sized to comfortably accommodate hub-style monorepo archives
 * (e.g. ``cisco-ai-defense/skills`` weighs in around 3.2k entries
 * with sibling docs and license files). The earlier 1000-entry cap
 * was chosen for single-skill folders and rejected most real-world
 * "skills-repo.zip" downloads outright.
 *
 * The hard-stop protections against zip bombs and runaway memory
 * remain the byte caps below (50 MB total, 1 MB per file) and the
 * 50-SKILL.md cap, all of which catch the actual abuse modes. The
 * entry count cap is now mostly a safety net against pathological
 * archives that pack millions of empty entries — those are still
 * rejected, but legitimate skills monorepos are not.
 *
 * Override with the ``SKILL_IMPORT_MAX_ZIP_ENTRIES`` env var if a
 * specific deployment needs to ingest larger archives without a
 * code change.
 */
export const DEFAULT_MAX_ZIP_ENTRIES = 25000;

/**
 * Resolve the active entry cap, honoring the env override.
 *
 * Read on every call rather than at module load so a single Next.js
 * runtime can pick up a config change after restart-less reloads
 * (relevant for serverless deployments where the module may stay
 * resident across redeploys). Invalid / non-positive values fall
 * back to the default.
 */
export function getMaxZipEntries(): number {
  const raw = process.env.SKILL_IMPORT_MAX_ZIP_ENTRIES;
  if (!raw) return DEFAULT_MAX_ZIP_ENTRIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ZIP_ENTRIES;
  return parsed;
}

/**
 * Backwards-compatible export of the entry cap. Returns the
 * effective limit including any env override; existing callers
 * that imported the constant get the right value without changes.
 *
 * Note: this is evaluated once at module load. Tests that need to
 * override at runtime should import ``getMaxZipEntries`` instead so
 * the env var is re-read per call.
 */
export const MAX_ZIP_ENTRIES = getMaxZipEntries();

/** Reject zips whose total uncompressed bytes exceed this. */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB

/** Drop individual ancillary files larger than this. */
export const MAX_ANCILLARY_FILE_BYTES = 1 * 1024 * 1024; // 1 MB

/** Reject zips that contain more SKILL.md files than this. */
export const MAX_SKILLS_PER_ZIP = 50;

// --- Public types ----------------------------------------------------------

export type ZipParseFailureReason =
  | "no_skills_found"
  | "too_large"
  | "too_many_entries"
  | "too_many_skills"
  | "invalid_zip"
  | "traversal_attempt";

export interface ZipParseFailure {
  ok: false;
  reason: ZipParseFailureReason;
  message: string;
}

/**
 * One SKILL.md candidate found inside the zip plus its ancillary
 * files (siblings and descendants of its directory, minus anything
 * that belongs to a deeper SKILL.md).
 */
export interface ZipSkillCandidate {
  /**
   * Stable client-side id derived from the zip-internal directory
   * path. Used as `candidateId` on resolutions so the import API
   * can re-correlate after the zip is re-parsed server-side.
   */
  candidateId: string;
  /** zip-internal directory of the SKILL.md (e.g. `skills/argocd/`). */
  directory: string;
  /** zip-internal path to the SKILL.md itself. */
  skillMdPath: string;
  /** Parsed frontmatter for preview (name + description). */
  parsed: ParsedSkillMd;
  /** SKILL.md content as utf-8 string. */
  skillContent: string;
  /**
   * Display name we'd save the skill as. Pulled from frontmatter
   * `name`, falling back to the H1 title or the directory basename.
   * The UI renames if the user picks "Rename" in the conflict modal.
   */
  proposedName: string;
  /** Ancillary files keyed by path RELATIVE to the skill directory. */
  ancillaryFiles: Record<string, string>;
  /** Total bytes of SKILL.md + ancillary files (for UI summary). */
  totalBytes: number;
  /** Files dropped because they exceeded MAX_ANCILLARY_FILE_BYTES. */
  skippedFiles: string[];
}

export interface ZipParseSuccess {
  ok: true;
  candidates: ZipSkillCandidate[];
  /** Total uncompressed bytes across the whole zip. */
  totalBytes: number;
  /** Number of zip entries processed. */
  totalEntries: number;
}

export type ZipParseResult = ZipParseSuccess | ZipParseFailure;

// --- Implementation --------------------------------------------------------

interface ZipFileLike {
  /**
   * Internal path within the zip, with backslashes already
   * normalised to forward slashes by the loader.
   */
  path: string;
  dir: boolean;
  /** Async accessor for utf-8 content. */
  text: () => Promise<string>;
  /** Uncompressed byte length, used for caps. */
  bytes: number;
}

/**
 * Parse a zip buffer into a list of skill candidates.
 *
 * Loads `jszip` lazily so the import-only path doesn't cost the
 * default bundle. Returns a tagged-union result rather than throwing
 * — caller (the import API route) translates failures into HTTP
 * responses.
 */
export async function parseSkillZip(
  buffer: ArrayBuffer,
): Promise<ZipParseResult> {
  let entries: ZipFileLike[];
  try {
    entries = await loadZipEntries(buffer);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid_zip",
      message: `Could not read zip: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Use the live getter so an env-var bump applies on the next
  // request without a code redeploy.
  const maxEntries = getMaxZipEntries();
  if (entries.length > maxEntries) {
    return {
      ok: false,
      reason: "too_many_entries",
      message:
        `Zip has ${entries.length} entries; maximum allowed is ${maxEntries}. ` +
        `Set SKILL_IMPORT_MAX_ZIP_ENTRIES to raise this limit if your ` +
        `archive is legitimately larger (e.g. a full skills monorepo).`,
    };
  }
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `Zip exceeds ${(MAX_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024).toFixed(0)} MB uncompressed (${(totalBytes / 1024 / 1024).toFixed(1)} MB).`,
    };
  }

  // Validate paths early so a single bad entry aborts the whole
  // import — we don't want to silently skip a traversal attempt
  // and proceed with the rest, since that could mask malicious
  // archives.
  for (const e of entries) {
    if (!isSafeZipPath(e.path)) {
      return {
        ok: false,
        reason: "traversal_attempt",
        message: `Zip contains an unsafe path: "${e.path}".`,
      };
    }
  }

  // Find every SKILL.md (case-insensitive). The directory of a
  // SKILL.md is everything before the final segment; for a SKILL.md
  // at the root we use "" as the directory key.
  const skillMdEntries = entries.filter(
    (e) => !e.dir && /(?:^|\/)SKILL\.md$/i.test(e.path),
  );
  if (skillMdEntries.length === 0) {
    return {
      ok: false,
      reason: "no_skills_found",
      message: "No SKILL.md files found anywhere in the zip.",
    };
  }
  if (skillMdEntries.length > MAX_SKILLS_PER_ZIP) {
    return {
      ok: false,
      reason: "too_many_skills",
      message: `Zip contains ${skillMdEntries.length} SKILL.md files; maximum allowed is ${MAX_SKILLS_PER_ZIP}.`,
    };
  }

  // Sort directories deepest-first so when we assign ancillary
  // files we can claim "this dir's files only" by checking if any
  // other (deeper) SKILL.md directory is a prefix of the file's
  // path. Without the deepest-first ordering an outer SKILL.md
  // would steal the inner skill's files before the inner one had
  // a chance to claim them.
  const skillDirs = skillMdEntries
    .map((e) => ({
      entry: e,
      dir: directoryOf(e.path),
    }))
    .sort((a, b) => b.dir.length - a.dir.length);

  // Track which file paths have already been claimed by a (deeper)
  // skill so the outer skill's grouping doesn't double-count them.
  const claimed = new Set<string>();
  // Process deepest-first to claim files; reverse for output order
  // so the user sees skills in zip-order top-to-bottom.
  const candidatesByDir = new Map<string, ZipSkillCandidate>();

  for (const sd of skillDirs) {
    const skillContent = await sd.entry.text();
    const parsed = parseSkillMd(skillContent);
    const directory = sd.dir;
    const candidateId = directory || "(root)";

    const ancillaryFiles: Record<string, string> = {};
    const skippedFiles: string[] = [];
    let cBytes = sd.entry.bytes;

    // Match this SKILL.md's directory: every non-skill-md file
    // whose path begins with `${directory}/` (or, for root SKILL.md,
    // every non-skill-md file at all) AND hasn't already been
    // claimed by a deeper sibling.
    const prefix = directory ? `${directory}/` : "";
    for (const f of entries) {
      if (f.dir) continue;
      if (claimed.has(f.path)) continue;
      if (f === sd.entry) continue;
      if (/(?:^|\/)SKILL\.md$/i.test(f.path)) continue; // never inline another skill
      if (prefix && !f.path.startsWith(prefix)) continue;
      claimed.add(f.path);
      const rel = prefix ? f.path.slice(prefix.length) : f.path;
      if (f.bytes > MAX_ANCILLARY_FILE_BYTES) {
        skippedFiles.push(rel);
        continue;
      }
      try {
        const content = await f.text();
        ancillaryFiles[rel] = content;
        cBytes += f.bytes;
      } catch {
        // Unreadable entry (binary that jszip refused to surface
        // as text) — skip and surface in skippedFiles so the user
        // sees that something dropped out.
        skippedFiles.push(rel);
      }
    }

    const proposedName = inferDisplayName(parsed, directory);

    candidatesByDir.set(directory, {
      candidateId,
      directory,
      skillMdPath: sd.entry.path,
      parsed,
      skillContent,
      proposedName,
      ancillaryFiles,
      totalBytes: cBytes,
      skippedFiles,
    });
  }

  // Output in stable (deterministic) order: directory ascending so
  // the user sees nested skills near their parent in the conflict
  // checklist.
  const candidates = Array.from(candidatesByDir.values()).sort((a, b) =>
    a.directory.localeCompare(b.directory),
  );

  return {
    ok: true,
    candidates,
    totalBytes,
    totalEntries: entries.length,
  };
}

// --- Path helpers ----------------------------------------------------------

/**
 * Reject obviously-unsafe zip-internal paths. Even though the import
 * route never extracts files to disk, traversal entries indicate a
 * crafted archive — failing closed is cheaper than auditing every
 * downstream consumer for path-confusion bugs.
 */
function isSafeZipPath(p: string): boolean {
  if (!p) return true; // empty entries skipped earlier
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (p.includes("..")) return false;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(p)) return false;
  // Absolute-ish Windows paths sneak in via some zip tools.
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
  return true;
}

function directoryOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function inferDisplayName(
  parsed: ParsedSkillMd,
  directory: string,
): string {
  // Frontmatter `name` is a kebab-case identifier in the Anthropic
  // format; we prefer the parsed `title` (H1) if present so the
  // human-friendly name lands in MongoDB. Fall back to the
  // directory basename, then a generic placeholder.
  const candidates = [
    parsed.title,
    parsed.name,
    directory.split("/").filter(Boolean).pop() || "",
    "Imported skill",
  ];
  for (const c of candidates) {
    const trimmed = (c || "").trim();
    if (trimmed && trimmed.toLowerCase() !== "untitled skill") return trimmed;
  }
  return "Imported skill";
}

// --- jszip loader ----------------------------------------------------------

/**
 * Lazy import of jszip + adapter to our minimal `ZipFileLike` shape.
 * Lazy because the import path is rarely hit and pulling jszip into
 * the default chunk would balloon every cold-start.
 */
async function loadZipEntries(buffer: ArrayBuffer): Promise<ZipFileLike[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const out: ZipFileLike[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    // jszip already normalises `\` to `/` in entry names but be
    // defensive — some bundlers reuse raw zip metadata.
    const normalisedPath = path.replace(/\\/g, "/");
    // Compute uncompressed size from the underlying _data record;
    // JSZip exposes it through its internal `_data.uncompressedSize` field.
    // for older zips. Fall back to a `Uint8Array` lookup if missing.
    let bytes = 0;
    const dataBag = (entry as unknown as {
      _data?: { uncompressedSize?: number };
    })._data;
    if (dataBag && typeof dataBag.uncompressedSize === "number") {
      bytes = dataBag.uncompressedSize;
    } else if (!entry.dir) {
      // Last resort: actually read the file just to measure it.
      // This is the slow path; almost no real-world zip omits the
      // uncompressedSize field, so we accept the cost when forced.
      const buf = await entry.async("uint8array");
      bytes = buf.byteLength;
    }
    out.push({
      path: normalisedPath,
      dir: entry.dir,
      text: () => entry.async("text"),
      bytes,
    });
  }
  return out;
}

// --- Resolution helpers (used by the API route) ---------------------------

/**
 * Build the initial conflict list from a parse result and the
 * caller's existing skill names. Used by the analyse phase of the
 * import API to drive the UI's `ImportConflictDialog`. Pure — no
 * database access — so it can be unit-tested without mocks.
 *
 * Each candidate either becomes a `ImportConflictDecision` (when its
 * proposed name collides with an existing skill) or is left out and
 * gets imported automatically as a brand-new skill.
 */
export function buildConflictDecisions(
  candidates: ZipSkillCandidate[],
  existing: Array<{ id: string; name: string }>,
): ImportConflictDecision[] {
  const byName = new Map<string, { id: string; name: string }>();
  for (const e of existing) {
    byName.set(normalise(e.name), e);
  }
  const conflicts: ImportConflictDecision[] = [];
  for (const c of candidates) {
    const hit = byName.get(normalise(c.proposedName));
    if (!hit) continue;
    conflicts.push({
      candidateId: c.candidateId,
      candidateName: c.proposedName,
      existingName: hit.name,
      existingId: hit.id,
      summary: summariseCandidate(c),
      action: "skip" as ImportConflictAction,
    });
  }
  return conflicts;
}

function summariseCandidate(c: ZipSkillCandidate): string {
  const parts: string[] = [];
  parts.push(`${(c.totalBytes / 1024).toFixed(1)} KB`);
  const ancillaryCount = Object.keys(c.ancillaryFiles).length;
  if (ancillaryCount) {
    parts.push(`${ancillaryCount} ancillary file${ancillaryCount === 1 ? "" : "s"}`);
  }
  if (c.skippedFiles.length) {
    parts.push(
      `${c.skippedFiles.length} skipped (>${(MAX_ANCILLARY_FILE_BYTES / 1024 / 1024).toFixed(0)} MB)`,
    );
  }
  parts.push(`from ${c.directory || "(root)"}`);
  return parts.join(" · ");
}

function normalise(s: string): string {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}
