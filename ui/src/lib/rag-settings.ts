import { getCollection } from "@/lib/mongodb";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";

export const RAG_TEAM_SLUG_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

interface RagPlatformConfigDocument {
  _id: string;
  rag_default_search_team_slug?: unknown;
}

export function normalizeRagDefaultSearchTeamSlug(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && RAG_TEAM_SLUG_PATTERN.test(normalized) ? normalized : null;
}

/** Return the team preselected for new-source search access, if configured. */
export async function getRagDefaultSearchTeamSlug(): Promise<string | null> {
  const collection = await getCollection<RagPlatformConfigDocument>("platform_config");
  const config = await collection.findOne({ _id: PLATFORM_CONFIG_ID } as never);
  return normalizeRagDefaultSearchTeamSlug(config?.rag_default_search_team_slug);
}
