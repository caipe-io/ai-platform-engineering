import {
getAuthFromBearerOrSession,
getPaginationParams,
paginatedResponse,
requireRbacPermission,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { listRealmUsersPage } from "@/lib/rbac/keycloak-admin";
import { NextRequest } from "next/server";

type WebexUserMetrics = {
  webex_user_id: string;
  last_interaction_at?: Date;
  obo_success_count?: number;
  obo_fail_count?: number;
  active_space_ids?: string[];
};

type WebexUserRow = {
  keycloak_user_id: string;
  username?: string;
  email?: string;
  display_name?: string;
  webex_user_id: string;
  link_status: "linked" | "unlinked";
  enabled?: boolean;
  teams: string[];
  last_interaction: string | null;
  obo_success_count: number;
  obo_fail_count: number;
  active_spaces: string[];
};

function readWebexId(attrs: unknown): string | undefined {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return undefined;
  const a = attrs as Record<string, string[]>;
  const v = a.webex_user_id;
  return v?.[0]?.trim() || undefined;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");

  const { page, pageSize, skip } = getPaginationParams(request);
  const status = (request.nextUrl.searchParams.get("status") || "all").toLowerCase();

  const linked: Array<{
    keycloak_user_id: string;
    username?: string;
    email?: string;
    display_name?: string;
    webex_user_id: string;
    enabled?: boolean;
  }> = [];

  for (let first = 0; first < 8000; first += 100) {
    const batch = await listRealmUsersPage(first, 100);
    if (batch.length === 0) break;
    for (const u of batch) {
      const wid = readWebexId(u.attributes);
      if (!wid) continue;
      linked.push({
        keycloak_user_id: String(u.id ?? ""),
        username: u.username !== undefined && u.username !== null ? String(u.username) : undefined,
        email: u.email !== undefined && u.email !== null ? String(u.email) : undefined,
        display_name:
          [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
          (u.username !== undefined && u.username !== null ? String(u.username) : undefined),
        webex_user_id: wid,
        enabled: u.enabled !== false,
      });
    }
    if (batch.length < 100) break;
  }

  const webexIdsLinked = new Set(linked.map((l) => l.webex_user_id));

  const unlinkedFromMetrics: Array<{ webex_user_id: string }> = [];
  try {
    const metricsColl = await getCollection<WebexUserMetrics>("webex_user_metrics");
    const orphans = await metricsColl
      .find({ webex_user_id: { $nin: Array.from(webexIdsLinked) } })
      .limit(100)
      .toArray();
    for (const m of orphans) {
      unlinkedFromMetrics.push({ webex_user_id: m.webex_user_id });
    }
  } catch {
    // optional collection
  }

  type RowIn = (typeof linked)[number] | { webex_user_id: string; unlinked: true };
  const baseRows: RowIn[] = [
    ...linked,
    ...unlinkedFromMetrics.map((u) => ({ ...u, unlinked: true as const })),
  ];

  const filtered: RowIn[] = baseRows.filter((row) => {
    if ("unlinked" in row && row.unlinked) {
      return status === "all" || status === "unlinked";
    }
    return status !== "unlinked";
  });

  const total = filtered.length;
  const pageSlice = filtered.slice(skip, skip + pageSize);

  const metricsColl = await getCollection<WebexUserMetrics>("webex_user_metrics").catch(() => null);
  const teamsColl = await getCollection<{ name: string; members: { user_id: string }[] }>("teams").catch(
    () => null
  );

  const items: WebexUserRow[] = await Promise.all(
    pageSlice.map(async (row) => {
      if ("unlinked" in row && row.unlinked) {
        let metrics: Partial<WebexUserMetrics> = {};
        if (metricsColl) {
          metrics = (await metricsColl.findOne({ webex_user_id: row.webex_user_id })) ?? {};
        }
        return {
          keycloak_user_id: "",
          webex_user_id: row.webex_user_id,
          link_status: "unlinked" as const,
          teams: [],
          last_interaction: metrics.last_interaction_at?.toISOString() ?? null,
          obo_success_count: metrics.obo_success_count ?? 0,
          obo_fail_count: metrics.obo_fail_count ?? 0,
          active_spaces: metrics.active_space_ids ?? [],
        };
      }

      const r = row as (typeof linked)[number];
      let teamNames: string[] = [];
      if (teamsColl && r.email) {
        const t = await teamsColl
          .find({ "members.user_id": r.email })
          .project({ name: 1 })
          .limit(20)
          .toArray();
        teamNames = t.map((x) => String(x.name ?? ""));
      }

      let metrics: Partial<WebexUserMetrics> = {};
      if (metricsColl) {
        metrics = (await metricsColl.findOne({ webex_user_id: r.webex_user_id })) ?? {};
      }

      return {
        keycloak_user_id: r.keycloak_user_id,
        username: r.username,
        email: r.email,
        display_name: r.display_name,
        webex_user_id: r.webex_user_id,
        link_status: "linked" as const,
        enabled: r.enabled,
        teams: teamNames,
        last_interaction: metrics.last_interaction_at?.toISOString() ?? null,
        obo_success_count: metrics.obo_success_count ?? 0,
        obo_fail_count: metrics.obo_fail_count ?? 0,
        active_spaces: metrics.active_space_ids ?? [],
      };
    })
  );

  return paginatedResponse(items, total, page, pageSize);
});
