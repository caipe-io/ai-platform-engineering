/**
 * Spec 104 — Team-scoped RBAC: resource assignment endpoint.
 *
 * GET  /api/admin/teams/[id]/resources
 *   → returns the agents/tools the team is currently granted (read live from
 *     OpenFGA, the single source of truth — NOT the dropped `team.resources`
 *     array), the read-only set of workflows the team owns/is-shared, plus the
 *     full picker catalog (`available.agents`, `available.tools`) so the UI can
 *     render checkboxes without a second round-trip.
 *
 * PUT  /api/admin/teams/[id]/resources
 *   body: { agents, agent_admins, tools, tool_wildcard }
 *   - Reconciles OpenFGA relationship tuples for team → resource access.
 *   - Previous state is read from OpenFGA (so revocations are computed against
 *     real grants), not from a Mongo array. The team document is NOT used to
 *     store the selection anymore; any legacy `resources` field is unset.
 *
 * Keycloak is intentionally not updated for per-resource grants. Realm roles
 * such as `agent_user:<id>` and `tool_user:<prefix>` are legacy artifacts; the
 * OpenFGA tuple store is the resource PDP.
 *
 * Note: workflows (OpenFGA `task:` type) are surfaced read-only here. They are
 * shared from the workflow editor (`visibility=team` + `shared_with_teams`,
 * reconciled by workflow-config-rebac.ts) — that is the single writer for
 * workflow team grants, so this endpoint never writes `task:` tuples.
 */

