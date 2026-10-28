import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { callSlackBotDirectory } from "@/lib/slack-bot-admin";
import {
  activeConnectorPublicationRequestsByItemId,
  connectorPublicationRequestView,
  publicationActorFromSession,
} from "@/lib/publication-approval.server";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { configuredSlackChannelsById } from "@/lib/rbac/slack-channel-configured-directory";
import { NextRequest } from "next/server";

interface NormalizedChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  num_members: number;
}

interface ChannelDirectoryResponse {
  channels: NormalizedChannel[];
  total_matches: number;
  total_visible: number;
  next_cursor: string | null;
  has_more: boolean;
  cached: boolean;
  fetched_at: number;
  scope: string;
  endpoint: string;
  query: { q: string; member_only: boolean; limit: number };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireResourcePermission(
    session,
    { type: "admin_surface", id: "slack", action: "read" },
    { bypassForOrgAdmin: true },
  );

  const directory = await callSlackBotDirectory<ChannelDirectoryResponse>("channels", request.nextUrl.searchParams);
  const page = directory.channels;
  const actor = publicationActorFromSession(session);
  const pageIds = page.map((channel) => channel.id);
  const [configuredById, pendingById] = await Promise.all([
    configuredSlackChannelsById(pageIds),
    activeConnectorPublicationRequestsByItemId("slack_channel", pageIds),
  ]);
  const channels = page.map((channel) => {
    const configured = configuredById.get(channel.id);
    const pending = pendingById.get(channel.id);
    return {
      ...channel,
      configured: Boolean(configured),
      ...(configured?.teamSlug
        ? { configured_team_slug: configured.teamSlug }
        : {}),
      ...(configured?.teamName
        ? { configured_team_name: configured.teamName }
        : {}),
      ...(configured?.agentId
        ? { configured_agent_id: configured.agentId }
        : {}),
      ...(configured?.agentName
        ? { configured_agent_name: configured.agentName }
        : {}),
      ...(!configured && pending
        ? { pending_publication: connectorPublicationRequestView(pending, actor) }
        : {}),
    };
  });

  return successResponse({ ...directory, channels });
});
