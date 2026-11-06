import { createHash } from "node:crypto";
import { githubHubOptions, type GitHubHubOptions } from "./github-hub-options";
/**
 * Hub Crawler — GitHub/GitLab repo crawler + MongoDB cache for skill hubs.
 *
 * Crawls registered skill hubs for SKILL.md files, caches results in MongoDB,
 * and returns them as CatalogSkill[] for the /api/skills route.
 */

import { validateCredentialsRef } from "@/lib/api-middleware";
import {
NOOP_EMITTER,
type CrawlEventEmitter,
type CrawlRequestPhase,
} from "@/lib/crawl-events";
import { getCollection } from "@/lib/mongodb";
import { scanHubSkillsAsync,type HubSkillScanRef } from "@/lib/skill-scan";
import type { ScanOverride,ScanStatus } from "@/types/agent-skill";
import { MAX_TREE_PAGES_HARD_LIMIT } from "./hub-crawl-constants";

/**
 * Issue a fetch and report it to the crawl-event emitter.
 *
 * Centralized here (rather than at every call site) because every
 * crawler request — tree page, SKILL.md body, ancillary file,
 * future scope-introspection probe — needs identical instrumentation.
 * Wrapping the fetch keeps the emitter ergonomic (one parameter, one
 * code path) and prevents drift where a new fetch callsite forgets
 * to emit a ``request`` event.
 *
 * The wrapper:
 *   - Records start time before the network call
 *   - Catches transport errors (TypeError thrown by `fetch` on
 *     connect timeout / DNS / TLS failure) and emits a ``request``
 *     event with ``status: 0`` so the UI can show "this URL never
 *     completed" rather than nothing at all
 *   - For 4xx/5xx responses, captures the body via ``.clone().text()``
 *     (clone preserves the original `Response` for the caller's
 *     ``.json()`` / ``.text()`` parsing) and includes it in
 *     ``body_preview`` clamped at 1KB. Secret-pattern redaction
 *     happens at the wire-encoder layer, not here, so the in-memory
 *     event still carries the full text for tests and logs.
 *   - Always re-throws transport errors after emitting, preserving
 *     existing crawler error handling
 */
async function fetchWithEmitter(
  url: string,
  init: RequestInit,
  emitter: CrawlEventEmitter,
  phase: CrawlRequestPhase,
): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    emitter.emit({
      type: "request",
      method,
      url,
      status: 0,
      duration_ms: Math.max(0, Date.now() - startedAt),
      phase,
    });
    throw err;
  }
  const duration_ms = Math.max(0, Date.now() - startedAt);
  // ``res.headers`` may be missing on test mocks (Jest's hand-rolled
  // ``Response``-shaped object). Tolerate gracefully — the wrapper
  // exists to instrument production fetches, and missing headers
  // simply means we can't report ``bytes``. We don't want test-only
  // mock omissions to make the production code path crash.
  const contentLengthHeader =
    typeof res.headers?.get === "function"
      ? res.headers.get("content-length")
      : null;
  const bytes =
    contentLengthHeader && /^\d+$/.test(contentLengthHeader)
      ? Number(contentLengthHeader)
      : undefined;

  // Capture error body for diagnostics — clone first so the caller
  // can still consume the original response untouched. ``.clone()``
  // is also test-mock-optional; if it's not provided, skip preview
  // entirely rather than throw.
  let body_preview: string | undefined;
  if (!res.ok && typeof res.clone === "function") {
    try {
      const text = await res.clone().text();
      body_preview = text.length > 1024 ? text.slice(0, 1024) : text;
    } catch {
      // Some Response implementations can't be cloned twice (e.g.
      // certain test mocks). Swallow — body_preview is best-effort.
    }
  }

  emitter.emit({
    type: "request",
    method,
    url,
    status: res.status,
    duration_ms,
    bytes,
    phase,
    body_preview,
  });

  return res;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrawledSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  metadata: Record<string, unknown>;
  path: string;
  /**
   * Sibling files (relative to the skill folder) the crawler captured.
   * Plain UTF-8 text only — binaries and oversized files are skipped and
   * tallied in `ancillary_summary` for operator visibility.
   */
  ancillary_files?: Record<string, string>;
  ancillary_summary?: AncillarySummary;
}

/**
 * Summary of ancillary-file collection so the gallery / operators can see
 * what was skipped without parsing the file map. `total_bytes` covers the
 * collected text files only (not skipped/binary).
 */
export interface AncillarySummary {
  total_files: number;
  total_bytes: number;
  skipped_binary: number;
  skipped_too_large: number;
  truncated_at_count_cap: boolean;
  truncated_at_size_cap: boolean;
}

export interface HubSkillDoc {
  cache_generation?: string;
  hub_id: string;
  skill_id: string;
  name: string;
  description: string;
  content: string;
  metadata: Record<string, unknown>;
  path: string;
  cached_at: Date;
  /**
   * Latest persisted scan status for this hub skill.
   *
   * The scanner only ever writes ``"passed" | "flagged" | "unscanned"``.
   * Admin overrides live in the ``scan_override`` sub-doc below as a
   * SEPARATE field — never as a magic ``scan_status`` value. That
   * earlier design collided with every scanner write path: hub
   * recrawl auto-scan and per-skill rescan would blindly overwrite
   * ``scan_status="flagged"`` and silently nuke the override.
   * Splitting the signals lets the scanner write status freely
   * while overrides stay stable.
   */
  scan_status?: ScanStatus;
  scan_summary?: string;
  scan_updated_at?: Date;
  /**
   * Audit metadata for an active admin override on this hub skill.
   * Set by ``POST /api/admin/skills/hub/[hubId]/[skillId]/scan-override``;
   * cleared by the matching DELETE handler. Scanner write paths
   * (``scanHubSkillsAsync`` after recrawl, per-skill rescan,
   * scan-all) intentionally do NOT touch this field, so an override
   * survives any number of rescans until an admin explicitly clears
   * it. The runtime gate (``applyRunnableGate`` here, Python
   * ``scan_gate.is_skill_blocked`` upstream) honours the override
   * iff ``ADMIN_SCAN_OVERRIDE_ENABLED`` is on.
   */
  scan_override?: ScanOverride;
  /** Sibling files captured during crawl (UTF-8 text only). */
  ancillary_files?: Record<string, string>;
  ancillary_summary?: AncillarySummary;
}

