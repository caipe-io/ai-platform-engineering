import JSZip from "jszip";

import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { recordScanEvent } from "@/lib/skill-scan-history";
import type { ScanStatus } from "@/types/agent-skill";

/**
 * URL of the standalone cisco-ai-defense/skill-scanner API server.
 *
 * We deliberately route to the scanner directly because:
 *
 *   1. The scanner is unauthenticated (per upstream README "Development
 *      Use Only"), so it MUST stay internal-only. Compose binds it to
 *      127.0.0.1:8765; Helm exposes it as a ClusterIP Service.
 *   2. Calling it from Next.js API routes (server-side only) means the
 *      scanner URL never leaks to the browser and the unauth surface
 *      stays inside the trust boundary (UI pod → scanner pod).
 *   3. Scanner upgrades become an image bump instead of a platform rebuild.
 *
 * If the env is unset (e.g. local dev without the scanner profile up) we
 * gracefully report `unscanned` rather than throwing — saving a skill
 * must never fail because security scanning is offline.
 */
const SKILL_SCANNER_URL = (process.env.SKILL_SCANNER_URL || "").trim();

/** Optional scan policy preset forwarded to /scan-upload. */
const SKILL_SCANNER_POLICY = (process.env.SKILL_SCANNER_POLICY || "").trim();

/** True when UI server can reach the standalone skill-scanner API. */
export function isSkillScannerConfigured(): boolean {
  return Boolean(SKILL_SCANNER_URL);
}

/** Alias kept for call sites that still import this name. */
export const isSupervisorScanConfigured = isSkillScannerConfigured;

/**
 * The standalone scanner is unauthenticated on the internal network, so
 * this is a no-op accepted only for source
 * compatibility with existing call sites in
 * `app/api/skills/configs/[id]/scan/route.ts` and the hub scan route.
 *
 * Safe to drop in a follow-up cleanup once those routes are simplified.
 */
export interface ScanAuth {
  accessToken?: string;
  catalogKey?: string;
}

/** Shape of /scan-upload responses we care about. */
interface ScannerFinding {
  severity?: string;
  title?: string;
  message?: string;
  description?: string;
}

interface ScannerResponse {
  is_safe?: boolean;
  max_severity?: string;
  findings_count?: number;
  findings?: ScannerFinding[];
  scan_duration_seconds?: number;
}

/**
 * Run the standalone skill-scanner against a single SKILL.md body.
 *
 * The scanner expects a **directory** (zipped, via /scan-upload), so we
 * synthesize a minimal one-file package: `<name>/SKILL.md`. The scanner
 * walks it just like any disk skill.
 *
 * Failure modes (all degrade to `unscanned` instead of throwing — a
 * scanner outage must never block a skill save):
 *   - SKILL_SCANNER_URL unset → scanner not deployed
 *   - Empty content → nothing to scan
 *   - Network error / timeout → scanner pod down or slow
 *   - Non-2xx HTTP → log status + body snippet for debugging
 *
 * `auth` is accepted for compatibility with existing call sites and ignored.
 */
/**
 * Hard cap on total ancillary bytes packed into a single scan ZIP.
 *
 * Two reasons we cap aggressively (default 4 MB) instead of trusting the
 * scanner's 50 MB ingest limit:
 *
 *   1. Static analyzers in the scanner walk every file; a 50 MB upload
 *      can balloon LLM analyzer cost and push the per-skill scan past
 *      our 60s timeout.
 *   2. Hub crawls already cap individual ancillary files (~256 KB each)
 *      but a skill with hundreds of small files can still exceed what
 *      the scanner can usefully analyze. When we hit the cap we drop
 *      additional files (largest first) and surface the truncation in
 *      `scan_summary` so admins notice instead of getting a silent
 *      partial scan.
 */
