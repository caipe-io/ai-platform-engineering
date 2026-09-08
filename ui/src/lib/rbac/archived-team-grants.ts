// Archiving a team must also revoke every resource grant that flows through
// the team's `#member` / `#admin` userset — otherwise `team:<slug>#member
// can_use agent:X` still resolves true for anyone still on the roster, so an
// "archived" team would keep granting access. `team.status` is NOT consulted
// anywhere in the OpenFGA authorization path (OpenFGA is the source of truth),
// so archival is only real if the tuples go with it.
//
// What we strip: tuples where the archived team's userset is the SUBJECT —
//   team:<slug>#member  <relation>  <resource:id>
//   team:<slug>#admin   manager     <resource:id>
// across every shareable resource type (agent, skill, task, tool,
// knowledge_base, mcp_server, secret_ref, slack_channel, webex_space,
// conversation, service_account, ...).
//
// What we KEEP: the membership roster itself — `user:<sub> member team:<slug>`
// (the team is the OBJECT there, never the subject). Keeping the roster means
// the admin UI still shows who was on the team, and identity-group-sync can
// later flip `team.status` back to "active" if the group regains membership.
// It does NOT mean grants are auto-restored on unarchive: resource-team
// assignment is read live from OpenFGA with no other durable record (the
// legacy `team.resources` Mongo array was intentionally dropped), so once
// stripped here there is nothing to replay from — an admin must re-grant
// resources via the Team Resources UI after unarchiving.
//
// Deletes go through `deleteExactOpenFgaTuples` with keys read straight from
// the store. Userset tuples (`team:<slug>#member ...`) MUST be deleted this
// way: `writeOpenFgaTuples` runs a per-tuple `/check` that cannot resolve a
// userset as the `user`, so it would treat every such delete as "already gone"
// and silently drop it (see the note on `deleteExactOpenFgaTuples`).

import {
  deleteExactOpenFgaTuples,
  isOpenFgaReconciliationEnabled,
  readOpenFgaTuples,
  type OpenFgaTupleKey,
} from "./openfga";

/** Userset relations a team can hold as the SUBJECT of a resource grant. */
const TEAM_GRANT_USERSET_RELATIONS = new Set(["member", "admin", "owner"]);

/**
 * Parse `team:<slug>#<userset>` from a tuple `user` field. Returns the team
 * slug when the user is a team userset we treat as a grant subject, else null.
 * Plain memberships (`user:<sub>`) and non-team usersets return null.
 */
function archivedTeamSlugFromGrantSubject(user: string, archivedSlugs: Set<string>): string | null {
  const match = /^team:([^#]+)#(member|admin|owner)$/.exec(user);
  if (!match) return null;
  const [, slug, userset] = match;
  if (!TEAM_GRANT_USERSET_RELATIONS.has(userset)) return null;
  return archivedSlugs.has(slug) ? slug : null;
}

/**
 * Return every stored tuple that grants a resource to one of `archivedSlugs`
 * via its `#member`/`#admin`/`#owner` userset. Reads the full store once
 * (paginated) and filters in memory — bounded by store size, not slug count,
 * so a one-time bulk archival of hundreds of teams is a single scan rather
 * than thousands of per-team list calls. Membership tuples (team as object)
 * are never matched.
 */
async function readArchivedTeamGrantTuples(archivedSlugs: Set<string>): Promise<OpenFgaTupleKey[]> {
  const grants: OpenFgaTupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({ continuationToken, pageSize: 100 });
    for (const entry of page.tuples) {
      const key = entry.key;
      if (archivedTeamSlugFromGrantSubject(key.user, archivedSlugs)) {
        grants.push({ user: key.user, relation: key.relation, object: key.object });
      }
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return grants;
}

export interface StripArchivedTeamGrantsResult {
  /** Teams whose grants were considered (the input set size). */
  teamsConsidered: number;
  /** Grant tuples found in the store for those teams. */
  tuplesFound: number;
  /** Grant tuples OpenFGA acknowledged deleting. */
  tuplesDeleted: number;
  openFgaEnabled: boolean;
}

/**
 * Strip all resource-grant tuples flowing through the `#member`/`#admin`/
 * `#owner` userset of the given (archived) team slugs. Idempotent: re-running
 * with the same slugs after a successful strip finds nothing and deletes
 * nothing. The team membership roster (`user:<sub> -> team:<slug>`) is left
 * intact so the archive is reversible.
 *
 * No-ops (and does not read the store) when `slugs` is empty or OpenFGA
 * reconciliation is disabled, so callers can invoke it unconditionally on
 * every sync without paying for a store scan when nothing was archived.
 */
export async function stripArchivedTeamResourceGrants(
  slugs: Iterable<string>,
): Promise<StripArchivedTeamGrantsResult> {
  const archivedSlugs = new Set(Array.from(slugs).filter((slug) => typeof slug === "string" && slug.length > 0));
  if (archivedSlugs.size === 0) {
    return { teamsConsidered: 0, tuplesFound: 0, tuplesDeleted: 0, openFgaEnabled: true };
  }
  if (!isOpenFgaReconciliationEnabled()) {
    return { teamsConsidered: archivedSlugs.size, tuplesFound: 0, tuplesDeleted: 0, openFgaEnabled: false };
  }

  const grants = await readArchivedTeamGrantTuples(archivedSlugs);
  if (grants.length === 0) {
    return { teamsConsidered: archivedSlugs.size, tuplesFound: 0, tuplesDeleted: 0, openFgaEnabled: true };
  }

  const result = await deleteExactOpenFgaTuples(grants);
  return {
    teamsConsidered: archivedSlugs.size,
    tuplesFound: grants.length,
    tuplesDeleted: result.deletes,
    openFgaEnabled: result.enabled,
  };
}

// Exported for unit tests — lets a test assert the subject-matching rule
// (grant subject vs. membership object) without standing up an OpenFGA store.
export const __test__ = { archivedTeamSlugFromGrantSubject };
