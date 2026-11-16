import { parseReleaseNotesRepository } from "@/lib/release-notes-ref";

// Server-only deployment policy. Do not read this from browser input or MongoDB.
const DEFAULT_REPOSITORY = "https://github.com/caipe-io/ai-platform-engineering";

function canonicalRepository(value: string): string | null {
  const parsed = parseReleaseNotesRepository(value.trim());
  return parsed ? `https://github.com/${parsed.owner}/${parsed.repository}`.toLowerCase() : null;
}

/** An explicit empty or malformed policy permits no comparison repositories. */
export function getReleaseNotesAllowedRepositories(): string[] {
  const configured = process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
  if (configured === undefined) return [DEFAULT_REPOSITORY];
  if (!configured.trim()) return [];
  const entries = configured.split(",");
  if (entries.length > 32) return [];
  const repositories = entries.map(canonicalRepository);
  if (repositories.some((repository) => repository === null)) return [];
  return [...new Set(repositories as string[])];
}

/** Resolve aliases such as case and .git, then require an exact approved repo. */
export function approvedReleaseNotesRepository(value: string): string | null {
  const repository = canonicalRepository(value);
  return repository && getReleaseNotesAllowedRepositories().includes(repository) ? repository : null;
}
