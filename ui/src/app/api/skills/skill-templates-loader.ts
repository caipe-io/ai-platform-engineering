/**
 * Shared loader for filesystem skill templates.
 *
 * Extracted from /api/skill-templates so both /api/skill-templates and
 * /api/skills can reuse the same loading + caching logic.
 */

import fs from "fs";
import path from "path";

export interface SkillInputVariable {
  name: string;
  label: string;
  required: boolean;
  placeholder?: string;
}

export interface SkillTemplateData {
  id: string;
  name: string;
  description: string;
  title: string;
  category: string;
  icon: string;
  tags: string[];
  content: string;
  input_variables?: SkillInputVariable[];
}

function resolveSkillsDir(): string {
  if (process.env.SKILLS_DIR) {
    return process.env.SKILLS_DIR;
  }

  const chartPath = path.resolve(
    process.cwd(),
    "..",
    "charts",
    "ai-platform-engineering",
    "data",
    "skills",
  );
  if (fs.existsSync(chartPath)) {
    return chartPath;
  }

  const localPath = path.resolve(process.cwd(), "data", "skills");
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  return chartPath;
}

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
        // Store previous key
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
    // Store last key
    if (currentKey === "name") name = currentValue.trim();
    if (currentKey === "description") description = currentValue.trim();
  }
  return { name, description };
}

interface SkillMetadata {
  title?: string;
  category?: string;
  icon?: string;
  tags?: string[];
  input_variables?: SkillInputVariable[];
}

function parseMetadata(raw: string): SkillMetadata {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function buildTemplate(
  id: string,
  content: string,
  metadata: SkillMetadata,
): SkillTemplateData {
  const fm = parseFrontmatter(content);
  const tpl: SkillTemplateData = {
    id: fm.name || id,
    name: fm.name || id,
    description: fm.description,
    title: metadata.title || fm.name || id,
    category: metadata.category || "Custom",
    icon: metadata.icon || "Zap",
    tags: metadata.tags || [],
    content,
  };
  if (metadata.input_variables && metadata.input_variables.length > 0) {
    tpl.input_variables = metadata.input_variables;
  }
  return tpl;
}

/**
 * Walk a packaged skill's directory and collect every sibling file other
 * than `SKILL.md` / `metadata.json` into a `{ rel_path: utf8_content }` map
 * — the same shape `scanSkillContent({ ancillaryFiles })` expects. This is
 * the on-disk equivalent of `agent_skills.ancillary_files` for built-ins,
 * and lets the bulk scanner analyze referenced shell scripts / prompt
 * snippets the way the agent runtime materializes them at
 * `/skills/<source>/<name>/<rel_path>`.
 *
 * Cap (`SKILL_TEMPLATES_ANCILLARY_BYTE_CAP`, default 4 MiB) and binary
 * detection are intentionally generous; the scanner side enforces its own
 * stricter cap before upload (see `ANCILLARY_BYTE_CAP` in `skill-scan.ts`).
 *
 * Folder layout only — the flat layout has no "directory" to walk.
 */
const ANCILLARY_BYTE_CAP_DEFAULT = 4 * 1024 * 1024;
const ANCILLARY_FILE_LIMIT = 200;

function isLikelyTextFile(buf: Buffer): boolean {
  // Heuristic: any NUL in the first 8 KiB → treat as binary and skip.
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  return !slice.includes(0);
}

export function loadTemplateAncillaryFiles(
  templateDir: string,
): Record<string, string> {
  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    return {};
  }

  const cap = (() => {
    const raw = process.env.SKILL_TEMPLATES_ANCILLARY_BYTE_CAP;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : ANCILLARY_BYTE_CAP_DEFAULT;
  })();

  const out: Record<string, string> = {};
  let totalBytes = 0;
  let fileCount = 0;

  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount >= ANCILLARY_FILE_LIMIT) return;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      // Skip the canonical files — SKILL.md is uploaded separately and
      // metadata.json is UI-only (no value to the static analyzer).
      if (relPath === "SKILL.md" || relPath === "metadata.json") continue;
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        continue;
      }
      if (!isLikelyTextFile(buf)) continue;
      if (totalBytes + buf.length > cap) {
        // Surface the overflow path so callers can include it in
        // scan_summary if they want to be loud about it.
        continue;
      }
      out[relPath] = buf.toString("utf-8");
      totalBytes += buf.length;
      fileCount += 1;
    }
  };

  walk(templateDir, "");
  return out;
}