import {
ApiError,
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { reconcileTupleDiff } from "@/lib/authz";
import {
buildTeamResourceTupleDiff,
teamToolWildcardSentinelTuple,
TEAM_TOOL_WILDCARD_SENTINEL_OBJECT,
} from "@/lib/rbac/openfga";
import { TeamResourceListingCache } from "@/lib/rbac/team-resource-listing";
import { requireTeamMembershipManagementPermission } from "@/lib/rbac/team-admin-guards";
import type { Team } from "@/types/teams";
import { ObjectId } from "mongodb";
import { NextRequest,NextResponse } from "next/server";

interface DynamicAgentLite {
  _id: string;
  name?: string;
  description?: string;
  visibility?: string;
  enabled?: boolean;
}

interface MCPServerLite {
  visibility?: string;
  _id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
}

interface SkillLite {
  _id?: string;
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  enabled?: boolean;
}

interface SkillHubLite {
  id?: string;
  enabled?: boolean;
}

interface HubSkillLite {
  hub_id?: string;
  skill_id?: string;
  name?: string;
  description?: string;
}

interface WorkflowConfigLite {
  _id?: string;
  name?: string;
  title?: string;
  description?: string;
}

function requireMongoDB() {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: "MongoDB not configured - team resources require MongoDB",
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

function diff(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((x) => !prevSet.has(x)),
    removed: prev.filter((x) => !nextSet.has(x)),
  };
}

/**
 * Expand a `tool_wildcard` selection into the explicit `<server>/*` prefixes
 * for every enabled MCP server. The wildcard and a manual "select all servers"
 * choice write byte-identical OpenFGA tuples (both flow through
 * mcpServerAccessTuples / gateway caller / agent-runtime caller with the same
 * server set), so we never need a dedicated wildcard tuple shape: expanding it
 * here lets reads (which can't tell wildcard from select-all) round-trip
 * losslessly, and lets revocation diff plain per-server prefixes.
 */
function expandToolWildcard(
  tools: string[],
  wildcard: boolean,
  allMcpServerIds: string[],
): string[] {
  if (!wildcard) return tools;
  const merged = new Set(tools);
  for (const serverId of allMcpServerIds) merged.add(`${serverId}/*`);
  return Array.from(merged);
}

/** Whether the granted tool prefixes cover every enabled MCP server. */
function allServersGranted(grantedTools: string[], allServerPrefixes: string[]): boolean {
  if (allServerPrefixes.length === 0) return false;
  const granted = new Set(grantedTools);
  return allServerPrefixes.every((prefix) => granted.has(prefix));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — current selection (OpenFGA-derived) + available picker catalog
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const mongoCheck = requireMongoDB();
    if (mongoCheck) return mongoCheck;

    const { user, session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, "team", "view");

      const { id } = await context.params;
      const teamId = parseTeamId(id);

      const teamsCol = await getCollection<Team>("teams");
      const team = await teamsCol.findOne({ _id: teamId } as never);
      if (!team) throw new ApiError("Team not found", 404);
      const slug = team.slug || id;

      const agentsCol = await getCollection<DynamicAgentLite>("dynamic_agents");
      const mcpCol = await getCollection<MCPServerLite>("mcp_servers");
      const skillsCol = await getCollection<SkillLite>("skills");
      const skillHubsCol = await getCollection<SkillHubLite>("skill_hubs");
      const hubSkillsCol = await getCollection<HubSkillLite>("hub_skills");

      const [allAgents, allServers, allSkills, enabledHubs, allHubSkills] = await Promise.all([
        agentsCol
          .find({ enabled: { $ne: false } } as never, { projection: { _id: 1, name: 1, description: 1, visibility: 1 } })
          .sort({ name: 1 })
          .toArray()
          .catch(() => [] as DynamicAgentLite[]),
        mcpCol
          .find({ enabled: { $ne: false } } as never, { projection: { _id: 1, name: 1, description: 1 } })
          .sort({ name: 1 })
          .toArray()
          .catch(() => [] as MCPServerLite[]),
        skillsCol
          .find({ enabled: { $ne: false } } as never, { projection: { _id: 1, id: 1, name: 1, title: 1, description: 1 } })
          .sort({ name: 1 })
          .toArray()
          .catch(() => [] as SkillLite[]),
        skillHubsCol
          .find({ enabled: { $ne: false } } as never, { projection: { id: 1, enabled: 1 } })
          .sort({ id: 1 })
          .toArray()
          .catch(() => [] as SkillHubLite[]),
        hubSkillsCol
          .find({}, { projection: { hub_id: 1, skill_id: 1, name: 1, description: 1 } })
          .sort({ name: 1 })
          .toArray()
          .catch(() => [] as HubSkillLite[]),
      ]);

      // We render tools by MCP server wildcard (e.g. `jira/*`) because the
      // slash form (`<server>/*`) is the ONLY wildcard the AgentGateway bridge
      // enforces at runtime. The tuple builder accepts this current slash form
      // and the legacy underscore form (`<server>_*`) for old stored team docs,
      // then materializes concrete `mcp_server:<server>` and `tool:<server>/*`
      // OpenFGA tuples.
      const toolPrefixes = allServers.map((s) => `${s._id}/*`);
      const enabledHubIds = new Set(
        enabledHubs.map((hub) => hub.id).filter((id): id is string => Boolean(id))
      );
      const hubSkillOptions = allHubSkills
        .filter((skill) => skill.hub_id && skill.skill_id && enabledHubIds.has(skill.hub_id))
        .map((skill) => ({
          id: `hub-${skill.hub_id}-${skill.skill_id}`,
          name: skill.name ?? skill.skill_id ?? "",
          description: skill.description ?? "",
        }));
      const configuredSkillOptions = allSkills.map((s) => {
        const id = String(s.id ?? s._id ?? s.name);
        return { id, name: s.name ?? s.title ?? id, description: s.description ?? "" };
      });
      const skillOptions = [...configuredSkillOptions, ...hubSkillOptions].sort((a, b) =>
        a.name.localeCompare(b.name)
      );

      // ── Live grants from OpenFGA (single source of truth). The reconcilers
      //    write the same `team:<slug>#member <rel>` tuple for both the owner
      //    team and every shared team, so each list-objects returns owned +
      //    shared together.
      const cache = new TeamResourceListingCache();
      const [grantedAgents, grantedAgentAdmins, grantedToolsRaw, grantedWorkflows, grantedSkills] =
        await Promise.all([
          cache.listTeamResourceObjectIds({ teamSlug: slug, type: "agent", relation: "user" }),
          cache.listTeamAdminResourceObjectIds({ teamSlug: slug, type: "agent", relation: "manager" }),
          cache.listTeamResourceObjectIds({ teamSlug: slug, type: "tool", relation: "caller" }),
          cache.listTeamResourceObjectIds({ teamSlug: slug, type: "task", relation: "user" }),
          cache.listTeamResourceObjectIds({ teamSlug: slug, type: "skill", relation: "user" }),
        ]);

      // The `tool:*` sentinel (stripped to `*`) records wildcard intent — it is
      // not a real per-server grant, so keep it out of the editable tools list.
      const sentinelId = TEAM_TOOL_WILDCARD_SENTINEL_OBJECT.slice("tool:".length);
      const hasWildcardSentinel = grantedToolsRaw.includes(sentinelId);
      const grantedTools = grantedToolsRaw.filter((id) => id !== sentinelId);

      // Wildcard is on when the sentinel is set, or (self-heal for teams granted
      // before the sentinel existed) every enabled `<server>/*` prefix is
      // granted. A server added after the wildcard was set still shows the box
      // checked via the sentinel.
      const toolWildcard = hasWildcardSentinel || allServersGranted(grantedTools, toolPrefixes);

      // Resolve workflow names for read-only display.
      const workflowsCol = await getCollection<WorkflowConfigLite>("workflow_configs");
      const workflowDocs = grantedWorkflows.length
        ? await workflowsCol
            .find({ _id: { $in: grantedWorkflows } } as never, {
              projection: { _id: 1, name: 1, title: 1, description: 1 },
            })
            .toArray()
            .catch(() => [] as WorkflowConfigLite[])
        : [];
      const workflowById = new Map(workflowDocs.map((w) => [String(w._id), w]));
      const workflows = grantedWorkflows.map((wfId) => {
        const doc = workflowById.get(wfId);
        return { id: wfId, name: doc?.name ?? doc?.title ?? wfId, description: doc?.description ?? "" };
      });

      // Resolve skill names from the picker catalog (configured + hub skills)
      // for read-only display; fall back to the id when a grant points at a
      // skill no longer in the catalog.
      const skillOptionById = new Map(skillOptions.map((s) => [s.id, s]));
      const skills = grantedSkills.map((skillId) => {
        const opt = skillOptionById.get(skillId);
        return { id: skillId, name: opt?.name ?? skillId, description: opt?.description ?? "" };
      });

      console.log(
        `[Admin TeamResources] GET team=${id} agents=${grantedAgents.length} agent_admins=${grantedAgentAdmins.length} tools=${grantedTools.length} workflows=${grantedWorkflows.length} skills=${grantedSkills.length} wildcard=${toolWildcard ? "yes" : "no"} by=${user.email}`
      );

      return successResponse({
        team_id: id,
        resources: {
          agents: grantedAgents,
          agent_admins: grantedAgentAdmins,
          tools: grantedTools,
          tool_wildcard: toolWildcard,
          // Read-only: shared from the workflow editor, not editable here.
          workflows,
          // Read-only: shared from the skill editor (skill-team-grants.ts is the
          // single writer for skill team grants), surfaced here for visibility.
          skills,
        },
        available: {
          agents: allAgents.map((a) => ({ id: a._id, name: a.name ?? a._id, description: a.description ?? "" })),
          tools: toolPrefixes.map((id, i) => ({
            id,
            name: id,
            description: allServers[i].description ?? "",
          })),
          // NOTE: no `knowledge_bases` here. KB assignment uses its own picker
          // (`TeamKbAssignmentPanel`), backed by the RAG datasource catalog +
          // OpenFGA grants; the resources tab never rendered a KB option list,
          // so the field was vestigial and is dropped with `team_kb_ownership`.
          skills: skillOptions,
        },
      });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT — reconcile OpenFGA tuples (previous state read from OpenFGA)
// ─────────────────────────────────────────────────────────────────────────────

interface PutBody {
  agents?: unknown;
  agent_admins?: unknown;
  tools?: unknown;
  tool_wildcard?: unknown;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(`${field} must be an array of strings`, 400);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new ApiError(`${field} must be an array of non-empty strings`, 400);
    }
    out.push(item.trim());
  }
  // Dedup while preserving order — the UI sends checkbox state that is
  // already unique, but defence-in-depth keeps the tuple writes clean.
  return Array.from(new Set(out));
}

