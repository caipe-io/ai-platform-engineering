import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { callWebexBotAdmin } from "@/lib/webex-bot-admin";
import { getDiscoveryCacheTtlMs } from "@/lib/rbac/discovery-cache-config";
import {
  activeConnectorPublicationRequestsByItemId,
  connectorPublicationRequestView,
  publicationActorFromSession,
} from "@/lib/publication-approval.server";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";

interface WebexBotOption {
  id: string;
  name: string;
  available: boolean;
}

interface NormalizedSpace {
  id: string;
  webex_room_id?: string;
  name: string;
  type: string;
  is_locked: boolean;
  available_bot_ids?: string[];
}

interface RuntimeSpacesResponse {
  spaces: NormalizedSpace[];
  total_matches: number;
  total_visible: number;
  next_cursor: string | null;
  has_more: boolean;
  cached: boolean;
  fetched_at: number;
  bot: WebexBotOption;
}

const DEFAULT_UI_LIMIT = 200;
const MAX_UI_LIMIT = 500;

function applyCursor(spaces: NormalizedSpace[], cursor: string | undefined): NormalizedSpace[] {
  if (!cursor) return spaces;
  const normalized = cursor.toLocaleLowerCase();
  return spaces.filter((space) => space.name.toLocaleLowerCase() > normalized);
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireResourcePermission(
    session,
    { type: "admin_surface", id: "webex", action: "read" },
    { bypassForOrgAdmin: true },
  );

  const params = request.nextUrl.searchParams;
  const requestedBotId = params.get("bot_id")?.trim();
  const catalog = await callWebexBotAdmin<{ bots: WebexBotOption[] }>("/admin/webex/bots");
  const availableBots = (catalog.bots ?? []).filter((bot) => bot.available);
  const bots = requestedBotId
    ? availableBots.filter((bot) => bot.id === requestedBotId)
    : availableBots;
  if (requestedBotId && bots.length === 0) {
    throw new ApiError(`Unknown or unavailable Webex bot: ${requestedBotId}`, 400);
  }
  if (bots.length === 0) throw new ApiError("No configured Webex bot is available", 503);

  const refresh = params.get("refresh") === "1";
  const query = (params.get("q") ?? "").trim();
  const cursor = params.get("cursor") ?? undefined;
  const parsedLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_UI_LIMIT)
    : DEFAULT_UI_LIMIT;
  const cacheTtlSeconds = Math.floor(
    (await getDiscoveryCacheTtlMs("webex")) / 1000,
  );

  const snapshots = await Promise.all(
    bots.map((bot) => callWebexBotAdmin<RuntimeSpacesResponse>(
      `/admin/webex/bots/${bot.id}/spaces`,
      {
        query: {
          refresh: refresh ? 1 : 0,
          cache_ttl_seconds: cacheTtlSeconds,
          q: query || undefined,
          cursor: bots.length === 1 ? cursor : undefined,
          limit: bots.length === 1 ? limit : MAX_UI_LIMIT,
        },
      },
    )),
  );

  const actor = publicationActorFromSession(session);
  const annotatePending = async (spaces: NormalizedSpace[]) => {
    const pendingById = await activeConnectorPublicationRequestsByItemId(
      "webex_space",
      spaces.map((space) => space.id),
    );
    return spaces.map((space) => {
      const pending = pendingById.get(space.id);
      return pending
        ? { ...space, pending_publication: connectorPublicationRequestView(pending, actor) }
        : space;
    });
  };

  if (snapshots.length === 1) {
    const snapshot = snapshots[0];
    console.log(
      `[Admin WebexSpaces] discovery ok bot=${bots[0].id} total=${snapshot.total_visible} returned=${snapshot.spaces.length} by=${user.email}`,
    );
    return successResponse({
      ...snapshot,
      spaces: await annotatePending(snapshot.spaces.map((space) => ({
        ...space,
        available_bot_ids: [bots[0].id],
      }))),
      bots: bots.map(({ id, name }) => ({ id, name })),
    });
  }

  const merged = new Map<string, NormalizedSpace>();
  for (let index = 0; index < snapshots.length; index += 1) {
    for (const space of snapshots[index].spaces) {
      const current = merged.get(space.id);
      const botIds = new Set(current?.available_bot_ids ?? []);
      botIds.add(bots[index].id);
      merged.set(space.id, { ...(current ?? space), available_bot_ids: [...botIds] });
    }
  }
  const allSpaces = [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
  const afterCursor = applyCursor(allSpaces, cursor);
  const page = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > limit;

  return successResponse({
    spaces: await annotatePending(page),
    total_matches: allSpaces.length,
    total_visible: allSpaces.length,
    next_cursor: hasMore ? page.at(-1)?.name ?? null : null,
    has_more: hasMore,
    cached: snapshots.every((snapshot) => snapshot.cached),
    fetched_at: Math.max(...snapshots.map((snapshot) => snapshot.fetched_at)),
    query: { q: query, limit },
    bots: bots.map(({ id, name }) => ({ id, name })),
  });
});
