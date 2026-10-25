// assisted-by Codex Codex-sonnet-4-6
//
// Mongo-backed scope filter for dynamic agents. OpenFGA is authoritative at
// invoke time, but stale `user:* user agent:<id>` tuples (e.g. after a
// global → team demote before reconcile runs) can temporarily grant
// `can_use` to every org member. This helper narrows candidate agents using
// persisted ownership metadata before FGA batch checks.

import { authorize } from "@/lib/authz";
import type { DynamicAgentConfig, LegacyVisibilityType } from "@/types/dynamic-agent";

import { listUserTeamSlugs } from "./openfga-team-membership";
import { caipeOrgKey } from "./organization";
import type { ResourceAuthzSession } from "./resource-authz";

export interface AgentOwnershipScopeContext {
  userSub: string;
  teamSlugs: ReadonlySet<string>;
  platformDefaultAgentId: string | null;
}

function normalizeVisibility(value: unknown): "global" | "private" | "team" {
  if (value === "global" || value === "private") return value;
  return "team";
}

function ownerSubject(agent: Pick<DynamicAgentConfig, "owner_id" | "owner_subject">): string | null {
  const raw = agent.owner_subject ?? agent.owner_id;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isPrivateAgentOwner(
  agent: Pick<DynamicAgentConfig, "visibility" | "owner_id" | "owner_subject">,
  userSub: string,
): boolean {
  return normalizeVisibility(agent.visibility) === "private"
    && ownerSubject(agent) === userSub.trim();
}

function teamSlugMatches(teamSlugs: ReadonlySet<string>, slug: unknown): boolean {
  if (typeof slug !== "string") return false;
  const trimmed = slug.trim();
  return trimmed.length > 0 && teamSlugs.has(trimmed);
}

/**
 * Returns true when Mongo metadata says the user may see this agent in list
 * UIs (chat picker, admin agents tab) before OpenFGA filtering.
 */
export function isAgentInOwnershipScope(
  agent: Pick<
    DynamicAgentConfig,
    | "_id"
    | "visibility"
    | "owner_id"
    | "owner_subject"
    | "owner_team_slug"
    | "shared_with_teams"
  > & { visibility?: LegacyVisibilityType },
  ctx: AgentOwnershipScopeContext,
): boolean {
  const agentId = String(agent._id ?? "").trim();
  if (!agentId) return false;

  const visibility = normalizeVisibility(agent.visibility);
  const owner = ownerSubject(agent);

  // Private resources are discoverable only by their direct owner. Keep
  // this ahead of the platform-default exception so inconsistent metadata
  // cannot accidentally turn a private agent into a globally visible row.
  if (visibility === "private") {
    return isPrivateAgentOwner(agent, ctx.userSub);
  }

  if (ctx.platformDefaultAgentId && agentId === ctx.platformDefaultAgentId) {
    return true;
  }

  if (visibility === "global") {
    return true;
  }

  if (owner && owner === ctx.userSub) {
    return true;
  }

  if (teamSlugMatches(ctx.teamSlugs, agent.owner_team_slug)) {
    return true;
  }

  for (const slug of agent.shared_with_teams ?? []) {
    if (teamSlugMatches(ctx.teamSlugs, slug)) {
      return true;
    }
  }

  return false;
}

export async function buildAgentOwnershipScopeContext(
  userSub: string,
  platformDefaultAgentId: string | null,
): Promise<AgentOwnershipScopeContext> {
  const teamSlugs = await listUserTeamSlugs({ subject: userSub });
  return {
    userSub,
    teamSlugs: new Set(teamSlugs),
    platformDefaultAgentId,
  };
}

export function filterAgentsByOwnershipScope<T extends DynamicAgentConfig>(
  agents: T[],
  ctx: AgentOwnershipScopeContext,
): T[] {
  return agents.filter((agent) => isAgentInOwnershipScope(agent, ctx));
}

/**
 * Org admins retain broad discovery for team/global agents, but private
 * agents still require direct ownership in the normal list surface.
 */
export function filterPrivateAgentsByOwner<T extends DynamicAgentConfig>(
  agents: T[],
  userSub: string,
): T[] {
  const normalizedSubject = userSub.trim();
  if (!normalizedSubject) return [];
  return agents.filter((agent) => (
    normalizeVisibility(agent.visibility) !== "private"
    || ownerSubject(agent) === normalizedSubject
  ));
}

async function isOrgAdminSession(session: ResourceAuthzSession): Promise<boolean> {
  if (typeof session.sub !== "string" || !session.sub.trim()) return false;
  const result = await authorize({
    subject: {
      type: session.isServiceAccount === true ? "service_account" : "user",
      id: session.sub.trim(),
    },
    resource: { type: "organization", id: caipeOrgKey() },
    action: "manage",
  });
  return result.decision === "ALLOW";
}

/**
 * Narrow agent candidates using Mongo ownership metadata. Org admins may
 * discover all team/global agents, but private agents remain owner-only.
 */
export async function filterAgentsByOwnershipScopeForSession<T extends DynamicAgentConfig>(
  session: ResourceAuthzSession,
  agents: T[],
  platformDefaultAgentId: string | null,
): Promise<T[]> {
  if (typeof session.sub !== "string" || !session.sub.trim()) return [];
  const userSub = session.sub.trim();
  if (await isOrgAdminSession(session)) {
    return filterPrivateAgentsByOwner(agents, userSub);
  }
  const ctx = await buildAgentOwnershipScopeContext(userSub, platformDefaultAgentId);
  return filterAgentsByOwnershipScope(agents, ctx);
}
