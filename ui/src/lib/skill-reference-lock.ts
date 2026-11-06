import { ApiError } from "@/lib/api-middleware";
import { withAgentMutationLock } from "@/lib/agent-mutation-lock";
import { getCollection } from "@/lib/mongodb";

/** Fence attachment and retirement of saved skill references across UI replicas. */
export function withSkillReferenceLock<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(ids.filter(id => id.startsWith("skill-") || id.startsWith("hub-")))].sort();
  const acquire = (index: number): Promise<T> => index === keys.length ? operation() :
    withAgentMutationLock(`skill-reference:${keys[index]}`, () => acquire(index + 1));
  return acquire(0);
}
export async function assertSavedSkillsExist(ids: readonly string[], pinnedIds: readonly string[] = []): Promise<void> {
  for (const id of new Set(ids)) {
    if (!id.startsWith("skill-") && !id.startsWith("hub-")) continue;
    const hub = /^hub-([a-f0-9]{24})-(.+)$/.exec(id);
    const row = hub
      ? await (await getCollection("hub_skills")).findOne({hub_id: hub[1], skill_id: hub[2]})
      : await (await getCollection("agent_skills")).findOne({id});
    if (!row) throw new ApiError(`Skill is unavailable; reload the catalog before saving: ${id}`, 409);
    if (pinnedIds.includes(id)) {
      const summary = row.ancillary_summary ?? {};
      if (row.scan_status !== "passed" || ["skipped_binary", "skipped_too_large", "truncated_at_count_cap", "truncated_at_size_cap"].some(key => summary[key])) {
        throw new ApiError(`Pinned skill package is unscanned or incomplete: ${id}`, 409);
      }
    }
    if (hub) {
      const source = await (await getCollection("skill_hubs")).findOne({id: hub[1]});
      if (!source || !source.enabled || (source.cache_generation && source.cache_generation !== row.cache_generation)) {
        throw new ApiError(`Skill Hub configuration changed; refresh before saving: ${id}`, 409);
      }
    }
  }
}