/**
 * Result of the most recent crawl's tree-listing step. Persisted on
 * the hub doc so the admin UI can surface a yellow "skills may be
 * missing" warning even after the recrawl toast has dismissed.
 *
 *  - `kind: "ok"` → tree fit within the platform/cap and was fully read.
 *  - `kind: "platform"` → the upstream API itself reported truncation
 *    (today only GitHub via `truncated: true` from the Git Trees API).
 *    Operator action: scope the crawl with `include_paths` or split.
 *  - `kind: "cap"` → our own `max_tree_pages` cap was hit (GitLab only,
 *    since GitHub fetches the tree in a single request). Operator
 *    action: raise the cap or scope with `include_paths`.
 *
 * `pages_walked` is informational: how many tree-listing pages the
 * crawler walked. Always 1 for GitHub.
 */
export type HubLastCrawlTruncation =
  | { kind: "ok"; pages_walked: number }
  | { kind: "platform"; pages_walked: number; reason: string }
  | { kind: "cap"; pages_walked: number; cap: number };

export interface SkillHubDoc {
  id: string;
  cache_generation?: string;
  type: "github" | "gitlab";
  location: string;
  enabled: boolean;
  credentials_ref: string | null;
  labels?: string[];
  /** Team ids or slugs that should be granted can_use on every skill from this hub. */
  shared_with_teams?: string[];
  /**
   * Optional path-prefix allow-list (each entry normalized to end with `/`).
   * When non-empty, the crawler only ingests SKILL.md files whose path
   * begins with one of these prefixes. Empty/absent => crawl whole repo.
   */
  include_paths?: readonly string[];
  revision?: string;
  entry_paths?: string[];
  /**
   * GitLab only: per-hub override of the recursive-tree page cap.
   * Each page returns up to 100 entries, so a cap of 50 walks at most
   * 5,000 entries. When unset, falls back to the GITLAB_MAX_TREE_PAGES
   * env-var (default 50). Capped at MAX_TREE_PAGES_HARD_LIMIT to bound
   * memory/latency regardless of admin input.
   */
  max_tree_pages?: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_message: string | null;
  /**
   * Truncation summary from the most recent successful crawl. Set on
   * every crawl so a previously-truncated hub clears the warning once
   * the cap is raised (or include_paths are added) and the next crawl
   * fits.
   */
  last_truncation?: HubLastCrawlTruncation;
  /**
   * Persisted log of the most recent ``forceFresh`` crawl, capped to
   * ``MAX_PERSISTED_LOG_EVENTS`` events (see ``crawl-stream-response.ts``).
   * Each entry is a ``CrawlEvent`` with redaction already applied at
   * encode time, so reading this field via a Mongo direct query is
   * safe — secrets never reach this collection unredacted. Only the
   * ``/api/skill-hubs/[id]/refresh`` route writes this field; the
   * preview route is ephemeral. Optional and may be absent for hubs
   * that haven't been refreshed since the streaming feature shipped.
   */
  last_crawl_log?: import("@/lib/crawl-events").CrawlEvent[];
  /** ISO timestamp of when ``last_crawl_log`` was written. */
  last_crawl_log_at?: string;
}

// `MAX_TREE_PAGES_HARD_LIMIT` lives in a dependency-free constants
// module so client-bundled / jsdom-test callers (e.g. the admin UI's
// validator helpers) can import it without pulling in this file's
// transitive `mongodb` dependency. Re-export here so server callers
// keep their existing import path stable.
export { MAX_TREE_PAGES_HARD_LIMIT } from "./hub-crawl-constants";

/**
 * Normalize an `include_paths` array for use as path-prefix filters:
 *  - trim whitespace, drop empties
 *  - dedupe (preserve order)
 *  - ensure each entry ends with a trailing `/` so `skills` does not match
 *    `skills-archive/SKILL.md`
 *
 * Returns `null` when no usable entries remain so callers can short-circuit
 * the filter (treat as "walk the whole repo").
 */
export function normalizeIncludePaths(
  raw: readonly string[] | undefined | null,
): readonly string[] | null {
  if (!raw || raw.length === 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const withSlash = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    if (seen.has(withSlash)) continue;
    seen.add(withSlash);
    out.push(withSlash);
  }
  return out.length > 0 ? out : null;
}

function pathMatchesIncludePrefixes(
  path: string,
  prefixes: readonly string[] | null,
): boolean {
  if (!prefixes) return true;
  for (const p of prefixes) {
    if (path.startsWith(p)) return true;
  }
  return false;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  source: "default" | "agent_skills" | "hub";
  source_id: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  /** Hub-only: latest scan outcome surfaced from `hub_skills` cache. */
  scan_status?: "passed" | "flagged" | "unscanned";
  scan_summary?: string;
  scan_updated_at?: string;
  /**
   * Admin scan-override audit metadata, projected from the hub_skills
   * cache when an admin has green-lit a flagged hub skill. Lives in a
   * separate field from ``scan_status`` (post-pivot, two-field design)
   * so scanner write paths can keep updating ``scan_status`` without
   * racing the override. The runtime ``scan_gate`` checks the same field;
   * the gate is
   *   ``scan_status === "flagged" && !scan_override``.
   * Surfaced through the catalog so the UI's report dialog can render
   * the audit panel + Remove-override button on hub-projected rows.
   */
  scan_override?: {
    set_by: string;
    set_at: string;
    reason: string;
    prior_scan_status: "flagged";
    prior_scan_summary?: string;
  };
  /**
   * Sibling files (paths relative to the skill folder) — populated only
   * when callers request `include_content=true`. Mirrors the same field on
   * `agent_skills` so editors / installers can treat both sources alike.
   */
  ancillary_files?: Record<string, string>;
  ancillary_summary?: AncillarySummary;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HUB_CACHE_TTL_MS = parseInt(
  process.env.HUB_CACHE_TTL_MS || "3600000",
  10,
);

// Hard cap on GitLab tree-listing pages per crawl. The tree endpoint
// returns at most 100 entries per page; with the default cap of 50 we
// will scan up to 5,000 entries before bailing — generous for any
// single-repo skill hub but bounded so a runaway monorepo can't OOM
// the Node process. Operators with legitimately huge repos can override
// via env (e.g. set to "200" for up to 20,000 entries).
const GITLAB_MAX_TREE_PAGES = Math.max(
  1,
  parseInt(process.env.GITLAB_MAX_TREE_PAGES || "50", 10) || 50,
);

// ENV_VAR_NAME_RE removed — use validateCredentialsRef from api-middleware instead

// ---------------------------------------------------------------------------
// Frontmatter parser (mirrors skill-templates-loader.ts)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): {
  name: string;
  description: string;
} {
  let name = "";
  let description = "";
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (match) {
    const lines = match[1].split("\n");
    let currentKey = "";
    let currentValue = "";

    for (const line of lines) {
      const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
      if (keyMatch) {
        if (currentKey === "name") name = currentValue.trim();
        if (currentKey === "description") description = currentValue.trim();
        currentKey = keyMatch[1];
        const val = keyMatch[2].trim();
        // YAML folded scalar ">" or literal "|" — value is on next lines
        currentValue = val === ">" || val === "|" ? "" : val;
      } else if (currentKey && line.match(/^\s+/)) {
        // Continuation line (indented) — append with space
        currentValue += " " + line.trim();
      }
    }
    if (currentKey === "name") name = currentValue.trim();
    if (currentKey === "description") description = currentValue.trim();
  }
  return { name, description };
}

