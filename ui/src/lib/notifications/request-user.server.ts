import type { NextRequest } from "next/server";

import { ApiError, getAuthFromBearerOrSession } from "@/lib/api-middleware";

export async function notificationUser(request: NextRequest) {
  const auth = await getAuthFromBearerOrSession(request);
  if (
    auth.session.isServiceAccount === true ||
    typeof auth.session.sub !== "string" ||
    !auth.session.sub.trim()
  )
    throw new ApiError("Sign in with a user account", 403);
  return { ...auth, subject: auth.session.sub.trim() };
}
