/**
 * API route for listing the datasources a team can see, for the dynamic
 * agent editor's datasource-binding picker (spec
 * 2026-07-21-rag-source-mgmt-ui, Workstream D).
 *
 * GET /api/dynamic-agents/datasources?team_slug=<slug>
 *
 * Returns the union of the owning team's `knowledge_base` grants and the
 * current caller's readable datasources. The caller-specific half is what lets
 * a creator pin their personal source to an agent without granting that source
 * to the entire owner team. At runtime the RAG server still intersects the pin
 * with each caller's own access, so selecting a personal source never shares
 * it with other agent users.
 */

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { manageableDatasourceIdsForCollectionPublishing } from "@/lib/rag-collections.server";
import {
  getRagServerUrl,
  loadLatestSuccessfulIngestionStats,
  ragRequestHeaders,
} from "@/lib/rag-ingestion-stats.server";
import { listTeamKbGrants } from "@/lib/rbac/team-resource-listing";
import { NextRequest } from "next/server";

interface RagDatasourceListItem {
  datasource_id?: unknown;
  id?: unknown;
  name?: unknown;
  source_type?: unknown;
  _permissions?: {
    can_read_content?: unknown;
    can_manage_source?: unknown;
  };
}

interface CallerDatasourceOption {
  name: string;
  sourceType?: string;
  canRead: boolean;
  canManageSource: boolean;
}

/**
 * Best-effort id -> display name lookup from the RAG server. Returns an
 * empty map (never throws) so a RAG-server outage degrades the picker to
 * raw ids instead of failing the whole editor load.
 */
async function loadCallerReadableDatasources(session: {
  accessToken?: string;
  org?: string;
}): Promise<Map<string, CallerDatasourceOption>> {
  const options = new Map<string, CallerDatasourceOption>();
  if (!session.accessToken) return options;

  try {
    const response = await fetch(`${getRagServerUrl()}/v1/datasources`, {
      method: "GET",
      headers: ragRequestHeaders(session),
    });
    if (!response.ok) return options;
    const data: unknown = await response.json();
    const list =
      data &&
      typeof data === "object" &&
      Array.isArray((data as { datasources?: unknown }).datasources)
        ? (data as { datasources: RagDatasourceListItem[] }).datasources
        : [];
    for (const item of list) {
      const id = item.datasource_id ?? item.id;
      if (typeof id !== "string" || !id) continue;
      const canRead = item._permissions?.can_read_content === true;
      const canManageSource = item._permissions?.can_manage_source === true;
      if (!canRead && !canManageSource) continue;
      options.set(id, {
        name:
          typeof item.name === "string" && item.name.trim()
            ? item.name.trim()
            : id,
        ...(typeof item.source_type === "string" && item.source_type.trim()
          ? { sourceType: item.source_type.trim() }
          : {}),
        canRead,
        canManageSource,
      });
    }
  } catch {
    // best-effort — fall back to raw ids
  }
  return options;
}

/**
 * Load the latest successful ingestion counts in bounded batches. The RAG
 * endpoint applies its own datasource read filter, and failures intentionally
 * degrade to cards without rarity metadata.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

  const { searchParams } = new URL(request.url);
  const teamSlug = (searchParams.get("team_slug") || "").trim();
  const purpose =
    searchParams.get("purpose") === "publish" ? "publish" : "agent";

  if (teamSlug) {
    // The caller must be able to act as this team (member/admin) — mirrors the
    // owner-team gate used elsewhere in the agent editor's write path. Org
    // admins can edit agents for any team and therefore need the same explicit
    // bypass here or their datasource picker would fail to load.
    try {
      await requireResourcePermission(
        session,
        { type: "team", id: teamSlug, action: "use" },
        { bypassForOrgAdmin: true },
      );
    } catch {
      await requireResourcePermission(
        session,
        { type: "team", id: teamSlug, action: "manage" },
        { bypassForOrgAdmin: true },
      );
    }
  }

  const grants = teamSlug
    ? await listTeamKbGrants(teamSlug)
    : { kbIds: [] as string[], permissions: {} as Record<string, string> };
  const callerDatasources = await loadCallerReadableDatasources({
    accessToken: session.accessToken,
    org: session.org,
  });
  const callerReadableIds = [...callerDatasources]
    .filter(([, option]) => option.canRead)
    .map(([id]) => id);
  const ids = new Set(
    purpose === "publish"
      ? callerDatasources.keys()
      : [...grants.kbIds, ...callerReadableIds],
  );
  const candidates = [...ids].map((id) => ({ id }));
  const manageableIds =
    purpose === "publish"
      ? await manageableDatasourceIdsForCollectionPublishing(session, [...ids])
      : new Set<string>();
  const ingestionStats = await loadLatestSuccessfulIngestionStats(
    { accessToken: session.accessToken, org: session.org },
    [...ids],
  );

  return successResponse({
    datasources: candidates
      .map(({ id }) => {
        const canManage = manageableIds.has(id);
        return {
          datasource_id: id,
          name: callerDatasources.get(id)?.name || id,
          ...(callerDatasources.get(id)?.sourceType
            ? { source_type: callerDatasources.get(id)?.sourceType }
            : {}),
          ...(ingestionStats.has(id)
            ? {
                document_count: ingestionStats.get(id)?.documentCount,
                chunk_count: ingestionStats.get(id)?.chunkCount,
              }
            : {}),
          permission:
            purpose === "publish"
              ? canManage
                ? "Manage source"
                : "Read source"
              : grants.permissions[id] || "Your access",
          ...(purpose === "publish" ? { can_manage: canManage } : {}),
          ...(purpose === "publish"
            ? { can_read: callerDatasources.get(id)?.canRead === true }
            : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});
