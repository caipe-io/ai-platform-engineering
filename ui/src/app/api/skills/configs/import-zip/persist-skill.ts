import type { Collection } from "mongodb";
import { ApiError } from "@/lib/api-middleware";
import type { AgentSkill } from "@/types/agent-skill";

export async function persistImportedSkill(
  collection: Collection<AgentSkill>,
  skill: AgentSkill,
  mode: "create" | "overwrite",
): Promise<{ rollback: () => Promise<void> }> {
  const mongoRow = { ...skill };
  delete mongoRow.shared_with_teams;
  const filter = { id: skill.id, config_driven: { $ne: true } };
  if (mode === "create") {
    await collection.insertOne(mongoRow);
    return { rollback: async () => { await collection.deleteOne(filter); } };
  }
  const previous = await collection.findOne({ id: skill.id });
  const result = await collection.updateOne(
    filter,
    { $set: mongoRow, $unset: { shared_with_teams: "" } },
  );
  if (!result.matchedCount) throw new ApiError("Skill changed during the request. Reload and retry.", 409);
  return {
    rollback: async () => {
      if (previous) await collection.replaceOne(filter, previous);
    },
  };
}