// ---------------------------------------------------------------------------
// Ancillary-file collection (shared by GitHub + GitLab crawlers)
//
// Anthropic-style skills (e.g. `pdf`, `docx`, `slack`) ship runtime code,
// reference docs, and assets alongside SKILL.md. Without those files an
// installed skill is broken — SKILL.md references like `scripts/extract.py`
// won't resolve.
//
// Strategy:
//   - Bound resource use with per-file / per-skill / per-hub caps.
//   - Skip binaries (extension allowlist + null-byte sniff) since plain-text
//     storage in Mongo is the simplest way to keep parity with `agent_skills`.
//     Operators get a count of skipped binaries via `ancillary_summary` so
//     missing files aren't silent.
//   - Preserve nested paths verbatim (relative to the skill folder).
// ---------------------------------------------------------------------------

const HUB_ANCILLARY_PER_FILE_BYTES = parseInt(
  process.env.HUB_ANCILLARY_PER_FILE_BYTES || String(1 * 1024 * 1024),
  10,
);
const HUB_ANCILLARY_TOTAL_BYTES = parseInt(
  process.env.HUB_ANCILLARY_TOTAL_BYTES || String(5 * 1024 * 1024),
  10,
);
const HUB_ANCILLARY_FILE_LIMIT = parseInt(
  process.env.HUB_ANCILLARY_FILE_LIMIT || "100",
  10,
);

/** Rough text-file allowlist by extension (extend as needed). */
const TEXT_FILE_EXTENSIONS = new Set([
  // Code
  "py", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "go", "rs", "rb", "php", "java", "kt", "swift", "scala", "cs",
  "c", "h", "cc", "cpp", "hpp", "m", "mm",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "proto",
  // Markup / config / data
  "md", "markdown", "mdx", "rst", "txt", "log",
  "json", "jsonc", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "xml", "html", "htm", "css", "scss", "less", "svg", "ql",
  "csv", "tsv",
  // DevOps
  "dockerfile", "tf", "tfvars", "hcl",
  "lock", "gitignore", "gitattributes", "editorconfig",
  // Misc text
  "tpl", "tmpl", "j2", "ejs",
]);

/** Strong "this is text" override for files without an extension. */
const TEXT_FILENAMES = new Set([
  "Dockerfile", "Makefile", "Rakefile", "Gemfile", "Pipfile",
  "LICENSE", "NOTICE", "README", "CHANGELOG", "CONTRIBUTING",
  "CODEOWNERS", ".gitignore", ".dockerignore", ".gitattributes",
  ".editorconfig",
]);

function isLikelyTextPath(path: string): boolean {
  const filename = path.split("/").pop() || "";
  if (TEXT_FILENAMES.has(filename)) return true;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return false; // unknown bareword extension → treat as binary
  const ext = filename.slice(dot + 1).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(ext);
}

/**
 * Cheap binary sniff — UTF-8 text shouldn't contain a NUL byte in the
 * first 8 KiB. Catches the case where an extension allow-listed file is
 * actually binary (e.g. `.lock` from a non-text format).
 */
function looksLikeBinaryContent(text: string): boolean {
  const sample = text.length > 8192 ? text.slice(0, 8192) : text;
  return sample.includes("\u0000");
}

/** Mutable accumulator passed through the per-skill collection loop. */
interface AncillaryAccumulator {
  files: Record<string, string>;
  summary: AncillarySummary;
}

function newAncillaryAccumulator(): AncillaryAccumulator {
  return {
    files: {},
    summary: {
      total_files: 0,
      total_bytes: 0,
      skipped_binary: 0,
      skipped_too_large: 0,
      truncated_at_count_cap: false,
      truncated_at_size_cap: false,
    },
  };
}

/**
 * Try to ingest one ancillary file into the accumulator. Returns `false`
 * when the per-skill caps are exhausted so the caller can stop fetching
 * additional siblings (saves API calls).
 */
function tryAcceptAncillary(
  acc: AncillaryAccumulator,
  relPath: string,
  bytes: number,
  fetchText: () => Promise<string>,
): Promise<boolean> {
  if (acc.summary.total_files >= HUB_ANCILLARY_FILE_LIMIT) {
    acc.summary.truncated_at_count_cap = true;
    return Promise.resolve(false);
  }
  if (bytes > HUB_ANCILLARY_PER_FILE_BYTES) {
    acc.summary.skipped_too_large += 1;
    return Promise.resolve(true);
  }
  if (acc.summary.total_bytes + bytes > HUB_ANCILLARY_TOTAL_BYTES) {
    acc.summary.truncated_at_size_cap = true;
    return Promise.resolve(false);
  }
  if (!isLikelyTextPath(relPath)) {
    acc.summary.skipped_binary += 1;
    return Promise.resolve(true);
  }
  return fetchText().then((text) => {
    if (looksLikeBinaryContent(text)) {
      acc.summary.skipped_binary += 1;
      return true;
    }
    acc.files[relPath] = text;
    acc.summary.total_files += 1;
    acc.summary.total_bytes += bytes;
    return true;
  });
}

// ---------------------------------------------------------------------------
// GitHub crawler
// ---------------------------------------------------------------------------

interface GitHubTreeEntry {
  path: string;
  type: string;
  sha: string;
  url: string;
  /** Blob byte size — present for `type: "blob"` entries from the trees API. */
  size?: number;
}

/**
 * Result of a hub crawl. `skills` is what callers care about most of
 * the time; `truncation` is informational so the caller can persist
 * the warning on the hub doc and the admin UI can surface it.
 */
export interface CrawlResult {
  skills: CrawledSkill[];
  truncation: HubLastCrawlTruncation;
}

