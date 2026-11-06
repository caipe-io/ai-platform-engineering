import { ApiError } from "./api-middleware";

export type SkillPackagePins = Record<string, { content_sha256: string; ancillary_sha256: Record<string, string> }>;

export function normalizeSkillPackagePins(value: unknown, skills: string[]): SkillPackagePins {
  if (!Array.isArray(skills) || skills.some(id => typeof id !== "string")) throw new ApiError("Invalid attached skill IDs", 400);
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Invalid skill package pins", 400);
  const result: SkillPackagePins = {};
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  for (const [id, raw] of Object.entries(value)) {
    if (!skills.includes(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("Pins must refer to attached skills", 400);
    const pin = raw as Record<string, unknown>;
    const files = pin.ancillary_sha256;
    if (!hash(pin.content_sha256) || !files || typeof files !== "object" || Array.isArray(files)) throw new ApiError("Invalid skill package hashes", 400);
    const entries = Object.entries(files);
    if (entries.some(([path, digest]) => !path || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some(p => ["", ".", ".."].includes(p)) || path === "SKILL.md" || !hash(digest))) throw new ApiError("Invalid ancillary package hash", 400);
    result[id] = { content_sha256: pin.content_sha256, ancillary_sha256: Object.fromEntries(entries) };
  }
  return result;
}
