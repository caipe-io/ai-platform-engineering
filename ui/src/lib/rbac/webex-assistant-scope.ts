import { ApiError } from "@/lib/api-error";
import { getRbacCollection } from "./mongo-collections";
import { webexWorkspaceRef } from "./webex-space-grant-store";

/** Resolve group scope from the bot-specific deployment mapping, never message fields. */
export async function resolveWebexAssistantTeam(botId: string, spaceId: string): Promise<{
  workspaceId: string;
  teamSlug: string;
}> {
  const workspaceId = webexWorkspaceRef();
  const mappings = await getRbacCollection("webexSpaceTeamMappings");
  const mapping = await mappings.findOne({
    bot_id: botId, webex_workspace_id: workspaceId, webex_space_id: spaceId,
    active: { $ne: false },
  });
  const teamSlug = mapping?.team_slug;
  if (typeof teamSlug !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(teamSlug)) {
    throw new ApiError("This bot and Webex space need an active team mapping", 403);
  }
  return { workspaceId, teamSlug };
}
