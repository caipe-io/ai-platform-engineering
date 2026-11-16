import { successResponse, withAuth, withErrorHandler } from "@/lib/api-middleware";
import { normalizeFavoriteAppIds } from "@/lib/agentic-apps/favorites";
import { getCollection } from "@/lib/mongodb";
import type { UserSettings } from "@/types/mongodb";
import { NextRequest } from "next/server";

/** Read only the favorite IDs; Home does not need the full settings document. */
export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    const settings = await getCollection<UserSettings>("user_settings");
    const record = await settings.findOne(
      { user_id: user.email },
      { projection: { "preferences.favorite_agentic_apps": 1 } },
    );
    const response = successResponse({
      favoriteAppIds: normalizeFavoriteAppIds(record?.preferences?.favorite_agentic_apps),
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });
});
