import type { Document } from "mongodb";

import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import {
  deleteExactOpenFgaTuples,
  readOpenFgaTuples,
  type OpenFgaTupleKey,
} from "@/lib/rbac/openfga";
import {
  deleteWebexSpaceGrants,
  webexSpaceSubjectId,
  webexWorkspaceRef,
} from "@/lib/rbac/webex-space-grant-store";
import { deleteWebexSpaceAgentRoutes } from "@/lib/rbac/webex-space-route-store";
import { webexBotInstallationUser } from "@/lib/rbac/webex-bot-openfga";

interface WebexSpaceTeamMappingDoc extends Document {
  bot_id?: string;
  webex_workspace_id?: string;
  webex_space_id: string;
}

export const WEBEX_SPACE_USABLE_OBJECT_TYPES = [
  "agent",
  "mcp_server",
  "tool",
  "knowledge_base",
  "rag_collection",
  "data_source",
  "mcp_tool",
  "document",
  "skill",
  "task",
] as const;

async function readAllTuples(filter: Partial<OpenFgaTupleKey>): Promise<OpenFgaTupleKey[]> {
  const keys: OpenFgaTupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await readOpenFgaTuples({
      tuple: filter,
      pageSize: 100,
      ...(continuationToken ? { continuationToken } : {}),
    });
    for (const tuple of result.tuples) keys.push(tuple.key);
    continuationToken = result.continuationToken;
  } while (continuationToken);
  return keys;
}

async function listSpaceTuples(workspaceId: string, spaceId: string): Promise<OpenFgaTupleKey[]> {
  const spaceRef = `webex_space:${webexSpaceSubjectId(workspaceId, spaceId)}`;
  const reads = await Promise.all([
    readAllTuples({ object: spaceRef }),
    ...WEBEX_SPACE_USABLE_OBJECT_TYPES.map((type) =>
      readAllTuples({ object: `${type}:`, user: spaceRef }),
    ),
  ]);
  const seen = new Set<string>();
  return reads.flat().filter((key) => {
    const identity = `${key.user}\n${key.relation}\n${key.object}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function listBotInstallationTuples(
  botId: string,
  workspaceId: string,
  spaceId: string,
): Promise<OpenFgaTupleKey[]> {
  const installation = webexBotInstallationUser(botId, workspaceId, spaceId);
  const reads = await Promise.all([
    readAllTuples({ object: installation }),
    readAllTuples({ object: "agent:", user: installation }),
  ]);
  return reads.flat();
}

export async function deleteWebexSpaceState(input: {
  workspaceId: string;
  spaceId: string;
  botId?: string;
  mappingId?: unknown;
  requireOpenFga?: boolean;
}) {
  const workspaceId = webexWorkspaceRef(input.workspaceId);
  const mappings = await getRbacCollection<WebexSpaceTeamMappingDoc>("webexSpaceTeamMappings");
  const mappingFilter = input.mappingId !== undefined
    ? { _id: input.mappingId }
    : {
        webex_workspace_id: workspaceId,
        webex_space_id: input.spaceId,
        ...(input.botId ? { bot_id: input.botId } : {}),
      };
  const [ownerCount, selectedOwnerCount] = input.botId
    ? await Promise.all([
      mappings.countDocuments({
        webex_workspace_id: workspaceId,
        webex_space_id: input.spaceId,
        active: { $ne: false },
      } as never),
      mappings.countDocuments(mappingFilter as never),
    ])
    : [1, 1];
  const remainingOwners = Math.max(0, ownerCount - selectedOwnerCount);

  let openfgaDeleted = 0;
  if (input.botId) {
    try {
      const result = await deleteExactOpenFgaTuples(
        await listBotInstallationTuples(input.botId, workspaceId, input.spaceId),
      );
      if (!result.enabled && input.requireOpenFga) {
        throw new Error("OpenFGA is not configured");
      }
      openfgaDeleted += result.deletes;
    } catch (error) {
      if (input.requireOpenFga) throw error;
      console.warn("[Webex bot ownership cleanup] OpenFGA cleanup failed", error);
    }
  }
  if (remainingOwners === 0) {
    try {
      const result = await deleteExactOpenFgaTuples(
        await listSpaceTuples(workspaceId, input.spaceId),
      );
      if (!result.enabled && input.requireOpenFga) {
        throw new Error("OpenFGA is not configured");
      }
      openfgaDeleted += result.deletes;
    } catch (error) {
      if (input.requireOpenFga) throw error;
      console.warn("[Webex ownership cleanup] OpenFGA cleanup failed", error);
    }
  }

  const mappingResult = await mappings.deleteMany(mappingFilter as never);
  const routesDeleted = await deleteWebexSpaceAgentRoutes(workspaceId, input.spaceId, input.botId);
  const grantsDeleted = remainingOwners === 0
    ? await deleteWebexSpaceGrants(workspaceId, input.spaceId)
    : 0;
  return {
    openfga_tuples: openfgaDeleted,
    routes: routesDeleted,
    grants: grantsDeleted,
    team_mappings: mappingResult.deletedCount ?? 0,
  };
}
