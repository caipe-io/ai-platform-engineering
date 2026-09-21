// GET /api/admin/users/[id]/access
//
// Effective access for one user with the source of each grant. Team resource
// listings provide precise team/role attribution, while direct effective
// queries retain global, collection-derived, and external-group access that
// cannot be attributed to one local team. RAG Search and datasource Owner
// access remain separate capabilities throughout the response.

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { requireAdminSimulationUserProfileRead } from "@/lib/rbac/admin-simulation-server";
import { getRealmUserById } from "@/lib/rbac/keycloak-admin";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import { listOpenFgaObjects } from "@/lib/rbac/openfga";
import {
  listTeamResourceIdsBatch,
  TEAM_TOOL_WILDCARD_SENTINEL_ID,
  TeamResourceListingCache,
} from "@/lib/rbac/team-resource-listing";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import type { Team } from "@/types/teams";
import type { TeamMembershipSource } from "@/types/identity-group-sync";
import { type NextRequest, NextResponse } from "next/server";

type TeamRole = "member" | "admin";

interface AccessVia {
  /**
   * `team` — granted because the user belongs to a team that holds the grant.
   * `owned` — granted because the user personally owns the resource
   * (`user:<sub> owner <type>:<id>`), independent of any team.
   * `effective` — granted through a direct, global, collection, or external
   * group relationship that cannot be attributed to one local team.
   */
  kind: "team" | "owned" | "effective";
  /** Team attribution (set when `kind === "team"`; empty for owned grants). */
  team_slug: string;
  team_name: string;
  role: TeamRole;
}

interface AccessItem {
  id: string;
  name: string;
  capability: string;
  via: AccessVia[];
}

interface AccessGroups {
  agents: AccessItem[];
  tools: AccessItem[];
  knowledge_bases: AccessItem[];
  skills: AccessItem[];
  workflows: AccessItem[];
}

function requireMongoDB(): NextResponse | null {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      { success: false, error: "MongoDB not configured — user access requires MongoDB", code: "MONGODB_NOT_CONFIGURED" },
      { status: 503 },
    );
  }
  return null;
}

/**
 * Accumulate access items keyed by (id, capability), merging the granting
 * teams into `via` so the UI can show "GitHub agent — use — via Platform,
 * Payments".
 */
class AccessAccumulator {
  private readonly byKey = new Map<string, AccessItem>();

  add(id: string, capability: string, name: string, via: AccessVia) {
    const key = `${id}\u0000${capability}`;
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.name === existing.id && name !== id) existing.name = name;
      if (
        via.kind === "effective" &&
        existing.via.some((candidate) => candidate.kind !== "effective")
      ) {
        return;
      }
      if (via.kind !== "effective") {
        existing.via = existing.via.filter(
          (candidate) => candidate.kind !== "effective",
        );
      }
      if (
        !existing.via.some(
          (candidate) =>
            candidate.kind === via.kind &&
            candidate.team_slug === via.team_slug,
        )
      ) {
        existing.via.push(via);
      }
      return;
    }
    this.byKey.set(key, { id, name, capability, via: [via] });
  }

  toSorted(): AccessItem[] {
    return [...this.byKey.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.capability.localeCompare(b.capability),
    );
  }
}