export async function crawlGitHubRepo(
  owner: string,
  repo: string,
  token?: string,
  includePaths?: readonly string[],
  emitter: CrawlEventEmitter = NOOP_EMITTER,
  sourceOptions: GitHubHubOptions = {},
): Promise<CrawlResult> {
  const { revision, entry_paths: entryPaths = [] } = githubHubOptions(sourceOptions);
  const ref = revision || "HEAD";
  const normalizedIncludes = normalizeIncludePaths(includePaths);

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "caipe-hub-crawler/1.0",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  // Use Git Trees API (recursive) for efficiency — single request for full tree
  const treeRes = await fetchWithEmitter(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
    { headers, signal: AbortSignal.timeout(15000) },
    emitter,
    "tree",
  );
  if (!treeRes.ok) {
    throw new Error(
      `GitHub API error: ${treeRes.status} ${treeRes.statusText}`,
    );
  }
  const treeData = await treeRes.json();
  // GitHub's Git Trees API caps responses at ~100k entries / 7MB and
  // signals overflow with `truncated: true`, silently omitting the
  // rest of the tree. Surface this via the structured `truncation`
  // result so the admin UI can show a persistent warning and an
  // "Add include_paths" CTA. We still ingest whatever did come back —
  // a partial set of skills is more useful than no skills at all, and
  // the warning makes it clear the result is incomplete.
  const platformTruncated = treeData.truncated === true;
  if (platformTruncated && (revision || entryPaths.length)) throw new Error("Original package tree is truncated");
  const entries: GitHubTreeEntry[] = treeData.tree || [];

  // GitHub returns the entire recursive tree in a single response.
  // Emit a synthetic ``page`` event so the UI dialog can render the
  // same "1 page walked" indicator it shows for GitLab. ``has_next``
  // is always false because there is no pagination on this endpoint.
  emitter.emit({
    type: "page",
    page: 1,
    entries: entries.length,
    has_next: false,
  });

  // Find all SKILL.md files (optionally filtered to the configured prefixes
  // so monorepos don't blast the whole tree into Mongo).
  const skillMdPaths = entries
    .filter(
      (e: GitHubTreeEntry) =>
        e.type === "blob" && (e.path.endsWith("/SKILL.md") || entryPaths.includes(e.path)),
    )
    .map((e: GitHubTreeEntry) => e.path)
    .filter((p) => pathMatchesIncludePrefixes(p, normalizedIncludes));

  // Index every blob by path so we can enumerate ancillary siblings without
  // additional tree calls.
  const blobBySize = new Map<string, number>();
  for (const e of entries) {
    if (e.type === "blob") blobBySize.set(e.path, e.size ?? 0);
  }

  // Sort skill dirs by path so nested-skill detection is deterministic.
  const skillDirs = skillMdPaths
    .map((p) => p.slice(0, p.lastIndexOf("/")))
    .sort();

  /**
   * Returns true when `path` lives inside a *nested* skill folder (i.e. a
   * SKILL.md exists at a deeper level than `currentDir`). Those files are
   * owned by the nested skill, not the parent, so we must not duplicate
   * them.
   */
  function belongsToNestedSkill(currentDir: string, path: string): boolean {
    for (const otherDir of skillDirs) {
      if (otherDir === currentDir) continue;
      if (!otherDir.startsWith(`${currentDir}/`)) continue;
      if (path === `${otherDir}/SKILL.md`) return true;
      if (path.startsWith(`${otherDir}/`)) return true;
    }
    return false;
  }

  const skills: CrawledSkill[] = [];

  for (const skillPath of skillMdPaths) {
    try {
      // Fetch SKILL.md content
      const contentRes = await fetchWithEmitter(
        `https://api.github.com/repos/${owner}/${repo}/contents/${skillPath}${revision ? `?ref=${revision}` : ""}`,
        { headers, signal: AbortSignal.timeout(10000) },
        emitter,
        "skill_md",
      );
      if (!contentRes.ok) {
        emitter.emit({
          type: "warning",
          code: "fetch_failed",
          message: `SKILL.md fetch failed for ${skillPath}: HTTP ${contentRes.status}`,
          context: { path: skillPath, status: contentRes.status },
        });
        continue;
      }
      const contentData = await contentRes.json();
      const content = Buffer.from(contentData.content, "base64").toString(
        "utf-8",
      );

      // Derive skill directory and id
      const dir = skillPath.slice(0, skillPath.lastIndexOf("/"));
      const id = skillPath.endsWith("/SKILL.md") ? dir.split("/").pop() || dir : skillPath.split("/").pop()!.replace(/\.md$/, "");

      // Collect ancillary siblings (everything under `dir/` except SKILL.md
      // itself and any files belonging to a nested skill). metadata.json is
      // also captured here so installers/exports get it verbatim, while we
      // still parse it separately into `metadata`.
      const ancillary = newAncillaryAccumulator();
      const dirPrefix = `${dir}/`;
      const candidates = Array.from(blobBySize.entries())
        .filter(([p]) => p.startsWith(dirPrefix) && p !== skillPath)
        .filter(([p]) => !belongsToNestedSkill(dir, p))
        .sort(([a], [b]) => a.localeCompare(b));

      for (const [absPath, size] of candidates) {
        const relPath = absPath.slice(dirPrefix.length);
        const accepted = await tryAcceptAncillary(
          ancillary,
          relPath,
          size,
          async () => {
            const fileRes = await fetchWithEmitter(
              `https://api.github.com/repos/${owner}/${repo}/contents/${absPath}${revision ? `?ref=${revision}` : ""}`,
              { headers, signal: AbortSignal.timeout(10000) },
              emitter,
              "ancillary",
            );
            if (!fileRes.ok) {
              throw new Error(
                `GitHub content fetch failed for ${absPath}: ${fileRes.status}`,
              );
            }
            const data = await fileRes.json();
            // Reject server-side truncations (>1 MiB blobs return empty
            // `content` with `encoding: "none"`); treat as too-large.
            if (!data.content || data.encoding !== "base64") {
              throw new Error(`Unsupported encoding for ${absPath}`);
            }
            return Buffer.from(data.content, "base64").toString("utf-8");
          },
        );
        if (!accepted) break;
      }

      // Parse metadata.json out of the collected ancillary files (we already
      // fetched it once — no second request needed).
      let metadata: Record<string, unknown> = {};
      const metaContent = ancillary.files["metadata.json"];
      if (metaContent) {
        try {
          metadata = JSON.parse(metaContent);
        } catch {
          // Malformed metadata.json — leave empty but keep the file.
        }
      }

      const fm = parseFrontmatter(content);

      const skillName = fm.name || id;
      const original = !!revision || entryPaths.includes(skillPath);
      if (original && (ancillary.summary.skipped_binary || ancillary.summary.skipped_too_large ||
        ancillary.summary.truncated_at_count_cap || ancillary.summary.truncated_at_size_cap)) {
        throw new Error(`Original package is incomplete: ${skillPath}`);
      }
      skills.push({
        id: original ? `${skillName}-${createHash("sha256").update(skillPath).digest("hex").slice(0, 12)}` : skillName,
        name: skillName,
        description: fm.description || "",
        content,
        metadata: { ...metadata, ...(revision || entryPaths.includes(skillPath) ? { upstream_revision: revision || null, upstream_entry_path: skillPath, original_content: true } : {}) },
        path: skillPath,
        ancillary_files: ancillary.files,
        ancillary_summary: ancillary.summary,
      });
      emitter.emit({
        type: "skill_found",
        path: skillPath,
        name: skillName,
        ancillary_count: Object.keys(ancillary.files).length,
      });
    } catch (err) {
      if (revision || entryPaths.includes(skillPath)) throw err;
      console.error(`[HubCrawl] Failed to fetch ${skillPath}:`, err);
      emitter.emit({
        type: "warning",
        code: "fetch_failed",
        message: `Failed to ingest ${skillPath}: ${err instanceof Error ? err.message : String(err)}`,
        context: { path: skillPath },
      });
    }
  }

  const truncation: HubLastCrawlTruncation = platformTruncated
    ? {
        kind: "platform",
        pages_walked: 1,
        reason:
          `GitHub Git Trees API truncated the recursive tree (>100k entries ` +
          `or >7MB). Skills outside the returned slice were silently omitted.`,
      }
    : { kind: "ok", pages_walked: 1 };
  if (truncation.kind === "platform") {
    emitter.emit({
      type: "warning",
      code: "tree_truncated_platform",
      message: truncation.reason,
    });
  }
  return { skills, truncation };
}