const ANCILLARY_BYTE_CAP = (() => {
  const raw = parseInt(process.env.SKILL_SCAN_ANCILLARY_BYTE_CAP || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4 * 1024 * 1024;
})();

/**
 * Reject paths that try to escape the synthesized skill directory or
 * collide with the SKILL.md root file. Anything suspicious is dropped
 * silently — this is content sourced from MongoDB / GitHub that was
 * already validated upstream, but defense in depth is cheap here.
 */
function isSafeAncillaryPath(rel: string): boolean {
  if (!rel || typeof rel !== "string") return false;
  if (rel === "SKILL.md") return false; // never overwrite root
  if (rel.startsWith("/") || rel.startsWith("\\")) return false;
  if (rel.includes("..")) return false;
  // Scanner runs on Linux, but a malicious key with a NUL or control
  // char could trip the unzip step.
  if (/[\x00-\x1f]/.test(rel)) return false;
  return true;
}

interface AncillaryEntry {
  rel: string;
  content: string;
  bytes: number;
}

/**
 * Validate, dedupe, and sort ancillary files for inclusion in the scan
 * ZIP. Smallest-first ordering means a single oversized file can't
 * starve the smaller scripts/prompts most likely to carry injection
 * payloads. Invalid paths are dropped silently — content is sourced
 * from MongoDB / GitHub which already validated upstream, but we
 * defense-in-depth here.
 */
function collectAncillaryEntries(
  files: Record<string, string> | undefined,
): AncillaryEntry[] {
  if (!files || typeof files !== "object") return [];
  const entries: AncillaryEntry[] = [];
  for (const [rel, content] of Object.entries(files)) {
    if (!isSafeAncillaryPath(rel)) continue;
    if (typeof content !== "string" || content.length === 0) continue;
    // UTF-8 byte count, not char count, so the cap is meaningful.
    const bytes = Buffer.byteLength(content, "utf8");
    entries.push({ rel, content, bytes });
  }
  entries.sort((a, b) => a.bytes - b.bytes);
  return entries;
}

export interface ScanOptions {
  /**
   * Sibling files referenced by SKILL.md (scripts, prompts, JSON specs,
   * examples). When provided, they're packaged alongside SKILL.md in
   * the scan ZIP so static + LLM analyzers see the same surface that
   * the agent runtime materializes into the StateBackend. See
   * `skills_middleware/backend_sync.py` and
   * `dynamic_agents/services/skills.py` for the runtime side.
   *
   * Keyed by relative path (e.g. `scripts/check.sh`,
   * `examples/report.md`). Path validation: see `isSafeAncillaryPath`.
   */
  ancillaryFiles?: Record<string, string>;
}

export async function scanSkillContent(
  name: string,
  content: string,
  configId?: string,
  optionsOrAuth?: ScanOptions | ScanAuth,
): Promise<{
  scan_status: ScanStatus;
  scan_summary?: string;
  /**
   * Populated when `scan_status === "unscanned"` so callers (bulk
   * scan dialog, per-skill UI, audit log) can show *why* the scan
   * didn't run instead of leaving the user guessing.
   */
  unscanned_reason?: string;
}> {
  if (!SKILL_SCANNER_URL) {
    return {
      scan_status: "unscanned",
      unscanned_reason: "Scanner not configured (SKILL_SCANNER_URL unset)",
    };
  }
  if (!content?.trim()) {
    return {
      scan_status: "unscanned",
      unscanned_reason: "Skill has no SKILL.md content to scan",
    };
  }

  // Callers may pass either scan options or auth fields; only scan options
  // affect the standalone scanner request.
  const options: ScanOptions =
    optionsOrAuth && "ancillaryFiles" in optionsOrAuth
      ? (optionsOrAuth as ScanOptions)
      : {};
  const ancillaryEntries = collectAncillaryEntries(options.ancillaryFiles);

  let zipBuffer: Uint8Array;
  let truncatedAncillary: { dropped: number; reason: string } | null = null;
  try {
    const zip = new JSZip();
    // Sanitize the directory name: scanner uses the top-level dir as the
    // skill name and only accepts a normal path. Strip anything that
    // could escape the temp dir or confuse a Windows-side scanner.
    const safeName = (name || configId || "skill")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 64) || "skill";
    zip.file(`${safeName}/SKILL.md`, content);

    // Ancillary files: pack smallest-first up to ANCILLARY_BYTE_CAP so
    // that a runaway megabyte file doesn't starve the small scripts /
    // prompts that are most likely to carry injection content.
    let consumed = 0;
    let dropped = 0;
    for (const entry of ancillaryEntries) {
      if (consumed + entry.bytes > ANCILLARY_BYTE_CAP) {
        dropped += 1;
        continue;
      }
      zip.file(`${safeName}/${entry.rel}`, entry.content);
      consumed += entry.bytes;
    }
    if (dropped > 0) {
      truncatedAncillary = {
        dropped,
        reason: `${dropped} ancillary file(s) skipped — exceeded ${Math.round(ANCILLARY_BYTE_CAP / 1024)} KB scan cap`,
      };
      console.warn(
        `[ScanSkill] Truncated ancillary payload for "${safeName}": ${truncatedAncillary.reason}`,
      );
    }

    zipBuffer = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      // Keep small — scanner's upload cap is 50 MB; even with ancillary
      // files our cap above keeps us well below it.
      compressionOptions: { level: 6 },
    });
  } catch (err) {
    console.warn("[ScanSkill] Failed to build scan ZIP:", err);
    return {
      scan_status: "unscanned",
      unscanned_reason: `Failed to package SKILL.md for scanner: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([zipBuffer as BlobPart], { type: "application/zip" }),
    "skill.zip",
  );
  if (SKILL_SCANNER_POLICY) {
    form.append("policy", SKILL_SCANNER_POLICY);
  }

  try {
    const resp = await fetch(`${SKILL_SCANNER_URL}/scan-upload`, {
      method: "POST",
      body: form,
      // Static-only scans finish in <1s; LLM scans can take longer but
      // 60s is plenty for a single-file skill.
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(
        `[ScanSkill] skill-scanner returned ${resp.status}: ${body.slice(0, 200)}`,
      );
      return {
        scan_status: "unscanned",
        unscanned_reason: `Scanner returned HTTP ${resp.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
      };
    }
    const data = (await resp.json()) as ScannerResponse;
    const result = interpretScannerResponse(data);
    if (truncatedAncillary) {
      // Surface truncation alongside any scanner summary so the
      // operator knows the scan was partial.
      result.scan_summary = result.scan_summary
        ? `${result.scan_summary} — ${truncatedAncillary.reason}`
        : truncatedAncillary.reason;
    }
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[ScanSkill] skill-scanner unreachable:", reason);
    // Differentiate timeout (60s) from connection error so the operator
    // knows whether to bump the timeout or check the scanner pod.
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return {
      scan_status: "unscanned",
      unscanned_reason: isTimeout
        ? "Scanner did not respond within 60s — pod may be overloaded"
        : `Scanner unreachable: ${reason}`,
    };
  }
}

