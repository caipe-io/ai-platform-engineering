import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";

/** Serialize cross-service agent publication, including relationship changes. */
export async function withAgentMutationLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  return withResourceMutationLock("agent_mutation_locks", agentId, "Another agent save is in progress", operation);
}

/** Use Mongo's unique primary key to exclude mutations across UI replicas. */
export async function withResourceMutationLock<T>(
  collection: string,
  resourceId: string,
  conflictMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = await getCollection<{ _id: string; token: string }>(collection);
  const token = randomUUID();
  try { await locks.insertOne({ _id: resourceId, token }); }
  catch (error) {
    if ((error as { code?: number }).code === 11000) throw new ApiError(conflictMessage, 409);
    throw error;
  }
  try { return await operation(); }
  finally { await locks.deleteOne({ _id: resourceId, token }); }
}
