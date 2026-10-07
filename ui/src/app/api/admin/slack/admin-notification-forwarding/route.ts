// GET /api/admin/slack/admin-notification-forwarding — admin-only read
// PATCH /api/admin/slack/admin-notification-forwarding — admin-only update
//
// Admin → Integrations → Slack → Advanced → "Forward Platform Admin
// Notifications". Unlike the broad `platform-config` GET (readable by any
// authenticated user), this surfaces a Slack channel id and user ids, so
// both verbs require `system_config` admin access.

import {
  getAdminNotificationForwardingConfig,
  normalizeAdminNotificationForwardingConfig,
} from "@/lib/admin-notification-forwarding.server";
import { requireRbacPermission,withAuth,withErrorHandler } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { NextRequest,NextResponse } from "next/server";

interface PlatformConfigDoc {
  slack_admin_notification_forwarding?: unknown;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return await withAuth(request, async (_req, _user, session) => {
    await requireResourcePermission(session, {
      type: "system_config",
      id: PLATFORM_CONFIG_ID,
      action: "admin",
    });
    const data = await getAdminNotificationForwardingConfig();
    return NextResponse.json({ success: true, data });
  });
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return await withAuth(request, async (_req, user, session) => {
    await requireRbacPermission(session, "admin_ui", "admin");
    await requireResourcePermission(session, {
      type: "system_config",
      id: PLATFORM_CONFIG_ID,
      action: "admin",
    });

    const rawBody = await request.json().catch(() => ({}));
    const normalized = normalizeAdminNotificationForwardingConfig(rawBody, { strict: true });

    const col = await getCollection<PlatformConfigDoc>("platform_config");
    await col.updateOne(
      { _id: PLATFORM_CONFIG_ID } as never,
      {
        $set: {
          slack_admin_notification_forwarding: normalized,
          updated_at: new Date(),
          updated_by: user.email,
        },
      },
      { upsert: true },
    );

    return NextResponse.json({ success: true, data: normalized });
  });
});
