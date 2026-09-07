import { getCollection } from "@/lib/mongodb";

interface SlackChannelMappingDocument {
  slack_channel_id?: string;
  team_slug?: string;
  active?: boolean;
}

interface TeamDocument {
  slug?: string;
  name?: string;
}

interface SlackChannelAgentRouteDocument {
  channel_id?: string;
  agent_id?: string;
  enabled?: boolean;
  priority?: number;
  status?: string;
}

interface DynamicAgentDocument {
  _id?: string;
  name?: string;
}

export interface ConfiguredSlackChannel {
  channelId: string;
  teamSlug?: string;
  teamName?: string;
  agentId?: string;
  agentName?: string;
}

export async function configuredSlackChannelsById(
  channelIds: string[],
): Promise<Map<string, ConfiguredSlackChannel>> {
  const ids = Array.from(
    new Set(channelIds.map((value) => value.trim()).filter(Boolean)),
  );
  if (ids.length === 0) return new Map();

  const [mappings, routes] = await Promise.all([
    getCollection<SlackChannelMappingDocument>("channel_team_mappings"),
    getCollection<SlackChannelAgentRouteDocument>(
      "slack_channel_agent_routes",
    ),
  ]);
  const [rows, routeRows] = await Promise.all([
    mappings
      .find(
        {
          slack_channel_id: { $in: ids },
          active: { $ne: false },
        } as never,
        { projection: { slack_channel_id: 1, team_slug: 1 } },
      )
      .toArray(),
    routes
      .find(
        {
          channel_id: { $in: ids },
          status: "active",
          enabled: { $ne: false },
        } as never,
        { projection: { channel_id: 1, agent_id: 1, priority: 1 } },
      )
      .toArray(),
  ]);

  const primaryRouteByChannel = new Map<
    string,
    SlackChannelAgentRouteDocument
  >();
  for (const route of routeRows) {
    const channelId = route.channel_id?.trim();
    const agentId = route.agent_id?.trim();
    if (!channelId || !agentId) continue;
    const current = primaryRouteByChannel.get(channelId);
    if (
      !current ||
      (route.priority ?? 100) < (current.priority ?? 100) ||
      ((route.priority ?? 100) === (current.priority ?? 100) &&
        agentId.localeCompare(current.agent_id ?? "") < 0)
    ) {
      primaryRouteByChannel.set(channelId, route);
    }
  }
  const teamSlugs = Array.from(
    new Set(rows.map((row) => row.team_slug?.trim()).filter((value): value is string => Boolean(value))),
  );
  const agentIds = Array.from(
    new Set(
      Array.from(primaryRouteByChannel.values())
        .map((route) => route.agent_id?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const namesBySlug = new Map<string, string>();
  const agentNamesById = new Map<string, string>();
  const [teams, agents] = await Promise.all([
    teamSlugs.length > 0
      ? getCollection<TeamDocument>("teams")
      : Promise.resolve(null),
    agentIds.length > 0
      ? getCollection<DynamicAgentDocument>("dynamic_agents")
      : Promise.resolve(null),
  ]);
  const [teamRows, agentRows] = await Promise.all([
    teams
      ? teams
          .find(
            { slug: { $in: teamSlugs } } as never,
            { projection: { slug: 1, name: 1 } },
          )
          .toArray()
      : Promise.resolve([]),
    agents
      ? agents
          .find(
            { _id: { $in: agentIds } } as never,
            { projection: { _id: 1, name: 1 } },
          )
          .toArray()
      : Promise.resolve([]),
  ]);
  for (const team of teamRows) {
    if (team.slug) namesBySlug.set(team.slug, team.name?.trim() || team.slug);
  }
  for (const agent of agentRows) {
    if (agent._id) {
      agentNamesById.set(agent._id, agent.name?.trim() || agent._id);
    }
  }

  return new Map(
    rows.flatMap((row) => {
      const channelId = row.slack_channel_id?.trim();
      if (!channelId) return [];
      const teamSlug = row.team_slug?.trim() || undefined;
      const agentId = primaryRouteByChannel
        .get(channelId)
        ?.agent_id?.trim() || undefined;
      return [[channelId, {
        channelId,
        teamSlug,
        teamName: teamSlug ? namesBySlug.get(teamSlug) ?? teamSlug : undefined,
        agentId,
        agentName: agentId ? agentNamesById.get(agentId) ?? agentId : undefined,
      }] as const];
    }),
  );
}