/**
 * Translate scanner output into the UI's tri-state. We treat the scan as
 * `flagged` whenever the scanner says it's not safe OR reports any
 * finding at HIGH/CRITICAL severity.
 */
function interpretScannerResponse(
  data: ScannerResponse,
): { scan_status: ScanStatus; scan_summary?: string } {
  const severity = (data.max_severity || "").toLowerCase();
  const blocking = severity === "high" || severity === "critical";
  const isSafe = data.is_safe !== false && !blocking;

  const findings = Array.isArray(data.findings) ? data.findings : [];
  const summaryParts: string[] = [];
  if (typeof data.findings_count === "number") {
    summaryParts.push(
      `${data.findings_count} finding${data.findings_count === 1 ? "" : "s"}`,
    );
  }
  if (severity && severity !== "safe") {
    summaryParts.push(`max severity: ${severity}`);
  }
  // Surface the worst finding's message so the user has something
  // actionable in the Scan tab without opening dev tools.
  const worst = findings.find((f) =>
    ["critical", "high"].includes((f.severity || "").toLowerCase()),
  ) ?? findings[0];
  if (worst) {
    const msg = worst.title || worst.message || worst.description;
    if (msg) summaryParts.push(msg.toString().slice(0, 240));
  }

  return {
    scan_status: isSafe ? "passed" : "flagged",
    scan_summary: summaryParts.length ? summaryParts.join(" — ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Hub auto-scan (fire-and-forget after crawl)
// ---------------------------------------------------------------------------

/**
 * Skill payload required to scan and persist an individual hub skill. We
 * intentionally accept a narrow shape (instead of the full `HubSkillDoc`)
 * so this module stays free of circular imports with `hub-crawl.ts`.
 */
export interface HubSkillScanRef {
  hub_id: string;
  skill_id: string;
  name: string;
  content: string;
  /**
   * Sibling files (scripts, prompts, JSON specs, examples) that the
   * hub crawler captured into `hub_skills.ancillary_files`. Forwarded
   * to the scanner so static + LLM analyzers see the same surface the
   * agent runtime injects into the StateBackend.
   */
  ancillary_files?: Record<string, string>;
}

/**
 * Concurrency cap for fan-out. Static-only scans finish in <1s but the
 * scanner pod is single-replica by default — anything higher just queues
 * inside the scanner without saving wall time.
 */
const HUB_SCAN_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.HUB_SCAN_CONCURRENCY || "3", 10),
);

/**
 * Scan a batch of hub skills in the background and persist results onto
 * `hub_skills` (`scan_status` / `scan_summary` / `scan_updated_at`).
 *
 * Used by the hub crawler after first import or when content changes —
 * keeps the "Hub ingest uses Skill Scanner" UX promise without blocking
 * the crawl response. Always resolves; per-skill errors are logged and
 * recorded in `skill_scan_history` so admins have an audit trail.
 *
 * No-op when the scanner is unconfigured (logged once per call).
 */
export async function scanHubSkillsAsync(
  refs: HubSkillScanRef[],
): Promise<void> {
  if (!refs.length) return;
  if (!isSkillScannerConfigured()) {
    console.info(
      `[ScanSkill] Skipping auto-scan for ${refs.length} hub skill(s): SKILL_SCANNER_URL not set`,
    );
    return;
  }
  if (!isMongoDBConfigured) {
    console.warn(
      "[ScanSkill] Skipping hub auto-scan: MongoDB not configured (cannot persist scan_status)",
    );
    return;
  }

  let hubSkillsCol;
  try {
    hubSkillsCol = await getCollection("hub_skills");
  } catch (err) {
    console.warn("[ScanSkill] Hub auto-scan aborted, hub_skills unavailable:", err);
    return;
  }

  // Simple worker-pool fan-out so we don't hammer the scanner with N
  // parallel uploads when a fresh hub returns dozens of skills.
  const queue = [...refs];
  async function worker(): Promise<void> {
    while (queue.length) {
      const ref = queue.shift();
      if (!ref) return;
      const startedAt = Date.now();
      try {
        const result = await scanSkillContent(ref.name, ref.content, ref.skill_id, {
          ancillaryFiles: ref.ancillary_files,
        });
        // Persist the unscanned reason as scan_summary so admins see
        // *why* a hub skill is unscanned without digging into logs.
        const persistedSummary =
          result.scan_summary ?? result.unscanned_reason ?? null;
        // Write only ``scan_status`` / ``scan_summary``. The
        // ``scan_override`` sub-doc (when present, set by the
        // admin override route) is intentionally untouched —
        // recrawl-triggered auto-scans must NOT clear an admin's
        // explicit "I trust this" assertion. Status and override
        // are independent fields by design; see the override
        // route's docstring for the why.
        await hubSkillsCol.updateOne(
          { hub_id: ref.hub_id, skill_id: ref.skill_id, content: ref.content, ancillary_files: ref.ancillary_files ?? {} },
          {
            $set: {
              scan_status: result.scan_status,
              scan_summary: persistedSummary,
              scan_updated_at: new Date(),
            },
          },
        );
        await recordScanEvent({
          trigger: "hub_crawl",
          // Match the catalog id format used elsewhere (hub-<hubId>-<skillId>)
          // so the per-skill history lookup in the workspace finds it.
          skill_id: `hub-${ref.hub_id}-${ref.skill_id}`,
          skill_name: ref.name,
          source: "hub",
          hub_id: ref.hub_id,
          scan_status: result.scan_status,
          scan_summary: persistedSummary ?? undefined,
          scanner_unavailable: result.scan_status === "unscanned",
          duration_ms: Date.now() - startedAt,
        });
      } catch (err) {
        console.warn(
          `[ScanSkill] Hub auto-scan failed for ${ref.hub_id}/${ref.skill_id}:`,
          err,
        );
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(HUB_SCAN_CONCURRENCY, refs.length) },
    () => worker(),
  );
  await Promise.all(workers);
}
