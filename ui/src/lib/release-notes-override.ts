import { trimReleaseMarkdown } from "@/lib/release-notes-markdown";
import { isValidReleaseNotesRef } from "@/lib/release-notes-ref";

export const MAX_RELEASE_NOTES_LENGTH = 128 * 1024;
export interface ReleaseNotesOverride {
  source: "automatic" | "manual" | "repository";
  release_version: string;
  markdown: string;
  markdown_repository: string;
  markdown_ref: string;
  markdown_path: string;
  changelog_url: string;
}

export function normalizeReleaseNotesOverride(value: unknown): ReleaseNotesOverride {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const string = (key: string) => typeof input[key] === "string" ? (input[key] as string).trim() : "";
  return {
    source: input.source === "manual" || input.source === "repository" ? input.source : "automatic",
    release_version: string("release_version").replace(/^v/i, ""),
    markdown: typeof input.markdown === "string" ? trimReleaseMarkdown(input.markdown) : "",
    markdown_repository: string("markdown_repository"),
    markdown_ref: string("markdown_ref"),
    markdown_path: string("markdown_path"),
    changelog_url: string("changelog_url"),
  };
}

export function validReleaseMarkdownPath(value: string): boolean {
  return value.length <= 1024 && /\.mdx?$/i.test(value) &&
    !/[\x00-\x20\x7f\\%?#:]/.test(value) &&
    value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

export function validateReleaseNotesOverride(config: ReleaseNotesOverride): string | null {
  if (new TextEncoder().encode(config.markdown).byteLength > MAX_RELEASE_NOTES_LENGTH) return "Release notes must be at most 128 KiB of text.";
  if (config.source === "automatic") return null;
  if (!config.release_version || config.release_version.length > 200 || /\s/.test(config.release_version)) {
    return "Set the deployed release version for these notes.";
  }
  if (config.source === "manual") {
    if (!config.markdown.trim()) return "Enter curated release notes before selecting manual notes.";
    if (config.changelog_url) {
      try {
        const url = new URL(config.changelog_url);
        if (url.protocol !== "https:" || url.username || url.password) return "Use an HTTPS changelog URL without credentials.";
      } catch { return "Enter a valid HTTPS changelog URL."; }
    }
  } else if (!isValidReleaseNotesRef(config.markdown_ref) || !validReleaseMarkdownPath(config.markdown_path)) {
    return "Set a valid Git ref and repository-relative .md or .mdx path.";
  }
  return null;
}

export function hasReleaseNotesOverride(config: { override?: ReleaseNotesOverride | null } | null | undefined, version: string): boolean {
  return Boolean(config?.override && config.override.source !== "automatic" &&
    config.override.release_version === version.replace(/^v/i, ""));
}
