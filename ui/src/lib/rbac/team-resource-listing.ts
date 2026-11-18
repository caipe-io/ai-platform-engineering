import {
  listOpenFgaObjects,
  mapWithConcurrency,
  openFgaReadConcurrency,
} from "@/lib/rbac/openfga";
import type { KbPermission } from "@/lib/rbac/types";

export { TEAM_TOOL_WILDCARD_SENTINEL_ID } from "./team-tool-wildcard";

/**
 * Resource kinds that teams own / are granted access to, surfaced in the admin
 * Teams & Users views. OpenFGA is the single source of truth — these listings
 * read live `list-objects` results, NOT the dropped `team.resources` arrays.
 */
export type TeamResourceKind = "agents" | "skills" | "workflows" | "tools";

/** OpenFGA (object type, team-member relation) the reconcilers actually write. */
interface ResourceRelationSpec {
  /** OpenFGA object type (e.g. `agent`, `skill`, `task`). */
  type: string;
  /** Relation a `team:<slug>#member` holds when granted use of the resource. */
  memberRelation: string;
}

/**
 * Source of truth for which relation each kind is granted under. Mirrors the
 * write paths so reads and writes can never disagree:
 * - agents   → `agent`, member rel `user`     (openfga-agent-tools.ts)
 * - skills   → `skill`, member rel `user`      (skill-team-grants.ts)
 * - workflows→ `task`,  member rel `user`      (workflow-config-rebac.ts)
 * - tools    → `tool`,  member rel `caller`    (team resources route)
 */
const RESOURCE_RELATIONS: Record<TeamResourceKind, ResourceRelationSpec> = {
  agents: { type: "agent", memberRelation: "user" },
  skills: { type: "skill", memberRelation: "user" },
  workflows: { type: "task", memberRelation: "user" },
  tools: { type: "tool", memberRelation: "caller" },
};

/**
 * Relation a `team:<slug>#admin` holds when the team can MANAGE a resource
 * (admin-grade access). Only agents currently distinguish manage from use.
 */
const AGENT_ADMIN_RELATION = "manager";

export interface TeamResourceIds {
  agents: string[];
  skills: string[];
  workflows: string[];
  /** Tool ids the team is granted (`tool:<id>`), including the concrete wildcard-intent marker. */
  tools: string[];
  /** Subset of `agents` the team can manage (`team:<slug>#admin manager agent:<id>`). */
  agentAdmins: string[];
}

function emptyTeamResourceIds(): TeamResourceIds {
  return { agents: [], skills: [], workflows: [], tools: [], agentAdmins: [] };
}

/** Strip the `type:` prefix from a fully-qualified OpenFGA object ref. */
function stripObjectType(object: string, type: string): string | null {
  const prefix = `${type}:`;
  if (!object.startsWith(prefix)) return null;
  const id = object.slice(prefix.length);
  return id || null;
}

/**
 * Request-scoped memo/coalescing cache. One instance per request/page load —
 * NOT a global cache (avoids cross-request staleness). Reuse a single cache
 * across every team in one response so duplicate `(slug, type, relation)`
 * lookups collapse to a single in-flight OpenFGA call.
 */
export class TeamResourceListingCache {
  private readonly inflight = new Map<string, Promise<string[]>>();

  private key(teamSlug: string, type: string, relation: string): string {
    return `${teamSlug}|${relation}|${type}`;
  }

  /**
   * Object ids of `type` the given team holds `relation` on. Coalesces and
   * memoizes for this cache's lifetime. Throws on OpenFGA failure (no silent
   * empty) — FGA is required, callers surface an error state rather than a
   * misleadingly-empty list.
   */
  listTeamResourceObjectIds(args: {
    teamSlug: string;
    type: string;
    relation: string;
  }): Promise<string[]> {
    const teamSlug = args.teamSlug.trim();
    if (!teamSlug) return Promise.resolve([]);
    const cacheKey = this.key(teamSlug, args.type, args.relation);
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;
    const promise = listOpenFgaObjects({
      user: `team:${teamSlug}#member`,
      relation: args.relation,
      type: args.type,
    }).then((res) =>
      res.objects
        .map((object) => stripObjectType(object, args.type))
        .filter((id): id is string => Boolean(id)),
    );
    this.inflight.set(cacheKey, promise);
    return promise;
  }

  /** Object ids of `type` the given team's ADMINS hold `relation` on. */
  listTeamAdminResourceObjectIds(args: {
    teamSlug: string;
    type: string;
    relation: string;
  }): Promise<string[]> {
    const teamSlug = args.teamSlug.trim();
    if (!teamSlug) return Promise.resolve([]);
    const cacheKey = `admin:${this.key(teamSlug, args.type, args.relation)}`;
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;
    const promise = listOpenFgaObjects({
      user: `team:${teamSlug}#admin`,
      relation: args.relation,
      type: args.type,
    }).then((res) =>
      res.objects
        .map((object) => stripObjectType(object, args.type))
        .filter((id): id is string => Boolean(id)),
    );
    this.inflight.set(cacheKey, promise);
    return promise;
  }
}

/**
 * Resolve the full owned+shared resource id set for a single team. The
 * reconcilers write the same `team:<slug>#member <rel>` tuple for both the
 * owner team and every shared team, so one `list-objects` per kind returns
 * owned + shared together.
 */