/**
 * Resolve the on-disk directory for a packaged template by id (folder
 * layout). Returns `null` if not found or if the loader is in flat-file
 * mode. Used by `/api/skill-templates/[id]/scan` to find ancillary files
 * without re-iterating the entire catalog.
 */
export function resolveTemplateDir(id: string): string | null {
  const skillsDir = resolveSkillsDir();
  if (!fs.existsSync(skillsDir)) return null;
  const direct = path.join(skillsDir, id);
  if (
    fs.existsSync(direct) &&
    fs.statSync(direct).isDirectory() &&
    fs.existsSync(path.join(direct, "SKILL.md"))
  ) {
    return direct;
  }
  // Fall back: the loader's id is `frontmatter.name || dirname`, so the
  // dir name may differ from the template id. Scan one level deep.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    try {
      const content = fs.readFileSync(skillMd, "utf-8");
      const fmName = parseFrontmatter(content).name?.trim();
      if (fmName === id || entry.name === id) {
        return path.join(skillsDir, entry.name);
      }
    } catch {
      continue;
    }
  }
  return null;
}

function loadFromFolderLayout(skillsDir: string): SkillTemplateData[] {
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const templates: SkillTemplateData[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const metadataPath = path.join(skillsDir, entry.name, "metadata.json");
      const metadata = fs.existsSync(metadataPath)
        ? parseMetadata(fs.readFileSync(metadataPath, "utf-8"))
        : {};

      templates.push(buildTemplate(entry.name, content, metadata));
    } catch (err) {
      console.error(`[SkillTemplates] Error loading ${entry.name}:`, err);
    }
  }

  return templates;
}

function loadFromFlatLayout(skillsDir: string): SkillTemplateData[] {
  const files = fs.readdirSync(skillsDir);
  const skillFiles = files.filter((f) => f.endsWith("--SKILL.md"));
  const templates: SkillTemplateData[] = [];

  for (const skillFile of skillFiles) {
    const id = skillFile.replace("--SKILL.md", "");
    try {
      const content = fs.readFileSync(
        path.join(skillsDir, skillFile),
        "utf-8",
      );
      const metaFile = `${id}--metadata.json`;
      const metadata = files.includes(metaFile)
        ? parseMetadata(
            fs.readFileSync(path.join(skillsDir, metaFile), "utf-8"),
          )
        : {};

      templates.push(buildTemplate(id, content, metadata));
    } catch (err) {
      console.error(`[SkillTemplates] Error loading flat skill ${id}:`, err);
    }
  }

  return templates;
}

let cachedTemplates: SkillTemplateData[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Load skill templates from the filesystem (cached, 30s TTL).
 */
export function loadSkillTemplatesInternal(): SkillTemplateData[] {
  const now = Date.now();
  if (cachedTemplates && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedTemplates;
  }

  const skillsDir = resolveSkillsDir();
  if (!fs.existsSync(skillsDir)) {
    console.warn(`[SkillTemplates] Skills directory not found: ${skillsDir}`);
    return [];
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const hasSubdirs = entries.some((e) => e.isDirectory());
  const hasFlatFiles = entries.some(
    (e) => e.isFile() && e.name.endsWith("--SKILL.md"),
  );

  let templates: SkillTemplateData[];

  if (hasSubdirs) {
    templates = loadFromFolderLayout(skillsDir);
  } else if (hasFlatFiles) {
    templates = loadFromFlatLayout(skillsDir);
  } else {
    templates = [];
  }

  for (const id of ["live-skills", "update-skills"]) {
    const instructionPath = path.join(skillsDir, `${id}.md`);
    if (!templates.some((skill) => skill.id === id) && fs.existsSync(instructionPath)) {
      const template = buildTemplate(id, fs.readFileSync(instructionPath, "utf-8"), {
        title: id === "live-skills" ? "Live Skills" : "Update Skills",
        category: "General", tags: ["catalog"],
      });
      template.description = "Coding agent catalog integration";
      templates.push(template);
    }
  }

  templates.sort((a, b) => a.title.localeCompare(b.title));

  cachedTemplates = templates;
  cacheTimestamp = now;

  return templates;
}
