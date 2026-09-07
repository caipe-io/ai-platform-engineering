import { ObjectId } from "mongodb";
import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import { writeOpenFgaTuples } from "@/lib/rbac/openfga";
import { buildUniversalRebacTupleDiff } from "@/lib/rbac/tuple-builders";
import { parseWebexSpaceRouteParams } from "@/lib/rbac/webex-space-openfga";
import { webexSpaceTeamVisibilityRelationships } from "@/lib/rbac/webex-space-rebac";
import type { Team } from "@/types/teams";
import { requireAvailableWebexBotPolicy } from "@/lib/webex-bot-policy";

import { withWebexSpaceRebacManageAuth } from "../../../_lib";

interface RouteContext {
  params: Promise<{ workspaceId: string; spaceId: string }>;
}

interface WebexSpaceTeamMappingDoc {
  bot_id: string;
  webex_workspace_id?: string;
  webex_space_id: string;
  space_name?: string;
  space_title?: string;
  team_id?: string;
  team_slug?: string;
  active?: boolean;
}

function teamSlugOf(team: Team, fallback: string): string {
  return typeof team.slug === "string" && team.slug.trim() ? team.slug.trim() : fallback;
}

export const PUT = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const raw = await context.params;
  const { workspaceId, spaceId } = parseWebexSpaceRouteParams(raw.workspaceId, raw.spaceId);

  return withWebexSpaceRebacManageAuth(request, async () => {
    const { session } = await getAuthFromBearerOrSession(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const teamSlugInput = typeof body.team_slug === "string" ? body.team_slug.trim() : "";
    if (!teamSlugInput) throw new ApiError("team_slug is required", 400);

    const mappings = await getRbacCollection<WebexSpaceTeamMappingDoc>("webexSpaceTeamMappings");
    const existing = await mappings.findOne({
      webex_workspace_id: workspaceId,
      webex_space_id: spaceId,
      active: { $ne: false },
    } as never);

    // bot_id scopes the OpenFGA/runtime lookup (space_team_resolver.py) to a
    // specific Webex bot. Fall back to whatever the existing mapping already
    // has so re-assigning an already-configured space doesn't require
    // re-supplying it; a brand-new mapping has nothing to fall back to.
    const requestedBotId = request.nextUrl.searchParams.get("bot_id")?.trim();
    const botId = (
      await requireAvailableWebexBotPolicy(requestedBotId || existing?.bot_id || null)
    ).id;

    const teams = await getCollection<Team>("teams");
    const team = await teams.findOne({ slug: teamSlugInput } as never);
    if (!team) throw new ApiError(`Team ${teamSlugInput} was not found`, 404);
    const resolvedTeamSlug = teamSlugOf(team, teamSlugInput);
    const teamId = String(team._id ?? "");

    const spaceName = typeof body.space_name === "string" && body.space_name.trim()
      ? body.space_name.trim()
      : existing?.space_name ?? existing?.space_title ?? spaceId;

    // Mappings written by the bulk team-Webex-spaces route only store
    // team_id, not team_slug. Fall back to resolving the previous team's
    // slug by id so a stale OpenFGA grant still gets revoked on reassignment.
    let previousTeamSlug = existing?.team_slug;
    if (!previousTeamSlug && existing?.team_id && existing.team_id !== teamId) {
      const oldTeamFilter = ObjectId.isValid(existing.team_id)
        ? { _id: new ObjectId(existing.team_id) }
        : { _id: existing.team_id };
      const oldTeam = await teams.findOne(oldTeamFilter as never);
      if (oldTeam) previousTeamSlug = teamSlugOf(oldTeam, existing.team_id);
    }

    const writes = webexSpaceTeamVisibilityRelationships(workspaceId, spaceId, resolvedTeamSlug);
    const deletes = previousTeamSlug && previousTeamSlug !== resolvedTeamSlug
      ? webexSpaceTeamVisibilityRelationships(workspaceId, spaceId, previousTeamSlug)
      : [];
    const openfga = await writeOpenFgaTuples(buildUniversalRebacTupleDiff({ writes, deletes }));
    if (!openfga.enabled) throw new ApiError("OpenFGA is not configured", 502);

    const now = new Date();

    // Reassigning to a different bot must not leave the space with two
    // active mappings: the upsert below is keyed on the new bot_id, so a
    // mapping under the old bot_id would otherwise survive untouched.
    if (existing?.bot_id && existing.bot_id !== botId) {
      await mappings.updateOne(
        {
          bot_id: existing.bot_id,
          webex_workspace_id: workspaceId,
          webex_space_id: spaceId,
        } as never,
        { $set: { active: false, updated_at: now } } as never,
      );
    }

    await mappings.updateOne(
      {
        bot_id: botId,
        webex_workspace_id: workspaceId,
        webex_space_id: spaceId,
      } as never,
      {
        $set: {
          bot_id: botId,
          webex_workspace_id: workspaceId,
          webex_space_id: spaceId,
          space_name: spaceName,
          space_title: spaceName,
          team_id: teamId,
          team_slug: resolvedTeamSlug,
          active: true,
          updated_at: now,
          updated_by: session?.user?.email ?? "api",
        },
        $setOnInsert: {
          created_at: now,
          created_by: session?.user?.email ?? "api",
        },
      } as never,
      { upsert: true },
    );

    return successResponse({
      workspace_id: workspaceId,
      space_id: spaceId,
      bot_id: botId,
      team_id: teamId,
      team_slug: resolvedTeamSlug,
    });
  }, { workspaceId, spaceId });
});
