import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";

/** Serialize cross-service agent publication, including relationship changes. */
export async function withAgentMutationLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  const locks = await getCollection<{ _id: string; token: string }>("agent_mutation_locks");
  const token = randomUUID();
  try { await locks.insertOne({ _id: agentId, token }); }
  catch (error) {
    if ((error as { code?: number }).code === 11000) throw new ApiError("Another agent save is in progress", 409);
    throw error;
  }
  try { return await operation(); }
  finally { await locks.deleteOne({ _id: agentId, token }); }
}
