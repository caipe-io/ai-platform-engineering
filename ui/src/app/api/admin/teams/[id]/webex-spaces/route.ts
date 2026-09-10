/**
 * Team-scoped Webex space assignment.
 *
 * GET  /api/admin/teams/[id]/webex-spaces
 * PUT  /api/admin/teams/[id]/webex-spaces
 *   body: { spaces: Array<{ webex_space_id, space_name, webex_workspace_id? }> }
 */

import {
ApiError,
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import { writeOpenFgaTupleDiff } from "@/lib/rbac/openfga";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { requireReservedTeamMutationPermission } from "@/lib/rbac/team-admin-guards";
import { webexSpaceSubjectId,webexWorkspaceRef } from "@/lib/rbac/webex-space-grant-store";
import type { Team } from "@/types/teams";
import { ObjectId } from "mongodb";
import { NextRequest,NextResponse } from "next/server";

interface WebexSpaceTeamMappingDoc {
  _id?: ObjectId;
  bot_id?: string;
  webex_space_id: string;
  team_id: string;
  team_slug?: string;
  space_name?: string;
  space_title?: string;
  webex_workspace_id?: string;
  active?: boolean;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

interface WebexSpaceInput {
  bot_id?: string;
  webex_space_id: string;
  space_name: string;
  webex_workspace_id?: string;
}

function teamSlug(team: Team, fallback: string): string {
  return typeof team.slug === "string" && team.slug.trim() ? team.slug.trim() : fallback;
}

async function reconcileWebexSpaceOwnership(
  slug: string,
  addedOrKept: WebexSpaceInput[],
  removed: WebexSpaceTeamMappingDoc[],
): Promise<void> {
  await writeOpenFgaTupleDiff({
    writes: addedOrKept.flatMap((space) => {
      const object = `webex_space:${webexSpaceSubjectId(space.webex_workspace_id ?? "", space.webex_space_id)}`;
      return [
        { user: `team:${slug}#member`, relation: "user", object },
        { user: `team:${slug}#admin`, relation: "manager", object },
      ];
    }),
    deletes: removed.flatMap((space) => {
      const object = `webex_space:${webexSpaceSubjectId(space.webex_workspace_id ?? "", space.webex_space_id)}`;
      return [
        { user: `team:${slug}#member`, relation: "user", object },
        { user: `team:${slug}#admin`, relation: "manager", object },
      ];
    }),
  });
}

function requireMongoDB() {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: "MongoDB not configured - team Webex space mappings require MongoDB",
        code: "MONGODB_NOT_CONFIGURED",
      },
      { status: 503 }
    );
  }
  return null;
}

function parseTeamId(id: string): ObjectId {
  if (!ObjectId.isValid(id)) {
    throw new ApiError("Invalid team ID format", 400);
  }
  return new ObjectId(id);
}

const WEBEX_SPACE_ID_RE = /^[a-zA-Z0-9_-]{8,}$/;

function parseSpaceInput(value: unknown, idx: number): WebexSpaceInput {
  if (!value || typeof value !== "object") {
    throw new ApiError(`spaces[${idx}] must be an object`, 400);
  }
  const v = value as Record<string, unknown>;

  const webexSpaceId = typeof v.webex_space_id === "string" ? v.webex_space_id.trim() : "";
  if (!webexSpaceId) {
    throw new ApiError(`spaces[${idx}].webex_space_id is required`, 400);
  }
  if (!WEBEX_SPACE_ID_RE.test(webexSpaceId)) {
    throw new ApiError(
      `spaces[${idx}].webex_space_id "${webexSpaceId}" doesn't look like a Webex space ID`,
      400
    );
  }

  const spaceName =
    typeof v.space_name === "string" && v.space_name.trim()
      ? v.space_name.trim()
      : typeof v.space_title === "string" && v.space_title.trim()
        ? v.space_title.trim()
        : webexSpaceId;

  const workspaceId =
    typeof v.webex_workspace_id === "string" && v.webex_workspace_id.trim()
      ? v.webex_workspace_id.trim()
      : undefined;

  const botId = typeof v.bot_id === "string" && v.bot_id.trim() ? v.bot_id.trim() : undefined;

  return {
    ...(botId ? { bot_id: botId } : {}),
    webex_space_id: webexSpaceId,
    space_name: spaceName,
    webex_workspace_id: webexWorkspaceRef(workspaceId),
  };
}

export const GET = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const mongoCheck = requireMongoDB();
    if (mongoCheck) return mongoCheck;

    const { user, session } = await getAuthFromBearerOrSession(request);

    const { id } = await context.params;
    const teamId = parseTeamId(id);
    const teamIdStr = id;

    const teamsCol = await getCollection<Team>("teams");
    const team = await teamsCol.findOne({ _id: teamId } as never);
    if (!team) throw new ApiError("Team not found", 404);
    await requireResourcePermission(session, { type: "team", id: teamSlug(team, teamIdStr), action: "read" }, { bypassForOrgAdmin: true });

    const teamCol = await getRbacCollection<WebexSpaceTeamMappingDoc>("webexSpaceTeamMappings");

    const teamMappings = await teamCol
      .find({ team_id: teamIdStr, active: { $ne: false } } as never)
      .sort({ space_name: 1, space_title: 1 })
      .toArray();

    const spaces = teamMappings.map((m) => ({
      bot_id: m.bot_id,
      webex_space_id: m.webex_space_id,
      space_name: m.space_name ?? m.space_title ?? m.webex_space_id,
      webex_workspace_id: webexWorkspaceRef(m.webex_workspace_id),
    }));

    console.log(
      `[Admin TeamWebexSpaces] GET team=${teamIdStr} spaces=${spaces.length} by=${user.email}`
    );

    return successResponse({
      team_id: teamIdStr,
      spaces,
    });
  }
);