// ---------------------------------------------------------------------------
// GitLab crawler
// ---------------------------------------------------------------------------

interface GitLabTreeEntry {
  id: string;
  name: string;
  type: string;
  path: string;
  mode: string;
}

/**
 * Translate a non-2xx GitLab tree response into an actionable error
 * message.
 *
 * The bare ``GitLab API error: 403 Forbidden`` we used to surface
 * told the admin nothing about WHY: was the token missing, did it
 * lack ``read_repository`` scope, was the API URL pointing at the
 * wrong instance, or did the project just not exist? The hints
 * below cover the four diagnoses we can derive from the code's
 * own state (status + token presence + configured base URL).
 *
 * Specifically reproduces the user-reported failure mode where a
 * self-hosted GitLab project (``https://cd.splunkdev.com/...``)
 * either:
 *   - has ``GITLAB_API_URL`` correctly pointed at the self-hosted
 *     instance but no matching ``GITLAB_TOKEN`` set, or
 *   - has a token from a different instance (``gitlab.com`` token
 *     against ``cd.splunkdev.com``), which GitLab rejects with 403.
 *
 * Both diagnoses surface the same actionable line: "set
 * ``GITLAB_TOKEN`` to a token valid for ``<host>`` with
 * ``read_repository`` scope."
 *
 * GitLab's API uses 404 (not 403) for unauthenticated reads of a
 * private project — that's the same auth-shaped failure dressed up
 * to avoid leaking project existence — so we treat 401/403/404 as
 * the same diagnostic cluster.
 */
function formatGitLabFetchError(
  res: Response,
  baseUrl: string,
  hasToken: boolean,
  projectPath: string,
): string {
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  })();
  const base = `GitLab API error: ${res.status} ${res.statusText} (project: ${projectPath}, API: ${host})`;

  // 401/403/404 are the auth/visibility cluster. GitLab returns 404
  // for unauth'd private reads, 403 for valid-but-insufficient
  // tokens, and 401 only when the token is malformed. All three
  // benefit from the same operator action.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    if (!hasToken) {
      return (
        `${base}. No GitLab token is configured. ` +
        `For private or self-hosted projects, set GITLAB_TOKEN to ` +
        `a personal access token with the "read_repository" scope ` +
        `that's valid for ${host}.`
      );
    }
    return (
      `${base}. A GitLab token is set, but it does not grant access ` +
      `to this project on ${host}. Verify (a) the token belongs to ` +
      `the same GitLab instance as GITLAB_API_URL, (b) the token has ` +
      `the "read_repository" scope, and (c) the user owning the token ` +
      `can see the project. For self-hosted GitLab, the gitlab.com ` +
      `token will not work — generate one on ${host} instead.`
    );
  }

  if (res.status === 429) {
    return `${base}. Rate limited by GitLab. Wait and retry, or use an authenticated token to raise the rate limit.`;
  }

  return base;
}

