import type {
  WebexSpaceAccessCheckResult,
  WebexSpaceGrantResourceType,
} from "@/types/webex-rebac";
import type {
  UniversalRebacRelationship,
  UniversalRebacResourceAction,
  UniversalRebacResourceRef,
  UniversalRebacSubjectRef,
} from "@/types/rbac-universal";

import { checkUniversalRebacRelationship } from "./openfga";
import {
  WEBEX_SPACE_GRANT_RESOURCE_TYPES,
  webexSpaceSubjectId,
} from "./webex-space-grant-store";
import { webexBotInstallationId } from "./webex-bot-openfga";

export function webexSpaceSubjectRef(
  workspaceId: string,
  spaceId: string
): UniversalRebacSubjectRef {
  return {
    type: "webex_space",
    id: webexSpaceSubjectId(workspaceId, spaceId),
  };
}

export function webexSpaceGrantRelationship(
  workspaceId: string,
  spaceId: string,
  resource: UniversalRebacResourceRef,
  action: UniversalRebacResourceAction
): UniversalRebacRelationship {
  return {
    subject: { type: "webex_space", id: webexSpaceSubjectId(workspaceId, spaceId) },
    action,
    resource,
  };
}

// Team→space visibility tuples. Without these, the space exists in Mongo but
// no one can `can_read` it in OpenFGA, so the admin /api/admin/webex/spaces
// listing endpoint silently filters it out. Mirrors
// slackChannelTeamVisibilityRelationships for parity with the Slack surface.
export function webexSpaceTeamVisibilityRelationships(
  workspaceId: string,
  spaceId: string,
  teamSlug: string
): UniversalRebacRelationship[] {
  const spaceResource: UniversalRebacResourceRef = {
    type: "webex_space",
    id: webexSpaceSubjectId(workspaceId, spaceId),
  };
  return [
    {
      subject: { type: "team", id: teamSlug, relation: "member" },
      action: "manage",
      resource: spaceResource,
    },
    {
      subject: { type: "team", id: teamSlug, relation: "member" },
      action: "use",
      resource: spaceResource,
    },
  ];
}

export async function checkWebexSpaceAccess(input: {
  bot_id: string;
  workspace_id: string;
  space_id: string;
  resource: UniversalRebacResourceRef;
  action: UniversalRebacResourceAction;
}): Promise<WebexSpaceAccessCheckResult> {
  if (!WEBEX_SPACE_GRANT_RESOURCE_TYPES.has(input.resource.type as WebexSpaceGrantResourceType)) {
    return {
      allowed: false,
      space_allowed: false,
      reason: "unsupported_resource",
    };
  }

  const spaceResult = await checkUniversalRebacRelationship({
    subject: {
      type: "webex_bot_installation",
      id: webexBotInstallationId(input.bot_id, input.workspace_id, input.space_id),
    },
    action: input.action,
    resource: input.resource,
  });

  return {
    allowed: spaceResult.allowed,
    space_allowed: spaceResult.allowed,
    reason: spaceResult.allowed ? "allowed" : "missing_space_grant",
  };
}