export const GET = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const mongoCheck = requireMongoDB();
    if (mongoCheck) return mongoCheck;

    const { session } = await getAuthFromBearerOrSession(request);
    const { id } = await context.params;
    await requireAdminSimulationUserProfileRead(
      new URL(request.url).searchParams,
      session,
      id,
    );

    const teamsResult: AccessVia[] = [];
    const agents = new AccessAccumulator();
    const tools = new AccessAccumulator();
    const knowledgeBases = new AccessAccumulator();
    const skills = new AccessAccumulator();
    const workflows = new AccessAccumulator();
    const datasourceNamesPromise = loadDatasourceNames();

    // Wave 1: user profile + owned grants in parallel. Owned grants only need
    // the user's subject id, which equals the URL `id` param (`kcUser.id ?? id`
    // always resolves to `id`), so both can start immediately.
    const [kcUser] = await Promise.all([
      getRealmUserById(id),
      addDirectGrants(
        id,
        { agents, knowledgeBases, skills, workflows },
        datasourceNamesPromise,
      ),
    ]);
    const datasourceNameById = await datasourceNamesPromise;

    const buildAccess = (): AccessGroups => ({
      agents: agents.toSorted(),
      tools: tools.toSorted(),
      knowledge_bases: knowledgeBases.toSorted(),
      skills: skills.toSorted(),
      workflows: workflows.toSorted(),
    });

    const email = String(kcUser.email ?? "").trim().toLowerCase();

    if (!email) {
      return successResponse({
        user: { id: String(kcUser.id ?? id), email: String(kcUser.email ?? "") },
        teams: teamsResult,
        access: buildAccess(),
      });
    }

    // Wave 2: resolve the user's active team memberships (needs email from kcUser).
    const sources = await getRbacCollection<TeamMembershipSource>("teamMembershipSources");
    const rows = await sources
      .find({ user_email: email, status: "active" })
      .project({ team_slug: 1, relationship: 1 })
      .toArray();

    const roleBySlug = new Map<string, TeamRole>();
    for (const row of rows) {
      const slug = (row as { team_slug?: string }).team_slug;
      if (!slug) continue;
      const role: TeamRole = (row as { relationship?: string }).relationship === "admin" ? "admin" : "member";
      const current = roleBySlug.get(slug);
      roleBySlug.set(slug, current === "admin" ? current : role);
    }

    if (roleBySlug.size === 0) {
      return successResponse({
        user: { id: String(kcUser.id ?? id), email: String(kcUser.email ?? "") },
        teams: teamsResult,
        access: buildAccess(),
      });
    }

    // Wave 3: all resource lookups in parallel — team names (Mongo), agent
    // display names (Mongo), OpenFGA resource grants (agents/skills/workflows),
    // tool grants (OpenFGA), and KB grants (OpenFGA) all depend only on `slugs`
    // and are fully independent of each other.
    const slugs = [...roleBySlug.keys()];
    const cache = new TeamResourceListingCache();
    const [teamDocs, agentDocs, resourceIdsBySlug, toolEntries, ragEntries] = await Promise.all([
      getCollection<Team>("teams").then((col) =>
        col.find({ slug: { $in: slugs } } as never).toArray(),
      ),
      getCollection<{ _id: string; name?: string }>("dynamic_agents")
        .then((col) => col.find({}, { projection: { _id: 1, name: 1 } }).toArray())
        .catch((): Array<{ _id: string; name?: string }> => []),
      listTeamResourceIdsBatch(slugs, ["agents", "skills", "workflows"]),
      Promise.all(
        slugs.map(async (slug) => [
          slug,
          await cache.listTeamResourceObjectIds({ teamSlug: slug, type: "tool", relation: "caller" }),
        ] as [string, string[]]),
      ),
      Promise.all(
        slugs.map(async (slug) => {
          const searchPromise = cache.listTeamResourceObjectIds({
            teamSlug: slug,
            type: "knowledge_base",
            relation: "can_read",
          });
          const ownerPromise = roleBySlug.get(slug) === "admin"
            ? cache.listTeamAdminResourceObjectIds({
                teamSlug: slug,
                type: "ingestion_source",
                relation: "can_manage",
              })
            : Promise.resolve([]);
          const [search, owner] = await Promise.all([
            searchPromise,
            ownerPromise,
          ]);
          return [slug, { search, owner }] as const;
        }),
      ).catch((err) => {
        console.error("[Admin UserAccess] failed to load RAG access", err);
        return [] as Array<readonly [string, { search: string[]; owner: string[] }]>;
      }),
    ]);

    const teamBySlug = new Map<string, Team>(
      teamDocs.map((team) => [team.slug, team] as [string, Team]),
    );
    const agentNameById = new Map<string, string>(
      agentDocs.map((a) => [String(a._id), a.name ?? String(a._id)] as [string, string]),
    );
    const toolsBySlug = new Map(toolEntries);
    const ragBySlug = new Map(ragEntries);

    for (const slug of slugs) {
      const role = roleBySlug.get(slug)!;
      const team = teamBySlug.get(slug);
      const teamName = team?.name ?? slug;
      const via: AccessVia = { kind: "team", team_slug: slug, team_name: teamName, role };
      teamsResult.push(via);

      const grants = resourceIdsBySlug.get(slug);

      // Agents — `use` for members (`team#member user`), `manage` for admins
      // only (`team#admin manager`).
      for (const agentId of grants?.agents ?? []) {
        agents.add(agentId, "use", agentNameById.get(agentId) ?? agentId, via);
      }
      if (role === "admin") {
        for (const agentId of grants?.agentAdmins ?? []) {
          agents.add(agentId, "manage", agentNameById.get(agentId) ?? agentId, via);
        }
      }

      // Tools — member-level `tool#caller` grants (per-server `<server>/*`
      // prefixes from the write path). The `tool:*` wildcard-intent sentinel is
      // surfaced as a single "All MCP tools" item, not a literal `*` tool.
      for (const toolId of toolsBySlug.get(slug) ?? []) {
        if (toolId === TEAM_TOOL_WILDCARD_SENTINEL_ID) {
          tools.add(TEAM_TOOL_WILDCARD_SENTINEL_ID, "call", "All MCP tools", via);
        } else {
          tools.add(toolId, "call", toolId, via);
        }
      }

      // Skills / workflows — member-level `use`.
      for (const skillId of grants?.skills ?? []) {
        skills.add(skillId, "use", skillId, via);
      }
      for (const workflowId of grants?.workflows ?? []) {
        workflows.add(workflowId, "use", workflowId, via);
      }

      // RAG Search and datasource Owner access are independent grants. Search
      // includes collection-inherited access; Owner follows the connector
      // configuration rather than the indexed knowledge-base object.
      const ragAccess = ragBySlug.get(slug);
      for (const datasourceId of ragAccess?.search ?? []) {
        knowledgeBases.add(
          datasourceId,
          "search",
          datasourceNameById.get(datasourceId) ?? datasourceId,
          via,
        );
      }
      for (const datasourceId of ragAccess?.owner ?? []) {
        knowledgeBases.add(
          datasourceId,
          "owner",
          datasourceNameById.get(datasourceId) ?? datasourceId,
          via,
        );
      }
    }

    return successResponse({
      user: { id: String(kcUser.id ?? id), email: String(kcUser.email ?? "") },
      teams: teamsResult.sort((a, b) => a.team_name.localeCompare(b.team_name)),
      access: buildAccess(),
    });
  },
);