export async function listTeamResourceIds(
  teamSlug: string,
  cache: TeamResourceListingCache = new TeamResourceListingCache(),
  kinds: readonly TeamResourceKind[] = ["agents", "skills", "workflows"],
): Promise<TeamResourceIds> {
  const slug = teamSlug.trim();
  if (!slug) return emptyTeamResourceIds();

  const result = emptyTeamResourceIds();
  await Promise.all(
    kinds.map(async (kind) => {
      const spec = RESOURCE_RELATIONS[kind];
      result[kind] = await cache.listTeamResourceObjectIds({
        teamSlug: slug,
        type: spec.type,
        relation: spec.memberRelation,
      });
    }),
  );

  if (kinds.includes("agents")) {
    result.agentAdmins = await cache.listTeamAdminResourceObjectIds({
      teamSlug: slug,
      type: RESOURCE_RELATIONS.agents.type,
      relation: AGENT_ADMIN_RELATION,
    });
  }

  return result;
}

/**
 * Batch the per-team resolution over many team slugs with bounded concurrency
 * (reuses the shared OpenFGA read-concurrency pool). All slugs share one
 * `TeamResourceListingCache` so duplicate lookups across teams coalesce.
 * Returns a Map keyed by team slug. Throws if any underlying call fails.
 */
export async function listTeamResourceIdsBatch(
  teamSlugs: readonly string[],
  kinds: readonly TeamResourceKind[] = ["agents", "skills", "workflows"],
): Promise<Map<string, TeamResourceIds>> {
  const slugs = Array.from(
    new Set(teamSlugs.map((s) => s.trim()).filter(Boolean)),
  );
  const cache = new TeamResourceListingCache();
  const out = new Map<string, TeamResourceIds>();
  const resolved = await mapWithConcurrency(
    slugs,
    openFgaReadConcurrency(),
    (slug) => listTeamResourceIds(slug, cache, kinds),
  );
  slugs.forEach((slug, i) => out.set(slug, resolved[i]));
  return out;
}

/**
 * KB (knowledge_base) grants a team holds, keyed by datasource id with the
 * strongest permission the team is granted. OpenFGA is the source of truth
 * (mirrors agents/skills/workflows) — every KB write path (the team
 * kb-assignments PUT, and the RAG-server upload `write_datasource_ownership`)
 * lands the same tuples, so this single read reflects them all.
 *
 * Relation → permission map (must mirror `KB_PERMISSION_TO_OPENFGA_RELATION`
 * in the kb-assignments route, inverted):
 *   - `team:<slug>#member reader`   → read
 *   - `team:<slug>#member ingestor` → ingest
 *   - `team:<slug>#admin  manager`  → admin
 *
 * Permissions stack (ingest ⊃ read; admin ⊃ both) so when a team holds more
 * than one relation on a KB we surface only the strongest.
 */
const KB_RELATION_TO_PERMISSION: ReadonlyArray<{
  userset: "member" | "admin";
  relation: string;
  permission: KbPermission;
}> = [
  { userset: "member", relation: "reader", permission: "read" },
  { userset: "member", relation: "ingestor", permission: "ingest" },
  { userset: "admin", relation: "manager", permission: "admin" },
];

/** Strength ordering so the strongest grant wins when a KB has several. */
const KB_PERMISSION_RANK: Record<KbPermission, number> = {
  read: 0,
  ingest: 1,
  admin: 2,
};

export interface TeamKbGrants {
  /** Datasource ids the team can access (owned or shared), via OpenFGA. */
  kbIds: string[];
  /** Strongest permission per datasource id. */
  permissions: Record<string, KbPermission>;
}

/**
 * Resolve the KB datasource ids + strongest permission a single team holds,
 * read live from OpenFGA. Throws on OpenFGA failure (no silent empty) — FGA is
 * required, so callers surface an error rather than a misleadingly-empty list.
 */
export async function listTeamKbGrants(teamSlug: string): Promise<TeamKbGrants> {
  const slug = teamSlug.trim();
  if (!slug) return { kbIds: [], permissions: {} };

  const permissions: Record<string, KbPermission> = {};
  await Promise.all(
    KB_RELATION_TO_PERMISSION.map(async ({ userset, relation, permission }) => {
      const res = await listOpenFgaObjects({
        user: `team:${slug}#${userset}`,
        relation,
        type: "knowledge_base",
      });
      for (const object of res.objects) {
        const id = stripObjectType(object, "knowledge_base");
        if (!id) continue;
        const current = permissions[id];
        if (
          current === undefined ||
          KB_PERMISSION_RANK[permission] > KB_PERMISSION_RANK[current]
        ) {
          permissions[id] = permission;
        }
      }
    }),
  );

  return { kbIds: Object.keys(permissions), permissions };
}

/**
 * Batch `listTeamKbGrants` over many team slugs with bounded concurrency
 * (reuses the shared OpenFGA read-concurrency pool). Returns a Map keyed by
 * team slug. Throws if any underlying call fails — KB counts on the admin grid
 * fail-closed at the call site, mirroring the agent/skill/workflow counts.
 */
export async function listTeamKbGrantsBatch(
  teamSlugs: readonly string[],
): Promise<Map<string, TeamKbGrants>> {
  const slugs = Array.from(
    new Set(teamSlugs.map((s) => s.trim()).filter(Boolean)),
  );
  const out = new Map<string, TeamKbGrants>();
  const resolved = await mapWithConcurrency(
    slugs,
    openFgaReadConcurrency(),
    (slug) => listTeamKbGrants(slug),
  );
  slugs.forEach((slug, i) => out.set(slug, resolved[i]));
  return out;
}