export async function crawlGitLabRepo(
  projectPath: string,
  token?: string,
  includePaths?: readonly string[],
  maxTreePages?: number,
  emitter: CrawlEventEmitter = NOOP_EMITTER,
): Promise<CrawlResult> {
  // GitLab's API addresses projects by URL-encoded namespaced path
  // (`group/sub/project`), NOT by full URL. Callers MUST pass the
  // canonical path; if a URL slips through, `encodeURIComponent`
  // produces something like `https%3A%2F%2Fgitlab.com%2F...` which
  // GitLab returns 404 for, and the resulting toast (`GitLab API
  // error: 404 Not Found`) is impossible to debug without reading the
  // wire. Fail loud with an actionable message instead.
  //
  // Self-hosted callers should set `GITLAB_API_URL` and pass the bare
  // namespaced path; the shared `normalizeHubLocation` helper in
  // `app/api/skill-hubs/_lib/normalize` does this correctly for inputs
  // arriving from the UI.
  const trimmed = projectPath.trim();
  if (!trimmed) {
    throw new Error("GitLab project path is empty");
  }
  if (trimmed.includes("://") || trimmed.startsWith("/")) {
    throw new Error(
      `GitLab project path must be a namespaced path like ` +
        `"group/project" or "group/subgroup/project", not a URL ` +
        `(got: "${trimmed}"). Normalize via normalizeHubLocation() ` +
        `before calling crawlGitLabRepo.`,
    );
  }
  if (!trimmed.includes("/")) {
    throw new Error(
      `GitLab project path must include at least one "/" separator ` +
        `(got: "${trimmed}").`,
    );
  }

  const normalizedIncludes = normalizeIncludePaths(includePaths);
  const encodedProject = encodeURIComponent(trimmed);
  const baseUrl =
    process.env.GITLAB_API_URL || "https://gitlab.com/api/v4";

  const headers: Record<string, string> = {
    "User-Agent": "caipe-hub-crawler/1.0",
  };
  if (token) headers["PRIVATE-TOKEN"] = token;

  // Resolve the per-crawl page cap. Per-hub `maxTreePages` (admin UI,
  // persisted on the hub doc) wins over the env-var default; both are
  // floored at 1 and ceilinged at MAX_TREE_PAGES_HARD_LIMIT so a
  // misconfigured hub can't OOM the Node process. We surface "we hit
  // the cap" via the structured CrawlResult so the admin UI can
  // display a yellow "skills past page N may be missing" warning.
  const effectiveCap = Math.min(
    MAX_TREE_PAGES_HARD_LIMIT,
    Math.max(
      1,
      typeof maxTreePages === "number" && Number.isFinite(maxTreePages)
        ? Math.floor(maxTreePages)
        : GITLAB_MAX_TREE_PAGES,
    ),
  );

  // Get recursive tree.
  //
  // GitLab's tree endpoint paginates at 100 entries per page; previously
  // we only fetched page 1, which silently dropped any SKILL.md whose
  // alphabetical position pushed it past the first 100 entries (e.g.
  // `skills/<name>/SKILL.md` in a repo that also ships hundreds of
  // `.claude-plugin/...` siblings). Walk pages until GitLab clears the
  // `x-next-page` header, capped so a runaway monorepo can't exhaust
  // Node's heap.
  const entries: GitLabTreeEntry[] = [];
  let page = 1;
  let pagesWalked = 0;
  let capHit = false;
  while (true) {
    const treeRes = await fetchWithEmitter(
      `${baseUrl}/projects/${encodedProject}/repository/tree?recursive=true&per_page=100&page=${page}`,
      { headers, signal: AbortSignal.timeout(15000) },
      emitter,
      "tree",
    );
    if (!treeRes.ok) {
      throw new Error(formatGitLabFetchError(treeRes, baseUrl, !!token, trimmed));
    }
    const pageEntries = (await treeRes.json()) as GitLabTreeEntry[];
    entries.push(...pageEntries);
    pagesWalked += 1;

    const nextHeader = treeRes.headers.get("x-next-page");
    const nextPage = nextHeader ? parseInt(nextHeader, 10) : NaN;
    const hasNext =
      !!nextHeader && Number.isFinite(nextPage) && nextPage > page;
    emitter.emit({
      type: "page",
      page,
      entries: pageEntries.length,
      has_next: hasNext,
    });
    if (!hasNext) {
      break;
    }
    if (pagesWalked >= effectiveCap) {
      // GitLab still has more pages but our cap stops us here. Record
      // it so the caller can persist the warning on the hub doc.
      capHit = true;
      break;
    }
    page = nextPage;
  }

  // Find SKILL.md files (optionally filtered to the configured prefixes
  // so monorepos don't blast the whole tree into Mongo).
  const skillMdPaths = entries
    .filter(
      (e: GitLabTreeEntry) =>
        e.type === "blob" && e.path.endsWith("/SKILL.md"),
    )
    .map((e: GitLabTreeEntry) => e.path)
    .filter((p) => pathMatchesIncludePrefixes(p, normalizedIncludes));

  // GitLab tree responses don't carry blob sizes, so we treat unknown sizes
  // as "fetch and check" — `tryAcceptAncillary` still enforces caps after
  // we read the body.
  const allBlobPaths = entries
    .filter((e) => e.type === "blob")
    .map((e) => e.path);

  const skillDirs = skillMdPaths
    .map((p) => p.replace(/\/SKILL\.md$/, ""))
    .sort();

  function belongsToNestedSkill(currentDir: string, path: string): boolean {
    for (const otherDir of skillDirs) {
      if (otherDir === currentDir) continue;
      if (!otherDir.startsWith(`${currentDir}/`)) continue;
      if (path === `${otherDir}/SKILL.md`) return true;
      if (path.startsWith(`${otherDir}/`)) return true;
    }
    return false;
  }

  const skills: CrawledSkill[] = [];

  for (const skillPath of skillMdPaths) {
    try {
      const encodedPath = encodeURIComponent(skillPath);
      const fileRes = await fetchWithEmitter(
        `${baseUrl}/projects/${encodedProject}/repository/files/${encodedPath}/raw?ref=HEAD`,
        { headers, signal: AbortSignal.timeout(10000) },
        emitter,
        "skill_md",
      );
      if (!fileRes.ok) {
        emitter.emit({
          type: "warning",
          code: "fetch_failed",
          message: `SKILL.md fetch failed for ${skillPath}: HTTP ${fileRes.status}`,
          context: { path: skillPath, status: fileRes.status },
        });
        continue;
      }
      const content = await fileRes.text();

      const dir = skillPath.replace(/\/SKILL\.md$/, "");
      const id = dir.split("/").pop() || dir;

      // Collect ancillary siblings (see GitHub crawler comment for rationale).
      const ancillary = newAncillaryAccumulator();
      const dirPrefix = `${dir}/`;
      const candidates = allBlobPaths
        .filter((p) => p.startsWith(dirPrefix))
        .filter((p) => p !== skillPath)
        .filter((p) => !belongsToNestedSkill(dir, p))
        .sort();

      for (const absPath of candidates) {
        const relPath = absPath.slice(dirPrefix.length);
        // GitLab raw API doesn't expose size in the tree listing; fetch
        // first and let the per-file cap enforce after the read. We trust
        // the `Content-Length` header when present to short-circuit large
        // bodies.
        const accepted = await tryAcceptAncillary(
          ancillary,
          relPath,
          0, // unknown size — accumulator still enforces total + count caps
          async () => {
            const encodedAbs = encodeURIComponent(absPath);
            const res = await fetchWithEmitter(
              `${baseUrl}/projects/${encodedProject}/repository/files/${encodedAbs}/raw?ref=HEAD`,
              { headers, signal: AbortSignal.timeout(10000) },
              emitter,
              "ancillary",
            );
            if (!res.ok) {
              throw new Error(
                `GitLab raw fetch failed for ${absPath}: ${res.status}`,
              );
            }
            const text = await res.text();
            if (text.length > HUB_ANCILLARY_PER_FILE_BYTES) {
              throw new Error(
                `Ancillary too large for ${absPath}: ${text.length} bytes`,
              );
            }
            return text;
          },
        );
        if (!accepted) break;
      }

      let metadata: Record<string, unknown> = {};
      const metaContent = ancillary.files["metadata.json"];
      if (metaContent) {
        try {
          metadata = JSON.parse(metaContent);
        } catch {
          // Malformed metadata.json — leave empty but keep the file.
        }
      }

      const fm = parseFrontmatter(content);

      const skillName = fm.name || id;
      skills.push({
        id: skillName,
        name: skillName,
        description: fm.description || "",
        content,
        metadata,
        path: skillPath,
        ancillary_files: ancillary.files,
        ancillary_summary: ancillary.summary,
      });
      emitter.emit({
        type: "skill_found",
        path: skillPath,
        name: skillName,
        ancillary_count: Object.keys(ancillary.files).length,
      });
    } catch (err) {
      console.error(`[HubCrawl] Failed to fetch ${skillPath}:`, err);
      emitter.emit({
        type: "warning",
        code: "fetch_failed",
        message: `Failed to ingest ${skillPath}: ${err instanceof Error ? err.message : String(err)}`,
        context: { path: skillPath },
      });
    }
  }

  const truncation: HubLastCrawlTruncation = capHit
    ? { kind: "cap", pages_walked: pagesWalked, cap: effectiveCap }
    : { kind: "ok", pages_walked: pagesWalked };
  if (truncation.kind === "cap") {
    emitter.emit({
      type: "warning",
      code: "tree_truncated_pages",
      message:
        `GitLab tree pagination capped at ${effectiveCap} pages ` +
        `(GITLAB_MAX_TREE_PAGES or per-hub override). Skills past ` +
        `page ${effectiveCap} may be missing.`,
      context: { pages_walked: pagesWalked, cap: effectiveCap },
    });
  }
  return { skills, truncation };
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

export function resolveHubToken(hub: SkillHubDoc): string | undefined {
  return resolveToken(hub);
}

function resolveToken(hub: SkillHubDoc): string | undefined {
  // First try the explicit credentials_ref
  if (hub.credentials_ref) {
    try {
      const validated = validateCredentialsRef(hub.credentials_ref);
      if (validated) {
        const val = process.env[validated];
        if (val) return val;
      }
    } catch {
      console.warn(
        `[HubCrawl] Invalid credentials_ref format: ${hub.credentials_ref}`,
      );
      return undefined;
    }
  }

  // Fall back to default token env vars
  if (hub.type === "github") return process.env.GITHUB_TOKEN;
  if (hub.type === "gitlab") return process.env.GITLAB_TOKEN;
  return undefined;
}

// ---------------------------------------------------------------------------
// Main entry point — getHubSkills (with MongoDB caching)
// ---------------------------------------------------------------------------

export async function getHubSkills(
  hub: SkillHubDoc,
  forceFresh = false,
  emitter: CrawlEventEmitter = NOOP_EMITTER,
): Promise<CatalogSkill[]> {
  const hubSkillsCol = await getCollection<HubSkillDoc>("hub_skills");

  // Always check for any cached docs first
  const cached = await hubSkillsCol
    .find({ hub_id: hub.id, ...(hub.cache_generation ? {cache_generation: hub.cache_generation} : {}) })
    .toArray();

  if (!forceFresh && cached.length > 0) {
    // Check if cache is still fresh
    const cacheThreshold = new Date(Date.now() - HUB_CACHE_TTL_MS);
    const isFresh = cached.some((doc) => doc.cached_at >= cacheThreshold);

    if (!isFresh) {
      // Stale — return cached immediately, refresh in background.
      // Background refresh deliberately does NOT propagate the
      // emitter because it runs after the request returns; there's
      // no UI listener to consume events, and we don't want to
      // accidentally hold a streaming response open waiting for a
      // background refresh that's racing the original request.
      _refreshHubInBackground(hub, hubSkillsCol).catch((err) => {
        console.warn(`[HubCrawl] Background refresh failed for ${hub.location}:`, err);
      });
    }

    return cached.map(docToCatalogSkill(hub));
  }

  // No cache at all (or force-fresh) — must crawl synchronously
  return _crawlAndCache(hub, hubSkillsCol, emitter);
}

/**
 * Crawl a hub repo and update the MongoDB cache. Returns CatalogSkill[].
 */
async function _crawlAndCache(
  hub: SkillHubDoc,
  hubSkillsCol: Awaited<ReturnType<typeof getCollection<HubSkillDoc>>>,
  emitter: CrawlEventEmitter = NOOP_EMITTER,
): Promise<CatalogSkill[]> {
  const token = resolveToken(hub);
  let crawled: CrawledSkill[];
  let truncation: HubLastCrawlTruncation;

  try {
    if (hub.type === "github") {
      let loc = hub.location;
      try {
        const url = new URL(loc);
        if (url.hostname === "github.com" || url.hostname.endsWith(".github.com")) {
          loc = url.pathname.replace(/^\/+|\/+$/g, "");
        }
      } catch {
        // Not a URL — assume owner/repo
      }
      const parts = loc.split("/");
      const owner = parts[0];
      const repo = parts[1];
      if (!owner || !repo) throw new Error(`Invalid GitHub location: ${hub.location}`);
      const result = await crawlGitHubRepo(
        owner,
        repo,
        token,
        hub.include_paths,
        emitter,
        { revision: hub.revision, entry_paths: hub.entry_paths },
      );
      crawled = result.skills;
      truncation = result.truncation;
    } else if (hub.type === "gitlab") {
      const result = await crawlGitLabRepo(
        hub.location,
        token,
        hub.include_paths,
        hub.max_tree_pages,
        emitter,
      );
      crawled = result.skills;
      truncation = result.truncation;
    } else {
      throw new Error(`Unsupported hub type: ${hub.type}`);
    }

    // Update hub success status. `last_truncation` is always written so
    // raising the cap / adding include_paths clears a stale warning on
    // the next crawl.
    const hubsCol = await getCollection("skill_hubs");
    await hubsCol.updateOne(
      { id: hub.id },
      {
        $set: {
          last_success_at: Math.floor(Date.now() / 1000),
          last_failure_at: null,
          last_failure_message: null,
          last_truncation: truncation,
          updated_at: new Date().toISOString(),
        },
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    try {
      const hubsCol = await getCollection("skill_hubs");
      await hubsCol.updateOne(
        { id: hub.id },
        {
          $set: {
            last_failure_at: Math.floor(Date.now() / 1000),
            last_failure_message: message,
            updated_at: new Date().toISOString(),
          },
        },
      );
    } catch {
      // Best-effort status update
    }

    throw err;
  }

  const currentHub = await (await getCollection("skill_hubs")).findOne({id: hub.id});
  if (currentHub?.cache_generation !== hub.cache_generation) throw new Error("Hub settings changed during crawl; refresh again");
  if (new Set(crawled.map(skill => skill.id)).size !== crawled.length) throw new Error("Hub has colliding skill identities");

  // Upsert crawled skills into cache. Track which ones are *new* or have
  // *changed content* so we can fire an async scan only for those — saves
  // scanner work on a no-op refresh of a 100-skill hub.
  const now = new Date();
  // Pull just the fields needed for change detection. Cheaper than
  // holding the full previous snapshot in memory.
  const priorDocs = await hubSkillsCol
    .find(
      { hub_id: hub.id },
      { projection: { skill_id: 1, content: 1, scan_status: 1, ancillary_files: 1 } },
    )
    .toArray();
  const priorById = new Map(
    priorDocs.map((d) => [
      d.skill_id,
      {
        content: d.content ?? "",
        ancillary: d.ancillary_files ?? {},
        scan_status: (d.scan_status as string | undefined) ?? null,
      },
    ]),
  );

  const refsToScan: HubSkillScanRef[] = [];

  for (const skill of crawled) {
    const prior = priorById.get(skill.id);
    const sameFiles = (a: Record<string, string>, b: Record<string, string>) =>
      Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([path, content]) => b[path] === content);
    const packageChanged = !!prior && (prior.content !== skill.content || !sameFiles(prior.ancillary, skill.ancillary_files ?? {}));
    await hubSkillsCol.updateOne(
      { hub_id: hub.id, skill_id: skill.id },
      {
        $set: {
          hub_id: hub.id,
          cache_generation: hub.cache_generation ?? null,
          skill_id: skill.id,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          metadata: skill.metadata,
          path: skill.path,
          cached_at: now,
          ...(packageChanged ? { scan_status: "unscanned", scan_summary: "Package changed; security scan pending" } : {}),
          ancillary_files: skill.ancillary_files ?? {},
          ancillary_summary:
            skill.ancillary_summary ?? {
              total_files: 0,
              total_bytes: 0,
              skipped_binary: 0,
              skipped_too_large: 0,
              truncated_at_count_cap: false,
              truncated_at_size_cap: false,
            },
        },
      },
      { upsert: true },
    );

    const isNew = !prior;
    const neverScanned = prior !== undefined && !prior.scan_status;
    if (isNew || packageChanged || neverScanned || prior?.scan_status === "unscanned") {
      refsToScan.push({
        hub_id: hub.id,
        skill_id: skill.id,
        name: skill.name,
        content: skill.content,
        // Forward ancillary files so the scanner sees the same surface
        // the agent runtime materializes into the StateBackend (see
        // `skills_middleware/backend_sync.py` and
        // `dynamic_agents/services/skills.py`). Otherwise scripts /
        // prompts shipped alongside SKILL.md would never be analyzed.
        ancillary_files: skill.ancillary_files,
      });
    }
  }

  // Remove stale skills that no longer exist in the repo
  const currentIds = crawled.map((s) => s.id);
  if (truncation.kind === "ok") {
    await hubSkillsCol.deleteMany({
      hub_id: hub.id,
      skill_id: { $nin: currentIds },
    });
  }

  // Fire-and-forget: run the scanner against the changed/new skills so
  // the per-skill scan_status catches up without blocking the crawl
  // response. Errors are swallowed inside the helper.
  if (refsToScan.length > 0) {
    void scanHubSkillsAsync(refsToScan).catch((err) => {
      console.warn(
        `[HubCrawl] Auto-scan dispatch failed for ${hub.id}:`,
        err,
      );
    });
  }

  const hubLabels = hub.labels || [];
  return crawled.map((s) => ({
    id: `hub-${hub.id}-${s.id}`,
    name: s.name,
    description: s.description,
    source: "hub" as const,
    source_id: hub.id,
    content: s.content,
    metadata: {
      ...s.metadata,
      hub_location: hub.location,
      hub_revision: hub.revision || null,
      hub_type: hub.type,
      path: s.path,
      tags: [...(Array.isArray(s.metadata?.tags) ? (s.metadata.tags as string[]) : []), ...hubLabels],
    },
    ancillary_files: s.ancillary_files,
    ancillary_summary: s.ancillary_summary,
  }));
}

/**
 * Fire-and-forget background refresh — crawl and update cache without
 * blocking the caller (stale-while-revalidate pattern).
 */
async function _refreshHubInBackground(
  hub: SkillHubDoc,
  hubSkillsCol: Awaited<ReturnType<typeof getCollection<HubSkillDoc>>>,
): Promise<void> {
  await _crawlAndCache(hub, hubSkillsCol);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docToCatalogSkill(hub: SkillHubDoc) {
  const hubLabels = hub.labels || [];
  return (doc: HubSkillDoc): CatalogSkill => ({
    id: `hub-${hub.id}-${doc.skill_id}`,
    name: doc.name,
    description: doc.description,
    source: "hub",
    source_id: hub.id,
    content: doc.content,
    metadata: {
      ...doc.metadata,
      hub_location: hub.location,
      hub_revision: hub.revision || null,
      hub_type: hub.type,
      path: doc.path,
      // Surface the hub composite identity to the UI so the override
      // resolver in SkillScanStatusIndicator can build the correct
      // /api/admin/skills/hub/<hubId>/<skillId>/scan-override URL
      // without having to re-parse the legacy ``catalog-hub-…`` id.
      // Existing readers (gallery row, scan dialog) ignore extra
      // metadata keys.
      hub_id: hub.id,
      hub_skill_id: doc.skill_id,
      tags: [...(Array.isArray(doc.metadata?.tags) ? (doc.metadata.tags as string[]) : []), ...hubLabels],
    },
    scan_status: doc.scan_status,
    scan_summary: doc.scan_summary,
    scan_updated_at: doc.scan_updated_at?.toISOString(),
    // Project the admin-override audit metadata so the report
    // dialog can render the audit panel + Remove-override button on
    // hub-projected rows. Always serialised through the catalog
    // even when undefined so the UI's optional-chained access
    // remains structurally identical between sources.
    scan_override: doc.scan_override,
    ancillary_files: doc.ancillary_files,
    ancillary_summary: doc.ancillary_summary,
  });
}
