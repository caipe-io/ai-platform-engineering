import { ApiError } from "./api-error";

export type GitHubHubOptions = { revision?: string; entry_paths?: string[] };

export function githubHubOptions(body: Record<string, unknown>): GitHubHubOptions {
  const result: GitHubHubOptions = {};
  if (body.revision !== undefined && body.revision !== null && body.revision !== "") {
    if (typeof body.revision !== "string" || !/^[a-f0-9]{40}$/.test(body.revision)) throw new ApiError("GitHub revision must be a full commit SHA", 400);
    result.revision = body.revision;
  }
  if (body.entry_paths !== undefined && body.entry_paths !== null) {
    if (!Array.isArray(body.entry_paths) || body.entry_paths.length > 100 || body.entry_paths.some(p =>
      typeof p !== "string" || !p.includes("/") || !p.endsWith(".md") || p.startsWith("/") || p.includes("\\") ||
      p.split("/").some((part: string) => ["", ".", ".."].includes(part)))) throw new ApiError("Entry paths must be relative Markdown file paths", 400);
    result.entry_paths = [...new Set(body.entry_paths as string[])];
  }
  return result;
}