interface PutBody {
  spaces?: unknown;
}

export const PUT = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const mongoCheck = requireMongoDB();
    if (mongoCheck) return mongoCheck;

    const { user, session } = await getAuthFromBearerOrSession(request);

    const { id } = await context.params;
    const teamId = parseTeamId(id);
    const teamIdStr = id;

    let body: PutBody;
    try {
      body = (await request.json()) as PutBody;
    } catch {
      throw new ApiError("Invalid JSON body", 400);
    }

    if (!Array.isArray(body.spaces)) {
      throw new ApiError("spaces must be an array", 400);
    }

    const inputs: WebexSpaceInput[] = body.spaces.map((s, i) => parseSpaceInput(s, i));

    const bySpace = new Map<string, WebexSpaceInput>();
    for (const s of inputs) bySpace.set(s.webex_space_id, s);
    const next = Array.from(bySpace.values());

    const teamsCol = await getCollection<Team>("teams");
    const team = await teamsCol.findOne({ _id: teamId } as never);
    if (!team) throw new ApiError("Team not found", 404);
    const ownerTeamSlug = teamSlug(team, teamIdStr);
    await requireReservedTeamMutationPermission(session, { slug: ownerTeamSlug });
    await requireResourcePermission(session, { type: "team", id: ownerTeamSlug, action: "manage" }, { bypassForOrgAdmin: true });

    const teamCol = await getRbacCollection<WebexSpaceTeamMappingDoc>("webexSpaceTeamMappings");

    const conflictingSpaceIds = next.map((s) => s.webex_space_id);
    if (conflictingSpaceIds.length > 0) {
      const conflicts = await teamCol
        .find({
          webex_space_id: { $in: conflictingSpaceIds },
          team_id: { $ne: teamIdStr },
          active: { $ne: false },
        } as never)
        .toArray();
      if (conflicts.length > 0) {
        const list = conflicts.map((c) => `${c.webex_space_id}→team ${c.team_id}`).join(", ");
        throw new ApiError(
          `Space(s) already mapped to a different team: ${list}. Remove them from that team first.`,
          409
        );
      }
    }

    const now = new Date();
    const nextSpaceIds = new Set(next.map((s) => s.webex_space_id));

    const previousMappings = await teamCol
      .find({ team_id: teamIdStr, active: { $ne: false } } as never)
      .toArray();
    const removedSpaceIds = previousMappings
      .filter((m) => !nextSpaceIds.has(m.webex_space_id))
      .map((m) => m.webex_space_id);
    const removedMappings = previousMappings.filter((m) => !nextSpaceIds.has(m.webex_space_id));

    if (removedSpaceIds.length > 0) {
      await teamCol.updateMany(
        { webex_space_id: { $in: removedSpaceIds }, team_id: teamIdStr } as never,
        { $set: { active: false, updated_at: now } }
      );
    }

    const previousBotIdBySpace = new Map(
      previousMappings.map((m) => [m.webex_space_id, m.bot_id] as const)
    );

    for (const s of next) {
      // bot_id scopes the OpenFGA/runtime lookup (space_team_resolver.py) to a
      // specific Webex bot. Fall back to whatever the existing mapping already
      // has so re-saving unrelated changes (e.g. removing another space) doesn't
      // require re-supplying it. A brand-new mapping has nothing to fall back to
      // and must be rejected rather than silently written unresolvable.
      const botId = s.bot_id ?? previousBotIdBySpace.get(s.webex_space_id);
      if (!botId) {
        throw new ApiError(
          `spaces[].bot_id is required to assign Webex space "${s.webex_space_id}" to a team`,
          400
        );
      }
      await teamCol.updateOne(
        { webex_space_id: s.webex_space_id, team_id: teamIdStr } as never,
        {
          $set: {
            bot_id: botId,
            webex_space_id: s.webex_space_id,
            team_id: teamIdStr,
            team_slug: ownerTeamSlug,
            space_name: s.space_name,
            webex_workspace_id: webexWorkspaceRef(s.webex_workspace_id),
            active: true,
            updated_at: now,
          },
          $setOnInsert: {
            created_by: user.email,
            created_at: now,
          },
        },
        { upsert: true }
      );
    }

    await teamsCol.updateOne(
      { _id: teamId } as never,
      {
        $set: {
          webex_spaces: next.map((s) => ({
            space_id: s.webex_space_id,
            space_name: s.space_name,
            workspace_id: webexWorkspaceRef(s.webex_workspace_id),
          })),
          updated_at: now,
        },
      }
    );

    await reconcileWebexSpaceOwnership(ownerTeamSlug, next, removedMappings);

    console.log(
      `[Admin TeamWebexSpaces] PUT team=${teamIdStr} spaces=${next.length} removed=${removedSpaceIds.length} by=${user.email}`
    );

    return successResponse({
      team_id: teamIdStr,
      spaces: next,
      removed_space_ids: removedSpaceIds,
    });
  }
);
