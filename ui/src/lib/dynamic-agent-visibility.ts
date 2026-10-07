import { getCollection } from "@/lib/mongodb";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";

const COLLECTION_NAME = "dynamic_agents";

/**
 * Resolve the current `visibility` of the given agent ids in a single indexed
 * `$in` query. Agents not present in the collection are omitted from the map
 * (caller treats a missing entry as "not global").
 *
 * Shared by the Unlinked Access resolver and the SA scope snapshot rebuild so
 * both agree on which grants are owned by an agent's Everyone-share (global)
 * rather than by an explicit admin scope.
 */
export async function findAgentVisibilities(
  agentIds: string[],
): Promise<Map<string, DynamicAgentConfig["visibility"]>> {
  const result = new Map<string, DynamicAgentConfig["visibility"]>();
  if (agentIds.length === 0) return result;

  const collection = await getCollection<DynamicAgentConfig>(COLLECTION_NAME);
  const docs = await collection
    .find({ _id: { $in: agentIds } }, { projection: { _id: 1, visibility: 1 } })
    .toArray();

  for (const doc of docs) {
    result.set(doc._id, doc.visibility);
  }
  return result;
}