export const PUT = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const mongoCheck = requireMongoDB();
    if (mongoCheck) return mongoCheck;

    const { user, session } = await getAuthFromBearerOrSession(request);

      const { id } = await context.params;
      const teamId = parseTeamId(id);

      let body: PutBody;
      try {
        body = (await request.json()) as PutBody;
      } catch {
        throw new ApiError("Invalid JSON body", 400);
      }

      const nextAgents = parseStringArray(body.agents ?? [], "agents");
      const nextAgentAdmins = parseStringArray(body.agent_admins ?? [], "agent_admins");
      const selectedTools = parseStringArray(body.tools ?? [], "tools");
      const wildcard = Boolean(body.tool_wildcard);

      const teamsCol = await getCollection<Team>("teams");
      const team = await teamsCol.findOne({ _id: teamId } as never);
      if (!team) throw new ApiError("Team not found", 404);
      const slug = team.slug || id;

      // Issue #1509: scoped team admins can manage resources on their own
      // team without platform-wide `organization:<org>#admin`.
      await requireTeamMembershipManagementPermission(session, user.email, team);

      const mcpCol = await getCollection<MCPServerLite>("mcp_servers");
      const allMcpServers = await mcpCol
        .find({ enabled: { $ne: false }, visibility: { $ne: "private" } } as never, { projection: { _id: 1 } })
        .toArray()
        .catch(() => [] as MCPServerLite[]);
      const allMcpServerIds = allMcpServers.filter((server) => server.visibility !== "private").map((server) => String(server._id));

      // Wildcard == select-all-servers (identical tuples), so expand it into
      // explicit `<server>/*` prefixes and reconcile plain per-server grants.
      const privateServers = await mcpCol.find({ visibility: "private" } as never, { projection: { _id: 1 } }).toArray();
      const privateIds = new Set(privateServers.filter((server) => server.visibility === "private").map((server) => String(server._id)));
      if (selectedTools.some((tool) => privateIds.has(tool.split("/")[0].replace(/_\*$/, "")))) {
        throw new ApiError("Private MCP servers cannot be granted to teams", 400, "PRIVATE_MCP_TEAM_GRANT");
      }
      const nextTools = expandToolWildcard(selectedTools, wildcard, allMcpServerIds);

      // ── 1. Previous state from OpenFGA (single source of truth). Reading the
      //    real grants is what makes revocation correct now that the
      //    `team.resources` array is gone. Over-reporting is safe: the OpenFGA
      //    writer drops deletes whose tuple does not actually exist.
      const cache = new TeamResourceListingCache();
      const [prevAgents, prevAgentAdmins, prevToolsRaw] = await Promise.all([
        cache.listTeamResourceObjectIds({ teamSlug: slug, type: "agent", relation: "user" }),
        cache.listTeamAdminResourceObjectIds({ teamSlug: slug, type: "agent", relation: "manager" }),
        cache.listTeamResourceObjectIds({ teamSlug: slug, type: "tool", relation: "caller" }),
      ]);

      // The `tool:*` sentinel (stripped to `*`) is wildcard intent, not a real
      // per-server grant — exclude it from the per-server tool diff and track it
      // separately so it isn't mistaken for a tool the admin deselected.
      const sentinelId = TEAM_TOOL_WILDCARD_SENTINEL_OBJECT.slice("tool:".length);
      const prevWildcardSentinel = prevToolsRaw.includes(sentinelId);
      const prevTools = prevToolsRaw.filter((id) => id !== sentinelId);

      const agentDiff = diff(prevAgents, nextAgents);
      const agentAdminDiff = diff(prevAgentAdmins, nextAgentAdmins);
      const toolDiff = diff(prevTools, nextTools);

      // ── 2. Reconcile OpenFGA ReBAC tuples. OpenFGA owns relationship facts;
      //    there is no Mongo authz array to persist anymore.
      //
      //    Grants are keyed on the `team:<slug>#member` / `#admin` userset, so a
      //    member's access resolves transitively at check time via their
      //    `user:<id> member team:<slug>` membership tuple. Those membership
      //    tuples are owned by the team-membership writers (members route +
      //    sync/audit reconcilers), so this path deliberately does NOT touch
      //    them — it used to re-resolve every member email→id against Keycloak
      //    (an O(members) serial lookup) on every save for no authorization gain.
      //
      //    Treat Save as authoritative: selected resources are desired writes
      //    (the writer filters tuples that already exist), and removals come
      //    from diffing the live OpenFGA grants. toolWildcard is always
      //    {added:false, removed:false} because wildcard is expanded into
      //    explicit per-server prefixes above.
      const tupleDiffInput = {
        teamSlug: slug,
        agents: { added: nextAgents, removed: agentDiff.removed },
        agentAdmins: { added: nextAgentAdmins, removed: agentAdminDiff.removed },
        tools: { added: nextTools, removed: toolDiff.removed },
        toolWildcard: { added: false, removed: false },
        allMcpServerIds,
      };
      const openFgaTupleDiff = buildTeamResourceTupleDiff(tupleDiffInput);

      // Persist wildcard INTENT via the `tool:*` sentinel so the MCP-server
      // reconciler can auto-grant servers added later. The per-server grants are
      // already expanded into `nextTools` above; the sentinel only flips when the
      // wildcard checkbox changes, so flipping it off doesn't strip the explicit
      // per-server prefixes (the diff handles those).
      if (wildcard && !prevWildcardSentinel) {
        openFgaTupleDiff.writes.push(teamToolWildcardSentinelTuple(slug));
      } else if (!wildcard && prevWildcardSentinel) {
        openFgaTupleDiff.deletes.push(teamToolWildcardSentinelTuple(slug));
      }

      const openfga = await reconcileTupleDiff(openFgaTupleDiff, {
        caller: { type: "user", id: session.sub! },
        source: "team_resources",
        tenantId: session.org,
      });

      // ── 3. Touch updated_at and drop any legacy `resources` array (FGA is the
      //    single source of truth; the migration backfills + unsets in bulk,
      //    this keeps re-saved teams clean immediately).
      const now = new Date();
      await teamsCol.updateOne(
        { _id: teamId } as never,
        {
          $set: { updated_at: now },
          $unset: { resources: "" },
        } as never
      );

      console.log(
        `[Admin TeamResources] PUT team=${id} agents+=${agentDiff.added.length}/-${agentDiff.removed.length} agent_admins+=${agentAdminDiff.added.length}/-${agentAdminDiff.removed.length} tools+=${toolDiff.added.length}/-${toolDiff.removed.length} wildcard=${wildcard ? "on" : "off"} by=${user.email}`
      );

      return successResponse({
        team_id: id,
        diff: {
          agents_added: agentDiff.added,
          agents_removed: agentDiff.removed,
          agent_admins_added: agentAdminDiff.added,
          agent_admins_removed: agentAdminDiff.removed,
          tools_added: toolDiff.added,
          tools_removed: toolDiff.removed,
        },
        openfga,
      });
  }
);