/** `via` attribution for a personally-owned (non-team) grant. */
const OWNED_VIA: AccessVia = { kind: "owned", team_slug: "", team_name: "", role: "admin" };
const EFFECTIVE_VIA: AccessVia = {
  kind: "effective",
  team_slug: "",
  team_name: "",
  role: "member",
};

/**
 * Surface direct ownership plus effective RAG access for the selected user.
 * Effective RAG checks retain collection, global, and external-group access
 * that cannot be reconstructed from local team membership rows.
 */
async function addDirectGrants(
  subject: string,
  acc: {
    agents: AccessAccumulator;
    knowledgeBases: AccessAccumulator;
    skills: AccessAccumulator;
    workflows: AccessAccumulator;
  },
  datasourceNamesPromise: Promise<Map<string, string>>,
): Promise<void> {
  if (!subject) return;
  const user = `user:${subject}`;
  try {
    const [
      ownedAgents,
      ownedSkills,
      ownedWorkflows,
      ownedSources,
      manageableSources,
      searchableKnowledgeBases,
      datasourceNameById,
    ] = await Promise.all([
      listOpenFgaObjects({ user, relation: "owner", type: "agent" }),
      listOpenFgaObjects({ user, relation: "owner", type: "skill" }),
      listOpenFgaObjects({ user, relation: "owner", type: "task" }),
      listOpenFgaObjects({ user, relation: "owner", type: "ingestion_source" }),
      listOpenFgaObjects({ user, relation: "can_manage", type: "ingestion_source" }),
      listOpenFgaObjects({ user, relation: "can_read", type: "knowledge_base" }),
      datasourceNamesPromise,
    ]);
    for (const obj of ownedAgents.objects) {
      const id = stripType(obj, "agent");
      if (id) acc.agents.add(id, "manage", id, OWNED_VIA);
    }
    for (const obj of ownedSkills.objects) {
      const id = stripType(obj, "skill");
      if (id) acc.skills.add(id, "use", id, OWNED_VIA);
    }
    for (const obj of ownedWorkflows.objects) {
      const id = stripType(obj, "task");
      if (id) acc.workflows.add(id, "use", id, OWNED_VIA);
    }
    const personallyOwnedSources = new Set<string>();
    for (const obj of ownedSources.objects) {
      const id = stripType(obj, "ingestion_source");
      if (!id) continue;
      personallyOwnedSources.add(id);
      acc.knowledgeBases.add(
        id,
        "owner",
        datasourceNameById.get(id) ?? id,
        OWNED_VIA,
      );
    }
    for (const obj of manageableSources.objects) {
      const id = stripType(obj, "ingestion_source");
      if (!id || personallyOwnedSources.has(id)) continue;
      acc.knowledgeBases.add(
        id,
        "owner",
        datasourceNameById.get(id) ?? id,
        EFFECTIVE_VIA,
      );
    }
    for (const obj of searchableKnowledgeBases.objects) {
      const id = stripType(obj, "knowledge_base");
      if (!id) continue;
      acc.knowledgeBases.add(
        id,
        "search",
        datasourceNameById.get(id) ?? id,
        EFFECTIVE_VIA,
      );
    }
  } catch (err) {
    console.error("[Admin UserAccess] failed to load direct access", err);
  }
}

async function loadDatasourceNames(): Promise<Map<string, string>> {
  try {
    const collection = await getCollection<
      Pick<IngestionSourceConfig, "source_id" | "name">
    >(
      "rag_ingestion_sources",
    );
    const rows = await collection
      .find({}, { projection: { _id: 0, source_id: 1, name: 1 } })
      .toArray();
    return new Map(
      rows.map((row) => [row.source_id, row.name || row.source_id]),
    );
  } catch (err) {
    console.error("[Admin UserAccess] failed to load datasource names", err);
    return new Map();
  }
}

/** Strip the `type:` prefix from a fully-qualified OpenFGA object ref. */
function stripType(object: string, type: string): string | null {
  const prefix = `${type}:`;
  if (!object.startsWith(prefix)) return null;
  return object.slice(prefix.length) || null;
}
